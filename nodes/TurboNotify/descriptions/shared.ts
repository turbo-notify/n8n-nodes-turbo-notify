import type { INodeProperties } from 'n8n-workflow';

type Show = NonNullable<NonNullable<INodeProperties['displayOptions']>['show']>;

export const on = (resource: string, operation: string[]): { show: Show } => ({
	show: { resource: [resource], operation },
});

/** An ID the user types, maps from an earlier node, or picks from a list. */
export const idLocator = (input: {
	name: string;
	displayName: string;
	description: string;
	searchListMethod: string;
	prefix: string;
	required?: boolean;
	show?: Show;
}): INodeProperties => ({
	displayName: input.displayName,
	name: input.name,
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: input.required ?? true,
	description: input.description,
	// The list belongs to one number: it reloads when the number changes.
	typeOptions: { loadOptionsDependsOn: ['number.value'] },
	...(input.show ? { displayOptions: { show: input.show } } : {}),
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			placeholder: 'Select...',
			typeOptions: { searchListMethod: input.searchListMethod, searchable: true },
		},
		{
			displayName: 'By ID',
			name: 'id',
			type: 'string',
			placeholder: `e.g. ${input.prefix}_0198d3c5a1b24d3e9f01a2b3c4d5e6f7`,
			validation: [
				{
					type: 'regex',
					properties: {
						regex: `^${input.prefix}_[0-9a-f]{32}$`,
						errorMessage: `Not a valid ID. It starts with ${input.prefix}_ and has 32 letters and digits`,
					},
				},
			],
		},
	],
});

/** The number the call is made on: the main number, or an extra number by alias or ID. */
export const numberProperty = (
	show: Show,
	description = 'The WhatsApp number to send from or read',
): INodeProperties => ({
	displayName: 'Number',
	name: 'number',
	type: 'resourceLocator',
	default: { mode: 'list', value: 'main', cachedResultName: 'main' },
	required: true,
	description,
	displayOptions: { show },
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			placeholder: 'Select...',
			typeOptions: { searchListMethod: 'searchNumbers' },
		},
		{
			displayName: 'By Alias or ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. main or sales-sp',
		},
	],
});

export const returnAllAndLimit = (resource: string): INodeProperties[] => [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: on(resource, ['getMany']),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: { show: { resource: [resource], operation: ['getMany'], returnAll: [false] } },
	},
];

export const simplifyProperty = (resource: string, operations: string[]): INodeProperties => ({
	displayName: 'Simplify',
	name: 'simplify',
	type: 'boolean',
	default: true,
	description: 'Whether to return a simplified version of the response instead of the raw data',
	displayOptions: on(resource, operations),
});

/** The same number picker without a default: empty means every number. */
export const optionalNumberProperty = (description: string): INodeProperties => ({
	displayName: 'Number',
	name: 'number',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	description,
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			placeholder: 'Select...',
			typeOptions: { searchListMethod: 'searchNumbers' },
		},
		{
			displayName: 'By Alias or ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. main or sales-sp',
		},
	],
});
