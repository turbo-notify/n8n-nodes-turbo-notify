import type { INodeProperties } from 'n8n-workflow';
import { idLocator, on, returnAllAndLimit, simplifyProperty } from './shared';

export const groupDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['group'] } },
		options: [
			{ name: 'Get', value: 'get', description: 'Get a WhatsApp group', action: 'Get a group' },
			{
				name: 'Get Many',
				value: 'getMany',
				description: 'Get the WhatsApp groups of a number',
				action: 'Get many groups',
			},
		],
		default: 'getMany',
	},
	idLocator({
		name: 'groupId',
		displayName: 'Group',
		description: 'The group to get. Pick it from the list, or map its ID from an earlier node.',
		searchListMethod: 'searchGroups',
		prefix: 'grp',
		show: { resource: ['group'], operation: ['get'] },
	}),
	...returnAllAndLimit('group'),
	simplifyProperty('group', ['get', 'getMany']),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: on('group', ['getMany']),
		options: [
			{
				displayName: 'Include Groups Left',
				name: 'includeLeft',
				type: 'boolean',
				default: false,
				description: 'Whether to include groups the number is no longer part of',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				description: 'Only groups whose name matches',
			},
		],
	},
];
