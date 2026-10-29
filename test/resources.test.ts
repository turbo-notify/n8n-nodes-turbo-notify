import type { IDataObject } from 'n8n-workflow';
import { API, CT, GRP, makeExecuteContext, node, run } from './helpers';

const page = (rows: IDataObject[], more = false) => ({
	data: rows,
	has_more: more,
	cursor: more ? 'cur_1' : null,
});

const contact = {
	id: CT,
	number_alias: 'main',
	phone_number: '5511977770001',
	name: 'Carlos Lima',
	is_self: false,
	first_messaged_at: 't',
	last_interaction_at: 't',
	picture: null,
	created_at: 't',
};
const group = {
	id: GRP,
	number_alias: 'main',
	name: 'Team',
	description: 'Daily',
	participants_count: 12,
	is_announce_only: false,
	is_active: true,
	picture: null,
	created_at: 't',
};

describe('Contact', () => {
	it('get reads one contact, picked from a list or typed, simplified by default', async () => {
		const { call, json } = await run(
			{ resource: 'contact', operation: 'get', number: 'main', contactId: CT },
			{ responses: [contact] },
		);
		expect(call).toMatchObject({ method: 'GET', url: `${API}/numbers/main/contacts/${CT}` });
		expect(json).not.toHaveProperty('picture');
		const raw = await run(
			{ resource: 'contact', operation: 'get', number: 'main', contactId: CT, simplify: false },
			{ responses: [contact] },
		);
		expect(raw.json).toEqual(contact);
	});

	it('get refuses a malformed or empty ID naming the field', async () => {
		for (const [value, pattern] of [
			['x', /'Contact' is not a valid ID/],
			['', /'Contact' is empty/],
		] as const) {
			const { context } = makeExecuteContext({
				params: { resource: 'contact', operation: 'get', number: 'main', contactId: value },
			});
			await expect(node.execute.call(context)).rejects.toThrow(pattern);
		}
	});

	it('getMany sends the filters as query parameters', async () => {
		const { call } = await run(
			{
				resource: 'contact',
				operation: 'getMany',
				number: 'main',
				returnAll: false,
				limit: 25,
				filters: {
					name: 'Carlos',
					phone: '+5511977770001',
					source: 'inbound',
					contactedInCycle: false,
				},
			},
			{ responses: [page([contact])] },
		);
		expect(call).toMatchObject({
			url: `${API}/numbers/main/contacts`,
			qs: {
				limit: 25,
				name: 'Carlos',
				phone: '+5511977770001',
				source: 'inbound',
				contacted_in_cycle: false,
			},
		});
	});

	it('getMany refuses a filter that was added and left empty', async () => {
		const { context, request } = makeExecuteContext({
			params: {
				resource: 'contact',
				operation: 'getMany',
				number: 'main',
				returnAll: false,
				limit: 5,
				filters: { name: '  ' },
			},
		});
		await expect(node.execute.call(context)).rejects.toThrow(/The 'Name' filter is empty/);
		expect(request).not.toHaveBeenCalled();
	});
});

describe('Group', () => {
	it('get reads one group', async () => {
		const { call } = await run(
			{ resource: 'group', operation: 'get', number: 'main', groupId: GRP },
			{ responses: [group] },
		);
		expect(call).toMatchObject({ method: 'GET', url: `${API}/numbers/main/groups/${GRP}` });
	});

	it('get refuses a malformed ID naming the field', async () => {
		const { context } = makeExecuteContext({
			params: { resource: 'group', operation: 'get', number: 'main', groupId: 'x' },
		});
		await expect(node.execute.call(context)).rejects.toThrow(/'Group' is not a valid ID/);
	});

	it('getMany can include the groups the number left', async () => {
		const { call } = await run(
			{
				resource: 'group',
				operation: 'getMany',
				number: 'main',
				returnAll: true,
				filters: { includeLeft: true, name: 'Team' },
			},
			{ responses: [page([group])] },
		);
		expect(call.qs).toMatchObject({ include_left: true, name: 'Team' });
	});
});

describe('Number', () => {
	const numbers = [{ id: 'num_1', alias: 'main', type: 'main', status: { status: 'connected' } }];

	it('getMany lists the numbers, filtered by status', async () => {
		const { call, result } = await run(
			{ resource: 'number', operation: 'getMany', filters: { status: 'disconnected' } },
			{ responses: [{ data: numbers, cursor: null }] },
		);
		expect(call).toMatchObject({
			method: 'GET',
			url: `${API}/numbers`,
			qs: { status: 'disconnected' },
		});
		expect(result[0]).toHaveLength(1);
	});

	it('get reads one number by alias or ID', async () => {
		const { call, json } = await run(
			{ resource: 'number', operation: 'get', number: 'sales-sp' },
			{ responses: [numbers[0]] },
		);
		expect(call).toMatchObject({ method: 'GET', url: `${API}/numbers/sales-sp` });
		expect(json).toEqual(numbers[0]);
	});
});

describe('Event', () => {
	const event = (n: number) => ({
		id: `evt_${n}`,
		type: 'message.received',
		created_at: `2026-10-28T10:00:0${n}Z`,
		data: {},
	});

	it('getMany sends the filters and returns one item per event', async () => {
		const { call, result } = await run(
			{
				resource: 'event',
				operation: 'getMany',
				returnAll: false,
				limit: 2,
				filters: {
					types: ['message.received', 'message.read'],
					number: { __rl: true, mode: 'id', value: 'num_0a1b2c3d4e5f60718293a4b5c6d7e8f9' },
					createdAfter: '2026-10-28T09:00:00Z',
					createdBefore: '2026-10-28T11:00:00-03:00',
				},
			},
			{ responses: [{ data: [event(2), event(1)], has_more: true }] },
		);
		expect(call).toMatchObject({
			method: 'GET',
			url: `${API}/events`,
			qs: {
				limit: 2,
				types: ['message.received', 'message.read'],
				number_id: 'num_0a1b2c3d4e5f60718293a4b5c6d7e8f9',
				'created[gte]': '2026-10-28T09:00:00.000Z',
				'created[lte]': '2026-10-28T14:00:00.000Z',
			},
		});
		expect(result[0]).toHaveLength(2);
	});

	it('reads the event types from an expression: a list, text with commas, or Any Event', async () => {
		const typesFor = async (types: unknown) =>
			(
				await run(
					{
						resource: 'event',
						operation: 'getMany',
						returnAll: false,
						limit: 5,
						filters: { types } as IDataObject,
					},
					{ responses: [{ data: [], has_more: false }] },
				)
			).call.qs;
		expect(await typesFor(['message.received'])).toMatchObject({ types: ['message.received'] });
		expect(await typesFor('message.received, message.sent')).toMatchObject({
			types: ['message.received', 'message.sent'],
		});
		expect(await typesFor('message.received')).toMatchObject({ types: ['message.received'] });
		expect(await typesFor(['*', 'message.read'])).not.toHaveProperty('types');
		expect(await typesFor('')).not.toHaveProperty('types');
	});

	it('Return All pages by the ID of the last event', async () => {
		const { calls } = await run(
			{ resource: 'event', operation: 'getMany', returnAll: true },
			{
				responses: [
					{ data: [event(2)], has_more: true },
					{ data: [event(1)], has_more: false },
				],
			},
		);
		expect(calls[1]?.qs).toMatchObject({ starting_after: 'evt_2', limit: 100 });
	});

	it('refuses more than 20 types and a Number filter left empty', async () => {
		const types = Array.from({ length: 21 }, (_, i) => `message.x${i}`);
		const tooMany = makeExecuteContext({
			params: {
				resource: 'event',
				operation: 'getMany',
				returnAll: false,
				limit: 5,
				filters: { types },
			},
		});
		await expect(node.execute.call(tooMany.context)).rejects.toThrow(/up to 20 types/);
		const empty = makeExecuteContext({
			params: {
				resource: 'event',
				operation: 'getMany',
				returnAll: false,
				limit: 5,
				filters: { number: { __rl: true, mode: 'list', value: '' } },
			},
		});
		await expect(node.execute.call(empty.context)).rejects.toThrow(/'Number' filter is empty/);
	});
});
