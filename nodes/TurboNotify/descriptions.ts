import type { INodeProperties } from 'n8n-workflow';

const MESSAGE_SENDS = [
	'sendText',
	'sendMedia',
	'sendLocation',
	'sendContactCard',
	'sendCalendarEvent',
	'sendLinkButton',
];
const WITH_MESSAGE_ID = ['reply', 'react', 'editText', 'editCaption', 'delete', 'getStatus', 'get'];

const message = (operation: string[]) => ({ show: { resource: ['message'], operation } });
const on = (resource: string, operation: string[]) => ({ show: { resource: [resource], operation } });

const returnAllAndLimit = (resource: string): INodeProperties[] => [
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

const simplify = (resource: string, description: string): INodeProperties => ({
	displayName: 'Simplify',
	name: 'simplify',
	type: 'boolean',
	default: true,
	description,
	displayOptions: on(resource, ['getMany']),
});

export const properties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: [
			{ name: 'Contact', value: 'contact' },
			{ name: 'Group', value: 'group' },
			{ name: 'Message', value: 'message' },
			{ name: 'Number', value: 'number' },
		],
		default: 'message',
	},

	// ---- Operations
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['message'] } },
		options: [
			{ name: 'Delete', value: 'delete', description: 'Delete a message you sent, for everyone in the chat', action: 'Delete a message' },
			{ name: 'Edit Caption', value: 'editCaption', description: 'Change the caption of an image, video or document within 15 minutes of sending', action: 'Edit a message caption' },
			{ name: 'Edit Text', value: 'editText', description: 'Change the text of a message within 15 minutes of sending', action: 'Edit a text message' },
			{ name: 'Get', value: 'get', description: 'Get a message with its content and status', action: 'Get a message' },
			{ name: 'Get Many', value: 'getMany', description: 'Get the messages of a number, newest first', action: 'Get many messages' },
			{ name: 'Get Status', value: 'getStatus', description: 'Get how far a message has gone: pending, sent, delivered, read or failed', action: 'Get a message status' },
			{ name: 'React', value: 'react', description: 'Add or remove an emoji reaction on a message', action: 'React to a message' },
			{ name: 'Reply', value: 'reply', description: 'Reply to an earlier message, quoting it', action: 'Reply to a message' },
			{ name: 'Send Calendar Event', value: 'sendCalendarEvent', description: 'Send a calendar event invitation', action: 'Send a calendar event message' },
			{ name: 'Send Contact Card', value: 'sendContactCard', description: 'Send a contact card the recipient can save', action: 'Send a contact card message' },
			{ name: 'Send Link Button', value: 'sendLinkButton', description: 'Send a message with a button that opens a link', action: 'Send a link button message' },
			{ name: 'Send Location', value: 'sendLocation', description: 'Send a map location', action: 'Send a location message' },
			{ name: 'Send Media', value: 'sendMedia', description: 'Send an image, video, audio, document or sticker from a web address', action: 'Send a media message' },
			{ name: 'Send Text', value: 'sendText', description: 'Send a text message', action: 'Send a text message' },
		],
		default: 'sendText',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['contact'] } },
		options: [
			{ name: 'Get', value: 'get', description: 'Get a contact', action: 'Get a contact' },
			{ name: 'Get Many', value: 'getMany', description: 'Get the contacts of a number', action: 'Get many contacts' },
		],
		default: 'getMany',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['group'] } },
		options: [
			{ name: 'Get', value: 'get', description: 'Get a WhatsApp group', action: 'Get a group' },
			{ name: 'Get Many', value: 'getMany', description: 'Get the WhatsApp groups of a number', action: 'Get many groups' },
		],
		default: 'getMany',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['number'] } },
		options: [
			{ name: 'Get Many', value: 'getMany', description: 'Get the numbers of the organization, main and extra', action: 'Get many numbers' },
		],
		default: 'getMany',
	},

	// ---- Number selector
	{
		displayName: 'Number',
		name: 'number',
		type: 'resourceLocator',
		default: { mode: 'list', value: 'main' },
		required: true,
		description: 'The WhatsApp number that sends or owns the data',
		displayOptions: { show: { resource: ['message', 'contact', 'group'] } },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchNumbers' },
			},
			{
				displayName: 'By Alias or ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. main or sales-sp',
			},
		],
	},

	// ---- Recipient (sends)
	{
		displayName: 'Recipient Type',
		name: 'recipientType',
		type: 'options',
		options: [
			{ name: 'Phone Number', value: 'phone' },
			{ name: 'Contact', value: 'contact' },
			{ name: 'Group', value: 'group' },
		],
		default: 'phone',
		description: 'Who receives the message. Sending to a group needs the Business plan or higher.',
		displayOptions: message(MESSAGE_SENDS),
	},
	{
		displayName: 'Phone Number',
		name: 'phoneNumber',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. +5511977770001',
		description: 'Number with the country code, starting with +',
		displayOptions: { show: { resource: ['message'], operation: MESSAGE_SENDS, recipientType: ['phone'] } },
	},
	{
		displayName: 'Contact ID',
		name: 'contactId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. ct_0198d3c5a1b24d3e9f01a2b3c4d5e6f7',
		description: 'ID of a contact Turbo Notify already knows, from Contact > Get Many',
		displayOptions: { show: { resource: ['message'], operation: MESSAGE_SENDS, recipientType: ['contact'] } },
	},
	{
		displayName: 'Group ID',
		name: 'groupId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. grp_e442553a56b14e2695f6acfd7d651b1a',
		description: 'ID of a group the number belongs to, from Group > Get Many',
		displayOptions: { show: { resource: ['message'], operation: MESSAGE_SENDS, recipientType: ['group'] } },
	},

	// ---- Message id
	{
		displayName: 'Message ID',
		name: 'messageId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. msg_0198d3c5a1b24d3e9f01a2b3c4d5e6f7',
		description: "ID returned when the message was sent or received. It belongs to the number selected above.",
		displayOptions: message(WITH_MESSAGE_ID),
	},

	// ---- Text
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		description: 'Message text, up to 4096 characters. Write @ and a number in international format without + to mention someone.',
		displayOptions: message(['sendText', 'reply', 'editText']),
	},

	// ---- Media
	{
		displayName: 'Media Type',
		name: 'mediaType',
		type: 'options',
		options: [
			{ name: 'Audio', value: 'audio' },
			{ name: 'Document', value: 'document' },
			{ name: 'Image', value: 'image' },
			{ name: 'Sticker', value: 'sticker' },
			{ name: 'Video', value: 'video' },
		],
		default: 'image',
		displayOptions: message(['sendMedia']),
	},
	{
		displayName: 'URL',
		name: 'mediaUrl',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. https://example.com/photo.jpg',
		description: 'Public web address of the file. Turbo Notify downloads it before sending.',
		displayOptions: message(['sendMedia']),
	},
	{
		displayName: 'Caption',
		name: 'caption',
		type: 'string',
		default: '',
		description: 'Text shown under the file, up to 1024 characters',
		displayOptions: { show: { resource: ['message'], operation: ['sendMedia'], mediaType: ['image', 'video', 'document'] } },
	},
	{
		displayName: 'Caption',
		name: 'caption',
		type: 'string',
		required: true,
		default: '',
		description: 'The new caption, up to 1024 characters',
		displayOptions: message(['editCaption']),
	},
	{
		displayName: 'File Name',
		name: 'fileName',
		type: 'string',
		default: '',
		placeholder: 'e.g. Invoice-April.pdf',
		description: 'Name shown on the attachment in the chat',
		displayOptions: { show: { resource: ['message'], operation: ['sendMedia'], mediaType: ['document'] } },
	},

	// ---- Location
	{
		displayName: 'Latitude',
		name: 'latitude',
		type: 'number',
		typeOptions: { numberPrecision: 6 },
		required: true,
		default: 0,
		description: 'Latitude from -90 to 90',
		displayOptions: message(['sendLocation']),
	},
	{
		displayName: 'Longitude',
		name: 'longitude',
		type: 'number',
		typeOptions: { numberPrecision: 6 },
		required: true,
		default: 0,
		description: 'Longitude from -180 to 180',
		displayOptions: message(['sendLocation']),
	},

	// ---- Contact card
	{
		displayName: 'Display Name',
		name: 'displayName',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Maria Souza',
		description: 'Name on the contact card',
		displayOptions: message(['sendContactCard']),
	},
	{
		displayName: 'Phones',
		name: 'phones',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Phone',
		default: {},
		description: 'Phone numbers on the card, from 1 to 10',
		displayOptions: message(['sendContactCard']),
		options: [
			{
				displayName: 'Phone',
				name: 'phoneValues',
				values: [
					{ displayName: 'Label', name: 'label', type: 'string', default: '', placeholder: 'e.g. Work', description: 'Label shown next to the number. Defaults to Mobile.' },
					{ displayName: 'Number', name: 'number', type: 'string', default: '', placeholder: 'e.g. +5511977770002', description: 'Number with the country code, starting with +' },
				],
			},
		],
	},

	// ---- Calendar event
	{
		displayName: 'Event Name',
		name: 'eventName',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Sprint planning',
		description: 'Title of the event, up to 200 characters',
		displayOptions: message(['sendCalendarEvent']),
	},
	{
		displayName: 'Start Time',
		name: 'startAt',
		type: 'dateTime',
		required: true,
		default: '',
		description: 'When the event starts. Include the time zone.',
		displayOptions: message(['sendCalendarEvent']),
	},

	// ---- Link button
	{
		displayName: 'Body',
		name: 'body',
		type: 'string',
		typeOptions: { rows: 3 },
		required: true,
		default: '',
		description: 'Message text above the button, up to 1024 characters',
		displayOptions: message(['sendLinkButton']),
	},
	{
		displayName: 'Button Text',
		name: 'buttonText',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Track order',
		description: 'Text on the button, up to 20 characters',
		displayOptions: message(['sendLinkButton']),
	},
	{
		displayName: 'Button URL',
		name: 'buttonUrl',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. https://example.com/tracking/123',
		description: 'Address the button opens',
		displayOptions: message(['sendLinkButton']),
	},

	// ---- Reaction
	{
		displayName: 'Reaction',
		name: 'reaction',
		type: 'string',
		default: '',
		placeholder: 'e.g. 👍',
		description: 'Emoji to react with. Leave empty to remove your earlier reaction.',
		displayOptions: message(['react']),
	},

	// ---- Contact, group ids
	{
		displayName: 'Contact ID',
		name: 'contactId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. ct_0198d3c5a1b24d3e9f01a2b3c4d5e6f7',
		description: 'ID of the contact, from Contact > Get Many',
		displayOptions: on('contact', ['get']),
	},
	{
		displayName: 'Group ID',
		name: 'groupId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. grp_e442553a56b14e2695f6acfd7d651b1a',
		description: 'ID of the group, from Group > Get Many',
		displayOptions: on('group', ['get']),
	},

	// ---- Return All, Limit, Simplify
	...returnAllAndLimit('message'),
	...returnAllAndLimit('contact'),
	...returnAllAndLimit('group'),
	simplify('message', 'Whether to return a simplified response instead of raw data'),
	simplify('contact', 'Whether to return a simplified response instead of raw data'),
	simplify('group', 'Whether to return a simplified response instead of raw data'),

	// ---- Filters
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: on('message', ['getMany']),
		options: [
			{
				displayName: 'Contact ID',
				name: 'contactId',
				type: 'string',
				default: '',
				description: 'Only messages this contact sent or received, including what they said in groups',
			},
			{
				displayName: 'Direction',
				name: 'direction',
				type: 'options',
				options: [
					{ name: 'Received', value: 'inbound' },
					{ name: 'Sent', value: 'outbound' },
				],
				default: 'inbound',
				description: 'Only received or only sent messages',
			},
			{
				displayName: 'Group ID',
				name: 'groupId',
				type: 'string',
				default: '',
				description: 'Only messages of this group',
			},
		],
	},
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
				description: "Whether to return only contacts messaged in this number's current billing cycle",
			},
			{ displayName: 'Name', name: 'name', type: 'string', default: '', description: 'Only contacts whose name matches' },
			{ displayName: 'Phone', name: 'phone', type: 'string', default: '', placeholder: 'e.g. +5511977770001', description: 'Only the contact with this phone number' },
			{
				displayName: 'Source',
				name: 'source',
				type: 'options',
				options: [
					{ name: 'Mentioned', value: 'mention' },
					{ name: 'Messaged First by Contact', value: 'inbound' },
					{ name: 'Messaged First by Us', value: 'outbound' },
					{ name: 'Own Number', value: 'self' },
				],
				default: 'inbound',
				description: 'How the contact first appeared',
			},
		],
	},
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
			{ displayName: 'Name', name: 'name', type: 'string', default: '', description: 'Only groups whose name matches' },
		],
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
				description: 'Only numbers in this status, for example Disconnected to find the ones that need attention',
			},
		],
	},

	// ---- Options per send operation
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: message(['sendText', 'reply']),
		options: [idempotencyKeyOption()],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: message(['sendMedia']),
		options: [
			idempotencyKeyOption(),
			{ displayName: 'MIME Type', name: 'mimeType', type: 'string', default: '', placeholder: 'e.g. image/jpeg', description: 'Informational. Turbo Notify reads the real type from the downloaded file.' },
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: message(['sendLocation']),
		options: [
			idempotencyKeyOption(),
			{ displayName: 'Address', name: 'address', type: 'string', default: '', description: 'Street address, up to 500 characters' },
			{ displayName: 'Name', name: 'name', type: 'string', default: '', placeholder: 'e.g. Avenida Paulista', description: 'Place name, up to 200 characters' },
			{ displayName: 'URL', name: 'url', type: 'string', default: '', placeholder: 'e.g. https://maps.example.com/?q=-23.55,-46.63', description: 'Web address with more about the place' },
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: message(['sendContactCard']),
		options: [
			idempotencyKeyOption(),
			{ displayName: 'Address', name: 'address', type: 'string', default: '', description: 'Postal address on the card, up to 500 characters' },
			{
				displayName: 'Emails',
				name: 'emails',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Email',
				default: {},
				description: 'Email addresses on the card, up to 10',
				options: [
					{
						displayName: 'Email',
						name: 'emailValues',
						values: [
							{ displayName: 'Label', name: 'label', type: 'string', default: '', placeholder: 'e.g. Work', description: 'Label shown next to the address' },
							{ displayName: 'Address', name: 'address', type: 'string', default: '', placeholder: 'e.g. maria@example.com', description: 'Email address' },
						],
					},
				],
			},
			{ displayName: 'Organization', name: 'organization', type: 'string', default: '', description: 'Company name, up to 200 characters' },
			{ displayName: 'Title', name: 'title', type: 'string', default: '', description: 'Job title, up to 100 characters' },
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: message(['sendCalendarEvent']),
		options: [
			idempotencyKeyOption(),
			{ displayName: 'Description', name: 'description', type: 'string', default: '', description: 'Details of the event, up to 2000 characters' },
			{ displayName: 'End Time', name: 'endAt', type: 'dateTime', default: '', description: 'When the event ends. It must be after the start time.' },
			{ displayName: 'Extra Guests Allowed', name: 'extraGuestsAllowed', type: 'boolean', default: false, description: 'Whether guests can bring extra people' },
			{ displayName: 'Join Link', name: 'joinLink', type: 'string', default: '', placeholder: 'e.g. https://meet.example.com/abc', description: 'Web address of the call' },
			{ displayName: 'Reminder', name: 'hasReminder', type: 'boolean', default: false, description: 'Whether to remind guests before the event' },
			{ displayName: 'Reminder Offset (Seconds)', name: 'reminderOffsetSeconds', type: 'number', typeOptions: { minValue: 0 }, default: 600, description: 'How many seconds before the event the reminder goes out. Used only when Reminder is on.' },
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: message(['sendLinkButton']),
		options: [
			idempotencyKeyOption(),
			{ displayName: 'Footer', name: 'footer', type: 'string', default: '', description: 'Small text under the button, up to 60 characters' },
			{ displayName: 'Header', name: 'headerText', type: 'string', default: '', description: 'Short title above the body, up to 60 characters' },
		],
	},
];

function idempotencyKeyOption(): INodeProperties {
	return {
		displayName: 'Idempotency Key',
		name: 'idempotencyKey',
		type: 'string',
		default: '',
		placeholder: 'e.g. order-4711-confirmation',
		description:
			'Up to 255 characters. If the node runs again with the same key on the same number, the message is not sent twice.',
	};
}
