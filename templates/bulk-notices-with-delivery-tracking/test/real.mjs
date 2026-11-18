/**
 * Real API scenario for the bulk-notices-with-delivery-tracking template: the exported workflow against the REAL Turbo Notify
 * API, with real WhatsApp delivery, to the owner's own test number only.
 *
 *   export TN_REAL_OWNER_PHONE='+<the owner test number>'
 *   node templates/harness/run-template.mjs templates/bulk-notices-with-delivery-tracking/workflow.json \
 *     --real-api --api-key-file <file with the line "- Value: tn_live_..."> --max-sends 4 \
 *     --scenario templates/bulk-notices-with-delivery-tracking/test/real.mjs --image n8nio/n8n:2.45.5 \
 *     --run-id t2real --ports 5692,9211
 *
 * Updated for the revision with an empty default_message, a required Message field, report_after_hours 12, "people" and no plan name
 * in the summary, and the plan saved on every row before the split. This revision has NOT been run against the real API.
 *
 * It SENDS REAL MESSAGES (3 expected: the notice, its summary and the summary of the resubmitted batch; at most 4, to the owner test number, enforced by the harness guard) and deletes
 * them for everyone at the end. The number is never written in this file: it comes from TN_REAL_OWNER_PHONE.
 *
 * What it runs: the setup trigger, one form batch with a TAB separated line, a duplicate and an invalid line (one real
 * notice), the LIVE Polling Trigger (the workflow stays active from the form to the summary, so the receipt that
 * arrives a few seconds after the send is picked up by the next minute poll), and the owner summary. The failure path
 * and the probes of the real API's answers to a malformed phone are in real-failure.mjs.
 *
 * Facts of the real API this scenario records: the quota output (tier in capitals), the receipt event of our own
 * message (data.id is our message id, direction inbound, origin native) and that Get Status is never called.
 * Not provoked on purpose: duplicate_burst_blocked and reply_ratio_too_low (documented only), the `message.send.failed`
 * payload (none exists on the account), the `read` receipt (the owner would have to open the chat).
 */
export const timeoutMs = 30 * 60_000;
export const credentials = [{ type: 'httpBasicAuth', name: 'Form access (Basic Auth)', data: { user: 'notices-team', password: 'real-run-form-password' } }];
const AUTH = 'Basic ' + Buffer.from('notices-team:real-run-form-password').toString('base64');
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const TRIGGER = 'New delivery and failure events';

/** The Schedule Trigger "Every hour" fires at minute 0: do not be active across it (a summary could go out in its run). */
async function avoidTopOfHour(windowSeconds) {
	for (;;) {
		const now = new Date();
		const sec = now.getUTCMinutes() * 60 + now.getUTCSeconds();
		if (sec + windowSeconds < 3600 && sec > 90) return;
		await new Promise((r) => setTimeout(r, 15_000));
	}
}

function ownerPhone() {
	const phone = process.env.TN_REAL_OWNER_PHONE;
	if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('set TN_REAL_OWNER_PHONE to the owner test number, with + and the country code');
	return phone;
}
/** The only values changed in Settings (listed in the README): the owner phone and a short pause between batches. */
function setSettings(nodes, patch) {
	const settings = nodes.find((n) => n.name === 'Settings');
	for (const assignment of settings.parameters.assignments.assignments) {
		if (assignment.name in patch) assignment.value = patch[assignment.name];
	}
}
export async function prepare(workflow) {
	setSettings(workflow.nodes, { owner_phone: ownerPhone(), pause_between_batches_seconds: 5 });
	return workflow;
}

export default async function scenario(t) {
	const { assert, real } = t;
	const OWNER = ownerPhone();
	const bodyKeys = (o) => Object.keys(o ?? {}).sort();

	const tableId = async () => (await t.n8n.dataTables()).find((x) => x.name === 'notices')?.id;
	const rows = async (where = {}) => {
		const filters = Object.entries(where).map(([columnName, value]) => ({ columnName, condition: 'eq', value }));
		return t.n8n.dataTableRows(await tableId(), filters.length ? { filter: { type: 'and', filters } } : {});
	};
	const sendsSince = async (mark) => real.guard.sends({ since: mark });
	/** The summaries: the owner number is also the recipient of the notices, so a summary is told by its text. */
	const toOwner = (sends) => sends.filter((s) => digits(s.to?.number) === digits(OWNER) && String(s.content?.text).startsWith('Notices batch'));
	const okRun = (execution) => assert.equal(execution.status, 'success', execution.describe());

	/** Nothing targets another number: Settings, every row in the table, and the lines about to be submitted. */
	const assertOnlyOwner = async (label, lines = []) => {
		const assignments = t.workflow.node('Settings').parameters.assignments.assignments;
		assert.equal(digits(assignments.find((a) => a.name === 'owner_phone').value), digits(OWNER), `${label}: owner_phone is the owner test number`);
		assert.equal(assignments.find((a) => a.name === 'stop_list').value, '', `${label}: the stop list is empty`);
		if (await tableId()) {
			for (const r of await rows()) {
				if (r.status === 'invalid_phone') continue; // an invalid value is never sent
				assert.equal(digits(r.phone), digits(OWNER), `${label}: row ${r.name || '(no name)'} targets the owner test number only`);
			}
		}
		for (const line of lines) {
			const parts = line.split(/[\t,;]/);
			const phone = parts.at(-1).trim();
			if (phone === 'abc') continue; // letters: the workflow marks it invalid before any send
			assert.equal(digits(phone), digits(OWNER), `${label}: line "${parts[0]}" targets the owner test number only`);
		}
	};

	await t.step('0 pre-flight on the real API: the key works, the number is connected, the quota is readable', async () => {
		const numbers = await real.numbers();
		const main = numbers.data.find((n) => n.alias === 'main');
		assert.ok(main, 'a main number exists');
		assert.equal(digits(main.number) === digits(OWNER), false, 'the sending number is not the recipient');
		assert.equal((await real.get('/v1/numbers/main')).status, 'connected', 'the number is connected');
		const quota = await real.quota();
		const contacts = await real.contactQuota();
		t.note('plan', { tier: quota.tier, messages_quota: quota.quota, messages_remaining: quota.remaining, contact_quota: contacts.quota, contact_tier: contacts.tier });
		assert.ok(quota.remaining >= 20, 'enough quota for a handful of messages');
		assert.equal(real.guard.messagesAccepted, 0, 'nothing sent yet');
	});

	await t.step('1 "Create the notices table (run once)" makes the table with its 12 columns', async () => {
		okRun(await t.run('Create the notices table (run once)'));
		const table = (await t.n8n.dataTables()).find((x) => x.name === 'notices');
		assert.ok(table, 'the table exists');
		assert.count(table.columns.filter((c) => !['id', 'createdAt', 'updatedAt'].includes(c.name)), 12, '12 columns');
	});

	let batch;
	let row;
	await t.step('2 one form batch with a TAB separated line, a duplicate and an invalid line, the workflow ACTIVE: one real send, the quota read, the live trigger started', async () => {
		const lines = [`Owner Test\t${OWNER}`, `Owner Again,${OWNER}`, 'Nope,abc'];
		await assertOnlyOwner('form', lines);
		const mark = await real.guard.mark();
		await avoidTopOfHour(900);
		await t.activate(); // stays active until the delivery news and the summary have been seen
		const since = await t.executionMark();
		const body = new FormData();
		body.set('field-0', lines.join('\n'));
		body.set('field-1', 'Real run notice for {name}.');
		body.set('field-2', 'Real');
		const response = await fetch(`${t.urls.n8n}/form/${t.workflow.node('New batch form').parameters.path}`, { method: 'POST', headers: { authorization: AUTH }, body });
		const text = await response.text();
		assert.equal(response.status, 200, `the form accepted the submission: ${text.slice(0, 200)}`);
		const execution = (await t.waitExecutions({ since, timeoutMs: 240_000 })).find((e) => e.ran('New batch form'));
		assert.ok(execution, 'a run started');
		okRun(execution);
		const saved = (await rows()).filter((r) => r.label === 'Real');
		batch = saved[0].batch_id;
		row = saved[0];
		assert.equal(saved.map((r) => r.status), ['sent', 'duplicate', 'invalid_phone'], 'sent, duplicate, invalid_phone');
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'one message');
		assert.equal(sends[0].content, { text: 'Real run notice for Owner Test.' }, 'merged text');
		assert.equal(sends[0].idempotencyKey, `${batch}-${saved[0].id}`, 'Idempotency-Key is <batch id>-<row id>');
		assert.equal(saved[0].message_id, sends[0].messageId, 'the row stores the real message id');
		assert.equal(digits(sends[0].to.number), digits(OWNER), 'to the owner test number');
		assert.ok(String(sends[0].to.number).startsWith('+'), 'the phone starts with +');
		const requests = await real.guard.requests({ since: mark });
		t.note('realRoutesUsed', requests.map((r) => `${r.method} ${r.path} -> ${r.status}`));
		const quotaOut = execution.first('Get message quota');
		t.note('realGetQuotaOutput', { keys: bodyKeys(quotaOut), tier: quotaOut.tier, remainingType: typeof quotaOut.remaining });
		t.note('realSendResponse', { status: sends[0].status, keys: bodyKeys(sends[0].response) });
		assert.equal(typeof quotaOut.remaining, 'number', 'remaining is a number');
		assert.equal(requests.some((r) => r.method === 'GET' && r.path === '/v1/numbers/main'), false, 'no separate number check any more');
		assert.equal(execution.ran('Decide which batches are ready'), true, 'the summary check ran at the end of the batch');
		assert.equal(toOwner(sends).length, 0, 'no summary yet: the row is only sent');
	});

	await t.step('3 the live Polling Trigger picks the receipt of the real message, the row moves to delivered and the owner gets ONE summary', async () => {
		const done = async () => {
			const current = (await rows({ batch_id: batch })).find((r) => r.message_id);
			const reports = toOwner(await sendsSince(0)).filter((s) => String(s.content?.text).includes(batch));
			return { ok: ['delivered', 'read'].includes(current.status) && reports.length >= 1, status: current.status, reports: reports.length };
		};
		const t0 = Date.now();
		const seen = [];
		for (;;) {
			const state = await done();
			seen.push({ afterMs: Date.now() - t0, status: state.status, reports: state.reports });
			if (state.ok || Date.now() - t0 > 6 * 60_000) break;
			await t.sleep(10_000);
		}
		t.note('trackingProgression', seen);
		const state = await done();
		assert.ok(state.ok, `the row reached delivered and was summarised within 6 minutes (${JSON.stringify(seen.at(-1))})`);
		// The runs of the Polling Trigger: what the real receipt event looked like.
		const pollRuns = (await t.waitExecutions({ since: 0, count: 1, timeoutMs: 10_000 })).filter((e) => e.ran(TRIGGER));
		assert.ok(pollRuns.length >= 1, 'the Polling Trigger started a run');
		const events = pollRuns.flatMap((e) => e.items(TRIGGER));
		const mine = events.find((e) => e.data?.id === row.message_id);
		assert.ok(mine, 'an event carries the id of our message in data.id');
		t.note('realReceiptEvent', { type: mine.type, envelopeKeys: bodyKeys(mine), dataKeys: bodyKeys(mine.data), direction: mine.data.direction, origin: mine.data.origin, idMatchesOurMessage: mine.data.id === row.message_id });
		const current = (await rows({ batch_id: batch })).find((r) => r.message_id);
		assert.ok(current.delivered_at, 'delivered_at is stored');
		const reports = toOwner(await sendsSince(0)).filter((s) => String(s.content?.text).includes(batch));
		assert.count(reports, 1, 'one summary');
		t.note('summaryText', String(reports[0].content.text).replace(batch, '<batch>'));
		assert.match(reports[0].content.text, /delivered 1 \(read so far [01]\)/, 'it says delivered 1 and "read so far"');
		assert.match(reports[0].content.text, /Messages left in this cycle: \d+ of \d+\./, 'the quota line (no plan name)');
		assert.match(reports[0].content.text, /snapshot/, 'and that it is a snapshot');
		assert.equal(reports[0].idempotencyKey, `report-${batch}`, 'summary key');
		assert.equal((await real.guard.requests()).filter((r) => /\/status$/.test(r.path)).length, 0, 'Get Status was never called');
		t.note('finalStateReached', (await real.status(row.message_id)).status.state);
	});

	await t.step('3b the owner phone may read the message: wait up to 3 minutes for a read receipt (recorded either way)', async () => {
		const seen = await real.observe(row.message_id, ['read'], { timeoutMs: 180_000, intervalMs: 10_000 });
		t.note('readReceipt', { reached: seen.reached, states: seen.seen });
		if (!seen.reached) return;
		await t.sleep(75_000); // one more tick of the live Polling Trigger
		const current = (await rows({ batch_id: batch })).find((r) => r.message_id);
		t.note('rowAfterRead', { status: current.status, read_at_set: Boolean(current.read_at) });
		assert.equal(current.status, 'read', 'the live trigger moved the row to read');
	});

	await t.step('3c the same list submitted again (idempotent resubmit): every line is a duplicate, nothing new is sent to the real API', async () => {
		const lines = [`Owner Test\t${OWNER}`, `Owner Again,${OWNER}`, 'Nope,abc'];
		await assertOnlyOwner('resubmit', lines);
		const mark = await real.guard.mark();
		const since = await t.executionMark();
		const body = new FormData();
		body.set('field-0', lines.join('\n'));
		body.set('field-1', 'Real run notice for {name}.');
		body.set('field-2', 'Again');
		const response = await fetch(`${t.urls.n8n}/form/${t.workflow.node('New batch form').parameters.path}`, { method: 'POST', headers: { authorization: AUTH }, body });
		assert.equal(response.status, 200, 'the form accepted it');
		const execution = (await t.waitExecutions({ since, timeoutMs: 240_000 })).find((e) => e.ran('New batch form'));
		assert.ok(execution, 'a run started');
		okRun(execution);
		const second = (await rows()).filter((r) => r.label === 'Again');
		t.note('resubmitStatuses', second.map((r) => r.status));
		assert.equal(second.map((r) => r.status), ['duplicate', 'duplicate', 'invalid_phone'], 'duplicate, duplicate, invalid_phone');
		const sends = await sendsSince(mark);
		t.note('resubmitSends', sends.map((s) => ({ owner: digits(s.to?.number) === digits(OWNER), text: String(s.content?.text ?? '').slice(0, 60).replace(/batch_[0-9a-z-]+/gi, '<batch>'), key: s.idempotencyKey ? 'set' : 'none' })));
		assert.equal(sends.length, 0, 'the resubmit itself sends nothing: the all-duplicate batch is summarised later, by the hourly check');
		assert.equal(sends.filter((s) => String(s.content?.text).startsWith('Real run notice')).length, 0, 'no notice was sent again');
		await t.deactivate();
		// A batch with nothing to send is summarised by the next run that reaches the summary step: here, the hourly check.
		const mark2 = await real.guard.mark();
		okRun(await t.run('Every hour'));
		const hourly = await sendsSince(mark2);
		t.note('hourlyAfterResubmit', hourly.map((s) => String(s.content?.text ?? '').split('\n').slice(0, 2).join(' | ').replace(/batch_[0-9a-z-]+/gi, '<batch>')));
		assert.count(hourly, 1, 'the hourly check sends the summary of the all-duplicate batch, once');
		assert.match(String(hourly[0].content?.text), /^Notices batch "Again"/, 'it is the summary of the second batch');
		assert.match(String(hourly[0].content?.text), /delivered 0 \(read so far 0\), invalid number 1, duplicate 2/, 'with its counts');
		const mark3 = await real.guard.mark();
		okRun(await t.run('Every hour'));
		assert.equal((await sendsSince(mark3)).length, 0, 'a second hourly run sends nothing more (a batch is never summarised twice)');
	});

	await t.step('4 what the real API holds matches what was sent: only the owner test number, inside the budget', async () => {
		const all = [...new Set(real.guard.acceptedMessageIds())];
		assert.ok(all.length <= 4, `the budget of 4 real messages holds (${all.length} sent)`);
		const list = await real.listSent(40);
		const mine = list.data.filter((m) => m.origin !== 'native' && Date.parse(m.at) >= Date.parse(real.startedAt) - 2000);
		assert.equal(mine.length, all.length, 'the real API lists exactly the messages the harness counted');
		for (const m of mine) assert.equal(digits(m.to?.number), digits(OWNER), 'every message went to the owner test number');
		t.note('messagesSent', all.length);
		t.note('guard', { blockedCalls: real.guard.blocked, requests: (await real.guard.requests()).length });
		assert.equal(real.guard.blocked, 0, 'the guard blocked nothing');
	});
}

/** Runs before the harness deletes the messages: the table goes first. */
export async function cleanup(t) {
	try {
		const table = (await t.n8n.dataTables()).find((x) => x.name === 'notices');
		if (table) {
			await t.n8n.rest('DELETE', `/rest/projects/${t.n8n.projectId}/data-tables/${table.id}`);
			t.note('dataTableDeleted', true);
		}
	} catch (error) {
		t.note('dataTableDeleted', `failed: ${error.message}`);
	}
	const results = [];
	for (const id of t.real.guard.acceptedMessageIds()) {
		const r = await t.real.deleteWhenSent(id);
		results.push({ state: r.state, status: r.status, deleted: r.deleted, error: r.error });
	}
	t.note('deleteForEveryone', results);
}
