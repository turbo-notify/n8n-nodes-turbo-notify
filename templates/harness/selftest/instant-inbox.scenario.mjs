/**
 * The instant trigger with signature checking, a data table and an idempotent reply.
 * Shows: declaring data tables, activating, signed webhooks from the mock, duplicate and forged deliveries.
 */
export const tables = [
	{
		name: 'inbox',
		columns: [
			{ name: 'sender', type: 'string' },
			{ name: 'body', type: 'string' },
			{ name: 'message_id', type: 'string' },
		],
	},
];

export default async function scenario(t) {
	const { assert } = t;
	await t.activate();
	await t.webhookTargetFor('Incoming message', { events: ['message.received', 'contact.created'] });
	const sendsMark = await t.mock.mark();
	const execMark = await t.executionMark();

	const injected = await t.step('a contact writes to the number', () =>
		t.mock.injectMessage({ from: '+5511977770004', name: 'Bia Costa', text: 'Hello, I need help' }),
	);

	const [execution] = await t.step('the instant trigger starts one execution', () => t.waitExecutions({ since: execMark, timeoutMs: 30_000 }));
	assert.equal(execution.status, 'success', execution.describe());
	assert.equal(execution.first('Incoming message').data.id, injected.message_id, 'trigger carries the message event');
	assert.equal(execution.first('Read the message').text, 'Hello, I need help', 'full text read from the API');

	await t.step('the row is in the data table and the reply went out once', async () => {
		const rows = await t.tables.rows('inbox');
		assert.count(rows, 1, 'one row');
		assert.subset(rows[0], { sender: '5511977770004', body: 'Hello, I need help', message_id: injected.message_id }, 'row');
		const sends = await t.mock.sends({ since: sendsMark });
		assert.count(sends, 1, 'one reply');
		assert.equal(sends[0].to, { number: '+5511977770004' }, 'reply goes to the sender');
		assert.equal(sends[0].content, { text: 'Got it: Hello, I need help' }, 'reply text');
		assert.equal(sends[0].idempotencyKey, `reply-${injected.message_id}`, 'typed idempotency key');
	});

	await t.step('the same event delivered twice starts nothing new', async () => {
		const mark = await t.executionMark();
		await t.mock.redeliver({ event_id: injected.event_id });
		await t.expectNoExecutions({ since: mark, ms: 4000 });
		const last = (await t.mock.deliveries()).at(-1);
		assert.equal(last.status, 200, 'the duplicate is answered 200 and ignored');
	});

	await t.step('a forged delivery is refused with 401 and starts nothing', async () => {
		const mark = await t.executionMark();
		await t.mock.redeliver({ event_id: injected.event_id, tamper: 'signature' });
		await t.expectNoExecutions({ since: mark, ms: 3000 });
		const last = (await t.mock.deliveries()).at(-1);
		assert.equal(last.status, 401, 'bad signature');
	});

	await t.step('the data table helpers seed, change, delete and clear rows', async () => {
		await t.tables.insert('inbox', [
			{ sender: '5511977770090', body: 'seed one', message_id: 'm-1' },
			{ sender: '5511977770091', body: 'seed two', message_id: 'm-2' },
		]);
		assert.count(await t.tables.rows('inbox'), 3, 'one from the workflow plus two seeded');
		await t.tables.update('inbox', { message_id: 'm-1' }, { body: 'changed' });
		assert.equal((await t.tables.rows('inbox', { where: { message_id: 'm-1' } }))[0].body, 'changed', 'update by column');
		await t.tables.remove('inbox', { message_id: 'm-2' });
		assert.count(await t.tables.rows('inbox'), 2, 'delete by column');
		await t.tables.clear('inbox');
		assert.count(await t.tables.rows('inbox'), 0, 'clear');
	});
}
