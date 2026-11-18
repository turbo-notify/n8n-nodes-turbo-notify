/**
 * An AI Agent answered by the fake LLM: the script makes the agent call its tool, then answer.
 * The harness gives the OpenAI Chat Model node a credential that points at the fake server.
 */
export default async function scenario(t) {
	const { assert } = t;
	t.llm.script([
		{ user: /6 times 7/i, toolCalls: [{ name: 'calculator', arguments: { input: '6*7' } }] },
		{ afterTool: /42/, reply: 'The answer is 42.' },
		{ reply: 'Unexpected question.' },
	]);
	const mark = await t.mock.mark();

	const execution = await t.step('run the agent', () => t.run('When clicking Test workflow'));
	assert.equal(execution.status, 'success', execution.describe());
	assert.equal(execution.first('AI Agent').output, 'The answer is 42.', 'agent output');

	await t.step('the model was asked with the system prompt and offered the tool', () => {
		const first = t.llm.requests[0];
		assert.match(first.ctx.system, /harness desk/, 'system prompt reached the model');
		assert.includes(first.ctx.tools, 'Calculator', 'tool offered (named after its node)');
		assert.ok(t.llm.requests.length >= 2, 'a second round carried the tool result');
	});

	await t.step('the answer was sent to the customer', async () => {
		const sends = await t.mock.sends({ since: mark });
		assert.count(sends, 1, 'one send');
		assert.equal(sends[0].to, { number: '+5511977770005' }, 'recipient');
		assert.equal(sends[0].content, { text: 'The answer is 42.' }, 'text');
	});
}
