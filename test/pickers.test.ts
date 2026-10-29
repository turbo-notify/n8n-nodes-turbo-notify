import type { IDataObject } from 'n8n-workflow';
import {
	searchContacts,
	searchGroups,
	searchNumbers,
} from '../nodes/TurboNotify/methods/listSearch';
import { API, CT, GRP, NODE } from './helpers';

function picker(rows: IDataObject[], selectedNumber = 'main') {
	const request = jest.fn().mockResolvedValue({ data: rows, has_more: true, cursor: 'cur_1' });
	const context = {
		getNode: () => NODE,
		getNodeParameter: () => selectedNumber,
		getCredentials: async () => ({ apiKey: 'k', baseUrl: 'https://api.turbonotify.com' }),
		helpers: { httpRequestWithAuthentication: request },
	};
	return { context: context as never, request };
}

describe('Number picker', () => {
	it('gives the main number as main and an extra number by its ID', async () => {
		const { context } = picker([
			{ id: 'num_1', type: 'main', alias: 'main', number: '5511977770001', name: 'Support' },
			{ id: 'num_2', type: 'extra', alias: 'sales-sp', number: '5511911112222', name: null },
		]);
		const out = await searchNumbers.call(context);
		expect(out.results).toEqual([
			{ name: 'Support: main (+5511977770001)', value: 'main' },
			{ name: 'sales-sp (+5511911112222)', value: 'num_2' },
		]);
	});
});

describe('Contact and Group pickers', () => {
	it('list the contacts of the selected number with name and phone, page by page', async () => {
		const { context, request } = picker(
			[{ id: CT, name: 'Maria', phone_number: '+5511977770002' }],
			'sales-sp',
		);
		const out = await searchContacts.call(context, undefined, 'cur_0');
		expect(request.mock.calls[0]?.[1]).toMatchObject({
			url: `${API}/numbers/sales-sp/contacts`,
			qs: { limit: 50, cursor: 'cur_0' },
		});
		expect(out.results).toEqual([{ name: 'Maria (+5511977770002)', value: CT }]);
		expect(out.paginationToken).toBe('cur_1');
	});

	it('look a typed phone number up by its exact number, and text by name', async () => {
		const byPhone = picker([]);
		await searchContacts.call(byPhone.context, '+55 11 97777-0002');
		expect(byPhone.request.mock.calls[0]?.[1].qs).toMatchObject({ phone: '+5511977770002' });
		const byName = picker([]);
		await searchContacts.call(byName.context, 'Mar');
		expect(byName.request.mock.calls[0]?.[1].qs).toMatchObject({ name: 'Mar' });
	});

	it('list the groups with their names', async () => {
		const { context, request } = picker([{ id: GRP, name: 'Team' }]);
		const out = await searchGroups.call(context, 'Te');
		expect(request.mock.calls[0]?.[1]).toMatchObject({
			url: `${API}/numbers/main/groups`,
			qs: { name: 'Te' },
		});
		expect(out.results).toEqual([{ name: 'Team', value: GRP }]);
	});
});
