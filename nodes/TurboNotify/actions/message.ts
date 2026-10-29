import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { apiRequest, numberPath, requestMany } from '../transport/request';
import * as v from '../validation';
import {
	type Handler,
	SIMPLE_FIELDS,
	additionalFieldsOf,
	idempotencyHeaders,
	locator,
	param,
	setIf,
	simplifier,
	unwrapLocator,
	withContext,
} from './shared';

function recipientOf(context: IExecuteFunctions, i: number, s: v.Scope): IDataObject {
	const type = param(context, 'recipientType', i, 'phone');
	// A picker that is not on screen cannot be read: n8n answers 'Could not find property'.
	return v.recipient(s, {
		type,
		phone: type === 'phone' ? param(context, 'phoneNumber', i, '') : '',
		contact: type === 'contact' ? locator(context, 'contactId', i) : '',
		group: type === 'group' ? locator(context, 'groupId', i) : '',
		auto: type === 'auto' ? param(context, 'recipient', i, '') : '',
	});
}

type Build = (
	context: IExecuteFunctions,
	i: number,
	extras: IDataObject,
	s: v.Scope,
) => IDataObject;

/** Sends one message. `build` returns the `content` object, already validated. */
function send(build: Build): Handler {
	return (context, i, ref, s) => {
		const extras = additionalFieldsOf(context, i);
		const to = recipientOf(context, i, s);
		const content = build(context, i, extras, s);
		const body: IDataObject = { to, content };
		if (extras.quotedMessageId !== undefined && v.asString(extras.quotedMessageId) !== '') {
			body.quoted_message_id = v.messageId(s, extras.quotedMessageId, 'Quoted Message ID');
		}
		const headers = idempotencyHeaders(context, i, s, JSON.stringify([ref, body]));
		return async () =>
			withContext(
				await apiRequest(context, {
					method: 'POST',
					path: `${numberPath(ref)}/messages`,
					body,
					headers,
					itemIndex: i,
				}),
				ref,
				to,
			);
	};
}

const MEDIA_FIELD = {
	image: 'image_url',
	video: 'video_url',
	audio: 'audio_url',
	document: 'document_url',
	sticker: 'sticker_url',
} as const;
type MediaType = keyof typeof MEDIA_FIELD;

const isMediaType = (value: unknown): value is MediaType =>
	typeof value === 'string' && Object.prototype.hasOwnProperty.call(MEDIA_FIELD, value);

const sendText = send((context, i, _extras, s) => ({
	text: v.requireText(s, param(context, 'text', i, ''), 'Text', 4096),
}));

const sendMedia = send((context, i, _extras, s) => {
	const type = param(context, 'mediaType', i, 'image');
	if (!isMediaType(type)) {
		v.fail(
			s,
			"'Media Type' must be image, video, audio, document or sticker",
			'Choose one of those five values, or fix the expression.',
		);
	}
	const content: IDataObject = {
		[MEDIA_FIELD[type]]: v.requireHttpUrl(s, param(context, 'mediaUrl', i, ''), 'Media URL'),
	};
	if (type === 'image' || type === 'video' || type === 'document') {
		setIf(content, 'caption', v.optionalText(s, param(context, 'caption', i, ''), 'Caption', 1024));
	}
	if (type === 'document') {
		setIf(
			content,
			'filename',
			v.optionalText(s, param(context, 'fileName', i, ''), 'File Name', 255),
		);
	}
	return content;
});

const sendLocation = send((context, i, extras, s) => {
	const content: IDataObject = {
		latitude: v.requireNumberInRange(s, param(context, 'latitude', i), 'Latitude', -90, 90),
		longitude: v.requireNumberInRange(s, param(context, 'longitude', i), 'Longitude', -180, 180),
	};
	setIf(content, 'name', v.optionalText(s, extras.name, 'Name', 200));
	setIf(content, 'address', v.optionalText(s, extras.address, 'Address', 500));
	setIf(
		content,
		'url',
		v.asString(extras.url) === '' ? undefined : v.requireHttpUrl(s, extras.url, 'URL'),
	);
	return content;
});

const sendContactCard = send((context, i, extras, s) => {
	const phones =
		param(context, 'phonesInput', i, 'fields') === 'json'
			? v.listInput(s, param(context, 'phonesJson', i, ''), 'Phones', 'number')
			: param<IDataObject>(context, 'phones', i, {}).phoneValues;
	const emails =
		v.listInput(s, extras.emailsJson, 'Emails (JSON)', 'address') ??
		(extras.emails as IDataObject | undefined)?.emailValues;
	const content: IDataObject = {
		display_name: v.requireText(s, param(context, 'displayName', i, ''), 'Display Name', 200),
		phones: v.phoneList(s, phones),
	};
	setIf(content, 'emails', v.emailList(s, emails));
	setIf(content, 'organization', v.optionalText(s, extras.organization, 'Organization', 200));
	setIf(content, 'title', v.optionalText(s, extras.title, 'Title', 100));
	setIf(content, 'address', v.optionalText(s, extras.address, 'Address', 500));
	return content;
});

const sendCalendarEvent = send((context, i, extras, s) => {
	const start = v.requireDateTime(s, param(context, 'startAt', i, ''), 'Start Time');
	const content: IDataObject = {
		name: v.requireText(s, param(context, 'eventName', i, ''), 'Event Name', 200),
		start_at: start,
	};
	if (v.asString(extras.endAt) !== '') {
		const end = v.requireDateTime(s, extras.endAt, 'End Time');
		if (Date.parse(end) <= Date.parse(start)) {
			v.fail(
				s,
				"'End Time' must be after 'Start Time'",
				'Pick an end time later than the start time, or leave it empty.',
			);
		}
		content.end_at = end;
	}
	setIf(content, 'description', v.optionalText(s, extras.description, 'Description', 2000));
	setIf(
		content,
		'join_link',
		v.asString(extras.joinLink) === ''
			? undefined
			: v.requireHttpUrl(s, extras.joinLink, 'Join Link'),
	);
	// A reminder is on when it is given: minutes before the start.
	if (extras.remindBeforeMinutes !== undefined && v.asString(extras.remindBeforeMinutes) !== '') {
		content.has_reminder = true;
		content.reminder_offset_sec =
			v.requireInteger(s, extras.remindBeforeMinutes, 'Remind Before (Minutes)', 0, 525_600) * 60;
	}
	if (v.asBoolean(s, extras.extraGuestsAllowed, 'Extra Guests Allowed'))
		content.extra_guests_allowed = true;
	return content;
});

const sendLinkButton = send((context, i, extras, s) => {
	const content: IDataObject = {
		interactive_type: 'cta_url',
		body: v.requireText(s, param(context, 'body', i, ''), 'Body', 1024),
		url_button: {
			display_text: v.requireText(s, param(context, 'buttonText', i, ''), 'Button Text', 20),
			url: v.requireHttpUrl(s, param(context, 'buttonUrl', i, ''), 'Button URL'),
		},
	};
	const header = v.optionalText(s, extras.headerText, 'Header', 60);
	if (header) content.header = { type: 'text', text: header };
	setIf(content, 'footer', v.optionalText(s, extras.footer, 'Footer', 60));
	return content;
});

const messagePath = (context: IExecuteFunctions, i: number, ref: string, s: v.Scope): string =>
	`${numberPath(ref)}/messages/${v.messageId(s, param(context, 'messageId', i, ''))}`;

/** An action on one message: validated now, sent when run. The answer gets `id` and the number. */
function action(
	suffix: string,
	body: (context: IExecuteFunctions, i: number, s: v.Scope) => IDataObject | undefined,
	extra: (answer: IDataObject, built: IDataObject | undefined) => IDataObject = (answer) => answer,
): Handler {
	return (context, i, ref, s) => {
		const path = `${messagePath(context, i, ref, s)}${suffix}`;
		const built = body(context, i, s);
		const headers =
			suffix === '/reply'
				? idempotencyHeaders(context, i, s, JSON.stringify([path, built]))
				: undefined;
		return async () =>
			extra(
				withContext(
					await apiRequest(context, { method: 'POST', path, body: built, headers, itemIndex: i }),
					ref,
				),
				built,
			);
	};
}

const reply = action('/reply', (context, i, s) => ({
	content: { text: v.requireText(s, param(context, 'text', i, ''), 'Text', 4096) },
}));
const react = action('/react', (context, i) => {
	const emoji = v.asString(param(context, 'reaction', i, ''));
	return { reaction: emoji === '' ? null : emoji };
});
const editText = action('/edit', (context, i, s) => ({
	text: v.requireText(s, param(context, 'text', i, ''), 'New Text', 4096),
}));
const editCaption = action('/edit', (context, i, s) => ({
	caption: v.requireText(s, param(context, 'caption', i, ''), 'New Caption', 1024),
}));
// The API accepts the deletion and WhatsApp finishes it a moment later: `deleted: true` means "accepted".
const remove = action(
	'/delete',
	() => undefined,
	(answer) => ({ ...answer, deleted: true }),
);

const sendTypingIndicator: Handler = (context, i, ref, s) => {
	const to = recipientOf(context, i, s);
	const isTyping = v.asBoolean(s, param(context, 'isTyping', i, true), 'Typing', true);
	return async () => {
		const done = await apiRequest(context, {
			method: 'POST',
			path: `${numberPath(ref)}/typing-indicator`,
			body: { to, is_typing: isTyping },
			itemIndex: i,
		});
		return { ...withContext(done, ref, to), is_typing: isTyping };
	};
};

const getStatus: Handler = (context, i, ref, s) => {
	const path = `${messagePath(context, i, ref, s)}/status`;
	return async () =>
		withContext(await apiRequest(context, { method: 'GET', path, itemIndex: i }), ref);
};

const getQuota: Handler = (context, i, ref) => async () =>
	withContext(
		await apiRequest(context, {
			method: 'GET',
			path: `${numberPath(ref)}/messages/quota`,
			itemIndex: i,
		}),
		ref,
	);

const getMessage: Handler = (context, i, ref, s) => {
	const path = messagePath(context, i, ref, s);
	const shape = simplifier(s, context, i);
	return async () =>
		shape(
			await apiRequest(context, { method: 'GET', path, itemIndex: i }),
			SIMPLE_FIELDS.messageOne,
		);
};

const getMessages: Handler = (context, i, ref, s) => {
	const returnAll = v.asBoolean(s, param(context, 'returnAll', i, false), 'Return All');
	const limit = returnAll ? 0 : v.limitValue(s, param(context, 'limit', i, 50));
	const filters = param<IDataObject>(context, 'filters', i, {});
	const qs: IDataObject = {};
	if (filters.direction) qs.direction = filters.direction;
	if ('groupId' in filters) qs.group_id = v.groupId(s, unwrapLocator(filters.groupId), 'Group');
	if ('contactId' in filters)
		qs.contact_id = v.contactId(s, unwrapLocator(filters.contactId), 'Contact');
	const shape = simplifier(s, context, i);
	return async () => {
		const items = await requestMany(
			context,
			{ path: `${numberPath(ref)}/messages`, qs, itemIndex: i },
			returnAll,
			limit,
		);
		return items.map((item) => shape(item, SIMPLE_FIELDS.message));
	};
};

export const messageHandlers: Record<string, Handler> = {
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
	sendTypingIndicator,
	getStatus,
	getQuota,
	get: getMessage,
	getMany: getMessages,
};
