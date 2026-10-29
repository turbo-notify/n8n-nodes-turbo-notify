import type { IDataObject } from 'n8n-workflow';
import { ACCEPTED, MESSAGE, makeExecuteContext, node, run } from './helpers';

const TEXT: IDataObject = { ...MESSAGE, operation: 'sendText', text: 'Hi' };
const key = (call: IDataObject | undefined) =>
	(call?.headers as IDataObject | undefined)?.['Idempotency-Key'];

describe('the automatic key', () => {
	it('is the same when n8n repeats an item and different for every item', async () => {
		const { calls } = await run(
			[
				{ ...TEXT, text: 'a' },
				{ ...TEXT, text: 'b' },
			],
			{
				mode: 'trigger',
				executionId: '812',
				runIndex: 2,
				items: [{ json: {} }, { json: {} }],
				responses: [ACCEPTED, ACCEPTED],
			},
		);
		expect(calls.map(key)).toEqual([
			'n8n-abcdef012345-812-node-1-2-0',
			'n8n-abcdef012345-812-node-1-2-1',
		]);
	});

	it('is left out when you click Test step, so a test click always sends', async () => {
		expect(key((await run(TEXT, { mode: 'manual', executionId: '9' })).call)).toBeUndefined();
	});

	it('gives way to a key you typed', async () => {
		const { call } = await run(
			{ ...TEXT, options: { idempotencyKey: 'order-1' } },
			{ mode: 'trigger', executionId: '9' },
		);
		expect(key(call)).toBe('order-1');
	});

	it('also protects Reply', async () => {
		const { call } = await run(
			{
				resource: 'message',
				operation: 'reply',
				number: 'main',
				messageId: 'msg_0198d3c5a1b24d3e9f01a2b3c4d5e6f7',
				text: 'Hi',
			},
			{ mode: 'trigger', executionId: '9' },
		);
		expect(key(call)).toMatch(/^n8n-/);
	});
});

describe('a key you type', () => {
	const two = (a: IDataObject, b: IDataObject) =>
		makeExecuteContext({
			params: [
				{ ...TEXT, ...a },
				{ ...TEXT, ...b },
			],
			items: [{ json: {} }, { json: {} }],
			responses: [ACCEPTED, ACCEPTED],
		});
	const typed = { options: { idempotencyKey: 'k1' } };

	it('may repeat for the same message', async () => {
		await expect(node.execute.call(two(typed, typed).context)).resolves.toBeDefined();
	});

	it('is refused when it stands for two different messages (the API would send only the first)', async () => {
		await expect(
			node.execute.call(
				two(
					{ ...typed, phoneNumber: '+5511977770001' },
					{ ...typed, phoneNumber: '+5511977770002' },
				).context,
			),
		).rejects.toThrow(/already used by another message/);
		await expect(node.execute.call(two(typed, { ...typed, text: 'b' }).context)).rejects.toThrow(
			/already used by another message/,
		);
	});

	it('must be plain text of 1 to 255 characters', async () => {
		await expect(run({ ...TEXT, options: { idempotencyKey: 'pedido-é' } })).rejects.toThrow(
			/plain letters/,
		);
		await expect(run({ ...TEXT, options: { idempotencyKey: 'k'.repeat(256) } })).rejects.toThrow(
			/1 to 255 characters/,
		);
	});
});
