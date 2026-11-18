/**
 * Real API mode (`--real-api`): the workflow talks to the REAL Turbo Notify API with a real key and real
 * WhatsApp delivery. Three pieces live here:
 *
 *   readApiKey()          reads the key from a file (never from the command line) and registers it for masking
 *   createGuardProxy()    a thin pass-through between n8n and the API that records every request (like the
 *                         mock's request log), refuses a send to any number but the one allowed, refuses
 *                         everything that is not a message send, edit, delete, read or a plain GET, and stops
 *                         at a hard message budget. It forwards the answer exactly as the API gave it.
 *   realClient()          what scenarios use as `t.real.*`: direct calls with the key (reads, cleanup deletes)
 *
 * The key never reaches stdout, stderr, the report, a file of the repository or a command line: everything the
 * harness prints goes through redact() (see util.mjs).
 */
import fs from 'node:fs';
import http from 'node:http';
import { redact, registerSecret, sleep, waitFor } from './util.mjs';

export const REAL_API_URL = 'https://api.turbonotify.com';

/** Reads the line `- Value: tn_live_...` (or `- Key: tn_live_...`) of the file. The value is registered for masking and returned. */
export function readApiKey(file) {
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		throw new Error(`cannot read the API key file ${file}`);
	}
	const match = text.match(/^\s*-?\s*(?:Value|Key):\s*(tn_(?:live|test)_\S+)\s*$/m);
	if (!match) throw new Error(`the API key file ${file} has no line "- Value: tn_live_..."`);
	registerSecret(match[1]);
	return match[1];
}

/** Digits only, so "+55 (11) 91234-5678" and "5511912345678" compare equal. */
export const digits = (value) => String(value ?? '').replace(/\D/g, '');

const MESSAGE_ID = '[A-Za-z0-9_]+';
const SEND_PATH = /^\/v1\/(?:numbers\/[^/]+\/)?messages$/;
/** Non GET calls the workflows may make. Everything else (numbers, pairing, disconnect, billing...) is refused. */
const REPLY_PATH = new RegExp(`^/v1/(?:numbers/[^/]+/)?messages/(${MESSAGE_ID})/reply$`);
const TYPING_PATH = /^\/v1\/(?:numbers\/[^/]+\/)?typing-indicator$/;
const ALLOWED_WRITES = [
	SEND_PATH,
	REPLY_PATH,
	TYPING_PATH,
	new RegExp(`^/v1/(?:numbers/[^/]+/)?messages/${MESSAGE_ID}/(?:edit|delete)$`),
	/^\/v1\/(?:numbers\/[^/]+\/)?messages\/read$/,
];

/**
 * Pass-through proxy in front of the real API. n8n's credential points here, so the harness sees every request
 * and enforces the rules that make a real run safe.
 */
export function createGuardProxy({ upstream = REAL_API_URL, allowedNumber, maxSends = 8 }) {
	const allowed = digits(allowedNumber);
	if (!allowed) throw new Error('the guard needs the one number that may receive messages (TN_REAL_OWNER_PHONE)');
	const entries = [];
	const acceptedMessageIds = new Set();
	let seq = 0;
	let blocked = 0;
	let chain = Promise.resolve();
	let server;

	const refuse = (res, status, error, message) => {
		const body = JSON.stringify({ error, message });
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(body);
		return { status, body: JSON.parse(body) };
	};

	const handle = async (req, res) => {
		const url = new URL(req.url, 'http://guard.local');
		const path = url.pathname;
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const rawBody = Buffer.concat(chunks).toString('utf8');
		let parsed;
		try {
			parsed = rawBody ? JSON.parse(rawBody) : undefined;
		} catch {
			parsed = rawBody;
		}
		const entry = {
			seq: seq++,
			at: new Date().toISOString(),
			method: req.method,
			path,
			query: Object.fromEntries(url.searchParams),
			headers: { 'idempotency-key': req.headers['idempotency-key'] },
			body: parsed,
			status: 0,
			response: undefined,
			blocked: undefined,
		};
		entries.push(entry);
		const finish = (outcome, extra = {}) => {
			entry.status = outcome.status;
			entry.response = outcome.body;
			Object.assign(entry, extra);
		};

		const isWrite = !['GET', 'HEAD'].includes(req.method);
		if (isWrite && !ALLOWED_WRITES.some((re) => re.test(path))) {
			blocked += 1;
			return finish(refuse(res, 403, 'harness_call_blocked', `${req.method} ${path} is not allowed in a real run`), { blocked: 'call' });
		}
		const isReply = req.method === 'POST' && REPLY_PATH.test(path);
		const isSend = req.method === 'POST' && (SEND_PATH.test(path) || isReply);
		const isTyping = req.method === 'POST' && TYPING_PATH.test(path);
		if (isSend && !isReply) {
			const to = parsed?.to;
			const target = digits(to?.number);
			if (!target || target !== allowed) {
				blocked += 1;
				return finish(refuse(res, 403, 'harness_recipient_blocked', 'this real run may only message the owner test number'), { blocked: 'recipient' });
			}
		}
		if (isTyping) {
			// A typing indicator is presence, not a message: it is allowed only towards the allowed number.
			if (digits(parsed?.to?.number) !== allowed) {
				blocked += 1;
				return finish(refuse(res, 403, 'harness_recipient_blocked', 'this real run may only message the owner test number'), { blocked: 'recipient' });
			}
		}
		if (isReply) {
			// A reply carries no recipient: it goes to the other side of the message it quotes. Look that message up
			// with the same key and require that the other side is the allowed number.
			let peer = '';
			try {
				const look = await fetch(`${upstream}${path.replace(/\/reply$/, '')}`, { headers: { authorization: String(req.headers.authorization ?? '') } });
				const quoted = look.ok ? await look.json() : null;
				peer = digits(quoted?.direction === 'inbound' ? quoted?.from?.number : quoted?.to?.number);
			} catch {
				peer = '';
			}
			if (!peer || peer !== allowed) {
				blocked += 1;
				return finish(refuse(res, 403, 'harness_recipient_blocked', 'this real run may only reply to a message of the owner test number'), { blocked: 'recipient' });
			}
			entry.verifiedTo = { number: peer };
		}

		// Sends go one at a time, so the budget check and the count cannot race.
		const forward = async () => {
			if (isSend && acceptedMessageIds.size + (api.extraCount?.() ?? 0) >= maxSends) {
				blocked += 1;
				return finish(refuse(res, 429, 'harness_budget_exhausted', `the real run budget of ${maxSends} messages is used`), { blocked: 'budget' });
			}
			const headers = {};
			for (const [key, value] of Object.entries(req.headers)) {
				if (['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding'].includes(key)) continue;
				headers[key] = Array.isArray(value) ? value.join(', ') : value;
			}
			let upstreamRes;
			try {
				upstreamRes = await fetch(`${upstream}${path}${url.search}`, { method: req.method, headers, body: isWrite ? rawBody : undefined });
			} catch (error) {
				return finish(refuse(res, 502, 'harness_upstream_unreachable', redact(error.message)));
			}
			const text = await upstreamRes.text();
			const outHeaders = {};
			upstreamRes.headers.forEach((value, key) => {
				if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key)) outHeaders[key] = value;
			});
			res.writeHead(upstreamRes.status, outHeaders);
			res.end(text);
			let json = text;
			try {
				json = JSON.parse(text);
			} catch {
				// not JSON
			}
			finish({ status: upstreamRes.status, body: json }, { responseHeaders: Object.fromEntries(Object.entries(outHeaders).filter(([k]) => !/cookie|authorization/i.test(k))) });
			if (isSend && upstreamRes.status < 300 && json?.message_id) acceptedMessageIds.add(json.message_id);
		};
		if (isSend) {
			const run = chain.then(forward, forward);
			chain = run.catch(() => undefined);
			await run;
		} else {
			await forward();
		}
	};

	const api = {
		entries,
		/** Sends made outside the proxy that share the budget (the customer sender of a two-number scenario). */
		extraCount: undefined,
		get blocked() {
			return blocked;
		},
		get messagesAccepted() {
			return acceptedMessageIds.size;
		},
		acceptedMessageIds: () => [...acceptedMessageIds],
		maxSends,
		async start(port, host) {
			server = http.createServer((req, res) => {
				handle(req, res).catch((error) => {
					try {
						refuse(res, 500, 'harness_guard_error', redact(error.message));
					} catch {
						// the response is gone
					}
				});
			});
			await new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, host, resolve);
			});
			return { port: server.address().port, url: `http://${host}:${server.address().port}` };
		},
		async stop() {
			await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
		},
	};
	return api;
}

const pick = (object, keys) => Object.fromEntries(keys.filter((k) => k in object).map((k) => [k, object[k]]));

/** The same reads the mock client offers over the guard's log: what n8n actually sent and what the API answered. */
export function guardClient(guard) {
	const rows = ({ method, path, since = 0 } = {}) =>
		guard.entries.filter((e) => e.seq >= since && (!method || e.method === method) && (!path || e.path.includes(path)));
	return {
		mark: async () => guard.entries.length,
		requests: async (filter) => rows(filter),
		sends: async ({ since = 0, accepted = true } = {}) =>
			rows({ method: 'POST', since })
				.filter((r) => SEND_PATH.test(r.path) || REPLY_PATH.test(r.path))
				.filter((r) => !accepted || r.status === 202 || r.status === 200)
				.map((r) => ({
					seq: r.seq,
					path: r.path,
					to: r.body?.to ?? r.verifiedTo,
					reply: REPLY_PATH.test(r.path),
					content: r.body?.content,
					idempotencyKey: r.headers['idempotency-key'],
					status: r.status,
					messageId: r.response?.message_id,
					response: r.response,
				})),
		get blocked() {
			return guard.blocked;
		},
		get messagesAccepted() {
			return guard.messagesAccepted;
		},
		acceptedMessageIds: () => guard.acceptedMessageIds(),
	};
}

/** Direct calls to the real API with the key: reads for the assertions and the cleanup deletes. */
export function realClient({ baseUrl = REAL_API_URL, apiKey }) {
	const call = async (method, path, body) => {
		let res;
		try {
			res = await fetch(`${baseUrl}${path}`, {
				method,
				headers: { authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (error) {
			throw new Error(redact(`real API ${method} ${path}: ${error.message}`));
		}
		const text = await res.text();
		let json = text;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			// keep the text
		}
		return { status: res.status, ok: res.ok, body: json, retryAfter: res.headers.get('retry-after') };
	};
	const must = async (method, path, body) => {
		const out = await call(method, path, body);
		if (!out.ok) throw new Error(redact(`real API ${method} ${path} -> ${out.status}: ${JSON.stringify(out.body)}`));
		return out.body;
	};
	const client = {
		call,
		get: (path) => must('GET', path),
		post: (path, body = {}) => must('POST', path, body),
		numbers: () => must('GET', '/v1/numbers'),
		quota: () => must('GET', '/v1/messages/quota'),
		contactQuota: () => must('GET', '/v1/contacts/quota'),
		message: (id) => must('GET', `/v1/messages/${id}`),
		status: (id) => must('GET', `/v1/messages/${id}/status`),
		receipts: (id) => must('GET', `/v1/messages/${id}/receipts`),
		responses: (id) => must('GET', `/v1/messages/${id}/responses`),
		events: (query = '') => must('GET', `/v1/events${query ? `?${query}` : ''}`),
		/** Newest sent messages (the API lists newest first). */
		listSent: (limit = 50) => must('GET', `/v1/messages?direction=outbound&limit=${limit}`),
		/** Delete for everyone. Never throws. A message still `pending` answers 400 message_not_deletable: see deleteWhenSent. */
		deleteMessage: async (id) => call('POST', `/v1/messages/${id}/delete`, {}),
		/**
		 * Real sends are queued and paced per number (about one every 15 s in a burst), so a message can still be
		 * `pending` for a while. Waits until it left `pending`, then deletes it for everyone; retries a 400 a few times.
		 * Resolves to { deleted, status, state }.
		 */
		async deleteWhenSent(id, { timeoutMs = 150_000 } = {}) {
			const left = await client.observe(id, ['sent', 'delivered', 'read', 'failed'], { timeoutMs, intervalMs: 3000 });
			if (left.state === 'failed') return { deleted: false, status: 0, state: 'failed', note: 'never reached WhatsApp, nothing to delete' };
			let r = await client.deleteMessage(id);
			for (let i = 0; i < 4 && r.status === 400; i += 1) {
				await sleep(4000);
				r = await client.deleteMessage(id);
			}
			return { deleted: r.ok, status: r.status, state: left.state, error: r.ok ? undefined : r.body };
		},
		/**
		 * Watches a message state until it is one of `states` (or the time is up) and returns every distinct state
		 * seen, in order, with the time it was first seen and the status timestamp the API gave.
		 */
		async observe(id, states, { timeoutMs = 120_000, intervalMs = 3000 } = {}) {
			const wanted = new Set(states);
			const seen = [];
			const t0 = Date.now();
			while (Date.now() - t0 < timeoutMs) {
				const body = await client.status(id);
				const state = body?.status?.state ?? body?.state;
				if (!seen.some((x) => x.state === state)) seen.push({ state, seenAfterMs: Date.now() - t0, apiAt: body?.status?.at ?? body?.at, error: body?.status?.error ?? null });
				if (wanted.has(state)) return { reached: true, state, seen, last: body };
				await sleep(intervalMs);
			}
			return { reached: false, state: seen.at(-1)?.state, seen };
		},
		/** Waits until the message state is one of `states`; returns the last status body (also on a timeout). */
		async waitForState(id, states, { timeoutMs = 120_000, intervalMs = 4000 } = {}) {
			const wanted = new Set(states);
			let last;
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				last = await client.status(id);
				const state = last?.status?.state ?? last?.state;
				if (wanted.has(state)) return { reached: true, status: last };
				await sleep(intervalMs);
			}
			return { reached: false, status: last };
		},
	};
	return client;
}

export { waitFor };


/**
 * A second organization's key, used ONLY to play the customer who writes to the number under test: it sends plain
 * text to one number (the number under test) from its own main number, and nothing else. Counted in the same budget
 * as the guard. The sending number must be the allowed one of the guard (checked once with a read).
 */
export function createCustomerSender({ apiKey, to, expectedFrom, maxSends, guard, baseUrl = REAL_API_URL }) {
	const target = digits(to);
	const ids = [];
	const client = realClient({ baseUrl, apiKey });
	const api = {
		get count() {
			return ids.length;
		},
		ids: () => [...ids],
		/** Reads the organization's numbers and checks that the sender is the expected number (never sends from another). */
		async verify() {
			const numbers = await client.numbers();
			const main = numbers.data.find((n) => n.alias === 'main');
			if (!main || digits(main.number) !== digits(expectedFrom)) throw new Error('the customer key does not belong to the expected sending number: refusing to send');
			return main;
		},
		/** One plain text to the number under test. */
		async send(text, idempotencyKey) {
			if (typeof text !== 'string' || !text.length || text.length > 500) throw new Error('the customer sender sends plain text only (1 to 500 characters)');
			if (guard.messagesAccepted + ids.length >= maxSends) throw new Error(`the real run budget of ${maxSends} messages is used`);
			const res = await client.call('POST', '/v1/messages', { to: { number: `+${target}` }, content: { text } });
			void idempotencyKey;
			if (!res.ok || !res.body?.message_id) throw new Error(redact(`the customer send failed: ${res.status} ${JSON.stringify(res.body)}`));
			ids.push(res.body.message_id);
			return { id: res.body.message_id, status: res.body.status };
		},
		get: (path) => client.get(path),
		status: (id) => client.status(id),
		observe: (id, states, opts) => client.observe(id, states, opts),
		/** Newest messages of the customer organization, both directions (to see what arrived). */
		list: (query = 'limit=20') => client.get(`/v1/messages?${query}`),
		async deleteAll() {
			const out = [];
			for (const id of ids) {
				const r = await client.deleteWhenSent(id).catch((error) => ({ deleted: false, error: error.message }));
				out.push({ deleted: r.deleted, state: r.state, status: r.status });
			}
			return out;
		},
	};
	return api;
}
