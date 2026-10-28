import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

export type TurboNotifyContext = IExecuteFunctions | IPollFunctions | ILoadOptionsFunctions;

export const CREDENTIAL = 'turboNotifyApi';
export const PAGE_SIZE = 200;

interface RequestInput {
	method: IHttpRequestMethods;
	path: string;
	qs?: IDataObject;
	body?: IDataObject;
	headers?: IDataObject;
	arrayFormat?: 'brackets';
	itemIndex?: number;
}

async function baseUrl(context: TurboNotifyContext): Promise<string> {
	const credentials = await context.getCredentials(CREDENTIAL);
	const raw = String(credentials.baseUrl ?? '').trim().replace(/\/+$/, '');
	let parsed: URL | undefined;
	try {
		parsed = new URL(raw);
	} catch {
		parsed = undefined;
	}
	if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
		throw new NodeOperationError(
			context.getNode(),
			"'Base URL' in the Turbo Notify API credential is not a valid web address",
			{ description: 'Use https://api.turbonotify.com unless support gave you another address.' },
		);
	}
	return raw;
}

export function numberPath(ref: string): string {
	return `/numbers/${encodeURIComponent(ref)}`;
}

/** One call to the Turbo Notify API, authenticated with the credential. */
export async function apiRequest(context: TurboNotifyContext, input: RequestInput): Promise<unknown> {
	const options: IHttpRequestOptions = {
		method: input.method,
		url: `${await baseUrl(context)}/v1${input.path}`,
		json: true,
	};
	if (input.qs && Object.keys(input.qs).length > 0) options.qs = input.qs;
	if (input.body) options.body = input.body;
	if (input.arrayFormat) options.arrayFormat = input.arrayFormat;
	if (input.headers && Object.keys(input.headers).length > 0) options.headers = input.headers as never;

	try {
		return await context.helpers.httpRequestWithAuthentication.call(context, CREDENTIAL, options);
	} catch (error) {
		throw toApiError(context, error, input.itemIndex);
	}
}

interface Described {
	message: string;
	description: string;
}

function pick(source: unknown, ...keys: string[]): unknown {
	let current: unknown = source;
	for (const key of keys) {
		if (current === null || typeof current !== 'object') return undefined;
		current = (current as IDataObject)[key];
	}
	return current;
}

function statusOf(error: unknown): number | undefined {
	const raw =
		pick(error, 'httpCode') ??
		pick(error, 'statusCode') ??
		pick(error, 'response', 'status') ??
		pick(error, 'cause', 'response', 'status') ??
		pick(error, 'cause', 'status');
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function bodyOf(error: unknown): IDataObject {
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

function headerOf(error: unknown, name: string): string | undefined {
	const headers = pick(error, 'response', 'headers') ?? pick(error, 'cause', 'response', 'headers');
	if (!headers || typeof headers !== 'object') return undefined;
	const value = (headers as IDataObject)[name] ?? (headers as IDataObject)[name.toLowerCase()];
	return value === undefined ? undefined : String(value);
}

const KNOWN: Record<string, Described> = {
	not_authenticated: {
		message: 'The API key was not accepted',
		description:
			"Check the 'API Key' in the Turbo Notify API credential. A revoked or expired key never works again: create a new one in the dashboard under API keys.",
	},
	number_not_connected: {
		message: 'The number is not connected to WhatsApp',
		description: 'Reconnect the number in the Turbo Notify dashboard, then run the node again.',
	},
	number_not_found: {
		message: 'The number was not found',
		description: "Check the 'Number' parameter. Use main, the alias of an extra number or its num_ id.",
	},
	not_found: {
		message: 'Nothing was found for that id on this number',
		description:
			"Ids belong to one number. Check that the 'Number' parameter is the number that sent or received it.",
	},
	feature_not_available: {
		message: 'The current plan does not include this feature',
		description: 'Sending to groups, reactions and some reads need a higher plan. See Quota and usage in the Turbo Notify docs.',
	},
	subscription_inactive: {
		message: 'The subscription is not active',
		description: 'Sort out the payment under Billing in the Turbo Notify dashboard. Sends resume when the subscription is active.',
	},
	messages_quota_exceeded: {
		message: "The number's message allowance is used up",
		description: 'The allowance resets when the billing cycle turns, or when the plan changes. Retrying now gives the same answer.',
	},
	contact_quota_exceeded: {
		message: "The number's contact allowance is used up",
		description: 'The allowance resets when the billing cycle turns, or when the plan changes. Retrying now gives the same answer.',
	},
	edit_window_expired: {
		message: 'This message can no longer be edited',
		description: 'A text or a caption can be changed only within 15 minutes of sending it. Send a new message instead.',
	},
	message_not_editable: {
		message: 'This message cannot be edited this way',
		description: 'Only text messages and the caption of an image, video or document can be edited.',
	},
};

function describe(status: number | undefined, body: IDataObject, error: unknown): Described {
	const code = typeof body.error === 'string' ? body.error : undefined;
	const known = code ? KNOWN[code] : undefined;
	let message = known?.message ?? (typeof body.message === 'string' ? body.message : undefined);
	let description = known?.description ?? (typeof body.hint === 'string' ? body.hint : '');

	if (code === 'insufficient_scope') {
		const scope = typeof body.required_scope === 'string' ? body.required_scope : 'the required';
		message = 'The API key cannot do this';
		description = `Add the '${scope}' scope to the key, or create a key from a template that includes it.`;
	} else if (code === 'validation_error') {
		const errors = pick(body, 'details', 'errors');
		const fields = Array.isArray(errors)
			? (errors as IDataObject[])
					.map((e) => {
						const loc = Array.isArray(e.loc) ? (e.loc as unknown[]).filter((p) => p !== 'body').join('.') : '';
						return `${loc}: ${String(e.msg ?? '')}`.trim();
					})
					.join('; ')
			: '';
		message = 'Turbo Notify rejected a value';
		description = fields || 'Check the values of the node.';
	} else if (status === 429 && !known) {
		const wait = headerOf(error, 'retry-after');
		message = 'Too many requests';
		description = wait ? `Wait ${wait} seconds and try again.` : 'Wait a moment and try again.';
	}

	const title = message ?? (error instanceof Error ? error.message : 'The request did not complete');
	return { message: code ? `${title} (${code})` : title, description };
}

export function toApiError(context: TurboNotifyContext, error: unknown, itemIndex?: number): NodeApiError {
	const status = statusOf(error);
	const { message, description } = describe(status, bodyOf(error), error);
	return new NodeApiError(context.getNode(), error as JsonObject, {
		message,
		description,
		httpCode: status === undefined ? undefined : String(status),
		itemIndex,
	});
}

interface Page {
	data?: IDataObject[];
	cursor?: string | null;
	has_more?: boolean;
}

/**
 * Cursor pagination. Without `returnAll`, asks only for what is left of
 * `limit` and stops as soon as it has enough.
 */
export async function requestMany(
	context: TurboNotifyContext,
	input: { path: string; qs?: IDataObject; itemIndex?: number },
	returnAll: boolean,
	limit: number,
): Promise<IDataObject[]> {
	const results: IDataObject[] = [];
	let cursor: string | undefined;
	do {
		const remaining = returnAll ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - results.length);
		const qs: IDataObject = { limit: remaining, ...input.qs };
		if (cursor) qs.cursor = cursor;
		const page = (await apiRequest(context, { method: 'GET', path: input.path, qs, itemIndex: input.itemIndex })) as Page;
		results.push(...(page.data ?? []));
		cursor = page.has_more && page.cursor ? page.cursor : undefined;
	} while (cursor && (returnAll || results.length < limit));
	return returnAll ? results : results.slice(0, limit);
}

export function pickFields(source: IDataObject, keys: string[]): IDataObject {
	const out: IDataObject = {};
	for (const key of keys) {
		if (source[key] !== undefined) out[key] = source[key];
	}
	return out;
}
