/**
 * Second real API scenario for the bulk-notices-with-delivery-tracking template: the failure path and the real API's answers to a malformed phone.
 *
 *   export TN_REAL_OWNER_PHONE='+<the owner test number>'
 *   node templates/harness/run-template.mjs templates/bulk-notices-with-delivery-tracking/workflow.json \
 *     --real-api --api-key-file <file with the line "- Value: tn_live_..."> --max-sends 3 \
 *     --scenario templates/bulk-notices-with-delivery-tracking/test/real-failure.mjs --image n8nio/n8n:2.45.5 \
 *     --run-id t2fail --ports 5692,9211
 *
 * At most 3 REAL messages to the owner test number: the owner summary of the failed batch, and the two probes below if
 * the real API accepts them. Everything is deleted for everyone at the end.
 *
 * 1. A text over 4096 characters (the documented limit): the node refuses it before any request (no POST reaches the
 *    API), the row is `failed` with the reason, and the owner summary lists it with one full stop at the end.
 * 2. Probes through the guard of what the REAL API answers to a malformed phone: the owner number with a letter
 *    appended (digits identical, so the guard lets it through, but it cannot be a valid number) and the owner number
 *    without `+`. The node refuses both itself, so only a direct request shows the API's own answer.
 */
export const timeoutMs = 20 * 60_000;
export const credentials = [{ type: 'httpBasicAuth', name: 'Form access (Basic Auth)', data: { user: 'notices-team', password: 'real-run-form-password' } }];
const AUTH = 'Basic ' + Buffer.from('notices-team:real-run-form-password').toString('base64');
const digits = (v) => String(v ?? '').replace(/\D/g, '');

function ownerPhone() {
	const phone = process.env.TN_REAL_OWNER_PHONE;
	if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('set TN_REAL_OWNER_PHONE to the owner test number, with + and the country code');
	return phone;
}
/** The only values changed in Settings (listed in the README): the owner phone, a short pause and a longer text limit. */
function setSettings(nodes, patch) {
	const settings = nodes.find((n) => n.name === 'Settings');
	for (const assignment of settings.parameters.assignments.assignments) {
		if (assignment.name in patch) assignment.value = patch[assignment.name];
	}
}
export async function prepare(workflow) {
	// The form accepts the long text; the node's own limit (4096) is what this scenario exercises.
	setSettings(workflow.nodes, { owner_phone: ownerPhone(), pause_between_batches_seconds: 5, max_message_length: 5000 });
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
	const toOwner = (sends) => sends.filter((s) => digits(s.to?.number) === digits(OWNER));
	const okRun = (execution) => assert.equal(execution.status, 'success', execution.describe());

	/** Submits the production form over HTTP with its Basic Auth header. The workflow is active only for that call. */
	const submit = async (recipient, message, label = '') => {
		assert.equal(digits(recipient), digits(OWNER), 'the line targets the owner test number only');
		await t.activate();
		const since = await t.executionMark();
		const body = new FormData();
		body.set('field-0', `Long Text,${recipient}`);
		body.set('field-1', message);
		body.set('field-2', label);
		const response = await fetch(`${t.urls.n8n}/form/${t.workflow.node('New batch form').parameters.path}`, { method: 'POST', headers: { authorization: AUTH }, body });
		const text = await response.text();
		const execution = (await t.waitExecutions({ since, timeoutMs: 180_000 })).find((e) => e.ran('New batch form')) ?? null;
		await t.deactivate();
		assert.equal(response.status, 200, `the form accepted the submission: ${text.slice(0, 200)}`);
		assert.ok(execution, 'a run started');
		okRun(execution);
		return execution;
	};

	await t.step('0 pre-flight and the table', async () => {
		assert.equal((await real.get('/v1/numbers/main')).status, 'connected', 'the number is connected');
		assert.equal(real.guard.messagesAccepted, 0, 'nothing sent yet');
		okRun(await t.run('Create the notices table (run once)'));
	});

	await t.step('1 a text over 4096 characters: the node refuses it before any request, the row is failed with the reason, the owner summary lists it', async () => {
		const mark = await real.guard.mark();
		await submit(OWNER, 'x'.repeat(4097), 'Failure');
		const row = (await rows()).find((r) => r.label === 'Failure');
		const batch = row.batch_id;
		const posts = (await real.guard.requests({ method: 'POST', since: mark })).filter((r) => /\/messages$/.test(r.path));
		assert.equal(posts.filter((r) => digits(r.body?.to?.number) === digits(OWNER) && String(r.body?.content?.text).length > 4096).length, 0, 'no send of the long text reached the API: the node refused the text itself');
		assert.equal(row.status, 'failed', 'the row is failed');
		assert.equal(row.message_id, '', 'no message id');
		t.note('failedRowError', row.error);
		const report = toOwner(await sendsSince(mark)).find((s) => String(s.content?.text).includes(batch));
		assert.ok(report, 'the failed batch is summarised to the owner in the same run (nothing is left to wait for)');
		t.note('failureSummaryText', String(report.content.text).replace(batch, '<batch>'));
		assert.match(report.content.text, /failed 1/, 'one failure');
		assert.excludes(report.content.text, '..', 'no double full stop');
	});

	await t.step('2 probes through the guard: what the real API answers to a malformed phone', async () => {
		const text = 'Harness probe: please ignore.';
		const malformed = await real.throughGuard('POST', '/v1/messages', { to: { number: `${OWNER}x` }, content: { text } });
		t.note('probeMalformedPhoneLetter', { status: malformed.status, body: malformed.body });
		const noPlus = await real.throughGuard('POST', '/v1/messages', { to: { number: digits(OWNER) }, content: { text } });
		t.note('probePhoneWithoutPlus', { status: noPlus.status, body: noPlus.status < 300 ? { keys: bodyKeys(noPlus.body) } : noPlus.body });
		assert.ok(real.guard.messagesAccepted <= 3, 'inside the budget of 3');
		assert.equal(real.guard.blocked, 0, 'the guard blocked nothing');
	});
}

export async function cleanup(t) {
	try {
		const table = (await t.n8n.dataTables()).find((x) => x.name === 'notices');
		if (table) await t.n8n.rest('DELETE', `/rest/projects/${t.n8n.projectId}/data-tables/${table.id}`);
		t.note('dataTableDeleted', true);
	} catch (error) {
		t.note('dataTableDeleted', `failed: ${error.message}`);
	}
	const results = [];
	for (const id of t.real.guard.acceptedMessageIds()) {
		const r = await t.real.deleteWhenSent(id);
		results.push({ state: r.state, status: r.status, deleted: r.deleted });
	}
	t.note('deleteForEveryone', results);
}
