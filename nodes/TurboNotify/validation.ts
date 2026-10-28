import type { IDataObject, INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/** Where a value comes from: the node and the input item being processed. */
export interface Scope {
	node: INode;
	itemIndex: number;
	items: number;
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

export function asString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

export function requireText(s: Scope, value: unknown, field: string, max: number): string {
	const text = asString(value);
	if (text === '') {
		fail(s, `'${field}' is empty`, `Type the ${field.toLowerCase()} to continue.`);
	}
	if (text.length > max) {
		fail(s, `'${field}' is too long (${text.length} characters, the limit is ${max})`,
			`Shorten the ${field.toLowerCase()} to ${max} characters or fewer.`,
		);
	}
	return text;
}

export function optionalText(s: Scope, value: unknown, field: string, max: number): string | undefined {
	const text = asString(value);
	return text === '' ? undefined : requireText(s, text, field, max);
}

export function requirePhone(s: Scope, value: unknown, field: string): string {
	const cleaned = asString(value).replace(/[\s\-().]/g, '');
	if (!PHONE.test(cleaned)) {
		fail(s, `'${field}' is not a valid international number`,
			'Start with + and the country code, then the number, for example +5511977770001.',
		);
	}
	return cleaned;
}

function requireId(s: Scope, value: unknown, field: string, pattern: RegExp, prefix: string): string {
	const id = asString(value);
	if (!pattern.test(id)) {
		fail(s, `'${field}' is not a valid id`,
			`It starts with ${prefix}_ followed by 32 letters and digits, for example ${prefix}_0198d3c5a1b24d3e9f01a2b3c4d5e6f7.`,
		);
	}
	return id;
}

export const messageId = (s: Scope, v: unknown, field = 'Message ID') => requireId(s, v, field, MESSAGE_ID, 'msg');
export const contactId = (s: Scope, v: unknown, field = 'Contact ID') => requireId(s, v, field, CONTACT_ID, 'ct');
export const groupId = (s: Scope, v: unknown, field = 'Group ID') => requireId(s, v, field, GROUP_ID, 'grp');

export function requireHttpUrl(s: Scope, value: unknown, field: string, max = 2083): string {
	const text = requireText(s, value, field, max);
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		fail(s, `'${field}' is not a valid web address`, 'Use a full address such as https://example.com/file.');
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		fail(s, `'${field}' must start with http:// or https://`, 'Use a full address such as https://example.com/file.');
	}
	return text;
}

export function requireNumberInRange(s: Scope, value: unknown, field: string, min: number, max: number): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (value === '' || value === undefined || value === null || !Number.isFinite(n) || n < min || n > max) {
		fail(s, `'${field}' must be a number from ${min} to ${max}`, `Enter a value between ${min} and ${max}.`);
	}
	return n;
}

export function requireDateTime(s: Scope, value: unknown, field: string): string {
	const text = asString(value) || (value instanceof Date ? value.toISOString() : '');
	const time = Date.parse(text);
	if (text === '' || Number.isNaN(time)) {
		fail(s, `'${field}' is not a valid date and time`, 'Pick a date and time, or use an ISO 8601 value such as 2026-11-03T14:00:00Z.');
	}
	return new Date(time).toISOString();
}

export function idempotencyKey(s: Scope, value: unknown): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const key = typeof value === 'string' ? value : String(value);
	if (key.trim() === '' || key.length > 255) {
		fail(s, "'Idempotency Key' must have 1 to 255 characters", 'Use a short stable value, such as the id of the order that triggers the message.');
	}
	return key;
}

export function limitValue(s: Scope, value: unknown): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) {
		fail(s, "'Limit' must be a whole number of 1 or more", 'Enter how many results to return, or turn on Return All.');
	}
	return n;
}

export function recipient(
	s: Scope,
	params: {
	type: unknown;
	phone: unknown;
	contact: unknown;
	group: unknown;
}): IDataObject {
	switch (params.type) {
		case 'contact':
			return { contact_id: contactId(s, params.contact) };
		case 'group':
			return { group_id: groupId(s, params.group) };
		default:
			return { number: requirePhone(s, params.phone, 'Phone Number') };
	}
}

export function emailList(s: Scope, entries: unknown): IDataObject[] | undefined {
	const list = Array.isArray(entries) ? (entries as IDataObject[]) : [];
	if (list.length === 0) return undefined;
	if (list.length > 10) {
		fail(s, "'Emails' accepts up to 10 addresses", 'Remove some addresses.');
	}
	return list.map((entry) => {
		const address = asString(entry.address);
		if (!EMAIL.test(address)) {
			fail(s, "'Emails' has an address that is not valid", 'Check each address, for example maria@example.com.');
		}
		const label = optionalText(s, entry.label, 'Emails', 30);
		return label ? { label, address } : { address };
	});
}

export function phoneList(s: Scope, entries: unknown): IDataObject[] {
	const list = Array.isArray(entries) ? (entries as IDataObject[]) : [];
	if (list.length === 0 || list.length > 10) {
		fail(s, "'Phones' needs 1 to 10 numbers", 'Add at least one phone number to the contact card.');
	}
	return list.map((entry) => {
		const number = requirePhone(s, entry.number, 'Phones');
		const label = optionalText(s, entry.label, 'Phones', 30);
		return label ? { label, number } : { number };
	});
}
