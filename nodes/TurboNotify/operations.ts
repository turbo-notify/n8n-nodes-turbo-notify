import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { apiRequest, numberPath, pickFields, requestMany } from './GenericFunctions';
import * as v from './validation';

type Handler = (context: IExecuteFunctions, i: number, ref: string, s: v.Scope) => Promise<IDataObject | IDataObject[]>;

const param = <T = unknown>(context: IExecuteFunctions, name: string, i: number, fallback?: unknown): T =>
	context.getNodeParameter(name, i, fallback) as T;

const optionsOf = (context: IExecuteFunctions, i: number): IDataObject =>
	param<IDataObject>(context, 'options', i, {});

const SIMPLE_FIELDS = {
	message: ['id', 'number_id', 'number_alias', 'direction', 'content_type', 'preview', 'at', 'from', 'to', 'status'],
	contact: ['id', 'name', 'phone_number', 'number_alias', 'is_self', 'first_messaged_at', 'last_interaction_at'],
	group: ['id', 'name', 'description', 'participants_count', 'is_active', 'number_alias', 'is_announce_only'],
} as const;

function recipientOf(context: IExecuteFunctions, i: number, s: v.Scope): IDataObject {
	return v.recipient(s, {
		type: param(context, 'recipientType', i, 'phone'),
		phone: param(context, 'phoneNumber', i, ''),
		contact: param(context, 'contactId', i, ''),
		group: param(context, 'groupId', i, ''),
	});
}

function idempotencyHeaders(s: v.Scope, options: IDataObject): IDataObject {
	const key = v.idempotencyKey(s, options.idempotencyKey);
	return key ? { 'Idempotency-Key': key } : {};
}

function setIf(target: IDataObject, key: string, value: unknown): void {
	if (value !== undefined) target[key] = value as IDataObject[string];
}

/** Sends one message. `build` returns the `content` object, already validated. */
function send(build: (context: IExecuteFunctions, i: number, options: IDataObject, s: v.Scope) => IDataObject): Handler {
	return async (context, i, ref, s) => {
		const options = optionsOf(context, i);
		const to = recipientOf(context, i, s);
		const content = build(context, i, options, s);
		const headers = idempotencyHeaders(s, options);
		return (await apiRequest(context, {
			method: 'POST',
			path: `${numberPath(ref)}/messages`,
			body: { to, content },
			headers,
			itemIndex: i,
		})) as IDataObject;
	};
}

const MEDIA_FIELD = { image: 'image_url', video: 'video_url', audio: 'audio_url', document: 'document_url', sticker: 'sticker_url' } as const;

const sendText = send((context, i, _options, s) => ({
	text: v.requireText(s, param(context, 'text', i, ''), 'Text', 4096),
}));

const sendMedia = send((context, i, options, s) => {
	const type = param<keyof typeof MEDIA_FIELD>(context, 'mediaType', i, 'image');
	const content: IDataObject = { [MEDIA_FIELD[type]]: v.requireHttpUrl(s, param(context, 'mediaUrl', i, ''), 'URL') };
	if (type === 'image' || type === 'video' || type === 'document') {
		setIf(content, 'caption', v.optionalText(s, param(context, 'caption', i, ''), 'Caption', 1024));
	}
	if (type === 'document') {
		setIf(content, 'filename', v.optionalText(s, param(context, 'fileName', i, ''), 'File Name', 255));
	}
	setIf(content, 'mime_type', v.optionalText(s, options.mimeType, 'MIME Type', 120));
	return content;
});

const sendLocation = send((context, i, options, s) => {
	const content: IDataObject = {
		latitude: v.requireNumberInRange(s, param(context, 'latitude', i), 'Latitude', -90, 90),
		longitude: v.requireNumberInRange(s, param(context, 'longitude', i), 'Longitude', -180, 180),
	};
	setIf(content, 'name', v.optionalText(s, options.name, 'Name', 200));
	setIf(content, 'address', v.optionalText(s, options.address, 'Address', 500));
	setIf(content, 'url', options.url ? v.requireHttpUrl(s, options.url, 'URL') : undefined);
	return content;
});

const sendContactCard = send((context, i, options, s) => {
	const phones = param<IDataObject>(context, 'phones', i, {}).phoneValues;
	const content: IDataObject = {
		display_name: v.requireText(s, param(context, 'displayName', i, ''), 'Display Name', 200),
		phones: v.phoneList(s, phones),
	};
	setIf(content, 'emails', v.emailList(s, (options.emails as IDataObject | undefined)?.emailValues));
	setIf(content, 'organization', v.optionalText(s, options.organization, 'Organization', 200));
	setIf(content, 'title', v.optionalText(s, options.title, 'Title', 100));
	setIf(content, 'address', v.optionalText(s, options.address, 'Address', 500));
	return content;
});

const sendCalendarEvent = send((context, i, options, s) => {
	const start = v.requireDateTime(s, param(context, 'startAt', i, ''), 'Start Time');
	const content: IDataObject = {
		name: v.requireText(s, param(context, 'eventName', i, ''), 'Event Name', 200),
		start_at: start,
	};
	if (options.endAt) {
		const end = v.requireDateTime(s, options.endAt, 'End Time');
		if (Date.parse(end) <= Date.parse(start)) {
			v.fail(s, "'End Time' must be after 'Start Time'", 'Pick an end time later than the start time, or leave it empty.');
		}
		content.end_at = end;
	}
	setIf(content, 'description', v.optionalText(s, options.description, 'Description', 2000));
	setIf(content, 'join_link', options.joinLink ? v.requireHttpUrl(s, options.joinLink, 'Join Link') : undefined);
	if (options.hasReminder === true) {
		content.has_reminder = true;
		content.reminder_offset_sec = v.requireNumberInRange(s, options.reminderOffsetSeconds ?? 600, 'Reminder Offset (Seconds)', 0, 31_536_000);
	}
	if (options.extraGuestsAllowed === true) content.extra_guests_allowed = true;
	return content;
});

const sendLinkButton = send((context, i, options, s) => {
	const content: IDataObject = {
		interactive_type: 'cta_url',
		body: v.requireText(s, param(context, 'body', i, ''), 'Body', 1024),
		url_button: {
			display_text: v.requireText(s, param(context, 'buttonText', i, ''), 'Button Text', 20),
			url: v.requireHttpUrl(s, param(context, 'buttonUrl', i, ''), 'Button URL'),
		},
	};
	const header = v.optionalText(s, options.headerText, 'Header', 60);
	if (header) content.header = { type: 'text', text: header };
	setIf(content, 'footer', v.optionalText(s, options.footer, 'Footer', 60));
	return content;
});

const messagePath = (context: IExecuteFunctions, i: number, ref: string, s: v.Scope): string =>
	`${numberPath(ref)}/messages/${v.messageId(s, param(context, 'messageId', i, ''))}`;

const reply: Handler = async (context, i, ref, s) => {
	const options = optionsOf(context, i);
	const path = messagePath(context, i, ref, s);
	const text = v.requireText(s, param(context, 'text', i, ''), 'Text', 4096);
	return (await apiRequest(context, {
		method: 'POST',
		path: `${path}/reply`,
		body: { content: { text } },
		headers: idempotencyHeaders(s, options),
		itemIndex: i,
	})) as IDataObject;
};

const react: Handler = async (context, i, ref, s) => {
	const path = messagePath(context, i, ref, s);
	const emoji = v.asString(param(context, 'reaction', i, ''));
	return (await apiRequest(context, {
		method: 'POST',
		path: `${path}/react`,
		body: { reaction: emoji === '' ? null : emoji },
		itemIndex: i,
	})) as IDataObject;
};

const editText: Handler = async (context, i, ref, s) => {
	const path = messagePath(context, i, ref, s);
	const text = v.requireText(s, param(context, 'text', i, ''), 'Text', 4096);
	return (await apiRequest(context, { method: 'POST', path: `${path}/edit`, body: { text }, itemIndex: i })) as IDataObject;
};

const editCaption: Handler = async (context, i, ref, s) => {
	const path = messagePath(context, i, ref, s);
	const caption = v.requireText(s, param(context, 'caption', i, ''), 'Caption', 1024);
	return (await apiRequest(context, { method: 'POST', path: `${path}/edit`, body: { caption }, itemIndex: i })) as IDataObject;
};

const remove: Handler = async (context, i, ref, s) => {
	const accepted = (await apiRequest(context, { method: 'POST', path: `${messagePath(context, i, ref, s)}/delete`, itemIndex: i })) as IDataObject;
	// The API accepts the deletion and WhatsApp finishes it a moment later: `deleted: true` means "accepted".
	return { ...accepted, deleted: true };
};

const getStatus: Handler = async (context, i, ref, s) =>
	(await apiRequest(context, { method: 'GET', path: `${messagePath(context, i, ref, s)}/status`, itemIndex: i })) as IDataObject;

const getMessage: Handler = async (context, i, ref, s) =>
	(await apiRequest(context, { method: 'GET', path: messagePath(context, i, ref, s), itemIndex: i })) as IDataObject;

/** Get Many: Return All or Limit, optional filters, optional Simplify. */
function getMany(
	kind: 'message' | 'contact' | 'group',
	suffix: string,
	filterQuery: (filters: IDataObject, s: v.Scope) => IDataObject,
): Handler {
	return async (context, i, ref, s) => {
		const returnAll = param<boolean>(context, 'returnAll', i, false);
		const limit = returnAll ? 0 : v.limitValue(s, param(context, 'limit', i, 50));
		const filters = param<IDataObject>(context, 'filters', i, {});
		const items = await requestMany(
			context,
			{ path: `${numberPath(ref)}${suffix}`, qs: filterQuery(filters, s), itemIndex: i },
			returnAll,
			limit,
		);
		return param<boolean>(context, 'simplify', i, true)
			? items.map((item) => pickFields(item, [...SIMPLE_FIELDS[kind]]))
			: items;
	};
}

const getMessages = getMany('message', '/messages', (f, s) => {
	const qs: IDataObject = {};
	if (f.direction) qs.direction = f.direction;
	if (f.groupId) qs.group_id = v.groupId(s, f.groupId);
	if (f.contactId) qs.contact_id = v.contactId(s, f.contactId);
	return qs;
});

const getContacts = getMany('contact', '/contacts', (f) => {
	const qs: IDataObject = {};
	if (f.name) qs.name = f.name;
	if (f.phone) qs.phone = f.phone;
	if (f.source) qs.source = f.source;
	if (f.contactedInCycle !== undefined) qs.contacted_in_cycle = f.contactedInCycle;
	return qs;
});

const getGroups = getMany('group', '/groups', (f) => {
	const qs: IDataObject = {};
	if (f.name) qs.name = f.name;
	if (f.includeLeft !== undefined) qs.include_left = f.includeLeft;
	return qs;
});

const getContact: Handler = async (context, i, ref, s) =>
	(await apiRequest(context, {
		method: 'GET',
		path: `${numberPath(ref)}/contacts/${v.contactId(s, param(context, 'contactId', i, ''))}`,
		itemIndex: i,
	})) as IDataObject;

const getGroup: Handler = async (context, i, ref, s) =>
	(await apiRequest(context, {
		method: 'GET',
		path: `${numberPath(ref)}/groups/${v.groupId(s, param(context, 'groupId', i, ''))}`,
		itemIndex: i,
	})) as IDataObject;

const getNumbers: Handler = async (context, i) => {
	const filters = param<IDataObject>(context, 'filters', i, {});
	const qs: IDataObject = {};
	if (filters.status) qs.status = filters.status;
	const page = (await apiRequest(context, { method: 'GET', path: '/numbers', qs, itemIndex: i })) as { data?: IDataObject[] };
	return page.data ?? [];
};

export const handlers: Record<string, Record<string, Handler>> = {
	message: {
		sendText,
		sendMedia,
		sendLocation,
		sendContactCard,
		sendCalendarEvent,
		sendLinkButton,
		reply,
		react,
		editText,
		editCaption,
		delete: remove,
		getStatus,
		get: getMessage,
		getMany: getMessages,
	},
	contact: { get: getContact, getMany: getContacts },
	group: { get: getGroup, getMany: getGroups },
	number: { getMany: getNumbers },
};
