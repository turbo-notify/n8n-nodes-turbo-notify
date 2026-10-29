import type { INodeProperties } from 'n8n-workflow';
import { on } from './shared';

export const numberDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['number'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				description: 'Get a number with its connection status',
				action: 'Get a number',
			},
			{
				name: 'Get Many',
				value: 'getMany',
				description: 'Get the numbers of the organization, main and extra',
				action: 'Get many numbers',
			},
		],
		default: 'getMany',
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: on('number', ['getMany']),
		options: [
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: [
					{ name: 'Connected', value: 'connected' },
					{ name: 'Connecting', value: 'connecting' },
					{ name: 'Disconnected', value: 'disconnected' },
					{ name: 'Failed', value: 'failed' },
					{ name: 'Inactive', value: 'inactive' },
					{ name: 'Pairing', value: 'pairing' },
					{ name: 'Pending', value: 'pending' },
					{ name: 'Reconnecting', value: 'reconnecting' },
					{ name: 'Revoked', value: 'revoked' },
				],
				default: 'disconnected',
				description:
					'Only numbers in this status, for example Disconnected to find the ones that need attention',
			},
		],
	},
];
