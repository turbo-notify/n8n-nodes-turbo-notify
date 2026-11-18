import { sleep, waitFor } from './util.mjs';

/**
 * Thin client for the control API of the mock (/__test/*) and for reading what the mock saw.
 * It talks plain HTTP, so it works the same whether the mock runs in this process or in another.
 */
export function mockClient(baseUrl, apiKey) {
	const call = async (method, path, body) => {
		const res = await fetch(`${baseUrl}${path}`, {
			method,
			headers: body === undefined ? {} : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		let json;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = text;
		}
		if (!res.ok) throw new Error(`mock ${method} ${path} -> ${res.status}: ${text}`);
		return json;
	};
	const post = (path, body = {}) => call('POST', `/__test${path}`, body);
	const get = (path) => call('GET', `/__test${path}`);

	/** Entries of the request log of the public API, optionally from a mark on. */
	const log = async ({ method, path, since = 0, limit = 5000 } = {}) => {
		const q = new URLSearchParams({ since: String(since), limit: String(limit) });
		if (method) q.set('method', method);
		if (path) q.set('path', path);
		return (await get(`/log?${q}`)).entries;
	};

	const client = {
		url: baseUrl,
		apiKey,
		call,
		get,
		post,
		reset: (keepConfig = false) => post('/reset', { keepConfig }),
		state: () => get('/state'),
		config: (settings) => post('/config', settings),
		quota: (settings) => post('/quota', settings),
		addNumber: (settings) => post('/number', settings),
		numberStatus: (settings) => post('/number-status', settings),
		addContact: (settings) => post('/contact', settings),
		addGroup: (settings) => post('/group', settings),
		recipient: (settings) => post('/recipient', settings),
		messageState: (settings) => post('/message-state', settings),
		messageAge: (settings) => post('/message-age', settings),
		fault: (settings) => post('/fault', settings),
		clearFaults: () => call('DELETE', '/__test/fault'),
		injectMessage: (settings) => post('/inject-message', settings),
		injectCalendarResponse: (settings) => post('/inject-calendar-response', settings),
		injectReaction: (settings) => post('/inject-reaction', settings),
		webhookTarget: (settings) => post('/webhook-target', settings),
		clearWebhookTargets: () => call('DELETE', '/__test/webhook-target'),
		redeliver: (settings) => post('/webhook-deliver', settings),
		deliveries: async () => (await get('/deliveries')).deliveries,
		clearLog: () => call('DELETE', '/__test/log'),
		log,

		/** A position in the request log. Pass it as `since` later to see only what came after. */
		mark: async () => (await get('/log?limit=1')).next_seq,

		/** Requests the API answered, filtered by method, a path fragment and a mark. */
		requests: (filter) => log(filter),

		/** The sends (POST .../messages and .../reply) as the workflow made them. */
		sends: async ({ since = 0, accepted = true } = {}) => {
			const rows = await log({ method: 'POST', since });
			return rows
				.filter((r) => /\/messages$/.test(r.path) || /\/messages\/[^/]+\/reply$/.test(r.path))
				.filter((r) => !accepted || r.status === 202)
				.map((r) => ({
					seq: r.seq,
					path: r.path,
					to: r.body?.to,
					content: r.body?.content,
					quotedMessageId: r.body?.quoted_message_id,
					idempotencyKey: r.headers['idempotency-key'],
					status: r.status,
					messageId: r.response?.message_id,
					response: r.response,
				}));
		},

		messages: async (filter = {}) => {
			const q = new URLSearchParams(filter);
			return (await get(`/messages?${q}`)).messages;
		},
		events: async (type) => (await get(`/events${type ? `?type=${encodeURIComponent(type)}` : ''}`)).events,

		/** Waits until a message reaches `state` (pending, sent, delivered, read or failed). */
		waitForMessageState: (messageId, state, { timeoutMs = 30_000 } = {}) =>
			waitFor(async () => (await client.messages()).find((m) => m.id === messageId && m.status.state === state), {
				timeoutMs,
				message: `message ${messageId} to reach ${state}`,
			}),

		/** Waits until the events feed holds an event of `type` that satisfies `where`. */
		waitForEvent: (type, { where = () => true, timeoutMs = 30_000 } = {}) =>
			waitFor(async () => (await client.events(type)).find((e) => where(e)), { timeoutMs, message: `an event ${type}` }),

		settle: (ms) => sleep(ms),
	};
	return client;
}
