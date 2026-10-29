import type { INodeProperties } from 'n8n-workflow';
import { contactDescription } from './ContactDescription';
import { eventDescription } from './EventDescription';
import { groupDescription } from './GroupDescription';
import { messageDescription } from './MessageDescription';
import { numberDescription } from './NumberDescription';
import { numberProperty } from './shared';

const resources = [
	messageDescription,
	contactDescription,
	groupDescription,
	numberDescription,
	eventDescription,
];

// Each resource file starts with its Operation selector. The editor shows properties in this order:
// Resource, Operation, Number, then what the operation needs.
export const properties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: [
			{ name: 'Contact', value: 'contact' },
			{ name: 'Event', value: 'event' },
			{ name: 'Group', value: 'group' },
			{ name: 'Message', value: 'message' },
			{ name: 'Number', value: 'number' },
		],
		default: 'message',
	},
	...resources.map((resource) => resource[0] as INodeProperties),
	numberProperty({ resource: ['message', 'contact', 'group'] }),
	numberProperty({ resource: ['number'], operation: ['get'] }, 'The number to get'),
	...resources.flatMap((resource) => resource.slice(1)),
];
