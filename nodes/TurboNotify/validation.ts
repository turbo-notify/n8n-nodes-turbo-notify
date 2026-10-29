import type { IDataObject, INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/** Where a value comes from: the node and the input item being processed. */
export interface Scope {
	node: INode;
	itemIndex: number;
	items: number;
	/** Idempotency keys typed in this run, and what each one was used for. */
	keys: Map<string, string>;
}

/**
 * A value the user typed is not acceptable. The message names the n8n
 * parameter in single quotes and the hint says what to change.
 */
export function fail(scope: Scope, message: string, hint: string): never {
	const suffix = scope.items > 1 ? ` [Item ${scope.itemIndex}]` : '';
	throw new NodeOperationError(scope.node, `${message}${suffix}`, {
		itemIndex: scope.itemIndex,
		description: hint,
	});
}

const MESSAGE_ID = /^msg_[0-9a-f]{32}$/;
const CONTACT_ID = /^ct_[0-9a-f]{32}$/;
const GROUP_ID = /^grp_[0-9a-f]{32}$/;
const PHONE = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A string, or a number that arrived from an earlier node (a phone column, an order number). */
export function asString(value: unknown): string {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return '';
}

export function requireText(s: Scope, value: unknown, field: string, max: number): string {
	if (value !== null && typeof value === 'object') {
		fail(
			s,
			`'${field}' holds an object or a list, not text`,
			'Map a text value, for example {{ $json.output.reply }}, or turn the whole object into text with {{ JSON.stringify($json.output) }}.',
		);
	}
	const text = asString(value);
	if (text === '') {
		fail(
			s,
			`'${field}' is empty`,
			`Fill in '${field}', or check that the field you mapped exists in the incoming item.`,
		);
	}
	if (text.length > max) {
		fail(
			s,
			`'${field}' is too long (${text.length} characters, the limit is ${max})`,
			`Shorten '${field}' to ${max} characters or fewer.`,
		);
	}
	return text;
}

export function optionalText(
	s: Scope,
	value: unknown,
	field: string,
	max: number,
): string | undefined {
	const text = asString(value);
	return text === '' ? undefined : requireText(s, text, field, max);
}

export function requirePhone(s: Scope, value: unknown, field: string): string {
	const raw = asString(value);
	if (raw === '') {
		fail(
			s,
			`'${field}' is empty`,
			'Type a number such as +5511977770001, or map one from the previous node.',
		);
	}
	const cleaned = raw.replace(/[\s\-().]/g, '');
	if (!PHONE.test(cleaned)) {
		fail(
			s,
			`'${field}' is not a valid international number`,
			"Start with + and the country code, then the number, for example +5511977770001. If your data has digits only, build the value with {{ '+' + $json.phone }}.",
		);
	}
	return cleaned;
}

function requireId(
	s: Scope,
	value: unknown,
	field: string,
	pattern: RegExp,
	prefix: string,
	empty: string,
): string {
	const id = asString(value);
	if (id === '') fail(s, `'${field}' is empty`, empty);
	if (id.startsWith('evt_')) {
		fail(
			s,
			`'${field}' holds an event ID`,
			'An item from the Trigger carries the message in data: map {{ $json.data.id }}.',
		);
	}
	if (!pattern.test(id)) {
		fail(
			s,
			`'${field}' is not a valid ID`,
			`It starts with ${prefix}_ followed by 32 letters and digits, for example ${prefix}_0198d3c5a1b24d3e9f01a2b3c4d5e6f7.`,
		);
	}
	return id;
}

export const messageId = (s: Scope, v: unknown, field = 'Message ID') =>
	requireId(
		s,
		v,
		field,
		MESSAGE_ID,
		'msg',
		'Map the ID of the message: {{ $json.id }} after another Turbo Notify step, {{ $json.data.id }} after the Trigger.',
	);
export const contactId = (s: Scope, v: unknown, field = 'Contact') =>
	requireId(
		s,
		v,
		field,
		CONTACT_ID,
		'ct',
		'Pick a contact from the list, or map its ID from the previous node.',
	);
export const groupId = (s: Scope, v: unknown, field = 'Group') =>
	requireId(
		s,
		v,
		field,
		GROUP_ID,
		'grp',
		'Pick a group from the list, or map its ID from the previous node.',
	);

export function requireHttpUrl(s: Scope, value: unknown, field: string, max = 2083): string {
	const text = requireText(s, value, field, max);
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		fail(
			s,
			`'${field}' is not a valid web address`,
			'Use a full address such as https://example.com/file.',
		);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		fail(
			s,
			`'${field}' must start with http:// or https://`,
			'Use a full address such as https://example.com/file.',
		);
	}
	return text;
}

export function requireNumberInRange(
	s: Scope,
	value: unknown,
	field: string,
	min: number,
	max: number,
): number {
	// Only a number or a numeric text counts: blank, true, a list or an object are not zero.
	const numeric = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
	const n = numeric ? Number(value) : Number.NaN;
	if (!Number.isFinite(n) || n < min || n > max) {
		fail(
			s,
			`'${field}' must be a number from ${min} to ${max}`,
			`Enter a value between ${min} and ${max}.`,
		);
	}
	return n;
}

const ISO_DATE_TIME =
	/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MIN_EPOCH_MS = 1e11;

/**
 * ISO 8601 text, a Date, a Luxon DateTime, or a Unix time in milliseconds. Other text (03/11/2026, 1)
 * is refused instead of read as some other date, and so are epoch seconds.
 */
function dateTimeText(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'number') {
		return Number.isFinite(value) && value >= MIN_EPOCH_MS ? new Date(value).toISOString() : '';
	}
	if (
		value !== null &&
		typeof value === 'object' &&
		typeof (value as { toISO?: unknown }).toISO === 'function'
	) {
		return String((value as { toISO: () => string | null }).toISO() ?? '');
	}
	const text = asString(value);
	return ISO_DATE_TIME.test(text) ? text : '';
}

export function requireDateTime(s: Scope, value: unknown, field: string): string {
	const text = dateTimeText(value);
	const time = Date.parse(text);
	if (text === '' || Number.isNaN(time)) {
		fail(
			s,
			`'${field}' is not a valid date and time`,
			"Pick a date and time, or use an ISO 8601 value such as 2026-11-03T14:00:00-03:00. For another format, convert it first, for example {{ DateTime.fromFormat($json.date, 'dd/MM/yyyy HH:mm').toISO() }}.",
		);
	}
	return new Date(time).toISOString();
}

export function idempotencyKey(s: Scope, value: unknown): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const key = typeof value === 'string' ? value : String(value);
	if (key.trim() === '' || key.length > 255) {
		fail(
			s,
			"'Idempotency Key' must have 1 to 255 characters",
			'Use a short stable value, such as the ID of the order that triggers the message.',
		);
	}
	if (!/^[\x20-\x7e]+$/.test(key)) {
		fail(
			s,
			"'Idempotency Key' has characters that are not plain letters, digits or punctuation",
			'Use letters, digits and punctuation only, for example order-4711.',
		);
	}
	return key;
}

export function requireInteger(
	s: Scope,
	value: unknown,
	field: string,
	min: number,
	max: number,
): number {
	const n = requireNumberInRange(s, value, field, min, max);
	if (!Number.isInteger(n)) {
		fail(s, `'${field}' must be a whole number`, `Enter a whole number between ${min} and ${max}.`);
	}
	return n;
}

/** A Get Many filter that is switched on must carry a value: an empty one would silently widen the search. */
export function filterValue(
	s: Scope,
	filters: IDataObject,
	key: string,
	field: string,
): string | undefined {
	if (!(key in filters)) return undefined;
	const text = asString(filters[key]);
	if (text === '') {
		fail(
			s,
			`The '${field}' filter is empty`,
			`Fill in '${field}', or remove the filter to return everything.`,
		);
	}
	return text;
}

export function limitValue(s: Scope, value: unknown): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) {
		fail(
			s,
			"'Limit' must be a whole number of 1 or more",
			'Enter how many results to return, or turn on Return All.',
		);
	}
	return n;
}

/** A true or false that may arrive from an expression as text. "false" must not count as true, and an unknown word is refused. */
export function asBoolean(s: Scope, value: unknown, field: string, fallback = false): boolean {
	if (typeof value === 'boolean') return value;
	if (value === undefined || value === null) return fallback;
	if (typeof value === 'number') return value !== 0;
	if (typeof value === 'string') {
		const text = value.trim().toLowerCase();
		if (text === '') return fallback;
		if (['true', '1', 'yes', 'on'].includes(text)) return true;
		if (['false', '0', 'no', 'off'].includes(text)) return false;
	}
	fail(
		s,
		`'${field}' must be true or false`,
		'Use true or false, or an expression that returns one of them.',
	);
}

export function recipient(
	s: Scope,
	params: { type: unknown; phone: unknown; contact: unknown; group: unknown; auto: unknown },
): IDataObject {
	switch (params.type) {
		case 'auto': {
			// One value from anywhere: the prefix tells a contact or group ID from a phone number.
			const value = asString(params.auto);
			if (value.startsWith('ct_')) return { contact_id: contactId(s, value, 'To') };
			if (value.startsWith('grp_')) return { group_id: groupId(s, value, 'To') };
			return { number: requirePhone(s, value, 'To') };
		}
		case 'contact':
			return { contact_id: contactId(s, params.contact) };
		case 'group':
			return { group_id: groupId(s, params.group) };
		case 'phone':
			return { number: requirePhone(s, params.phone, 'Phone Number') };
		default:
			fail(
				s,
				"'Recipient Type' is not one of Phone Number, Contact, Group or Auto-Detect",
				'Choose one of the four values, or fix the expression that sets it.',
			);
	}
}

const MAX_CARD_ENTRIES = 10;

export function emailList(s: Scope, entries: unknown): IDataObject[] | undefined {
	const list = Array.isArray(entries) ? (entries as IDataObject[]) : [];
	if (list.length === 0) return undefined;
	if (list.length > MAX_CARD_ENTRIES) {
		fail(
			s,
			"'Emails' accepts up to 10 addresses",
			'Remove some addresses, the card holds 10 at most.',
		);
	}
	return list.map((entry) => {
		const address = asString(entry.address);
		if (!EMAIL.test(address)) {
			fail(
				s,
				"'Emails' has an address that is not valid",
				'Check each address, for example maria@example.com.',
			);
		}
		const label = optionalText(s, entry.label, 'Emails', 30);
		return label ? { label, address } : { address };
	});
}

export function phoneList(s: Scope, entries: unknown): IDataObject[] {
	const list = Array.isArray(entries) ? (entries as IDataObject[]) : [];
	if (list.length === 0) {
		fail(s, "'Phones' is empty", 'Add at least one phone number to the contact card.');
	}
	if (list.length > MAX_CARD_ENTRIES) {
		fail(s, "'Phones' accepts up to 10 numbers", 'Remove some numbers, the card holds 10 at most.');
	}
	return list.map((entry, index) => {
		const number = requirePhone(
			s,
			entry.number,
			list.length > 1 ? `Phones, entry ${index + 1}` : 'Phones',
		);
		const label = optionalText(s, entry.label, 'Phones', 30);
		return label ? { label, number } : { number };
	});
}

/**
 * A list that arrives from an earlier node as an array, or typed as text: JSON, one value, or several
 * separated by commas, semicolons or lines (a spreadsheet cell). Items are plain values
 * (`"+5511977770001"`) or objects (`{"number": "...", "label": "Work"}`).
 * Returns undefined when the field is empty.
 */
export function listInput(
	s: Scope,
	value: unknown,
	field: string,
	key: string,
): IDataObject[] | undefined {
	let list: unknown = value;
	if (typeof list === 'string') {
		const text = list.trim();
		if (text === '') return undefined;
		if (text.startsWith('[') || text.startsWith('{')) {
			try {
				list = JSON.parse(text);
			} catch {
				fail(
					s,
					`'${field}' is not valid JSON`,
					`Use a list such as ["${key === 'number' ? '+5511977770001' : 'maria@example.com'}"].`,
				);
			}
		} else {
			list = text
				.split(/[,;\n]/)
				.map((part) => part.trim())
				.filter((part) => part !== '');
		}
	}
	if (list === undefined || list === null) return undefined;
	if (!Array.isArray(list)) {
		fail(
			s,
			`'${field}' must be a list`,
			'Wrap the value in square brackets, or map an array from an earlier node.',
		);
	}
	if (list.length === 0) return undefined;
	return list.map((entry): IDataObject => {
		if (entry !== null && typeof entry === 'object') return entry as IDataObject;
		return { [key]: entry as string };
	});
}
