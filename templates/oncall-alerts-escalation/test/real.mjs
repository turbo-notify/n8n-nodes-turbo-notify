/**
 * Real API scenario for T4 (oncall-alerts-escalation): the exported workflow against the REAL Turbo Notify API,
 * with real WhatsApp delivery between two numbers of the same owner. NOT RUN YET: written for a later gate 2 run.
 *
 *   The workflow runs on number A (the "number under test", the key passed with --api-key-file).
 *   The "on-call person" is number B, an owned number of ANOTHER organization. It is level 1 and the owner at once
 *   (levels 2 and 3 are empty), and it answers with its own key (--customer-key-file). The only recipient the
 *   workflow may reach is B (the guard). Both numbers count in the same budget (--max-sends).
 *
 *   export TN_REAL_OWNER_PHONE='+<number B: the on-call person, the only number the workflow may message>'
 *   export TN_REAL_PERSONAL_PHONE='+<number A: the number under test>'
 *   node templates/harness/run-template.mjs templates/oncall-alerts-escalation/workflow.json \
 *     --real-api --api-key-file <key of A> --customer-key-file <key of B> --max-sends 8 \
 *     --scenario templates/oncall-alerts-escalation/test/real.mjs --image n8nio/n8n:2.45.5 \
 *     --run-id t4real --ports 5695,9231
 *
 * Messages (7 of the 8 allowed; the page text now ends with the runbook link and the timer waits ack_minutes + 1 minute,
 * which the patched notified_at below already exceeds): alert 1 = the page with the runbook button, the answer "OK <code>" of B, the
 * confirmation; alert 2 = the page (plain text) and, after nobody answers, the ONE final message; alert 3 = the page
 * and the "resolved" message. A second, repeated request of alert 3 must send nothing.
 *
 * What real mode cannot show: the second and third level (the guard allows one number), a person typing on a phone,
 * how WhatsApp draws the button. The values typed in "Your settings" are the only patch.
 */
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const HOOK = 'Receive an alert';
const TOKEN = 'real-run-alert-token-0001';

export const timeoutMs = 40 * 60_000;
export const credentials = [{ type: 'httpHeaderAuth', name: 'Alert access (Header Auth)', data: { name: 'X-Alert-Token', value: TOKEN } }];

function phones() {
	const oncall = process.env.TN_REAL_OWNER_PHONE;
	const under = process.env.TN_REAL_PERSONAL_PHONE;
	for (const p of [oncall, under]) if (!p || !/^\+[1-9]\d{7,14}$/.test(p)) throw new Error('set TN_REAL_OWNER_PHONE (the on-call person) and TN_REAL_PERSONAL_PHONE (the number under test), with + and the country code');
	return { oncall, under };
}

/** The values a person types in "Your settings": level 1 and the owner are number B, no other level. */
export async function prepare(workflow) {
	const { oncall } = phones();
	const settings = workflow.nodes.find((n) => n.name === 'Your settings');
	const set = { oncall_phone_1: oncall, oncall_phone_2: '', oncall_phone_3: '', owner_phone: oncall };
	for (const a of settings.parameters.assignments.assignments) if (a.name in set) a.value = set[a.name];
	return workflow;
}

export default async function scenario(t) {
	const { assert, real } = t;
	const { oncall: ONCALL } = phones();
	const person = real.customer;
	assert.ok(person, 'the on-call sender is configured (--customer-key-file)');
	const rowOf = async (id) => (await t.tables.rows('oncall_alerts', { where: { alert_id: id } }))[0];
	const patchRow = (id, patch) => t.tables.update('oncall_alerts', { alert_id: id }, patch);
	const sendsSince = async (mark) => real.guard.sends({ since: mark });
	const call = (body, headers = { 'X-Alert-Token': TOKEN }) => t.callWebhook(HOOK, { body, headers });
	const until = async (predicate, ms, label) => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			const value = await predicate();
			if (value) return value;
			await t.sleep(4000);
		}
		assert.fail(`timed out after ${Math.round(ms / 1000)} s waiting for: ${label}`);
	};
	const body = (id, extra = {}) => ({ alert_id: id, service: 'Sample service', severity: 'critical', status: 'firing', message: `Sample alert ${id}`, ...extra });

	await t.step('0 pre-flight: the number under test is connected, the on-call number is the one the guard allows, the quota is readable', async () => {
		const single = await real.get('/v1/numbers/main');
		assert.equal(single.status, 'connected', 'the number under test is connected');
		// The on-call person must be somebody else: the linked phone cannot page itself (no push, and its own messages are not received).
		// The number resource names its phone `number` (a string), not `phone_number`.
		assert.ok(digits(single.number).length >= 8, 'the number resource holds its phone in `number`');
		assert.equal(digits(single.number), digits(process.env.TN_REAL_PERSONAL_PHONE), 'the number under test is the one configured');
		assert.ok(digits(single.number) !== digits(ONCALL), 'the on-call number is not the number linked to Turbo Notify');
		const from = await person.verify();
		assert.ok(from, 'the on-call sender is the number the guard allows');
		const quota = await real.quota();
		t.note('plan', { tier: quota.tier, messages_remaining: quota.remaining });
		assert.ok(quota.remaining >= 20, 'enough quota');
		assert.equal(real.guard.messagesAccepted + person.count, 0, 'nothing sent yet');
	});

	await t.step('1 the table is created by the workflow, the real webhook refuses a call without the header, and the workflow is switched on', async () => {
		const execution = await t.run('Run once: create the table');
		assert.equal(execution.status, 'success', execution.describe());
		await t.activate();
		const refused = await t.callWebhook(HOOK, { body: body('refused') });
		assert.equal(refused.status, 403, 'no header: refused');
		assert.equal(await rowOf('refused'), undefined, 'nothing stored');
		assert.equal(real.guard.messagesAccepted, 0, 'nothing sent');
	});

	let first;
	await t.step('2 alert 1: the page reaches WhatsApp as a link button message, the row records the message id', async () => {
		const mark = await real.guard.mark();
		const res = await call(body('real-1', { runbook_url: 'https://example.com/runbooks/sample' }));
		assert.equal(res.status, 200, 'the webhook answers');
		await until(async () => (await rowOf('real-1'))?.message_id, 90_000, 'the page to be accepted');
		first = await rowOf('real-1');
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'one message');
		assert.equal(digits(sends[0].to?.number), digits(ONCALL), 'to the on-call person only');
		assert.equal(sends[0].content?.interactive_type, 'cta_url', 'a link button message');
		assert.ok((sends[0].content?.text ?? sends[0].content?.body ?? '').endsWith('https://example.com/runbooks/sample'), 'the runbook link is also the last line of the text');
		assert.equal(first.paged_phones, ONCALL, 'recorded');
		const seen = await real.observe(first.message_id, ['delivered', 'read'], { timeoutMs: 90_000 });
		t.note('pageDelivery', { reached: seen.reached, state: seen.state, seen: seen.seen });
		assert.ok(['sent', 'delivered', 'read'].includes(seen.state), 'the page was sent');
		const again = await call(body('real-1', { runbook_url: 'https://example.com/runbooks/sample' }));
		assert.equal(again.status, 200, 'the same alert again');
		await t.sleep(5000);
		assert.count(await sendsSince(mark), 1, 'and nothing new is sent');
	});

	await t.step('3 the on-call person answers "OK <code>" from a real number: the real poller takes the alert and confirms', async () => {
		const mark = await real.guard.mark();
		await person.send(`OK ${first.short_code}`);
		const row = await until(async () => {
			const r = await rowOf('real-1');
			return r?.status === 'acknowledged' ? r : null;
		}, 240_000, 'the real poller to take the alert');
		assert.equal(digits(row.acknowledged_by), digits(ONCALL), 'by the sender');
		const sends = await until(async () => {
			const s = await sendsSince(mark);
			return s.length >= 1 ? s : null;
		}, 60_000, 'the confirmation');
		assert.match(sends[0].content?.text ?? '', /^Acknowledged, you own Sample service/, 'the confirmation text');
	});

	await t.step('4 alert 2: nobody answers, the real timer sends ONE final message and the alert stops', async () => {
		const mark = await real.guard.mark();
		await call(body('real-2'));
		await until(async () => (await rowOf('real-2'))?.message_id, 90_000, 'the page');
		await patchRow('real-2', { notified_at: new Date(Date.now() - 10 * 60_000).toISOString() });
		const row = await until(async () => {
			const r = await rowOf('real-2');
			return r?.status === 'unacknowledged' ? r : null;
		}, 170_000, 'the real timer to close the alert');
		const sends = await sendsSince(mark);
		assert.count(sends, 2, 'the page and ONE final message');
		assert.match(sends[1].content?.text ?? '', /^Nobody acknowledged Sample service/, 'the final text');
		assert.equal(row.status, 'unacknowledged', 'closed');
		await t.sleep(70_000);
		assert.count(await sendsSince(mark), 2, 'a minute later nothing more was sent');
	});

	await t.step('5 alert 3: a resolved request closes it and sends the resolved message', async () => {
		const mark = await real.guard.mark();
		await call(body('real-3'));
		await until(async () => (await rowOf('real-3'))?.message_id, 90_000, 'the page');
		await call(body('real-3', { status: 'resolved' }));
		await until(async () => (await rowOf('real-3'))?.status === 'resolved', 90_000, 'the alert to close');
		const sends = await until(async () => {
			const s = await sendsSince(mark);
			return s.length >= 2 ? s : null;
		}, 60_000, 'the resolved message');
		assert.match(sends[1].content?.text ?? '', /^Resolved: Sample service/, 'the resolved text');
	});

	await t.step('6 accounting', async () => {
		const total = real.guard.messagesAccepted + person.count;
		t.note('messages', { byWorkflow: real.guard.messagesAccepted, byPerson: person.count, total });
		assert.ok(total <= real.maxSends, `inside the budget (${total} of ${real.maxSends})`);
		assert.equal(real.guard.blocked, 0, 'the guard blocked nothing: the workflow never tried another number');
	});
}

export async function cleanup(t) {
	try {
		await t.deactivate();
	} catch {
		// already inactive
	}
	try {
		const tables = await t.n8n.dataTables();
		const table = tables.find((x) => x.name === 'oncall_alerts');
		if (table) await t.n8n.rest('DELETE', `/rest/projects/${t.n8n.projectId}/data-tables/${table.id}`);
		t.note('dataTablesDeleted', true);
	} catch (error) {
		t.note('dataTablesDeleted', `failed: ${error.message}`);
	}
}
