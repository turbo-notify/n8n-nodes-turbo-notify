import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import * as v from '../validation';

/** The request of one item, ready to run. Everything that can be refused is refused before it exists. */
export type Run = () => Promise<IDataObject | IDataObject[]>;

/**
 * Reads and validates one item, then hands back what to run. The node prepares every item before it
 * runs the first one, so a bad row 57 stops the run before row 1 is sent.
 */
export type Handler = (context: IExecuteFunctions, i: number, ref: string, s: v.Scope) => Run;

export const param = <T = unknown>(
	context: IExecuteFunctions,
	name: string,
	i: number,
	fallback?: unknown,
): T => context.getNodeParameter(name, i, fallback) as T;

/** An ID typed, mapped from an expression, or picked from a list (resource locator): n8n hands over the plain value. */
export const locator = (context: IExecuteFunctions, name: string, i: number): unknown =>
	context.getNodeParameter(name, i, '', { extractValue: true });

/** The same for a picker inside a collection (Filters), where n8n leaves the locator object as it is. */
export const unwrapLocator = (raw: unknown): unknown =>
	raw !== null && typeof raw === 'object' && 'value' in raw
		? (raw as { value: unknown }).value
		: raw;

export const additionalFieldsOf = (context: IExecuteFunctions, i: number): IDataObject =>
	param<IDataObject>(context, 'additionalFields', i, {});

export const optionsOf = (context: IExecuteFunctions, i: number): IDataObject =>
	param<IDataObject>(context, 'options', i, {});

export const setIf = (target: IDataObject, key: string, value: unknown): void => {
	if (value !== undefined) target[key] = value as IDataObject[string];
};

/** What Simplify keeps. The list of messages has only a preview; a single message keeps its text. */
export const SIMPLE_FIELDS = {
	message: [
		'id',
		'number_id',
		'number_alias',
		'direction',
		'content_type',
		'preview',
		'at',
		'from',
		'to',
		'status',
	],
	messageOne: [
		'id',
		'number_id',
		'direction',
		'content_type',
		'text',
		'at',
		'from',
		'to',
		'status',
		'content_expired',
	],
	contact: [
		'id',
		'name',
		'phone_number',
		'number_alias',
		'is_self',
		'first_messaged_at',
		'last_interaction_at',
	],
	group: [
		'id',
		'name',
		'description',
		'participants_count',
		'is_active',
		'number_alias',
		'is_announce_only',
	],
} as const;

/**
 * What the next node needs next to the API answer: `id` (the message ID, the same key Get and Get Many use,
 * so `{{ $json.id }}` works after any message step), the number that was used (as `number_id` or
 * `number_alias`, the names Get, Get Many and the Trigger use) and for sends the recipient as sent.
 */
export function withContext(body: IDataObject, ref: string, to?: IDataObject): IDataObject {
	const { message_id: messageId, ...rest } = body;
	const out: IDataObject = typeof messageId === 'string' ? { id: messageId, ...rest } : { ...rest };
	out[/^num_[0-9a-f]{32}$/.test(ref) ? 'number_id' : 'number_alias'] = ref;
	if (to) out.to = to;
	return out;
}

/**
 * Without a key typed by the user, a real run (not a test click) sends one that is the same
 * when n8n repeats the item (Retry On Fail re-runs the whole node) and different for every
 * item, node and loop pass, so a repeat never sends the message twice.
 */
function automaticKey(context: IExecuteFunctions, i: number): string | undefined {
	if (context.getMode() === 'manual') return undefined;
	const executionId = context.getExecutionId();
	if (!executionId) return undefined;
	// The instance is part of the key: execution numbers restart on a fresh or restored n8n, and the API remembers keys.
	const instance = context.getInstanceId().slice(0, 12);
	return `n8n-${instance}-${executionId}-${context.getNode().id}-${context.getWorkflowDataProxy(i).$runIndex}-${i}`;
}

/**
 * The Idempotency-Key header of a send. A key stands for one message: used again in the same run for
 * a different message it would silently drop the second, so that is refused.
 */
export function idempotencyHeaders(
	context: IExecuteFunctions,
	i: number,
	s: v.Scope,
	target: string,
): IDataObject {
	const typed = v.idempotencyKey(s, optionsOf(context, i).idempotencyKey);
	if (typed) {
		const before = s.keys.get(typed);
		if (before !== undefined && before !== target) {
			v.fail(
				s,
				"'Idempotency Key' is already used by another message in this run",
				'A key stands for one message, so a repeated key sends only the first. Make it differ for every item, for example {{ $json.orderId }}.',
			);
		}
		s.keys.set(typed, target);
	}
	const key = typed ?? automaticKey(context, i);
	return key ? { 'Idempotency-Key': key } : {};
}

/** Get of one record, or Get Many: the full record by default turned into the main fields when Simplify is on. */
export const simplifier = (
	s: v.Scope,
	context: IExecuteFunctions,
	i: number,
): ((record: IDataObject, fields: readonly string[]) => IDataObject) => {
	const on = v.asBoolean(s, param(context, 'simplify', i, true), 'Simplify', true);
	return (record, fields) => {
		if (!on) return record;
		const out: IDataObject = {};
		for (const key of fields) if (record[key] !== undefined) out[key] = record[key];
		return out;
	};
};
