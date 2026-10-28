import type { IDataObject } from 'n8n-workflow';
import { TurboNotify } from '../nodes/TurboNotify/TurboNotify.node';
import { ACCEPTED, API, CT, GRP, MSG, PHONE, makeExecuteContext } from './helpers';

const node = new TurboNotify();

async function run(params: IDataObject, responses: unknown[] = [ACCEPTED]) {
	const { context, request } = makeExecuteContext({
		params: { resource: 'message', number: 'main', messageId: MSG, ...params },
		responses,
	});
	const result = await node.execute.call(context);
	return { result, request, calls: request.mock.calls.map((c) => c[1] as IDataObject) };
}

describe('Message actions', () => {
	it('reply posts content.text to the reply route', async () => {
		const { calls } = await run({ operation: 'reply', text: 'On my way', options: { idempotencyKey: 'r-1' } });
		expect(calls[0]).toMatchObject({
			method: 'POST',
			url: `${API}/numbers/main/messages/${MSG}/reply`,
			body: { content: { text: 'On my way' } },
		});
		expect((calls[0]?.headers as IDataObject)['Idempotency-Key']).toBe('r-1');
	});

	it('react sends the emoji', async () => {
		const { calls } = await run({ operation: 'react', reaction: '\u{1F44D}' }, [
			{ ...ACCEPTED, reaction_event_id: 'op_reaction_a1b2c3d4e5f6' },
		]);
		expect(calls[0]).toMatchObject({
			method: 'POST',
			url: `${API}/numbers/main/messages/${MSG}/react`,
			body: { reaction: '\u{1F44D}' },
		});
	});

	it('react with an empty value removes the reaction (null)', async () => {
		const { calls } = await run({ operation: 'react', reaction: '' });
		expect(calls[0]?.body).toEqual({ reaction: null });
	});

	it('editText posts the new text', async () => {
		const { calls } = await run({ operation: 'editText', text: 'Corrected text' });
		expect(calls[0]).toMatchObject({
			method: 'POST',
			url: `${API}/numbers/main/messages/${MSG}/edit`,
			body: { text: 'Corrected text' },
		});
	});

	it('editCaption posts the new caption', async () => {
		const { calls } = await run({ operation: 'editCaption', caption: 'New caption' });
		expect(calls[0]).toMatchObject({
			url: `${API}/numbers/main/messages/${MSG}/edit`,
			body: { caption: 'New caption' },
		});
	});

	it('delete posts to the delete route without a body', async () => {
		const { calls } = await run({ operation: 'delete' });
		expect(calls[0]).toMatchObject({ method: 'POST', url: `${API}/numbers/main/messages/${MSG}/delete` });
		expect(calls[0]?.body).toBeUndefined();
	});

	it('getStatus reads the status route', async () => {
		const { calls, result } = await run({ operation: 'getStatus' }, [ACCEPTED]);
		expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/numbers/main/messages/${MSG}/status` });
		expect(result[0]?.[0]?.json).toEqual(ACCEPTED);
	});

	it('get reads the message', async () => {
		const { calls } = await run({ operation: 'get' }, [{ id: MSG }]);
		expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/numbers/main/messages/${MSG}` });
	});

	it.each(['reply', 'react', 'editText', 'editCaption', 'delete', 'getStatus', 'get'])(
		'%s rejects a malformed message id naming the field',
		async (operation) => {
			const { context, request } = makeExecuteContext({
				params: { resource: 'message', operation, number: 'main', messageId: 'msg_123', text: 'x', caption: 'x', reaction: 'x' },
			});
			await expect(node.execute.call(context)).rejects.toThrow(/'Message ID'/);
			expect(request).not.toHaveBeenCalled();
		},
	);

	describe('Get Many', () => {
		const page = (ids: string[], cursor: string | null, hasMore: boolean) => ({
			data: ids.map((id) => ({
				id,
				organization_id: 'org_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
				number_alias: 'main',
				number_id: 'num_0a1b2c3d4e5f60718293a4b5c6d7e8f9',
				from: { number: '5511977770001' },
				to: { alias: 'main', number: '5511977770001' },
				direction: 'inbound',
				content_type: 'text',
				channel: 'whatsapp',
				origin: 'native',
				preview: 'Hi',
				content_expired: false,
				at: '2026-10-28T10:00:00Z',
				status: { state: 'delivered' },
			})),
			cursor,
			has_more: hasMore,
		});

		it('with Limit requests only what is left and stops', async () => {
			const { calls, result } = await run(
				{ operation: 'getMany', returnAll: false, limit: 3, simplify: false },
				[page(['msg_1', 'msg_2', 'msg_3', 'msg_4'], 'c1', true)],
			);
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/numbers/main/messages`, qs: { limit: 3 } });
			expect(result[0]).toHaveLength(3);
		});

		it('with Return All follows the cursor across pages', async () => {
			const { calls, result } = await run(
				{ operation: 'getMany', returnAll: true, simplify: false, filters: { direction: 'inbound', groupId: GRP } },
				[page(['msg_1', 'msg_2'], 'c1', true), page(['msg_3'], null, false)],
			);
			expect(calls).toHaveLength(2);
			expect(calls[0]?.qs).toEqual({ limit: 200, direction: 'inbound', group_id: GRP });
			expect(calls[1]?.qs).toEqual({ limit: 200, direction: 'inbound', group_id: GRP, cursor: 'c1' });
			expect(result[0]).toHaveLength(3);
		});

		it('stops when has_more is true but no cursor is returned', async () => {
			const { calls } = await run(
				{ operation: 'getMany', returnAll: true, simplify: false },
				[page(['msg_1'], null, true)],
			);
			expect(calls).toHaveLength(1);
		});

		it('Simplify keeps at most 10 fields', async () => {
			const { result } = await run({ operation: 'getMany', returnAll: false, limit: 5, simplify: true }, [
				page(['msg_1'], null, false),
			]);
			const item = result[0]?.[0]?.json as IDataObject;
			expect(Object.keys(item).length).toBeLessThanOrEqual(10);
			expect(item.id).toBe('msg_1');
			expect(item.preview).toBe('Hi');
		});

		it('rejects a contact filter that is not a contact id', async () => {
			const { context } = makeExecuteContext({
				params: { resource: 'message', operation: 'getMany', number: 'main', returnAll: true, filters: { contactId: PHONE } },
			});
			await expect(node.execute.call(context)).rejects.toThrow(/'Contact ID'/);
		});

		it('rejects a limit below 1', async () => {
			const { context } = makeExecuteContext({
				params: { resource: 'message', operation: 'getMany', number: 'main', returnAll: false, limit: 0 },
			});
			await expect(node.execute.call(context)).rejects.toThrow(/'Limit'/);
		});
	});
});

describe('contact id constant', () => {
	it('is well formed', () => {
		expect(CT).toMatch(/^ct_[0-9a-f]{32}$/);
	});
});
