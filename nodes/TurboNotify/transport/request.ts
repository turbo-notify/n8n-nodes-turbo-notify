import type { IDataObject, IHttpRequestMethods, IHttpRequestOptions } from 'n8n-workflow';
import { NodeOperationError, sleep } from 'n8n-workflow';
import { CREDENTIAL, type TurboNotifyContext } from './context';
import { RETRY_CODES, bodyOf, headerOf, statusOf, toApiError } from './errors';
import { USER_AGENT } from './version';

export const PAGE_SIZE = 200;

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const MIN_WAIT_MS = 500;
const MAX_WAIT_MS = 30_000;
const DEFAULT_WAIT_MS = 1_000;

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
	// The node adds /v1 itself, so a Base URL pasted with it still works.
	const raw = String(credentials.baseUrl ?? '')
		.trim()
		.replace(/\/+$/, '')
		.replace(/\/v1$/, '');
	let parsed: URL | undefined;
	try {
		parsed = new URL(raw);
	} catch {
		parsed = undefined;
	}
	const usable =
		parsed !== undefined &&
		(parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
		parsed.username === '' &&
		parsed.password === '' &&
		parsed.search === '' &&
		parsed.hash === '';
	if (!usable) {
		throw new NodeOperationError(
			context.getNode(),
			"'Base URL' in the Turbo Notify API credential is not a valid web address",
			{
				description:
					'Use https://api.turbonotify.com unless support gave you another address. It takes no login, query or fragment.',
			},
		);
	}
	return raw;
}

export function numberPath(ref: string): string {
	return `/numbers/${encodeURIComponent(ref)}`;
}

/** One call to the Turbo Notify API, authenticated with the credential. */
export async function apiRequest<T = IDataObject>(
	context: TurboNotifyContext,
	input: RequestInput,
): Promise<T> {
	const options: IHttpRequestOptions = {
		method: input.method,
		url: `${await baseUrl(context)}/v1${input.path}`,
		json: true,
		timeout: input.method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS,
	};
	if (input.qs && Object.keys(input.qs).length > 0) options.qs = input.qs;
	if (input.body) options.body = input.body;
	if (input.arrayFormat) options.arrayFormat = input.arrayFormat;
	options.headers = { 'User-Agent': USER_AGENT, ...input.headers };

	for (let attempt = 0; ; attempt++) {
		try {
			return (await context.helpers.httpRequestWithAuthentication.call(
				context,
				CREDENTIAL,
				options,
			)) as T;
		} catch (error) {
			const wait = attempt < MAX_RETRIES ? retryDelay(error) : undefined;
			if (wait === undefined) throw toApiError(context, error, input.itemIndex);
			await sleep(wait);
		}
	}
}

/** Milliseconds to wait before repeating a throttled request, or undefined when waiting cannot help. */
function retryDelay(error: unknown): number | undefined {
	if (statusOf(error) !== 429) return undefined;
	const code = bodyOf(error).error;
	if (typeof code !== 'string' || !RETRY_CODES.has(code)) return undefined;
	const seconds = Number(headerOf(error, 'retry-after'));
	if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_WAIT_MS;
	const wait = Math.ceil(seconds * 1000);
	return wait > MAX_WAIT_MS ? undefined : Math.max(wait, MIN_WAIT_MS);
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
		const page = await apiRequest<Page>(context, {
			method: 'GET',
			path: input.path,
			qs,
			itemIndex: input.itemIndex,
		});
		results.push(...(page.data ?? []));
		cursor = page.has_more && page.cursor ? page.cursor : undefined;
	} while (cursor && (returnAll || results.length < limit));
	return returnAll ? results : results.slice(0, limit);
}

interface EventPage {
	data?: IDataObject[];
	has_more?: boolean;
}

const EVENT_PAGE_SIZE = 100;

/** Events paginate by the ID of the last one (`starting_after`), newest first. */
export async function requestEvents(
	context: TurboNotifyContext,
	input: { qs: IDataObject; itemIndex?: number },
	returnAll: boolean,
	limit: number,
): Promise<IDataObject[]> {
	const results: IDataObject[] = [];
	let after: string | undefined;
	do {
		const remaining = returnAll
			? EVENT_PAGE_SIZE
			: Math.min(EVENT_PAGE_SIZE, limit - results.length);
		const qs: IDataObject = { ...input.qs, limit: remaining };
		if (after) qs.starting_after = after;
		const page = await apiRequest<EventPage>(context, {
			method: 'GET',
			path: '/events',
			qs,
			arrayFormat: 'brackets',
			itemIndex: input.itemIndex,
		});
		const rows = page.data ?? [];
		results.push(...rows);
		const last = rows[rows.length - 1];
		after = page.has_more && last && typeof last.id === 'string' ? last.id : undefined;
	} while (after && (returnAll || results.length < limit));
	return returnAll ? results : results.slice(0, limit);
}
