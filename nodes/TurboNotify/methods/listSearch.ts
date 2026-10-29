import type { IDataObject, ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';
import { apiRequest, numberPath } from '../transport/request';

interface NumberRow {
	id?: string;
	type?: string;
	alias?: string;
	number?: string;
	name?: string | null;
}

interface ListPage {
	data?: Array<{ id?: string; name?: string | null; phone_number?: string | null }>;
	cursor?: string | null;
	has_more?: boolean;
}

/** The numbers of the organization. The main number is picked as `main`, an extra number by its ID (it survives a rename). */
export async function searchNumbers(this: ILoadOptionsFunctions): Promise<INodeListSearchResult> {
	const page = await apiRequest<{ data?: NumberRow[] }>(this, { method: 'GET', path: '/numbers' });
	return {
		results: (page.data ?? []).map((row) => {
			const alias = row.alias ?? 'main';
			const label = `${alias} (+${row.number ?? ''})`;
			return {
				name: row.name ? `${row.name}: ${label}` : label,
				value: row.type === 'main' ? 'main' : (row.id ?? alias),
			};
		}),
	};
}

/** One page of contacts or groups of the selected number, for the From List pickers. */
async function searchOf(
	context: ILoadOptionsFunctions,
	kind: 'contacts' | 'groups',
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const selected = context.getNodeParameter('number', '', { extractValue: true });
	const ref = typeof selected === 'string' && selected.trim() !== '' ? selected.trim() : 'main';
	const qs: IDataObject = { limit: 50 };
	if (filter) {
		// A typed phone number finds the contact by its exact number; anything else searches by name.
		const digits = filter.replace(/[\s\-().]/g, '');
		if (kind === 'contacts' && /^\+?\d{7,15}$/.test(digits))
			qs.phone = digits.startsWith('+') ? digits : `+${digits}`;
		else qs.name = filter;
	}
	if (paginationToken) qs.cursor = paginationToken;
	const page = await apiRequest<ListPage>(context, {
		method: 'GET',
		path: `${numberPath(ref)}/${kind}`,
		qs,
	});
	return {
		results: (page.data ?? [])
			.filter((row) => typeof row.id === 'string')
			.map((row) => {
				const label = row.name || row.phone_number || (row.id as string);
				return {
					name: row.name && row.phone_number ? `${row.name} (${row.phone_number})` : label,
					value: row.id as string,
				};
			}),
		paginationToken: page.has_more && page.cursor ? page.cursor : undefined,
	};
}

export async function searchContacts(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
) {
	return searchOf(this, 'contacts', filter, paginationToken);
}

export async function searchGroups(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
) {
	return searchOf(this, 'groups', filter, paginationToken);
}
