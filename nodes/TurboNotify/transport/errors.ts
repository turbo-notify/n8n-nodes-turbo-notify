import type { IDataObject, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import type { TurboNotifyContext } from './context';

/**
 * Throttling answers that clear by themselves within seconds. A refused request
 * was never accepted, so repeating it cannot send anything twice.
 */
export const RETRY_CODES = new Set([
	'send_rate_spacing',
	'rate_limit_exceeded',
	'messages_per_minute_limit_exceeded',
]);

interface Described {
	message: string;
	description: string;
}

export function pick(source: unknown, ...keys: string[]): unknown {
	let current: unknown = source;
	for (const key of keys) {
		if (current === null || typeof current !== 'object') return undefined;
		current = (current as IDataObject)[key];
	}
	return current;
}

export function statusOf(error: unknown): number | undefined {
	const raw =
		pick(error, 'httpCode') ??
		pick(error, 'statusCode') ??
		pick(error, 'response', 'status') ??
		pick(error, 'cause', 'response', 'status') ??
		pick(error, 'cause', 'status');
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function bodyOf(error: unknown): IDataObject {
	const body =
		pick(error, 'response', 'data') ??
		pick(error, 'response', 'body') ??
		pick(error, 'cause', 'response', 'data') ??
		pick(error, 'cause', 'response', 'body');
	if (typeof body === 'string') {
		try {
			return JSON.parse(body) as IDataObject;
		} catch {
			return {};
		}
	}
	return body && typeof body === 'object' ? (body as IDataObject) : {};
}

export function headerOf(error: unknown, name: string): string | undefined {
	const headers = pick(error, 'response', 'headers') ?? pick(error, 'cause', 'response', 'headers');
	if (!headers || typeof headers !== 'object') return undefined;
	const value = (headers as IDataObject)[name] ?? (headers as IDataObject)[name.toLowerCase()];
	return value === undefined ? undefined : String(value);
}

const DASHBOARD = 'https://dashboard.turbonotify.com';
const DOCS = 'https://docs.turbonotify.com/en';

/** "2 hours 42 minutes", "35 minutes", "less than a minute": how long until a limit renews. */
export function untilText(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.round((seconds % 3600) / 60);
	const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
	if (hours > 0)
		return minutes > 0
			? `${plural(hours, 'hour')} ${plural(minutes, 'minute')}`
			: plural(hours, 'hour');
	return minutes > 0 ? plural(minutes, 'minute') : 'less than a minute';
}

const KNOWN: Record<string, Described> = {
	not_authenticated: {
		message: 'The API key was not accepted',
		description:
			`Check the 'API Key' in the Turbo Notify API credential. A revoked or expired key never works again: create a new one under API keys in the dashboard (${DASHBOARD}/api-keys).`,
	},
	number_not_connected: {
		message: 'The number is not connected to WhatsApp',
		description: `Reconnect the number under Numbers in the Turbo Notify dashboard (${DASHBOARD}/numbers), then run the node again.`,
	},
	number_not_found: {
		message: 'The number was not found',
		description:
			"Check the 'Number' parameter. Use main, the alias of an extra number or its num_ ID.",
	},
	not_found: {
		message: 'Nothing was found for that ID on this number',
		description:
			"Ids belong to one number. Check that the 'Number' parameter is the number that sent or received it.",
	},
	feature_not_available: {
		message: 'The current plan does not include this feature',
		description:
			`Sending to groups and the typing indicator, for example, need a higher plan. Compare plans under Billing in the dashboard (${DASHBOARD}/billing).`,
	},
	subscription_inactive: {
		message: 'The subscription is not active',
		description:
			`Sort out the payment under Billing in the Turbo Notify dashboard (${DASHBOARD}/billing). Sends resume when the subscription is active.`,
	},
	messages_quota_exceeded: {
		message: "The number's message allowance is used up",
		description: `The allowance resets when the billing cycle turns. To send more now, change the plan under Billing in the dashboard (${DASHBOARD}/billing). Retrying now gives the same answer.`,
	},
	contact_quota_exceeded: {
		message: "The number's contact allowance is used up",
		description: `Each number can message a limited number of different contacts in a billing cycle, and a contact already messaged in this cycle can still receive messages. The allowance resets when the cycle turns. To message more people now, change the plan under Billing in the dashboard (${DASHBOARD}/billing). Retrying now gives the same answer.`,
	},
	edit_window_expired: {
		message: 'This message can no longer be edited',
		description:
			'A text or a caption can be changed only within 15 minutes of sending it. Send a new message instead.',
	},
	send_rate_spacing: {
		message: 'Messages are going out faster than this number allows',
		description:
			'The plan sets a minimum gap between sends on one number. The node waits and tries again up to 3 times when the wait is 30 seconds or less. Add a Wait node or Loop Over Items with a pause between sends, or choose a plan with a shorter gap.',
	},
	reply_ratio_too_low: {
		message: 'This number has sent much more than it has received',
		description:
			'Sending resumes when contacts reply or the volume drops. Waiting alone does not help. Send fewer messages to people who do not interact.',
	},
	duplicate_burst_blocked: {
		message: 'The same text went to too many recipients in the last hour',
		description:
			'Vary the text, for example with the name of each recipient, or space the sends out.',
	},
	warmup_limit_exceeded: {
		message: "This number's daily volume is still being released",
		description: `A new number sends a limited volume a day in its first week: 50 messages on the first day, 200 on the second, 500 on the third, 1,000 on the fourth and 2,000 a day until the seventh. After that only your plan limits apply. The schedule is at ${DOCS}/messages/rate-limits/.`,
	},
	recipients_per_day_limit_exceeded: {
		message: 'This recipient already received the daily maximum from this number',
		description:
			'A number can send up to 2,000 messages a day to the same recipient. Try again tomorrow.',
	},
	message_not_editable: {
		message: 'This message cannot be edited this way',
		description: 'Only text messages and the caption of an image, video or document can be edited.',
	},
};

const SERVER_HINT =
	"This happened on the Turbo Notify side. Reads are safe to repeat. For a send, check Message > Get Many with Direction 'Sent' before running it again, because the message may have gone out.";

/** What went wrong on the wire when there was no answer at all. */
function transportKind(error: unknown): 'timeout' | 'unreachable' | undefined {
	const code = String(pick(error, 'code') ?? pick(error, 'cause', 'code') ?? '');
	const text = error instanceof Error ? error.message : '';
	if (
		['ETIMEDOUT', 'ECONNABORTED', 'ESOCKETTIMEDOUT'].includes(code) ||
		/timeout|timed out|aborted/i.test(text)
	)
		return 'timeout';
	if (['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ECONNRESET'].includes(code)) return 'unreachable';
	return undefined;
}

function describe(status: number | undefined, body: IDataObject, error: unknown): Described {
	const code = typeof body.error === 'string' ? body.error : undefined;
	const known = code ? KNOWN[code] : undefined;
	let message = known?.message ?? (typeof body.message === 'string' ? body.message : undefined);
	let description = known?.description ?? (typeof body.hint === 'string' ? body.hint : '');

	if (code === 'warmup_limit_exceeded') {
		// The wait is the time left until the daily count starts again at midnight UTC.
		const wait = Number(headerOf(error, 'retry-after'));
		description = `${description} The count starts again at midnight UTC${
			Number.isFinite(wait) && wait > 0 ? `, in about ${untilText(wait)}` : ''
		}.`;
	} else if (code === 'messages_quota_exceeded' || code === 'contact_quota_exceeded') {
		const resets = Date.parse(String(pick(body, 'details', 'resets_at') ?? ''));
		if (!Number.isNaN(resets))
			description = `${description} It resets on ${new Date(resets).toISOString().slice(0, 10)} (UTC).`;
	}

	if (code === 'insufficient_scope') {
		const scope = typeof body.required_scope === 'string' ? body.required_scope : 'the required';
		message = 'The API key cannot do this';
		description = `Add the '${scope}' scope to the key, or create a key from a template that includes it.`;
	} else if (code === 'validation_error') {
		const errors = pick(body, 'details', 'errors');
		const fields = Array.isArray(errors)
			? (errors as IDataObject[])
					.map((e) => {
						const loc = Array.isArray(e.loc)
							? (e.loc as unknown[]).filter((p) => p !== 'body').join('.')
							: '';
						return `${loc}: ${String(e.msg ?? '')}`.trim();
					})
					.join('; ')
			: '';
		message = 'Turbo Notify rejected a value';
		description = fields || 'Check the values of the node.';
	} else if (code === 'feature_not_available' && typeof body.message === 'string') {
		description = `${body.message} ${description}`.trim();
	} else if (status === 429 && !known) {
		const wait = headerOf(error, 'retry-after');
		message = typeof body.message === 'string' ? body.message : 'Too many requests';
		description = wait ? `Wait ${wait} seconds and try again.` : 'Wait a moment and try again.';
	} else if (!known && status !== undefined && status >= 500) {
		message = `Turbo Notify could not complete the request (${status})`;
		description = SERVER_HINT;
	} else if (!known && status === undefined) {
		const kind = transportKind(error);
		if (kind === 'timeout') {
			message = 'Turbo Notify did not answer in time';
			description = SERVER_HINT;
		} else if (kind === 'unreachable') {
			message = 'Could not reach Turbo Notify';
			description =
				"Check 'Base URL' in the Turbo Notify API credential and the network of this n8n.";
		}
	}

	const title =
		message ?? (error instanceof Error ? error.message : 'The request did not complete');
	// The code helps people tell answers apart, except where it would put the word "error" in the text.
	return {
		message: code && code !== 'validation_error' ? `${title} (${code})` : title,
		description,
	};
}

type Failure = NonNullable<NonNullable<ConstructorParameters<typeof NodeApiError>[2]>['failure']>;

const THROTTLE_CODES = new Set([...RETRY_CODES, 'refresh_rate_limited', 'warmup_limit_exceeded']);
const QUOTA_CODES = new Set(['messages_quota_exceeded', 'contact_quota_exceeded']);
const MISSING_CODES = new Set(['number_not_found', 'invalid_number_id']);

/**
 * Tells n8n why the call failed. Declared only when the answer proves it: a 5xx or a
 * timeout on a send may have gone out, so those carry no cause.
 */
function failureOf(
	status: number | undefined,
	body: IDataObject,
	error: unknown,
): Failure | undefined {
	const code = typeof body.error === 'string' ? body.error : '';
	if (status === 401 || code === 'not_authenticated') return { cause: 'credential-invalid' };
	if (MISSING_CODES.has(code)) return { cause: 'configuration-invalid' };
	if (QUOTA_CODES.has(code)) {
		// The reset time is in the body when there is one, otherwise Retry-After says how many seconds are left.
		const seconds = Number(headerOf(error, 'retry-after'));
		const resets = Date.parse(String(pick(body, 'details', 'resets_at') ?? ''));
		if (!Number.isNaN(resets)) return { cause: 'quota-exhausted', resetsAtEpochMs: resets };
		return Number.isFinite(seconds) && seconds > 0
			? { cause: 'quota-exhausted', resetsAtEpochMs: Date.now() + Math.ceil(seconds * 1000) }
			: { cause: 'quota-exhausted' };
	}
	if (status === 429 && THROTTLE_CODES.has(code)) {
		const seconds = Number(headerOf(error, 'retry-after'));
		return Number.isFinite(seconds) && seconds > 0
			? { cause: 'rate-limited', retryAfterMs: Math.ceil(seconds * 1000) }
			: { cause: 'rate-limited' };
	}
	if (status === 503 && code === 'service_unavailable') return { cause: 'temporarily-unavailable' };
	return undefined;
}

export function toApiError(
	context: TurboNotifyContext,
	error: unknown,
	itemIndex?: number,
): NodeApiError {
	const status = statusOf(error);
	const body = bodyOf(error);
	const { message, description } = describe(status, body, error);
	// n8n's request helper already throws a NodeApiError, and wrapping one returns it unchanged
	// with our message dropped. Build from the original answer instead, and set the hint afterwards
	// because the constructor fills the description from the body.
	const source = error instanceof NodeApiError ? (error.cause ?? error) : error;
	const wrapped = new NodeApiError(context.getNode(), source as JsonObject, {
		message,
		description,
		httpCode: status === undefined ? undefined : String(status),
		itemIndex,
		failure: failureOf(status, body, error),
	});
	// n8n rewrites the message of some network codes (ECONNABORTED and the like): ours says more.
	wrapped.message = message;
	wrapped.description = description;
	return wrapped;
}
