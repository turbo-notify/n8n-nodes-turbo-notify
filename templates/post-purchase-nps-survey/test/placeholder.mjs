/**
 * Second scenario: the workflow exactly as exported, with NOTHING patched, so "Your settings" still holds the
 * sample owner phone and the sample business name. It proves the safe default on the live entry points too: the
 * table can be created, but a real order (a real HTTP request with the right header), the 30 minute timer, the
 * weekly timer and a reply all stop with a clear message, nobody is asked and nothing is stored.
 *
 *   node templates/harness/run-template.mjs templates/post-purchase-nps-survey/workflow.json \
 *     --scenario templates/post-purchase-nps-survey/test/placeholder.mjs --run-id t6 --ports 5697,9251,9252 \
 *     --image n8nio/n8n:2.45.5 --tz America/Sao_Paulo
 */
export const timeoutMs = 10 * 60_000;
export const credentials = [{ type: 'httpHeaderAuth', name: 'Order access (Header Auth)', data: { name: 'X-Order-Token', value: 'harness-order-token-0001' } }];

const HOOK = 'Receive an order';
const POLL = 'Poll WhatsApp replies';
const TIMER = 'Every 30 minutes: ask the surveys that are due';
const WEEK = 'Every week: send the NPS report';

export default async function scenario(t) {
	const { assert } = t;
	const mark = await t.mock.mark();
	const samples = /owner_phone is not a real number.*business_name is still the sample/;

	await t.step('the table can be created with the sample settings (it needs none)', async () => {
		const execution = await t.run('Run once: create the table');
		assert.equal(execution.status, 'success', execution.describe());
		assert.count(await t.tables.rows('surveys'), 0, 'the table is empty');
	});

	await t.step('a manual run of each entry point stops with a message that names every setting to change', async () => {
		const order = await t.run(HOOK, { pin: { [HOOK]: [{ headers: {}, params: {}, query: {}, body: { order_id: 'ph-1', customer_name: 'Ana', phone: '+5511977770001', status: 'delivered' } }] } });
		assert.equal(order.status, 'error', 'an order fails loudly');
		assert.match(order.error?.message ?? '', samples, 'and says what to set');
		assert.ok(!order.ran('Read the surveys'), 'the table was not even read');
		for (const [name, node] of [['the 30 minute timer', TIMER], ['the weekly report', WEEK]]) {
			const execution = await t.run(node);
			assert.equal(execution.status, 'error', `${name} fails loudly`);
			assert.match(execution.error?.message ?? '', samples, `${name} says what to set`);
		}
		const injected = await t.mock.injectMessage({ from: '+5511977770001', name: 'Somebody', text: '9' });
		const event = (await t.mock.events()).find((e) => e.id === injected.event_id);
		const reply = await t.run(POLL, { pin: { [POLL]: [event] } });
		assert.equal(reply.status, 'error', 'a reply fails loudly');
		assert.match(reply.error?.message ?? '', samples, 'and says what to set');
	});

	await t.step('a real order over HTTP with the right header is accepted, then fails inside the run: nothing is asked or stored', async () => {
		await t.activate();
		const since = await t.executionMark();
		const res = await t.callWebhook(HOOK, { body: { order_id: 'ph-2', customer_name: 'Ana', phone: '+5511977770001', status: 'delivered' }, headers: { 'X-Order-Token': 'harness-order-token-0001' } });
		assert.equal(res.status, 200, 'the shop is answered at once');
		await t.waitFor(async () => (await t.n8n.listExecutions(t.workflow.id)).some((e) => Number(e.id) > since && e.mode !== 'manual' && e.status === 'error'), { timeoutMs: 60_000, message: 'the run to fail' });
		const runs = (await t.n8n.listExecutions(t.workflow.id)).filter((e) => Number(e.id) > since && e.mode !== 'manual');
		const failed = await t.execution(runs.find((e) => e.status === 'error').id);
		assert.match(failed.error?.message ?? '', /^Not ready to survey anybody: /, 'with the plain message');
		await t.deactivate();
		assert.count(await t.tables.rows('surveys'), 0, 'nothing is stored');
		assert.count(await t.mock.sends({ since: mark }), 0, 'and nobody was asked');
	});
}
