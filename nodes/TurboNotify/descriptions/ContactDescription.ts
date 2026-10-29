import type { INodeProperties } from 'n8n-workflow';
import { idLocator, on, returnAllAndLimit, simplifyProperty } from './shared';

export const contactDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['contact'] } },
		options: [
			{ name: 'Get', value: 'get', description: 'Get a contact', action: 'Get a contact' },
			{
				name: 'Get Many',
				value: 'getMany',
				description: 'Get the contacts of a number',
				action: 'Get many contacts',
			},
		],
		default: 'getMany',
	},
	idLocator({
		name: 'contactId',
		displayName: 'Contact',
		description: 'The contact to get. Pick it from the list, or map its ID from an earlier node.',
		searchListMethod: 'searchContacts',
		prefix: 'ct',
		show: { resource: ['contact'], operation: ['get'] },
	}),
	...returnAllAndLimit('contact'),
	simplifyProperty('contact', ['get', 'getMany']),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: on('contact', ['getMany']),
		options: [
			{
				displayName: 'Contacted in Current Cycle',
				name: 'contactedInCycle',
				type: 'boolean',
				default: true,
				description:
					"Whether to return only contacts messaged in this number's current billing cycle",
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				description: 'Only contacts whose name matches',
			},
			{
				displayName: 'Phone',
				name: 'phone',
				type: 'string',
				default: '',
				placeholder: 'e.g. +5511977770001',
				description: 'Only the contact with this phone number',
			},
			{
				displayName: 'Source',
				name: 'source',
				type: 'options',
				options: [
					{ name: 'Contact Messaged First', value: 'inbound' },
					{ name: 'Mentioned', value: 'mention' },
					{ name: 'Own Number', value: 'self' },
					{ name: 'You Messaged First', value: 'outbound' },
				],
				default: 'inbound',
				description: 'How the contact first appeared',
			},
		],
	},
];
