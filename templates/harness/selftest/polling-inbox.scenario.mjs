/**
 * The polling trigger. n8n polls at most once a minute, so this scenario takes one to two minutes.
 * The first poll runs when the workflow is activated and only records what is already there.
 */
export const timeoutMs = 6 * 60_000;

export default async function scenario(t) {
	const { assert } = t;
	// History that exists before activation must never start the workflow.
	await t.mock.injectMessage({ from: '+5511977770006', name: 'Old', text: 'before activation' });
	await t.activate();
	const mark = await t.executionMark();
	const fresh = await t.mock.injectMessage({ from: '+5511977770007', name: 'New', text: 'after activation' });

	const executions = await t.step('one tick of the poller starts one execution for the new message only', () =>
		t.waitExecutions({ since: mark, timeoutMs: 150_000 }),
	);
	assert.count(executions, 1, 'exactly one execution');
	assert.equal(executions[0].status, 'success', executions[0].describe());
	assert.equal(executions[0].first('Keep the message id').seen_message, fresh.message_id, 'the new message, not the old one');

	await t.step('the events requests used the filters of the node', async () => {
		const calls = await t.mock.requests({ method: 'GET', path: '/v1/events' });
		assert.ok(calls.length >= 2, 'baseline plus at least one poll');
		assert.includes(calls.at(-1).query['types[]'], 'message.received', 'type filter sent as types[]');
		assert.ok('created[gte]' in calls.at(-1).query, 'time window sent as created[gte]');
	});
}
