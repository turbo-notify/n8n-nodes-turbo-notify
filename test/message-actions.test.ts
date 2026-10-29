import type { IDataObject } from 'n8n-workflow';
import { ACCEPTED, API, CT, GRP, MSG, body, makeExecuteContext, node, run } from './helpers';

const ON_MESSAGE: IDataObject = { resource: 'message', number: 'main', messageId: MSG };
const path = (suffix = '') => `${API}/numbers/main/messages/${MSG}${suffix}`;

describe('actions on one message', () => {
	it('reply posts the text to the reply route', async () => {
		const { call, json } = await run({
			...ON_MESSAGE,
			operation: 'reply',
			text: 'On my way',
			options: { idempotencyKey: 'r-1' },
		});
		expect(call).toMatchObject({
			method: 'POST',
			url: path('/reply'),
			body: { content: { text: 'On my way' } },
		});
		expect((call.headers as IDataObject)['Idempotency-Key']).toBe('r-1');
		expect(json).toMatchObject({ id: MSG, number_alias: 'main' });
	});

	it('react sends the emoji, and an empty one removes the reaction', async () => {
		expect(
			body((await run({ ...ON_MESSAGE, operation: 'react', reaction: '\u{1F44D}' })).call),
		).toEqual({ reaction: '\u{1F44D}' });
		expect(body((await run({ ...ON_MESSAGE, operation: 'react', reaction: '' })).call)).toEqual({
			reaction: null,
		});
	});

	it('editText and editCaption post the new value to the edit route', async () => {
		const text = await run({ ...ON_MESSAGE, operation: 'editText', text: 'Corrected text' });
		const caption = await run({ ...ON_MESSAGE, operation: 'editCaption', caption: 'New caption' });
		expect(text.call).toMatchObject({ url: path('/edit'), body: { text: 'Corrected text' } });
		expect(caption.call).toMatchObject({ url: path('/edit'), body: { caption: 'New caption' } });
	});

	it('delete posts without a body and reports deleted: true, meaning accepted', async () => {
		const { call, json } = await run({ ...ON_MESSAGE, operation: 'delete' });
		expect(call).toMatchObject({ method: 'POST', url: path('/delete') });
		expect(call.body).toBeUndefined();
		expect(json).toEqual({ id: MSG, status: ACCEPTED.status, number_alias: 'main', deleted: true });
	});

	it('getStatus reads the status route', async () => {
		const { call, json } = await run({ ...ON_MESSAGE, operation: 'getStatus' });
		expect(call).toMatchObject({ method: 'GET', url: path('/status') });
		expect(json).toEqual({ id: MSG, status: ACCEPTED.status, number_alias: 'main' });
	});

	it('get reads the message, simplified by default with its text', async () => {
		const record = {
			id: MSG,
			number_id: 'num_1',
			direction: 'inbound',
			content_type: 'text',
			text: 'Full text',
			preview: 'Full',
			at: 't',
			from: {},
			to: {},
			status: {},
			content_expired: false,
			channel: 'x',
		};
		const simple = await run({ ...ON_MESSAGE, operation: 'get' }, { responses: [record] });
		const full = await run(
			{ ...ON_MESSAGE, operation: 'get', simplify: false },
			{ responses: [record] },
		);
		expect(simple.call).toMatchObject({ method: 'GET', url: path() });
		expect(simple.json).toMatchObject({ text: 'Full text', content_expired: false });
		expect(simple.json).not.toHaveProperty('channel');
		expect(full.json).toEqual(record);
	});

	it('getQuota reads the number quota', async () => {
		const { call, json } = await run(
			{ resource: 'message', operation: 'getQuota', number: 'main' },
			{ responses: [{ used: 3, limit: 1800 }] },
		);
		expect(call).toMatchObject({ method: 'GET', url: `${API}/numbers/main/messages/quota` });
		expect(json).toEqual({ used: 3, limit: 1800, number_alias: 'main' });
	});

	it.each(['reply', 'react', 'editText', 'editCaption', 'delete', 'getStatus', 'get'])(
		'%s refuses a malformed message ID, naming the field',
		async (operation) => {
			const { context, request } = makeExecuteContext({
				params: { ...ON_MESSAGE, operation, messageId: 'nope', text: 'x', caption: 'x' },
			});
			await expect(node.execute.call(context)).rejects.toThrow(/'Message ID' is not a valid ID/);
			expect(request).not.toHaveBeenCalled();
		},
	);

	it('explains that an event ID is not a message ID', async () => {
		const { context } = makeExecuteContext({
			params: {
				...ON_MESSAGE,
				operation: 'getStatus',
				messageId: 'evt_0198d3c5a1b24d3e9f01a2b3c4d5e6f7',
			},
		});
		await expect(node.execute.call(context)).rejects.toMatchObject({
			message: expect.stringMatching(/event ID/),
			description: expect.stringMatching(/data\.id/),
		});
	});
});

describe('Message > Get Many', () => {
	const list = (rows: IDataObject[], more = false) => ({
		data: rows,
		has_more: more,
		cursor: more ? 'cur_1' : null,
	});
	const row = (n: number) => ({
		id: `msg_${n}`,
		number_id: 'num_1',
		number_alias: 'main',
		direction: 'inbound',
		content_type: 'text',
		preview: `p${n}`,
		at: 't',
		from: {},
		to: {},
		status: {},
		extra: n,
	});

	it('sends the filters as query parameters, picked from a list or typed', async () => {
		const { call } = await run(
			{
				resource: 'message',
				operation: 'getMany',
				number: 'main',
				returnAll: false,
				limit: 25,
				filters: {
					direction: 'inbound',
					groupId: GRP,
					contactId: { __rl: true, mode: 'list', value: CT },
				},
			},
			{ responses: [list([])] },
		);
		expect(call).toMatchObject({
			method: 'GET',
			url: `${API}/numbers/main/messages`,
			qs: { limit: 25, direction: 'inbound', group_id: GRP, contact_id: CT },
		});
	});

	it('Return All follows the cursor, Limit asks for what is left and stops', async () => {
		const all = await run(
			{
				resource: 'message',
				operation: 'getMany',
				number: 'main',
				returnAll: true,
				simplify: false,
			},
			{ responses: [list([row(1), row(2)], true), list([row(3)])] },
		);
		expect(all.calls[1]?.qs).toMatchObject({ cursor: 'cur_1', limit: 200 });
		expect(all.result[0]).toHaveLength(3);
		const limited = await run(
			{ resource: 'message', operation: 'getMany', number: 'main', returnAll: false, limit: 3 },
			{ responses: [list([row(1), row(2)], true), list([row(3), row(4)], true)] },
		);
		expect(limited.calls[1]?.qs).toMatchObject({ limit: 1 });
		expect(limited.result[0]).toHaveLength(3);
	});

	it('Simplify keeps the main fields; off keeps everything', async () => {
		const simple = await run(
			{ resource: 'message', operation: 'getMany', number: 'main', returnAll: false, limit: 1 },
			{ responses: [list([row(1)])] },
		);
		const raw = await run(
			{
				resource: 'message',
				operation: 'getMany',
				number: 'main',
				returnAll: false,
				limit: 1,
				simplify: false,
			},
			{ responses: [list([row(1)])] },
		);
		expect(simple.json).not.toHaveProperty('extra');
		expect(raw.json).toHaveProperty('extra');
	});

	it.each([
		['groupId', 'x', /'Group' is not a valid ID/],
		['contactId', 'x', /'Contact' is not a valid ID/],
		['groupId', '', /'Group' is empty/],
	])('refuses a %s filter of %j', async (key, value, pattern) => {
		const { context, request } = makeExecuteContext({
			params: {
				resource: 'message',
				operation: 'getMany',
				number: 'main',
				returnAll: false,
				limit: 5,
				filters: { [key]: value },
			},
		});
		await expect(node.execute.call(context)).rejects.toThrow(pattern);
		expect(request).not.toHaveBeenCalled();
	});

	it('refuses a Limit that is not a whole number of 1 or more', async () => {
		const { context } = makeExecuteContext({
			params: {
				resource: 'message',
				operation: 'getMany',
				number: 'main',
				returnAll: false,
				limit: 0,
			},
		});
		await expect(node.execute.call(context)).rejects.toThrow(/'Limit'/);
	});
});
