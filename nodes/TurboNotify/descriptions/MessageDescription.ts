import type { INodeProperties } from 'n8n-workflow';
import { idLocator, on, returnAllAndLimit, simplifyProperty } from './shared';

const SENDS = [
	'sendText',
	'sendMedia',
	'sendLocation',
	'sendContactCard',
	'sendCalendarEvent',
	'sendLinkButton',
];
const WITH_RECIPIENT = [...SENDS, 'sendTypingIndicator'];
const WITH_MESSAGE_ID = ['reply', 'react', 'editText', 'editCaption', 'delete', 'getStatus', 'get'];

const message = (operation: string[]) => on('message', operation);

const quotedMessageId: INodeProperties = {
	displayName: 'Quoted Message ID',
	name: 'quotedMessageId',
	type: 'string',
	default: '',
	placeholder: 'e.g. msg_0198d3c5a1b24d3e9f01a2b3c4d5e6f7',
	description: 'Quote an earlier message: its ID, starting with msg_',
};

export const messageDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['message'] } },
		options: [
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a message you sent, for everyone in the chat',
				action: 'Delete a message',
			},
			{
				name: 'Edit Caption',
				value: 'editCaption',
				description:
					'Change the caption of an image, video or document within 15 minutes of sending',
				action: 'Edit a message caption',
			},
			{
				name: 'Edit Text',
				value: 'editText',
				description: 'Change the text of a message within 15 minutes of sending',
				action: 'Edit a text message',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get a message with its content and status',
				action: 'Get a message',
			},
			{
				name: 'Get Many',
				value: 'getMany',
				description: 'Get the messages of a number, newest first',
				action: 'Get many messages',
			},
			{
				name: 'Get Quota',
				value: 'getQuota',
				description: 'Get how many messages a number can still send in this billing cycle',
				action: 'Get the message quota',
			},
			{
				name: 'Get Status',
				value: 'getStatus',
				description: 'Get how far a message has gone: pending, sent, delivered, read or failed',
				action: 'Get a message status',
			},
			{
				name: 'React',
				value: 'react',
				description: 'Add or remove an emoji reaction on a message',
				action: 'React to a message',
			},
			{
				name: 'Reply',
				value: 'reply',
				description: 'Reply to an earlier message, quoting it',
				action: 'Reply to a message',
			},
			{
				name: 'Send Calendar Event',
				value: 'sendCalendarEvent',
				description: 'Send a calendar event invitation',
				action: 'Send a calendar event message',
			},
			{
				name: 'Send Contact Card',
				value: 'sendContactCard',
				description: 'Send a contact card the recipient can save',
				action: 'Send a contact card message',
			},
			{
				name: 'Send Link Button',
				value: 'sendLinkButton',
				description: 'Send a message with a button that opens a link',
				action: 'Send a link button message',
			},
			{
				name: 'Send Location',
				value: 'sendLocation',
				description: 'Send a map location',
				action: 'Send a location message',
			},
			{
				name: 'Send Media',
				value: 'sendMedia',
				description: 'Send an image, video, audio, document or sticker from a web address',
				action: 'Send a media message',
			},
			{
				name: 'Send Text',
				value: 'sendText',
				description: 'Send a text message',
				action: 'Send a text message',
			},
			{
				name: 'Send Typing Indicator',
				value: 'sendTypingIndicator',
				description: 'Show typing in a chat while your workflow prepares the answer',
				action: 'Send a typing indicator',
			},
		],
		default: 'sendText',
	},

	// ---- Recipient (sends and typing indicator)
	{
		displayName: 'Recipient Type',
		name: 'recipientType',
		type: 'options',
		options: [
			{ name: 'Phone Number', value: 'phone', description: 'A number with the country code and +' },
			{ name: 'Contact', value: 'contact', description: 'A contact Turbo Notify already knows' },
			{
				name: 'Group',
				value: 'group',
				description: 'A group the number belongs to. Needs the Business plan or higher.',
			},
			{
				name: 'Auto-Detect',
				value: 'auto',
				description: 'A phone number, a contact ID or a group ID in one field',
			},
		],
		default: 'phone',
		description: 'Who receives the message',
		displayOptions: message(WITH_RECIPIENT),
	},
	{
		displayName: 'To',
		name: 'recipient',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. +5511977770001',
		description:
			'A phone number with the country code and +, a contact ID (ct_...) or a group ID (grp_...). The node tells them apart.',
		displayOptions: {
			show: { resource: ['message'], operation: WITH_RECIPIENT, recipientType: ['auto'] },
		},
	},
	{
		displayName: 'Phone Number',
		name: 'phoneNumber',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. +5511977770001',
		description: 'Number with the country code, starting with +',
		displayOptions: {
			show: { resource: ['message'], operation: WITH_RECIPIENT, recipientType: ['phone'] },
		},
	},
	idLocator({
		name: 'contactId',
		displayName: 'Contact',
		description:
			'A contact Turbo Notify already knows. Pick it from the list, or map its ID from an earlier node.',
		searchListMethod: 'searchContacts',
		prefix: 'ct',
		show: { resource: ['message'], operation: WITH_RECIPIENT, recipientType: ['contact'] },
	}),
	idLocator({
		name: 'groupId',
		displayName: 'Group',
		description:
			'A group the number belongs to. Pick it from the list, or map its ID from an earlier node.',
		searchListMethod: 'searchGroups',
		prefix: 'grp',
		show: { resource: ['message'], operation: WITH_RECIPIENT, recipientType: ['group'] },
	}),
	{
		displayName: 'Typing',
		name: 'isTyping',
		type: 'boolean',
		default: true,
		description: 'Whether to show the typing indicator. Turn it off to clear it.',
		hint: 'Needs the Lone Wolf plan or higher. Showing it also marks the unread messages of that chat as read.',
		displayOptions: message(['sendTypingIndicator']),
	},

	// ---- Message ID
	{
		displayName: 'Message ID',
		name: 'messageId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. msg_0198d3c5a1b24d3e9f01a2b3c4d5e6f7',
		description: 'ID of the message, starting with msg_. It belongs to the number selected above.',
		hint: 'After another Turbo Notify step, map the id of its output. After the Trigger, map data.id.',
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
		description:
			'Message text, up to 4096 characters. Write @ and a number in international format without + to mention someone.',
		displayOptions: message(['sendText', 'reply']),
	},
	{
		displayName: 'New Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		description: 'The text that replaces the old one, up to 4096 characters',
		displayOptions: message(['editText']),
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
		displayName: 'Media URL',
		name: 'mediaUrl',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. https://example.com/image.png',
		description: 'Public web address of the file. Turbo Notify downloads it before sending.',
		displayOptions: message(['sendMedia']),
	},
	{
		displayName: 'Caption',
		name: 'caption',
		type: 'string',
		default: '',
		description: 'Text shown under the file, up to 1024 characters',
		displayOptions: {
			show: {
				resource: ['message'],
				operation: ['sendMedia'],
				mediaType: ['image', 'video', 'document'],
			},
		},
	},
	{
		displayName: 'New Caption',
		name: 'caption',
		type: 'string',
		required: true,
		default: '',
		description: 'The caption that replaces the old one, up to 1024 characters',
		displayOptions: message(['editCaption']),
	},
	{
		displayName: 'File Name',
		name: 'fileName',
		type: 'string',
		default: '',
		placeholder: 'e.g. Invoice-April.pdf',
		description: 'Name shown on the attachment in the chat',
		displayOptions: {
			show: { resource: ['message'], operation: ['sendMedia'], mediaType: ['document'] },
		},
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
		placeholder: 'e.g. Nathan Smith',
		description: 'Name on the contact card',
		displayOptions: message(['sendContactCard']),
	},
	{
		displayName: 'Phones Input',
		name: 'phonesInput',
		type: 'options',
		options: [
			{ name: 'Fields Below', value: 'fields', description: 'Add the phone numbers one by one' },
			{ name: 'JSON', value: 'json', description: 'A list from an earlier node, or typed as JSON' },
		],
		default: 'fields',
		description: 'How the phone numbers of the card are given',
		displayOptions: message(['sendContactCard']),
	},
	{
		displayName: 'Phones',
		name: 'phones',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Phone',
		default: { phoneValues: [{ number: '', label: '' }] },
		description: 'Phone numbers on the card, from 1 to 10',
		displayOptions: {
			show: { resource: ['message'], operation: ['sendContactCard'], phonesInput: ['fields'] },
		},
		options: [
			{
				displayName: 'Phone',
				name: 'phoneValues',
				values: [
					{
						displayName: 'Phone Number',
						name: 'number',
						type: 'string',
						default: '',
						placeholder: 'e.g. +5511977770002',
						description: 'Number with the country code, starting with +',
					},
					{
						displayName: 'Label',
						name: 'label',
						type: 'string',
						default: '',
						placeholder: 'e.g. Work',
						description: 'Label shown next to the number. Defaults to Mobile.',
					},
				],
			},
		],
	},
	{
		displayName: 'Phones (JSON)',
		name: 'phonesJson',
		type: 'json',
		default: '',
		placeholder: 'e.g. ["+5511977770002"]',
		description:
			'A list of phone numbers, from 1 to 10: an array from an earlier node, or JSON. Each item is a number or an object with number and label.',
		displayOptions: {
			show: { resource: ['message'], operation: ['sendContactCard'], phonesInput: ['json'] },
		},
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
		displayName: 'Emoji',
		name: 'reaction',
		type: 'string',
		default: '',
		placeholder: 'e.g. 👍',
		description: 'Emoji to react with. Leave empty to remove your earlier reaction.',
		displayOptions: message(['react']),
	},

	// ---- Read: Return All, Limit, Simplify, Filters
	...returnAllAndLimit('message'),
	simplifyProperty('message', ['get', 'getMany']),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: message(['getMany']),
		options: [
			idLocator({
				name: 'contactId',
				displayName: 'Contact',
				description:
					'Only messages this contact sent or received, including what they said in groups',
				searchListMethod: 'searchContacts',
				prefix: 'ct',
				required: false,
			}),
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
			idLocator({
				name: 'groupId',
				displayName: 'Group',
				description: 'Only messages of this group',
				searchListMethod: 'searchGroups',
				prefix: 'grp',
				required: false,
			}),
		],
	},

	// ---- Additional fields (what goes in the message), one collection per send
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: message(['sendMedia']),
		options: [quotedMessageId],
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: message(['sendLocation']),
		options: [
			{
				displayName: 'Address',
				name: 'address',
				type: 'string',
				default: '',
				description: 'Street address, up to 500 characters',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				placeholder: 'e.g. Avenida Paulista',
				description: 'Place name, up to 200 characters',
			},
			quotedMessageId,
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				default: '',
				placeholder: 'e.g. https://maps.example.com/?q=-23.55,-46.63',
				description: 'Web address with more about the place',
			},
		],
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: message(['sendContactCard']),
		options: [
			{
				displayName: 'Address',
				name: 'address',
				type: 'string',
				default: '',
				description: 'Postal address on the card, up to 500 characters',
			},
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
							{
								displayName: 'Label',
								name: 'label',
								type: 'string',
								default: '',
								placeholder: 'e.g. Work',
								description: 'Label shown next to the address',
							},
							{
								displayName: 'Address',
								name: 'address',
								type: 'string',
								default: '',
								placeholder: 'e.g. nathan@example.com',
								description: 'Email address',
							},
						],
					},
				],
			},
			{
				displayName: 'Emails (JSON)',
				name: 'emailsJson',
				type: 'json',
				default: '',
				placeholder: 'e.g. ["nathan@example.com"]',
				description:
					"A list of email addresses: an array from an earlier node, or JSON. Used instead of 'Emails' when filled in.",
			},
			{
				displayName: 'Organization',
				name: 'organization',
				type: 'string',
				default: '',
				description: 'Company name, up to 200 characters',
			},
			quotedMessageId,
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				default: '',
				description: 'Job title, up to 100 characters',
			},
		],
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: message(['sendCalendarEvent']),
		options: [
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				default: '',
				description: 'Details of the event, up to 2000 characters',
			},
			{
				displayName: 'End Time',
				name: 'endAt',
				type: 'dateTime',
				default: '',
				description: 'When the event ends. It must be after the start time.',
			},
			{
				displayName: 'Extra Guests Allowed',
				name: 'extraGuestsAllowed',
				type: 'boolean',
				default: false,
				description: 'Whether guests can bring extra people',
			},
			{
				displayName: 'Join Link',
				name: 'joinLink',
				type: 'string',
				default: '',
				placeholder: 'e.g. https://meet.example.com/abc',
				description: 'Web address of the call',
			},
			quotedMessageId,
			{
				displayName: 'Remind Before (Minutes)',
				name: 'remindBeforeMinutes',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 10,
				description:
					'How many minutes before the start guests are reminded. Leave the field out for no reminder.',
			},
		],
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: message(['sendLinkButton']),
		options: [
			{
				displayName: 'Footer',
				name: 'footer',
				type: 'string',
				default: '',
				description: 'Small text under the button, up to 60 characters',
			},
			{
				displayName: 'Header',
				name: 'headerText',
				type: 'string',
				default: '',
				description: 'Short title above the body, up to 60 characters',
			},
			quotedMessageId,
		],
	},

	// ---- Options (how it is sent), the same on every send and on Reply
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: message([...SENDS, 'reply']),
		options: [
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				placeholder: 'e.g. order-4711-confirmation',
				description:
					'Stops the same message from going out twice. Leave it empty and the node sets one for you. To set your own, use a value that differs for every item, such as the order number from an earlier node. One fixed value sends only the first message. Up to 255 plain characters.',
			},
		],
	},
];
