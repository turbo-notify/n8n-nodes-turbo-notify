/**
 * Second scenario: the workflow exactly as exported, with NOTHING patched, so "Your settings" still holds the
 * placeholder phone numbers. It proves the safe default on the live entry points too: the table can be created, but
 * a real alert (a real HTTP request with the right header), the minute timer and a reply all stop with a clear
 * message, nobody is paged and nothing is stored.
 *
 *   node templates/harness/run-template.mjs templates/oncall-alerts-escalation/workflow.json \
 *     --scenario templates/oncall-alerts-escalation/test/placeholder.mjs --run-id t4 --ports 5695,9231,9232 \
 *     --image n8nio/n8n:2.45.5
 */
export const timeoutMs = 10 * 60_000;
export const credentials = [{ type: 'httpHeaderAuth', name: 'Alert access (Header Auth)', data: { name: 'X-Alert-Token', value: 'harness-alert-token-0001' } }];

const HOOK = 'Receive an alert';
const POLL = 'Poll WhatsApp replies';
const TIMER = 'Every minute: look for unanswered alerts';

export default async function scenario(t) {
	const { assert } = t;
	const mark = await t.mock.mark();
	const placeholders = /oncall_phone_1 is not a real number.*oncall_phone_2 is not a real number.*owner_phone is not a real number/;

	await t.step('the table can be created with the placeholder numbers (it needs none)', async () => {
		const execution = await t.run('Run once: create the table');
		assert.equal(execution.status, 'success', execution.describe());
		assert.count(await t.tables.rows('oncall_alerts'), 0, 'the table is empty');
	});

	await t.step('a manual run of each entry point stops with a message that names every number to change', async () => {
		const alert = await t.run(HOOK, { pin: { [HOOK]: [{ headers: {}, params: {}, query: {}, body: { alert_id: 'ph-1', service: 'db', severity: 'critical', message: 'down' } }] } });
		assert.equal(alert.status, 'error', 'an alert fails loudly');
		assert.match(alert.error?.message ?? '', placeholders, 'and says what to set');
		assert.ok(!alert.ran('Find the alert in the table'), 'the alert was not even looked up');
		const timer = await t.run(TIMER);
		assert.equal(timer.status, 'error', 'the timer fails loudly');
		const injected = await t.mock.injectMessage({ from: '+5511977770021', name: 'Somebody', text: 'OK' });
		const event = (await t.mock.events()).find((e) => e.id === injected.event_id);
		const reply = await t.run(POLL, { pin: { [POLL]: [event] } });
		assert.equal(reply.status, 'error', 'a reply fails loudly');
	});

	await t.step('a real alert over HTTP with the right header is accepted, then fails inside the run: nothing is sent or stored', async () => {
		await t.activate();
		const since = await t.executionMark();
		const res = await t.callWebhook(HOOK, { body: { alert_id: 'ph-2', service: 'web', severity: 'critical', message: 'slow' }, headers: { 'X-Alert-Token': 'harness-alert-token-0001' } });
		assert.equal(res.status, 200, 'the monitoring tool is answered at once');
		await t.waitFor(async () => (await t.n8n.listExecutions(t.workflow.id)).some((e) => Number(e.id) > since && e.mode !== 'manual' && e.status === 'error'), { timeoutMs: 60_000, message: 'the run to fail' });
		const runs = (await t.n8n.listExecutions(t.workflow.id)).filter((e) => Number(e.id) > since && e.mode !== 'manual');
		const failed = await t.execution(runs.find((e) => e.status === 'error').id);
		assert.match(failed.error?.message ?? '', /^Not ready to page anybody: /, 'with the plain message');
		await t.deactivate();
		assert.count(await t.tables.rows('oncall_alerts'), 0, 'nothing is stored');
		assert.count(await t.mock.sends({ since: mark }), 0, 'and nobody was paged');
	});
}
