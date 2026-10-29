import type { INodeProperties } from 'n8n-workflow';
import { EVENT_OPTIONS } from '../events';
import { on, optionalNumberProperty, returnAllAndLimit } from './shared';

export const eventDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['event'] } },
		options: [
			{
				name: 'Get Many',
				value: 'getMany',
				description:
					'Get what happened on your numbers, newest first. Use it to catch up on events a workflow missed.',
				action: 'Get many events',
			},
		],
		default: 'getMany',
	},
	...returnAllAndLimit('event'),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: on('event', ['getMany']),
		options: [
			{
				displayName: 'Created After',
				name: 'createdAfter',
				type: 'dateTime',
				default: '',
				description: 'Only events created at or after this time',
			},
			{
				displayName: 'Created Before',
				name: 'createdBefore',
				type: 'dateTime',
				default: '',
				description: 'Only events created at or before this time',
			},
			{
				displayName: 'Event Types',
				name: 'types',
				type: 'multiOptions',
				options: EVENT_OPTIONS,
				default: [],
				description: 'Only these types of event, up to 20. Leave empty for every type.',
			},
			optionalNumberProperty('Only the events of this number'),
		],
	},
];
