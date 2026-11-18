/**
 * The smallest complete scenario: run the workflow once and check what the mock saw.
 * A scenario module exports a default async function that receives `t`, the test context.
 */
// Sent after 0.5 s, delivered after 1 s, read only after 30 s: after the 3 second Wait the state is
// "delivered" however slow the machine is. The scenario forces "read" later instead of waiting for it.
export const mock = { delays: '500,1000,30000' };

export default async function scenario(t) {
	const { assert } = t;
	const mark = await t.mock.mark(); // only look at the requests made from here on

	const execution = await t.step('run the workflow from its manual trigger', () => t.run('When clicking Test workflow'));
	assert.equal(execution.status, 'success', execution.describe());
	assert.equal(execution.nodesRun, ['When clicking Test workflow', 'Send the text', 'Wait 3 seconds', 'Get the status'], 'nodes ran in order');

	await t.step('the send reached the API exactly as configured', async () => {
		const sends = await t.mock.sends({ since: mark });
		assert.count(sends, 1, 'one message was sent');
		assert.equal(sends[0].to, { number: '+5511977770001' }, 'recipient');
		assert.equal(sends[0].content, { text: 'Harness selftest: your order is on its way.' }, 'content');
		assert.equal(sends[0].idempotencyKey, 'selftest-order-1', 'Idempotency-Key header');
		assert.match(sends[0].messageId, /^msg_[0-9a-f]{32}$/, 'message id format');
	});

	await t.step('the node output carries id, number and status', async () => {
		const sent = execution.first('Send the text');
		assert.match(sent.id, /^msg_[0-9a-f]{32}$/, 'id');
		assert.equal(sent.number_alias, 'main', 'number_alias');
		const status = execution.first('Get the status');
		// The node renames the API's message_id to id on every message step.
		assert.equal(status.id, sent.id, 'status is for the message that was sent');
		// 3 s after the send the mock has delivered the message but not read it yet.
		assert.equal(status.status.state, 'delivered', 'state after 3 seconds');
	});

	await t.step('the lifecycle reaches read and fills the events feed', async () => {
		const id = execution.first('Send the text').id;
		await t.mock.messageState({ message_id: id, state: 'read' });
		const events = (await t.mock.events()).filter((e) => e.data.id === id).map((e) => e.type);
		assert.equal(events, ['message.sent', 'message.delivered', 'message.read'], 'events in order');
		const requests = await t.mock.requests({ since: mark });
		assert.ok(requests.every((r) => r.headers.authorization?.startsWith('Bearer tn_t')), 'every request carried the bearer key');
	});
}
