import type { IDataObject } from 'n8n-workflow';
import { TurboNotify } from '../nodes/TurboNotify/TurboNotify.node';
import { API, CT, GRP, makeExecuteContext } from './helpers';

const node = new TurboNotify();

async function run(params: IDataObject, responses: unknown[]) {
	const { context, request } = makeExecuteContext({ params: { number: 'main', ...params }, responses });
	const result = await node.execute.call(context);
	return { result, calls: request.mock.calls.map((c) => c[1] as IDataObject) };
}

const contact = {
	id: CT,
	number_alias: 'main',
	phone_number: '5511977770001',
	name: 'Carlos Lima',
	is_self: false,
	first_messaged_at: '2026-10-01T10:00:00Z',
	last_interaction_at: '2026-10-28T10:00:00Z',
	verified_on_whatsapp_at: null,
	picture: null,
	refresh: null,
	created_at: '2026-10-01T10:00:00Z',
	updated_at: '2026-10-28T10:00:00Z',
};
const group = {
	id: GRP,
	number_alias: 'main',
	name: 'Team',
	description: 'Daily',
	participants_count: 12,
	is_announce_only: false,
	is_locked: false,
	ephemeral_seconds: 0,
	is_active: true,
	picture: null,
	created_at: '2026-10-01T10:00:00Z',
	updated_at: '2026-10-28T10:00:00Z',
};

describe('Contact', () => {
	it('get reads one contact', async () => {
		const { calls, result } = await run({ resource: 'contact', operation: 'get', contactId: CT }, [contact]);
		expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/numbers/main/contacts/${CT}` });
		expect(result[0]?.[0]?.json).toEqual(contact);
	});

	it('get rejects a malformed id naming the field', async () => {
		const { context } = makeExecuteContext({ params: { resource: 'contact', operation: 'get', number: 'main', contactId: 'x' } });
		await expect(node.execute.call(context)).rejects.toThrow(/'Contact ID'/);
	});

	it('getMany sends filters as query parameters', async () => {
		const { calls } = await run(
			{
				resource: 'contact',
				operation: 'getMany',
				returnAll: false,
				limit: 25,
				simplify: false,
				filters: { name: 'Carlos', phone: '+5511977770001', source: 'inbound', contactedInCycle: true },
			},
			[{ data: [contact], cursor: null, has_more: false }],
		);
		expect(calls[0]).toMatchObject({
			method: 'GET',
			url: `${API}/numbers/main/contacts`,
			qs: { limit: 25, name: 'Carlos', phone: '+5511977770001', source: 'inbound', contacted_in_cycle: true },
		});
	});

	it('getMany Simplify returns at most 10 fields and flattens nothing it cannot', async () => {
		const { result } = await run(
			{ resource: 'contact', operation: 'getMany', returnAll: true, simplify: true },
			[{ data: [contact], cursor: null, has_more: false }],
		);
		const item = result[0]?.[0]?.json as IDataObject;
		expect(Object.keys(item).length).toBeLessThanOrEqual(10);
		expect(item).toMatchObject({ id: CT, name: 'Carlos Lima', phone_number: '5511977770001' });
	});

	it('getMany Return All pages with the cursor', async () => {
		const { calls, result } = await run(
			{ resource: 'contact', operation: 'getMany', returnAll: true, simplify: false },
			[
				{ data: [contact, contact], cursor: 'abc', has_more: true },
				{ data: [contact], cursor: null, has_more: false },
			],
		);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.qs).toEqual({ limit: 200, cursor: 'abc' });
		expect(result[0]).toHaveLength(3);
	});
});

describe('Group', () => {
	it('get reads one group', async () => {
		const { calls } = await run({ resource: 'group', operation: 'get', groupId: GRP }, [group]);
		expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/numbers/main/groups/${GRP}` });
	});

	it('get rejects a malformed id naming the field', async () => {
		const { context } = makeExecuteContext({ params: { resource: 'group', operation: 'get', number: 'main', groupId: 'g' } });
		await expect(node.execute.call(context)).rejects.toThrow(/'Group ID'/);
	});

	it('getMany sends name and include_left', async () => {
		const { calls, result } = await run(
			{
				resource: 'group',
				operation: 'getMany',
				returnAll: false,
				limit: 10,
				simplify: true,
				filters: { name: 'Team', includeLeft: true },
			},
			[{ data: [group], cursor: null, has_more: false }],
		);
		expect(calls[0]).toMatchObject({
			url: `${API}/numbers/main/groups`,
			qs: { limit: 10, name: 'Team', include_left: true },
		});
		expect(Object.keys(result[0]?.[0]?.json as IDataObject).length).toBeLessThanOrEqual(10);
	});
});

describe('Number', () => {
	const numbers = {
		data: [
			{ id: 'num_0a1b2c3d4e5f60718293a4b5c6d7e8f9', type: 'main', alias: 'main', number: '5511977770001', status: 'connected' },
			{ id: 'num_1a1b2c3d4e5f60718293a4b5c6d7e8f9', type: 'extra', alias: 'vendas-sp', number: '5511977770009', status: 'connected' },
		],
		cursor: null,
		has_more: false,
	};

	it('getMany returns one item per number and sends the status filter', async () => {
		const { calls, result } = await run(
			{ resource: 'number', operation: 'getMany', filters: { status: 'connected' } },
			[numbers],
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/numbers`, qs: { status: 'connected' } });
		expect(result[0]).toHaveLength(2);
	});

	it('getMany without filters sends no query string keys', async () => {
		const { calls } = await run({ resource: 'number', operation: 'getMany' }, [numbers]);
		expect(calls[0]?.qs).toBeUndefined();
	});
});

describe('Number list for the Number selector', () => {
	it('lists the numbers as options with the alias as value', async () => {
		const request = jest.fn().mockResolvedValue({
			data: [
				{ type: 'main', alias: 'main', number: '5511977770001', name: null },
				{ type: 'extra', alias: 'vendas-sp', number: '5511977770009', name: 'Sales' },
			],
		});
		const context = {
			getCredentials: async () => ({ apiKey: 'k', baseUrl: 'https://api.turbonotify.com' }),
			helpers: { httpRequestWithAuthentication: request },
		};
		const result = await node.methods.listSearch.searchNumbers.call(context as never);
		expect(result.results).toEqual([
			{ name: 'main (+5511977770001)', value: 'main' },
			{ name: 'Sales: vendas-sp (+5511977770009)', value: 'vendas-sp' },
		]);
	});
});
