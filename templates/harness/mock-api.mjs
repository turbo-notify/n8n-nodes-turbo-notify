#!/usr/bin/env node
/**
 * Stateful mock of the Turbo Notify public API, for testing n8n workflows end to end.
 *
 * Usage:
 *   node templates/harness/mock-api.mjs --port 9099
 *
 * Options (each also read from the environment variable in brackets):
 *   --port <n>             listening port, default 9099                         [MOCK_PORT]
 *   --host <addr>          bind address, default 127.0.0.1                      [MOCK_HOST]
 *   --key <token>          accepted API key, default tn_test_harness_key        [MOCK_API_KEY]
 *   --delays <a,b,c>       ms after acceptance until sent, delivered, read      [MOCK_DELAYS]
 *                          (default 1000,2000,4000)
 *   --quota <n>            message quota per number and cycle, default 1000     [MOCK_QUOTA]
 *   --contact-quota <n>    distinct contacts per number and cycle, default 1000 [MOCK_CONTACT_QUOTA]
 *   --plan <name>          free | lone_wolf | business | custom, default business [MOCK_PLAN]
 *   --enforce-spacing      answer 429 send_rate_spacing like the real API       [MOCK_ENFORCE_SPACING=1]
 *   --spacing-ms <n>       minimum interval between sends (default: the plan's)  [MOCK_SPACING_MS]
 *
 * The contract it mirrors is public-docs-web/public/openapi.json plus the pages under
 * public-docs-web/src/content/docs/en (messages, webhooks, reference/errors).
 *
 * What is real: routes, validation, error bodies and codes, id formats, message lifecycle
 * (pending, sent, delivered, read or failed), events feed with cursors, idempotency, quota,
 * spacing, plan gating, signed webhooks.
 * What is NOT: WhatsApp itself. Nothing is ever delivered to a phone.
 *
 * Test control API (no auth), all under /__test: see the README next to this file.
 *
 * The module also exports createMockApi() so the runner can host the mock in process.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ helpers */

const hex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
const newId = (prefix) => `${prefix}_${hex(16)}`;
const RE = {
	msg: /^msg_[0-9a-f]{32}$/,
	ct: /^ct_[0-9a-f]{32}$/,
	grp: /^grp_[0-9a-f]{32}$/,
	evt: /^evt_[0-9a-f]{32}$/,
	num: /^num_[0-9a-f]{32}$/,
	req: /^req_[0-9a-f]{32}$/,
};
// The contract writes the calendar preview with a long dash. It is built from its code point
// so this file stays free of that character.
const LONG_DASH = String.fromCharCode(0x2014);

const isoSec = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PLAN_SPACING_MS = { free: 6000, lone_wolf: 1200, business: 600, custom: 400 };
const PLAN_FEATURES = {
	free: { typing: false, reactions: false, groups: false, markRead: false },
	lone_wolf: { typing: true, reactions: true, groups: false, markRead: false },
	business: { typing: true, reactions: true, groups: true, markRead: true },
	custom: { typing: true, reactions: true, groups: true, markRead: true },
};

class ApiError extends Error {
	constructor(status, body, headers = {}) {
		super(body?.error ?? 'error');
		this.status = status;
		this.body = body;
		this.headers = headers;
	}
}
const fail = (status, error, extra = {}, headers = {}) => {
	throw new ApiError(status, { error, ...extra }, headers);
};
const invalid = (errors) =>
	fail(422, 'validation_error', {
		details: { errors: errors.map((e) => ({ field: e[0], message: e[1], type: e[2] ?? 'value_error' })) },
	});

/** Canonical JSON (sorted keys, no nulls), used to compare two requests for idempotency. */
function canon(value) {
	if (Array.isArray(value)) return value.map(canon);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.filter((k) => value[k] !== null && value[k] !== undefined)
				.map((k) => [k, canon(value[k])]),
		);
	}
	return value;
}

/** JSON the way the real API writes it for signing: non-ASCII characters escaped. */
function wireJson(value) {
	return JSON.stringify(value).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function truncate(text, max = 50, tokens = []) {
	// Each mention token counts as one character and is never cut in half.
	let out = '';
	let count = 0;
	let i = 0;
	const chars = Array.from(text);
	while (i < chars.length && count < max) {
		const rest = chars.slice(i).join('');
		const hit = tokens.find((t) => rest.startsWith(t));
		if (hit) {
			out += hit;
			i += Array.from(hit).length;
		} else {
			out += chars[i];
			i += 1;
		}
		count += 1;
	}
	return out;
}

function calendarPreview(name, startAt) {
	const d = new Date(startAt);
	if (Number.isNaN(d.getTime())) return name;
	const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const pad = (n) => String(n).padStart(2, '0');
	const stamp = `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
	return `${name} ${LONG_DASH} ${stamp}`;
}

const normalizePhone = (value) => {
	const cleaned = String(value ?? '').replace(/[\s\-().]/g, '');
	// The real API also accepts the digits without the "+" (checked 2026-11-17), although its documentation says "+" is required.
	return /^\+?\d{7,15}$/.test(cleaned) ? cleaned.replace(/^\+/, '') : null;
};

function defaults(overrides = {}) {
	const env = process.env;
	const rawDelays = overrides.delays ?? env.MOCK_DELAYS ?? '1000,2000,4000';
	const delays =
		rawDelays && typeof rawDelays === 'object'
			? [rawDelays.sent, rawDelays.delivered, rawDelays.read, rawDelays.op]
			: String(rawDelays)
					.split(',')
					.map((n) => Number(n.trim()));
	return {
		apiKey: overrides.apiKey ?? env.MOCK_API_KEY ?? 'tn_test_harness_key',
		delays: { sent: delays[0] ?? 1000, delivered: delays[1] ?? 2000, read: delays[2] ?? 4000, op: delays[3] ?? 500 },
		quota: Number(overrides.quota ?? env.MOCK_QUOTA ?? 1000),
		contactQuota: Number(overrides.contactQuota ?? env.MOCK_CONTACT_QUOTA ?? 1000),
		plan: overrides.plan ?? env.MOCK_PLAN ?? 'business',
		enforceSpacing: Boolean(overrides.enforceSpacing ?? env.MOCK_ENFORCE_SPACING === '1'),
		spacingMs: overrides.spacingMs ?? (env.MOCK_SPACING_MS ? Number(env.MOCK_SPACING_MS) : null),
		subscriptionActive: true,
		latencyMs: 0,
		webhookAttempts: 3,
		webhookRetryMs: 500,
	};
}

/* ------------------------------------------------------------------- server */

export function createMockApi(options = {}) {
	let cfg = defaults(options);
	const baseCfg = () => defaults(options);

	let seq = 0; // monotonic counter for events
	let msgOrder = 0; // monotonic counter for messages, to order two with the same second
	let st; // all mutable state, rebuilt by reset()
	const timers = new Set();
	let server = null;

	function later(ms, fn) {
		const t = setTimeout(() => {
			timers.delete(t);
			try {
				fn();
			} catch (error) {
				console.error('[mock] timer failed:', error);
			}
		}, Math.max(0, ms));
		timers.add(t);
		return t;
	}

	function reset(keepConfig = false) {
		for (const t of timers) clearTimeout(t);
		timers.clear();
		if (!keepConfig) cfg = baseCfg();
		seq = 0;
		msgOrder = 0;
		const orgId = newId('org');
		st = {
			orgId,
			numbers: [],
			messages: new Map(), // id -> message
			events: [], // oldest first
			log: [],
			idem: new Map(), // numberId|key -> { fp, messageId }
			recipients: new Map(), // phone digits -> behaviour
			faults: [],
			targets: [],
			deliveries: [],
			lastSendAt: new Map(), // numberId -> ms
		};
		addNumber({
			alias: 'main',
			number: '5511977770000',
			name: 'Turbo Notify',
			type: 'main',
		});
	}

	/* --------------------------------------------------------------- numbers */

	function addNumber({ alias, number, name = null, type = 'extra', status = 'connected', description = null }) {
		const n = {
			id: newId('num'),
			contactId: null,
			alias,
			number: String(number).replace(/^\+/, ''),
			name,
			type,
			description,
			status,
			statusAt: Date.now(),
			reason: null,
			quota: cfg.quota,
			used: 0,
			contacts: new Map(), // phone -> contact
			groups: new Map(), // id -> group
			createdAt: Date.now(),
		};
		st.numbers.push(n);
		return n;
	}

	function resolveNumber(ref) {
		if (ref === 'main') return st.numbers.find((n) => n.type === 'main');
		if (ref.startsWith('num_')) {
			if (!RE.num.test(ref)) fail(400, 'invalid_number_id');
			const n = st.numbers.find((x) => x.id === ref);
			if (!n) fail(404, 'number_not_found');
			return n;
		}
		const n = st.numbers.find((x) => x.alias === ref);
		if (!n) fail(404, 'number_not_found');
		return n;
	}

	/* -------------------------------------------------------------- contacts */

	function touchContact(num, digits, { name, source = 'outbound', create = true } = {}) {
		let c = num.contacts.get(digits);
		if (!c && !create) return null;
		if (!c) {
			c = {
				id: newId('ct'),
				digits,
				name: name ?? null,
				source,
				firstMessagedAt: null,
				lastInteractionAt: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				contactedInCycle: false,
			};
			num.contacts.set(digits, c);
			emit('contact.created', num, {
				id: c.id,
				name: c.name ?? undefined,
				number: digits,
				direction: 'inbound',
				channel: 'whatsapp',
				origin: 'tn',
			});
		}
		if (name && c.name !== name) {
			const old = c.name;
			c.name = name;
			c.updatedAt = Date.now();
			if (old) {
				emit('contact.name_changed', num, {
					id: c.id,
					name,
					old_name: old,
					number: digits,
					direction: 'inbound',
					channel: 'whatsapp',
					origin: 'tn',
					at: isoSec(Date.now()),
				});
			}
		}
		return c;
	}

	const contactJson = (num, c) =>
		compact({
			id: c.id,
			number_alias: num.alias,
			phone_number: `+${c.digits}`,
			name: c.name,
			is_self: false,
			first_messaged_at: c.firstMessagedAt ? new Date(c.firstMessagedAt).toISOString() : null,
			last_interaction_at: c.lastInteractionAt ? new Date(c.lastInteractionAt).toISOString() : null,
			verified_on_whatsapp_at: null,
			picture: { kind: 'unavailable', reason: 'peer_has_none' },
			refresh: null,
			created_at: new Date(c.createdAt).toISOString(),
			updated_at: new Date(c.updatedAt).toISOString(),
		});

	function addGroup(num, { id, name, members = [], description = null, active = true }) {
		const g = {
			id: id ?? newId('grp'),
			name,
			description,
			members: members.map((m) => ({ digits: String(m.phone ?? m).replace(/^\+/, ''), name: m.name ?? null })),
			active,
			announce: false,
			createdAt: Date.now(),
		};
		num.groups.set(g.id, g);
		return g;
	}

	const groupJson = (num, g) => ({
		id: g.id,
		number_alias: num.alias,
		name: g.name,
		description: g.description,
		participants_count: g.members.length + 1,
		is_announce_only: g.announce,
		is_locked: false,
		ephemeral_seconds: null,
		is_active: g.active,
		picture: { kind: 'unavailable', reason: 'peer_has_none' },
		created_at: new Date(g.createdAt).toISOString(),
		updated_at: new Date(g.createdAt).toISOString(),
	});

	/* ---------------------------------------------------------------- events */

	function emit(type, num, data, requestId) {
		seq += 1;
		const ev = {
			seq,
			id: newId('evt'),
			type,
			organization_id: st.orgId,
			...(num ? { number_alias: num.alias, number_id: num.id } : {}),
			created_at: isoSec(Date.now()),
			data,
			_request_id: requestId ?? null,
		};
		st.events.push(ev);
		for (const target of st.targets) {
			if (!target.enabled) continue;
			if (target.types && !target.types.includes(type)) continue;
			deliver(target, ev, {});
		}
		return ev;
	}
	const publicEvent = (ev) => {
		const { seq: _s, _request_id, ...rest } = ev;
		return rest;
	};

	/* ------------------------------------------------------ webhook delivery */

	function signatureHeaders(target, raw, attempt, tamper) {
		let ts = Math.floor(Date.now() / 1000);
		if (tamper === 'old-timestamp') ts -= 3600;
		let sig = `sha256=${crypto.createHmac('sha256', target.secret).update(`${ts}.${raw}`).digest('hex')}`;
		if (tamper === 'signature') sig = `sha256=${'0'.repeat(64)}`;
		if (tamper === 'no-signature') sig = undefined;
		return compact({
			'content-type': 'application/json',
			'user-agent': 'TurboNotify-Webhook/1.0',
			'x-webhook-signature': sig,
			'x-webhook-timestamp': String(ts),
			'x-webhook-attempt': String(attempt),
			'x-webhook-max-attempts': String(cfg.webhookAttempts),
		});
	}

	function deliver(target, ev, { tamper, attempt = 1, once = false } = {}) {
		const signedRaw = wireJson(publicEvent(ev));
		const headers = signatureHeaders(target, signedRaw, attempt, tamper);
		// A tampered body is signed before the change, so the signature no longer matches what is sent.
		const raw = tamper === 'body' ? `${signedRaw.slice(0, -1)} }` : signedRaw;
		const record = {
			id: hex(6),
			target_id: target.id,
			event_id: ev.id,
			event_type: ev.type,
			attempt,
			at: new Date().toISOString(),
			status: null,
			ok: false,
			error: null,
		};
		st.deliveries.push(record);
		const url = new URL(target.url);
		const req = http.request(
			{
				method: 'POST',
				hostname: url.hostname,
				port: url.port,
				path: url.pathname + url.search,
				headers: { ...headers, 'content-length': Buffer.byteLength(raw) },
				timeout: 10_000,
			},
			(res) => {
				res.resume();
				res.on('end', () => {
					record.status = res.statusCode;
					record.ok = res.statusCode >= 200 && res.statusCode < 300;
					if (!record.ok && !once && attempt < cfg.webhookAttempts) {
						later(cfg.webhookRetryMs * attempt, () => deliver(target, ev, { tamper, attempt: attempt + 1 }));
					}
				});
			},
		);
		req.on('timeout', () => req.destroy(new Error('timeout')));
		req.on('error', (error) => {
			record.error = error.message;
			if (!once && attempt < cfg.webhookAttempts) {
				later(cfg.webhookRetryMs * attempt, () => deliver(target, ev, { tamper, attempt: attempt + 1 }));
			}
		});
		req.end(raw);
		return record;
	}

	/* ------------------------------------------------------------- messages */

	function parties(num, m) {
		const us = compact({ name: num.name, alias: num.alias, number: num.number });
		const person = m.contact
			? compact({ contact_id: m.contact.id, name: m.contact.name, number: m.contact.digits })
			: null;
		const group = m.group ? compact({ group_id: m.group.id, name: m.group.name }) : null;
		if (m.direction === 'outbound') return { from: us, to: group ?? person };
		const sender = m.sender ? compact({ contact_id: m.sender.id, name: m.sender.name, number: m.sender.digits }) : person;
		return { from: sender, to: group ?? compact({ name: num.name, alias: num.alias, number: num.number }) };
	}

	function mentionsOf(num, text) {
		if (typeof text !== 'string') return { text, mentions: undefined, tokens: [] };
		const found = [];
		const fixed = text.replace(/(?<![\w@])@(\d{7,15})(?!\w)/g, (whole, digits) => {
			let d = digits;
			if (/^55\d{2}[6-9]\d{7}$/.test(d)) d = `${d.slice(0, 4)}9${d.slice(4)}`;
			if (!found.includes(d)) found.push(d);
			return `@${d}`;
		});
		const mentions = found.map((d) => {
			const c = num.contacts.get(d);
			return compact({ contact_id: c?.id, name: c?.name, number: d });
		});
		return { text: fixed, mentions: mentions.length ? mentions : undefined, tokens: found.map((d) => `@${d}`) };
	}

	function previewOf(type, c, tokens = []) {
		switch (type) {
			case 'text':
				return truncate(c.text ?? '', 50, tokens);
			case 'image':
			case 'video':
				return truncate(c.caption || (type === 'image' ? '[Image]' : '[Video]'), 50, tokens);
			case 'audio':
				return c.transcription?.kind === 'available' ? truncate(c.transcription.text, 50) : '[Audio]';
			case 'document':
				return truncate(c.caption || c.filename || '[Document]', 50, tokens);
			case 'sticker':
				return '[Sticker]';
			case 'location': {
				const parts = [c.name, c.address].filter(Boolean);
				return truncate(parts.length ? parts.join(', ') : `${c.latitude}, ${c.longitude}`);
			}
			case 'calendar':
				return truncate(calendarPreview(c.name, c.start_at), 50);
			case 'contact':
				return c.display_name ? `[Contact: ${c.display_name}]` : '[Contact]';
			case 'interactive':
				return truncate(c.body || '[Interactive]');
			default:
				return '';
		}
	}

	function contentJson(m) {
		const c = m.content;
		switch (m.contentType) {
			case 'text':
				return { text: c.text };
			case 'image':
			case 'video':
			case 'document':
			case 'audio':
			case 'sticker': {
				const media = {
					...(c.caption ? { caption: c.caption } : {}),
					...(c.filename ? { filename: c.filename } : {}),
					kind: 'available',
					url: c.url,
					expires_at: isoSec(Date.now() + 3600_000),
					mime_type: c.mime_type ?? null,
					size_bytes: c.size_bytes ?? null,
					...(c.transcription ? { transcription: c.transcription } : {}),
				};
				return { [m.contentType]: media };
			}
			case 'location':
				return { location: compact(c) };
			case 'calendar':
				return { calendar: clone(c) };
			case 'contact':
				return { contact: clone(c) };
			case 'interactive':
				return { interactive: clone(c) };
			default:
				return {};
		}
	}

	function messageStatusJson(m, { errorMode }) {
		const s = { state: m.status.state, at: isoSec(m.status.at) };
		if (m.status.error) s.error = m.status.error;
		else if (errorMode === 'null') s.error = null;
		return s;
	}

	/** Full message as GET /numbers/{ref}/messages/{id} writes it. */
	function messageJson(num, m) {
		const p = parties(num, m);
		const out = {
			id: m.id,
			organization_id: st.orgId,
			number_alias: num.alias,
			number_id: num.id,
			from: p.from,
			to: p.to,
			preview: m.deleted ? '' : m.preview,
			content_expired: false,
			...(m.deleted ? {} : contentJson(m)),
			...(m.mentions ? { mentions: m.mentions } : {}),
			...(m.replied ? { replied: m.replied } : {}),
			content_type: m.contentType,
			direction: m.direction,
			channel: 'whatsapp',
			origin: m.origin,
			at: isoSec(m.at),
			status: messageStatusJson(m, { errorMode: 'omit' }),
		};
		return out;
	}

	/** Summary as the list writes it. */
	function messageListJson(num, m) {
		const p = parties(num, m);
		return {
			id: m.id,
			organization_id: st.orgId,
			number_alias: num.alias,
			number_id: num.id,
			from: p.from,
			to: p.to,
			direction: m.direction,
			content_type: m.contentType,
			channel: 'whatsapp',
			origin: m.origin,
			preview: m.deleted ? '' : m.preview,
			content_expired: false,
			at: isoSec(m.at),
			status: messageStatusJson(m, { errorMode: 'null' }),
		};
	}

	/** The data object of a message.* event. */
	function eventData(num, m, { at, kind, extra = {}, receiptFrom } = {}) {
		const p = parties(num, m);
		let from = p.from;
		let to = p.to;
		let direction = m.direction;
		let origin = m.origin;
		if (receiptFrom !== undefined) {
			// Receipts are inbound: from is who triggered it, to is our side.
			from = receiptFrom;
			to = m.group
				? compact({ group_id: m.group.id, name: m.group.name })
				: compact({ name: num.name, alias: num.alias, number: num.number });
			direction = 'inbound';
			origin = 'native';
		}
		return {
			id: m.id,
			from,
			to,
			preview: kind === 'deleted' ? '' : m.preview,
			content_type: kind === 'deleted' ? '' : m.contentType,
			direction,
			channel: 'whatsapp',
			origin,
			...(m.mentions && ['sent', 'replied', 'received', 'edited'].includes(kind) ? { mentions: m.mentions } : {}),
			...(m.replied && ['replied'].includes(kind) ? { quoted_message_id: m.replied.message_id } : {}),
			...(m.contentType === 'audio' && m.content.transcription && kind === 'received'
				? { transcription: m.content.transcription }
				: {}),
			...extra,
			at: isoSec(at ?? m.at),
		};
	}

	function normalizeContent(raw, errs) {
		const c = raw ?? {};
		const f = (name) => `body.content.${name}`;
		const has = (k) => c[k] !== undefined && c[k] !== null && c[k] !== '';
		if ('content_type' in c) errs.push([f('content_type'), 'Extra inputs are not permitted', 'extra_forbidden']);
		const str = (k, max, required) => {
			if (!has(k)) {
				if (required) errs.push([f(k), 'Field required', 'missing']);
				return undefined;
			}
			if (typeof c[k] !== 'string') {
				errs.push([f(k), 'Input should be a valid string', 'string_type']);
				return undefined;
			}
			if (c[k].length > max) errs.push([f(k), `String should have at most ${max} characters`, 'string_too_long']);
			return c[k];
		};
		const url = (k, required) => {
			const v = str(k, 2083, required);
			if (v !== undefined && !/^https?:\/\/\S+$/i.test(v)) errs.push([f(k), 'Input should be a valid URL', 'url_parsing']);
			return v;
		};
		const num = (k, min, max) => {
			if (typeof c[k] !== 'number' || !Number.isFinite(c[k])) {
				errs.push([f(k), 'Input should be a valid number', 'float_type']);
				return undefined;
			}
			if (c[k] < min || c[k] > max) errs.push([f(k), `Input should be between ${min} and ${max}`, 'greater_than_equal']);
			return c[k];
		};
		const dateTime = (k, required) => {
			const v = str(k, 64, required);
			if (v !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v) || Number.isNaN(Date.parse(v)))) {
				errs.push([f(k), 'Input should be a valid datetime with a time zone', 'datetime_parsing']);
			}
			return v;
		};
		const media = (type, field, withCaption) => {
			const u = url(field, true);
			const out = { url: u, mime_type: str('mime_type', 120) ?? defaultMime(type) };
			if (withCaption) out.caption = str('caption', 1024);
			if (type === 'document') out.filename = str('filename', 255);
			return { type, content: compact(out) };
		};
		if (has('interactive_type')) {
			if (c.interactive_type !== 'cta_url') errs.push([f('interactive_type'), "Input should be 'cta_url'", 'literal_error']);
			const out = { interactive_type: 'cta_url', body: str('body', 1024, true) };
			if (c.header !== undefined && c.header !== null) {
				if (c.header?.type !== 'text' || typeof c.header?.text !== 'string' || !c.header.text || c.header.text.length > 60) {
					errs.push([f('header'), "Header must be { type: 'text', text } with 1 to 60 characters", 'value_error']);
				} else out.header = { type: 'text', text: c.header.text };
			}
			out.footer = str('footer', 60);
			const b = c.url_button;
			if (!b || typeof b !== 'object') errs.push([f('url_button'), 'Field required', 'missing']);
			else {
				if (typeof b.display_text !== 'string' || !b.display_text || b.display_text.length > 20)
					errs.push([f('url_button.display_text'), 'String should have 1 to 20 characters', 'string_too_long']);
				if (typeof b.url !== 'string' || !/^https?:\/\/\S+$/i.test(b.url))
					errs.push([f('url_button.url'), 'Input should be a valid URL', 'url_parsing']);
				out.url_button = { display_text: b.display_text, url: b.url };
			}
			return { type: 'interactive', content: compact(out) };
		}
		if (has('text')) return { type: 'text', content: { text: str('text', 4096, true) } };
		if (has('image_url')) return media('image', 'image_url', true);
		if (has('video_url')) return media('video', 'video_url', true);
		if (has('audio_url')) return media('audio', 'audio_url', false);
		if (has('document_url')) return media('document', 'document_url', true);
		if (has('sticker_url')) return media('sticker', 'sticker_url', false);
		if (has('display_name')) {
			const out = { display_name: str('display_name', 200, true) };
			if (!Array.isArray(c.phones) || c.phones.length < 1 || c.phones.length > 10) {
				errs.push([f('phones'), 'List should have 1 to 10 items', 'too_short']);
			} else {
				out.phones = c.phones.map((p, i) => {
					if (!p || typeof p.number !== 'string' || !p.number) errs.push([f(`phones.${i}.number`), 'Field required', 'missing']);
					return compact({ label: p?.label ?? 'Mobile', number: p?.number });
				});
			}
			if (c.emails !== undefined && c.emails !== null) {
				if (!Array.isArray(c.emails) || c.emails.length > 10) errs.push([f('emails'), 'List should have at most 10 items', 'too_long']);
				else {
					out.emails = c.emails.map((e, i) => {
						if (!e || typeof e.address !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.address))
							errs.push([f(`emails.${i}.address`), 'value is not a valid email address', 'value_error']);
						return compact({ label: e?.label ?? 'Email', address: e?.address });
					});
				}
			}
			out.organization = str('organization', 200);
			out.title = str('title', 100);
			out.address = str('address', 500);
			return { type: 'contact', content: compact(out) };
		}
		if (has('start_at')) {
			const out = { name: str('name', 200, true), start_at: dateTime('start_at', true) };
			out.description = str('description', 2000);
			out.end_at = dateTime('end_at');
			if (out.end_at && out.start_at && Date.parse(out.end_at) <= Date.parse(out.start_at)) {
				errs.push([f('end_at'), 'end_at must be after start_at', 'value_error']);
			}
			out.join_link = url('join_link');
			if (c.location) {
				out.location = compact({ latitude: c.location.latitude, longitude: c.location.longitude, name: c.location.name, address: c.location.address, url: c.location.url });
			}
			out.has_reminder = c.has_reminder === true;
			if (c.reminder_offset_sec !== undefined && c.reminder_offset_sec !== null) {
				if (!Number.isInteger(c.reminder_offset_sec)) errs.push([f('reminder_offset_sec'), 'Input should be a valid integer', 'int_type']);
				out.reminder_offset_sec = c.reminder_offset_sec;
			}
			out.extra_guests_allowed = c.extra_guests_allowed === true;
			return { type: 'calendar', content: compact(out) };
		}
		if (c.latitude !== undefined || c.longitude !== undefined) {
			const out = { latitude: num('latitude', -90, 90), longitude: num('longitude', -180, 180) };
			out.name = str('name', 200);
			out.address = str('address', 500);
			out.url = url('url');
			return { type: 'location', content: compact(out) };
		}
		if (c.name !== undefined) errs.push([f('start_at'), 'Field required', 'missing']);
		else errs.push(['body.content', 'content must carry one of: text, image_url, video_url, audio_url, document_url, sticker_url, latitude, display_name, start_at, interactive_type', 'value_error']);
		return { type: 'text', content: {} };
	}

	function defaultMime(type) {
		return { image: 'image/jpeg', video: 'video/mp4', audio: 'audio/ogg', document: 'application/pdf', sticker: 'image/webp' }[type];
	}

	function resolveRecipient(num, to, errs) {
		if (!to || typeof to !== 'object' || Array.isArray(to)) {
			errs.push(['body.to', 'Field required', 'missing']);
			return null;
		}
		const given = ['number', 'group_id', 'contact_id'].filter((k) => typeof to[k] === 'string' && to[k].trim() !== '');
		if (given.length !== 1) {
			errs.push(['body.to', 'Exactly one of number, group_id or contact_id is required', 'value_error']);
			return null;
		}
		const kind = given[0];
		const value = to[kind].trim();
		if (kind === 'number') {
			const digits = normalizePhone(value);
			if (!digits) fail(400, 'invalid_phone_number');
			return { kind: 'phone', digits };
		}
		if (kind === 'contact_id') {
			if (!RE.ct.test(value)) fail(400, 'invalid_contact_id');
			const c = [...num.contacts.values()].find((x) => x.id === value);
			if (!c) fail(400, 'contact_not_found');
			return { kind: 'phone', digits: c.digits };
		}
		if (!RE.grp.test(value)) fail(400, 'invalid_group_id');
		let g = num.groups.get(value);
		if (!g) {
			const other = st.numbers.some((n) => n !== num && n.groups.has(value));
			if (other) fail(422, 'group_not_owned_by_number');
			fail(404, 'group_not_found');
		}
		if (!g.active) fail(400, 'not_group_member');
		return { kind: 'group', group: g };
	}

	function cycleBounds() {
		const now = new Date();
		const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
		const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
		return { start, end };
	}

	function requireConnected(num) {
		if (num.status !== 'connected') fail(409, 'number_not_connected');
	}

	function requireFeature(feature) {
		if (!PLAN_FEATURES[cfg.plan]?.[feature]) fail(402, 'feature_not_available');
	}

	function requireSubscription() {
		if (!cfg.subscriptionActive) fail(402, 'subscription_inactive', { details: { status: 'past_due' } });
	}

	function checkSpacing(num) {
		if (!cfg.enforceSpacing) return;
		const spacing = cfg.spacingMs ?? PLAN_SPACING_MS[cfg.plan] ?? 600;
		const last = st.lastSendAt.get(num.id);
		if (last !== undefined && Date.now() - last < spacing) {
			const wait = Math.max(1, Math.ceil((spacing - (Date.now() - last)) / 1000));
			fail(429, 'send_rate_spacing', {}, { 'retry-after': String(wait) });
		}
	}

	function checkQuota(num) {
		if (num.used >= num.quota) {
			const { end } = cycleBounds();
			fail(429, 'messages_quota_exceeded', {}, { 'retry-after': String(Math.max(1, Math.ceil((end - Date.now()) / 1000))) });
		}
	}

	function checkContactQuota(num, digits) {
		const c = num.contacts.get(digits);
		if (c?.contactedInCycle) return;
		const used = [...num.contacts.values()].filter((x) => x.contactedInCycle).length;
		if (used >= cfg.contactQuota) {
			const { end } = cycleBounds();
			fail(402, 'contact_quota_exceeded', { details: { used, quota: cfg.contactQuota, resets_at: isoSec(end) } });
		}
	}

	/** Creates an outbound message, schedules its lifecycle and returns the 202 body. */
	function acceptOutbound(num, { recipient, contentType, content, quotedId, requestId, replyTo, idemKey, fp }) {
		const now = Date.now();
		const mm = mentionsOf(num, content.text ?? content.caption);
		if (content.text !== undefined) content.text = mm.text;
		else if (content.caption !== undefined) content.caption = mm.text;
		const m = {
			id: newId('msg'),
			numberId: num.id,
			direction: 'outbound',
			origin: 'tn',
			contentType,
			content,
			contact: null,
			group: null,
			sender: null,
			mentions: mm.mentions,
			tokens: mm.tokens,
			replied: null,
			at: now,
			status: { state: 'pending', at: now, error: null },
			deleted: false,
			receipts: [],
			reactions: [],
			responses: [],
			requestId,
			idemFp: fp,
			isReply: Boolean(replyTo),
		};
		m.preview = previewOf(contentType, content, mm.tokens);
		if (replyTo) {
			m.replied = { message_id: replyTo.id, preview: replyTo.preview };
		} else if (quotedId) {
			const q = st.messages.get(quotedId);
			if (q) m.replied = { message_id: q.id, preview: q.preview };
		}
		if (m.replied) m.isReply = true;
		if (recipient.kind === 'phone') {
			m.contact = touchContact(num, recipient.digits);
			m.contact.contactedInCycle = true;
			m.contact.lastInteractionAt = now;
		} else {
			m.group = recipient.group;
			m.groupDigits = recipient.group.members.map((x) => x.digits);
		}
		m.order = (msgOrder += 1);
		st.messages.set(m.id, m);
		num.used += 1;
		st.lastSendAt.set(num.id, now);
		if (idemKey) st.idem.set(`${num.id}|${idemKey}`, { fp, messageId: m.id });
		scheduleLifecycle(num, m, requestId);
		return m;
	}

	function behaviourFor(m) {
		const phone = m.contact?.digits;
		const key = phone ?? m.group?.id;
		return (key && st.recipients.get(key)) || (m.group && m.group.members.map((x) => st.recipients.get(x.digits)).find(Boolean)) || null;
	}

	function scheduleLifecycle(num, m, requestId) {
		const b = behaviourFor(m) ?? {};
		const d = { ...cfg.delays, ...(b.delays ?? {}) };
		const failure = b.fail ? (b.fail === true ? { code: 'whatsapp_send_failed', message: 'WhatsApp refused the message.' } : b.fail) : null;
		const stopAt = b.stopAt ?? 'read';
		later(d.sent, () => {
			if (m.forced) return;
			if (failure) return failMessage(num, m, failure, requestId);
			markSent(num, m, requestId);
		});
		if (failure) return;
		if (stopAt === 'sent') return;
		later(d.delivered, () => {
			if (m.forced || m.status.state === 'failed') return;
			markReceipt(num, m, 'delivered');
		});
		if (stopAt === 'delivered') return;
		later(d.read, () => {
			if (m.forced || m.status.state === 'failed') return;
			markReceipt(num, m, 'read');
		});
	}

	function failMessage(num, m, error, requestId) {
		m.status = { state: 'failed', at: Date.now(), error: compact({ code: error.code, message: error.message ?? 'The message could not be sent.', hint: error.hint }) };
		const type = m.isReply && m.replied ? 'message.reply.failed' : 'message.send.failed';
		emit(type, num, eventData(num, m, { at: m.status.at, kind: 'failed', extra: { error: m.status.error } }), requestId ?? m.requestId);
	}

	function markSent(num, m, requestId) {
		m.status = { state: 'sent', at: Date.now(), error: null };
		m.at = m.status.at;
		const type = m.isReply ? 'message.replied' : 'message.sent';
		emit(type, num, eventData(num, m, { at: m.at, kind: m.isReply ? 'replied' : 'sent' }), requestId ?? m.requestId);
		if (m.contact && !m.contact.firstMessagedAt) {
			m.contact.firstMessagedAt = m.at;
			emit('contact.first_messaged', num, {
				id: m.contact.id,
				name: m.contact.name ?? undefined,
				number: m.contact.digits,
				direction: 'inbound',
				channel: 'whatsapp',
				origin: 'tn',
				at: isoSec(m.at),
			});
		}
	}

	function markReceipt(num, m, state) {
		if (m.status.state === 'read') return;
		if (state === 'delivered' && m.status.state === 'delivered') return;
		const now = Date.now();
		m.status = { state, at: now, error: null };
		const people = m.group
			? (m.group.members.length ? m.group.members : [{ digits: '5511977770099', name: null }])
			: [{ digits: m.contact.digits, name: m.contact.name, contact: m.contact }];
		for (const p of people) {
			const c = p.contact ?? touchContact(num, p.digits, { name: p.name, source: 'inbound' });
			const from = compact({ contact_id: c?.id, name: c?.name ?? p.name, number: p.digits });
			m.receipts.push({ from, status: state, at: now });
			emit(`message.${state}`, num, eventData(num, m, { at: now, kind: state, receiptFrom: from }), m.requestId);
		}
	}

	/* --------------------------------------------------------------- listing */

	function encodeCursor(offset, sig) {
		return Buffer.from(JSON.stringify({ o: offset, s: sig })).toString('base64url');
	}
	function decodeCursor(cursor, sig) {
		try {
			const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
			if (!Number.isInteger(v.o) || v.o < 0 || v.s !== sig) throw new Error('bad');
			return v.o;
		} catch {
			return fail(400, 'invalid_cursor');
		}
	}
	function limitOf(q, fallback, max) {
		const raw = q.get('limit');
		if (raw === null) return fallback;
		const n = Number(raw);
		if (!Number.isInteger(n) || n < 1 || n > max) invalid([['query.limit', `Input should be between 1 and ${max}`, 'value_error']]);
		return n;
	}
	function page(items, q, sigParts, fallback = 50, max = 200) {
		const limit = limitOf(q, fallback, max);
		const sig = JSON.stringify(sigParts);
		const cursor = q.get('cursor');
		const offset = cursor ? decodeCursor(cursor, sig) : 0;
		const slice = items.slice(offset, offset + limit);
		const more = offset + limit < items.length;
		return { data: slice, cursor: more ? encodeCursor(offset + limit, sig) : null, has_more: more };
	}

	/* ----------------------------------------------------------- the router */

	const routes = [];
	const route = (method, pattern, handler) => {
		const keys = [];
		const rx = new RegExp(`^${pattern.replace(/:([a-z_]+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
		routes.push({ method, rx, keys, handler });
	};

	function findMessage(num, id) {
		if (!RE.msg.test(id)) fail(400, 'invalid_message_id');
		const m = st.messages.get(id);
		if (!m || m.numberId !== num.id) fail(404, 'not_found');
		return m;
	}

	const sendHeaders = (ctx) => ({ 'x-request-id': ctx.requestId });

	// --- usage (also the credential test of the n8n credential)
	route('GET', '/v1/usage', () => {
		const { end } = cycleBounds();
		const used = st.numbers.reduce((s, n) => s + n.used, 0);
		const quota = st.numbers.reduce((s, n) => s + n.quota, 0);
		const contacts = st.numbers.reduce((s, n) => s + [...n.contacts.values()].filter((c) => c.contactedInCycle).length, 0);
		return {
			status: 200,
			body: {
				messages: { used, quota, remaining: Math.max(0, quota - used), resets_at: isoSec(end), tier: String(cfg.plan).toUpperCase() },
				contacts: { used: contacts, quota: cfg.contactQuota, remaining: Math.max(0, cfg.contactQuota - contacts), resets_at: isoSec(end), tier: String(cfg.plan).toUpperCase() },
				numbers: st.numbers.map((n) => ({
					alias: n.alias,
					messages: { used: n.used, quota: n.quota, remaining: Math.max(0, n.quota - n.used) },
					contacts: {
						used: [...n.contacts.values()].filter((c) => c.contactedInCycle).length,
						quota: cfg.contactQuota,
						remaining: Math.max(0, cfg.contactQuota - [...n.contacts.values()].filter((c) => c.contactedInCycle).length),
					},
				})),
			},
		};
	});

	// --- numbers
	const numberRow = (n) => ({
		id: n.id,
		contact_id: n.contactId,
		name: n.name,
		type: n.type,
		alias: n.alias,
		number: n.number,
		description: n.description,
		status: { status: n.status, at: isoSec(n.statusAt), reason: n.reason },
		scheduled_deletion_at: null,
	});
	route('GET', '/v1/numbers', (ctx) => {
		const status = ctx.query.get('status');
		if (status && !['pending', 'pairing', 'inactive', 'connecting', 'connected', 'disconnected', 'reconnecting', 'failed', 'revoked'].includes(status)) {
			invalid([['query.status', 'Input should be a valid number status', 'enum']]);
		}
		const rows = st.numbers.filter((n) => !status || n.status === status).map(numberRow);
		return { status: 200, body: { data: rows, cursor: null, has_more: false } };
	});
	route('GET', '/v1/numbers/:ref', (ctx) => {
		const n = resolveNumber(ctx.params.ref);
		const base = { id: n.id, contact_id: n.contactId, name: n.name, type: n.type, alias: n.alias, number: n.number, status: n.status, at: isoSec(n.statusAt) };
		if (n.type === 'main') return { status: 200, body: base };
		return { status: 200, body: { ...base, description: n.description, scheduled_deletion_at: null, reason: n.reason, pairing: null } };
	});

	// --- send
	route('POST', '/v1/numbers/:ref/messages', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const body = ctx.body;
		if (!body || typeof body !== 'object' || Array.isArray(body)) invalid([['body', 'Input should be a valid dictionary', 'dict_type']]);
		const errs = [];
		const recipient = resolveRecipient(num, body.to, errs);
		const norm = normalizeContent(body.content, errs);
		if (body.quoted_message_id !== undefined && body.quoted_message_id !== null && !RE.msg.test(body.quoted_message_id)) fail(400, 'invalid_message_id');
		if (errs.length) invalid(errs);
		let quotedId = body.quoted_message_id ?? null;
		if (quotedId) {
			const q = st.messages.get(quotedId);
			if (!q || q.numberId !== num.id) fail(404, 'not_found');
		}
		return sendCommon(ctx, num, { recipient, norm, quotedId, fpKind: 'send' });
	});

	function sendCommon(ctx, num, { recipient, norm, quotedId, fpKind, replyTo }) {
		requireConnected(num);
		requireSubscription();
		if (recipient.kind === 'group') requireFeature('groups');
		const idemKey = ctx.headers['idempotency-key'];
		if (idemKey !== undefined && (idemKey.trim() === '' || idemKey.length > 255)) fail(400, 'invalid_idempotency_key');
		const target = recipient.kind === 'group' ? recipient.group.id : recipient.digits;
		const fp = JSON.stringify(canon({ fpKind, target, type: norm.type, content: norm.content, quotedId, replyTo: replyTo?.id }));
		if (idemKey) {
			const prior = st.idem.get(`${num.id}|${idemKey}`);
			if (prior) {
				const original = st.messages.get(prior.messageId);
				if (original && original.idemFp === fp) {
					return {
						status: 202,
						body: { message_id: original.id, status: statusBody(original) },
						headers: sendHeaders(ctx),
					};
				}
				fail(409, 'idempotency_key_conflict');
			}
		}
		checkSpacing(num);
		checkQuota(num);
		if (recipient.kind === 'phone') checkContactQuota(num, recipient.digits);
		const m = acceptOutbound(num, { recipient, contentType: norm.type, content: norm.content, quotedId, requestId: ctx.requestId, replyTo, idemKey, fp });
		return { status: 202, body: { message_id: m.id, status: statusBody(m) }, headers: sendHeaders(ctx) };
	}
	const statusBody = (m) => ({ state: m.status.state, at: isoSec(m.status.at), error: m.status.error ?? null });

	route('POST', '/v1/numbers/:ref/messages/read', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		requireFeature('markRead');
		requireConnected(num);
		const errs = [];
		const r = resolveRecipient(num, ctx.body?.to, errs);
		if (errs.length) invalid(errs);
		void r;
		return { status: 202, body: { operation_id: `op_read_${hex(6)}`, status: { state: 'pending', at: isoSec(Date.now()) } }, headers: sendHeaders(ctx) };
	});

	route('POST', '/v1/numbers/:ref/typing-indicator', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const body = ctx.body;
		if (!body || typeof body.is_typing !== 'boolean') invalid([['body.is_typing', 'Field required', 'missing']]);
		const errs = [];
		const r = resolveRecipient(num, body.to, errs);
		if (errs.length) invalid(errs);
		requireFeature('typing');
		if (r.kind === 'group') requireFeature('groups');
		requireConnected(num);
		return { status: 202, body: { operation_id: `op_typing_${hex(6)}`, status: { state: 'pending', at: isoSec(Date.now()) } }, headers: sendHeaders(ctx) };
	});

	route('GET', '/v1/numbers/:ref/messages/quota', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const { start, end } = cycleBounds();
		return {
			status: 200,
			body: { used: num.used, quota: num.quota, remaining: Math.max(0, num.quota - num.used), cycle_start: isoSec(start), cycle_end: isoSec(end), resets_at: isoSec(end), tier: String(cfg.plan).toUpperCase() },
		};
	});
	route('GET', '/v1/numbers/:ref/contacts/quota', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const { start, end } = cycleBounds();
		const used = [...num.contacts.values()].filter((c) => c.contactedInCycle).length;
		return {
			status: 200,
			body: { used, quota: cfg.contactQuota, remaining: Math.max(0, cfg.contactQuota - used), cycle_start: isoSec(start), cycle_end: isoSec(end), resets_at: isoSec(end), tier: String(cfg.plan).toUpperCase() },
		};
	});

	// --- list messages
	route('GET', '/v1/numbers/:ref/messages', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const q = ctx.query;
		const direction = q.get('direction');
		if (direction && !['inbound', 'outbound'].includes(direction)) invalid([['query.direction', "Input should be 'outbound' or 'inbound'", 'enum']]);
		const groupId = q.get('group_id');
		const contactId = q.get('contact_id');
		let group = null;
		let contact = null;
		if (groupId) {
			if (!RE.grp.test(groupId)) fail(400, 'invalid_group_id');
			group = num.groups.get(groupId);
			if (!group) fail(404, 'group_not_found');
		}
		if (contactId) {
			if (!RE.ct.test(contactId)) fail(400, 'invalid_contact_id');
			contact = [...num.contacts.values()].find((c) => c.id === contactId);
			if (!contact) fail(404, 'contact_not_found');
		}
		const rows = [...st.messages.values()]
			.filter((m) => m.numberId === num.id)
			.filter((m) => !direction || m.direction === direction)
			.filter((m) => !group || m.group?.id === group.id)
			.filter((m) => !contact || m.contact?.id === contact.id || m.sender?.id === contact.id)
			.sort((a, b) => b.at - a.at || b.order - a.order);
		const p = page(rows, q, [num.id, direction, groupId, contactId]);
		return { status: 200, body: { ...p, data: p.data.map((m) => messageListJson(num, m)) } };
	});

	route('GET', '/v1/numbers/:ref/messages/:id', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		return { status: 200, body: messageJson(num, findMessage(num, ctx.params.id)) };
	});
	route('GET', '/v1/numbers/:ref/messages/:id/status', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const m = findMessage(num, ctx.params.id);
		return { status: 200, body: { message_id: m.id, status: statusBody(m) } };
	});
	route('GET', '/v1/numbers/:ref/messages/:id/receipts', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const m = findMessage(num, ctx.params.id);
		return { status: 200, body: { message_id: m.id, receipts: m.receipts.map((r) => ({ from: r.from, status: r.status, at: isoSec(r.at) })) } };
	});
	route('GET', '/v1/numbers/:ref/messages/:id/reactions', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const m = findMessage(num, ctx.params.id);
		return { status: 200, body: { message_id: m.id, reactions: m.reactions.map((r) => ({ from: r.from, emoji: r.emoji, at: isoSec(r.at), direction: r.direction })) } };
	});
	route('GET', '/v1/numbers/:ref/messages/:id/responses', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const m = findMessage(num, ctx.params.id);
		if (m.contentType !== 'calendar') fail(400, 'message_not_calendar');
		const latest = new Map();
		for (const r of m.responses) latest.set(r.from.number, r);
		const rows = [...latest.values()].sort((a, b) => b.at - a.at);
		const counts = { going: 0, not_going: 0, maybe: 0, extra_guests: 0 };
		for (const r of rows) {
			counts[r.response] += 1;
			counts.extra_guests += r.extra_guests ?? 0;
		}
		return {
			status: 200,
			body: {
				message_id: m.id,
				counts,
				responses: rows.map((r) => compact({ from: r.from, response: r.response, extra_guests: r.extra_guests || undefined, at: isoSec(r.at) })),
			},
		};
	});

	// --- reply
	route('POST', '/v1/numbers/:ref/messages/:id/reply', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const target = findMessage(num, ctx.params.id);
		const errs = [];
		const norm = normalizeContent(ctx.body?.content, errs);
		if (errs.length) invalid(errs);
		if (target.deleted || (target.direction === 'outbound' && ['pending', 'failed'].includes(target.status.state))) fail(422, 'message_not_replyable');
		const recipient = target.group ? { kind: 'group', group: target.group } : { kind: 'phone', digits: (target.direction === 'outbound' ? target.contact : target.sender ?? target.contact).digits };
		return sendCommon(ctx, num, { recipient, norm, quotedId: null, fpKind: 'reply', replyTo: target });
	});

	// --- react
	route('POST', '/v1/numbers/:ref/messages/:id/react', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const m = findMessage(num, ctx.params.id);
		const body = ctx.body;
		if (!body || typeof body !== 'object' || !('reaction' in body)) invalid([['body.reaction', 'Field required', 'missing']]);
		if (body.reaction !== null && typeof body.reaction !== 'string') invalid([['body.reaction', 'Input should be a valid string', 'string_type']]);
		requireFeature('reactions');
		requireConnected(num);
		if (m.deleted || (m.direction === 'outbound' && m.status.state !== 'sent' && m.status.state !== 'delivered' && m.status.state !== 'read')) fail(422, 'message_not_reactable');
		const emoji = body.reaction ?? '';
		const opId = `op_reaction_${hex(6)}`;
		later(cfg.delays.op, () => {
			m.reactions = m.reactions.filter((r) => r.direction !== 'outbound');
			const us = compact({ name: num.name, alias: num.alias, number: num.number });
			if (emoji) m.reactions.push({ from: us, emoji, at: Date.now(), direction: 'outbound' });
			const p = parties(num, m);
			emit('message.reacted', num, {
				id: m.id,
				from: us,
				to: m.group ? p.to : compact({ contact_id: m.contact?.id ?? m.sender?.id, name: (m.contact ?? m.sender)?.name, number: (m.contact ?? m.sender)?.digits }),
				preview: emoji,
				content_type: 'text',
				direction: 'outbound',
				channel: 'whatsapp',
				origin: 'tn',
				at: isoSec(Date.now()),
			}, ctx.requestId);
		});
		return { status: 202, body: { message_id: m.id, reaction_event_id: opId, status: { state: 'pending', at: isoSec(Date.now()) } }, headers: sendHeaders(ctx) };
	});

	// --- edit
	route('POST', '/v1/numbers/:ref/messages/:id/edit', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const m = findMessage(num, ctx.params.id);
		const body = ctx.body;
		if (!body || typeof body !== 'object') invalid([['body', 'Input should be a valid dictionary', 'dict_type']]);
		requireConnected(num);
		if (m.direction !== 'outbound' || m.deleted) fail(400, 'message_not_editable');
		const errs = [];
		const f = (n) => `body.${n}`;
		let apply;
		let canceled = false;
		if (typeof body.text === 'string' || body.text !== undefined) {
			if (m.contentType !== 'text') fail(400, 'message_not_editable');
			if (typeof body.text !== 'string' || !body.text) errs.push([f('text'), 'String should have at least 1 character', 'string_too_short']);
			else if (body.text.length > 4096) errs.push([f('text'), 'String should have at most 4096 characters', 'string_too_long']);
			if (errs.length) invalid(errs);
			if (Date.now() - m.at > 15 * 60_000) fail(400, 'edit_window_expired');
			apply = () => {
				const mm = mentionsOf(num, body.text);
				m.content.text = mm.text;
				m.mentions = mm.mentions;
				m.tokens = mm.tokens;
			};
		} else if (body.caption !== undefined) {
			if (!['image', 'video', 'document'].includes(m.contentType)) fail(400, 'message_not_editable');
			if (typeof body.caption !== 'string' || !body.caption || body.caption.length > 1024) invalid([[f('caption'), 'String should have 1 to 1024 characters', 'string_too_long']]);
			if (Date.now() - m.at > 15 * 60_000) fail(400, 'edit_window_expired');
			apply = () => {
				const mm = mentionsOf(num, body.caption);
				m.content.caption = mm.text;
				m.mentions = mm.mentions;
				m.tokens = mm.tokens;
			};
		} else if (body.start_at !== undefined || body.name !== undefined) {
			if (m.contentType !== 'calendar') fail(400, 'message_not_editable');
			const norm = normalizeContent({ ...body, canceled: undefined }, errs);
			if (errs.length) invalid(errs);
			canceled = body.canceled === true;
			apply = () => {
				m.content = { ...norm.content, ...(canceled ? { is_canceled: true } : {}) };
			};
		} else {
			invalid([['body', 'Provide text, caption or a calendar event', 'value_error']]);
		}
		const requestId = ctx.requestId;
		later(cfg.delays.op, () => {
			apply();
			m.preview = previewOf(m.contentType, m.content, m.tokens ?? []);
			m.idemFp = JSON.stringify(canon({ fpKind: 'send', target: m.group?.id ?? m.contact?.digits, type: m.contentType, content: m.content, quotedId: m.replied?.message_id ?? null }));
			emit('message.edited', num, eventData(num, m, { at: Date.now(), kind: 'edited', extra: canceled ? { canceled: true } : {} }), requestId);
		});
		return { status: 202, body: { message_id: m.id, status: { state: 'pending', at: isoSec(Date.now()), error: null } }, headers: sendHeaders(ctx) };
	});

	// --- delete
	route('POST', '/v1/numbers/:ref/messages/:id/delete', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const m = findMessage(num, ctx.params.id);
		requireConnected(num);
		if (m.deleted || m.direction !== 'outbound' || ['pending', 'failed'].includes(m.status.state)) fail(400, 'message_not_deletable');
		const requestId = ctx.requestId;
		later(cfg.delays.op, () => {
			m.deleted = true;
			emit('message.deleted', num, eventData(num, m, { at: Date.now(), kind: 'deleted' }), requestId);
		});
		return { status: 202, body: { message_id: m.id, status: { state: 'pending', at: isoSec(Date.now()), error: null } }, headers: sendHeaders(ctx) };
	});

	// --- contacts
	route('GET', '/v1/numbers/:ref/contacts', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const q = ctx.query;
		const phone = q.get('phone');
		const name = q.get('name');
		const source = q.get('source');
		const cic = q.get('contacted_in_cycle');
		if (source && !['inbound', 'outbound', 'mention', 'self'].includes(source)) invalid([['query.source', 'Input should be inbound, outbound, mention or self', 'enum']]);
		if (cic !== null && !['true', 'false'].includes(cic)) invalid([['query.contacted_in_cycle', 'Input should be a valid boolean', 'bool_parsing']]);
		let wanted = null;
		if (phone) {
			wanted = normalizePhone(phone);
			if (!wanted) fail(400, 'invalid_phone_number');
		}
		const rows = [...num.contacts.values()]
			.filter((c) => !wanted || c.digits === wanted)
			.filter((c) => !name || (c.name ?? '').toLowerCase().includes(name.toLowerCase()))
			.filter((c) => !source || c.source === source)
			.filter((c) => cic === null || c.contactedInCycle === (cic === 'true'))
			.sort((a, b) => b.createdAt - a.createdAt || b.digits.localeCompare(a.digits));
		const p = page(rows, q, [num.id, phone, name, source, cic]);
		return { status: 200, body: { ...p, data: p.data.map((c) => contactJson(num, c)) } };
	});
	route('GET', '/v1/numbers/:ref/contacts/:id', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		if (!RE.ct.test(ctx.params.id)) fail(400, 'invalid_contact_id');
		const c = [...num.contacts.values()].find((x) => x.id === ctx.params.id);
		if (!c) fail(404, 'contact_not_found');
		return { status: 200, body: contactJson(num, c) };
	});

	// --- groups
	route('GET', '/v1/numbers/:ref/groups', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		const q = ctx.query;
		const name = q.get('name');
		const includeLeft = q.get('include_left') === 'true';
		const rows = [...num.groups.values()]
			.filter((g) => includeLeft || g.active)
			.filter((g) => !name || (g.name ?? '').toLowerCase().includes(name.toLowerCase()))
			.sort((a, b) => b.createdAt - a.createdAt);
		const p = page(rows, q, [num.id, name, includeLeft]);
		return { status: 200, body: { ...p, data: p.data.map((g) => groupJson(num, g)) } };
	});
	route('GET', '/v1/numbers/:ref/groups/:id', (ctx) => {
		const num = resolveNumber(ctx.params.ref);
		if (!RE.grp.test(ctx.params.id)) fail(400, 'invalid_group_id');
		const g = num.groups.get(ctx.params.id);
		if (!g) fail(404, 'group_not_found');
		return { status: 200, body: groupJson(num, g) };
	});

	// --- events
	route('GET', '/v1/events', (ctx) => {
		const q = ctx.query;
		const limit = limitOf(q, 25, 100);
		const types = [...q.getAll('types[]'), ...q.getAll('types')].flatMap((t) => t.split(',')).filter(Boolean);
		if (types.length > 20) invalid([['query.types', 'List should have at most 20 items', 'too_long']]);
		const typeGlob = q.get('type');
		const numberId = q.get('number_id');
		const numberAlias = q.get('number_alias');
		if (numberId && !RE.num.test(numberId)) fail(400, 'invalid_number_id');
		const requestId = q.get('request_id');
		if (requestId && !RE.req.test(requestId)) fail(400, 'invalid_request_id');
		const after = q.get('starting_after');
		const before = q.get('ending_before');
		for (const c of [after, before]) if (c && !RE.evt.test(c)) fail(400, 'invalid_event_id');
		const parseTime = (name) => {
			const raw = q.get(name);
			if (raw === null) return null;
			const t = Date.parse(raw);
			if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}/.test(raw)) invalid([[`query.${name}`, 'Input should be a valid datetime', 'datetime_parsing']]);
			return t;
		};
		const gte = parseTime('created[gte]');
		const lte = parseTime('created[lte]');
		const glob = typeGlob ? new RegExp(`^${typeGlob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`) : null;
		let rows = st.events
			.filter((e) => !types.length || types.includes(e.type))
			.filter((e) => !glob || glob.test(e.type))
			.filter((e) => !numberId || e.number_id === numberId)
			.filter((e) => !numberAlias || e.number_alias === numberAlias)
			.filter((e) => !requestId || e._request_id === requestId)
			.filter((e) => gte === null || Date.parse(e.created_at) >= gte)
			.filter((e) => lte === null || Date.parse(e.created_at) <= lte)
			.sort((a, b) => b.seq - a.seq);
		if (after) {
			const i = rows.findIndex((e) => e.id === after);
			if (i >= 0) rows = rows.slice(i + 1);
		}
		if (before) {
			const i = rows.findIndex((e) => e.id === before);
			if (i >= 0) rows = rows.slice(0, i).slice(-limit);
		}
		const slice = rows.slice(0, limit);
		return { status: 200, body: { object: 'list', data: slice.map(publicEvent), has_more: rows.length > limit } };
	});

	/* ------------------------------------------------------------ test API */

	const T = (method, path, handler) => route(method, `/__test${path}`, handler);
	const ok = (body = { ok: true }) => ({ status: 200, body });

	function resolveNumberForTest(ref) {
		return resolveNumber(ref || 'main');
	}

	T('POST', '/reset', (ctx) => {
		reset(ctx.body?.keepConfig === true);
		return ok({ ok: true, organization_id: st.orgId, number_id: st.numbers[0].id });
	});

	T('GET', '/state', () =>
		ok({
			organization_id: st.orgId,
			config: { ...cfg, apiKey: `${cfg.apiKey.slice(0, 4)}...` },
			numbers: st.numbers.map((n) => ({ id: n.id, alias: n.alias, number: n.number, status: n.status, used: n.used, quota: n.quota, contacts: n.contacts.size, groups: [...n.groups.values()].map((g) => ({ id: g.id, name: g.name })) })),
			messages: st.messages.size,
			events: st.events.length,
			webhook_targets: st.targets.map((t) => ({ id: t.id, url: t.url, enabled: t.enabled })),
		}),
	);

	T('POST', '/config', (ctx) => {
		const b = ctx.body ?? {};
		if (b.apiKey) cfg.apiKey = b.apiKey;
		if (b.delays) cfg.delays = { ...cfg.delays, ...b.delays };
		if (b.plan) {
			if (!PLAN_FEATURES[b.plan]) invalid([['plan', 'Unknown plan', 'enum']]);
			cfg.plan = b.plan;
		}
		for (const k of ['enforceSpacing', 'spacingMs', 'subscriptionActive', 'latencyMs', 'contactQuota', 'webhookAttempts', 'webhookRetryMs']) if (k in b) cfg[k] = b[k];
		if (b.quota !== undefined) {
			cfg.quota = b.quota;
			for (const n of st.numbers) n.quota = b.quota;
		}
		return ok({ ok: true, config: { ...cfg, apiKey: `${cfg.apiKey.slice(0, 4)}...` } });
	});

	T('POST', '/quota', (ctx) => {
		const b = ctx.body ?? {};
		const n = resolveNumberForTest(b.number);
		if (b.limit !== undefined) n.quota = b.limit;
		if (b.used !== undefined) n.used = b.used;
		if (b.remaining !== undefined) n.used = Math.max(0, n.quota - b.remaining);
		return ok({ used: n.used, quota: n.quota, remaining: Math.max(0, n.quota - n.used) });
	});

	T('POST', '/number', (ctx) => {
		const b = ctx.body ?? {};
		if (!b.alias || !b.number) invalid([['alias,number', 'alias and number are required']]);
		const n = addNumber({ alias: b.alias, number: b.number, name: b.name ?? null, description: b.description ?? null, status: b.status ?? 'connected' });
		return ok({ id: n.id, alias: n.alias, number: n.number });
	});
	T('POST', '/number-status', (ctx) => {
		const b = ctx.body ?? {};
		const n = resolveNumberForTest(b.number);
		n.status = b.status;
		n.statusAt = Date.now();
		n.reason = b.reason ?? null;
		return ok({ id: n.id, status: n.status });
	});
	T('POST', '/contact', (ctx) => {
		const b = ctx.body ?? {};
		const n = resolveNumberForTest(b.number);
		const digits = normalizePhone(b.phone);
		if (!digits) fail(400, 'invalid_phone_number');
		const c = touchContact(n, digits, { name: b.name, source: b.source ?? 'inbound' });
		return ok({ id: c.id, phone: `+${digits}` });
	});
	T('POST', '/group', (ctx) => {
		const b = ctx.body ?? {};
		const n = resolveNumberForTest(b.number);
		const g = addGroup(n, { id: b.id, name: b.name, members: b.members ?? [], description: b.description, active: b.active !== false });
		return ok({ id: g.id, name: g.name });
	});

	T('POST', '/recipient', (ctx) => {
		const b = ctx.body ?? {};
		const key = b.group_id ?? normalizePhone(b.number);
		if (!key) invalid([['number', 'number must be E.164 with +, or give group_id']]);
		const prev = st.recipients.get(key) ?? {};
		const next = { ...prev };
		if ('fail' in b) next.fail = b.fail === false ? undefined : b.fail;
		if (b.delays) next.delays = b.delays;
		if (b.stopAt) next.stopAt = b.stopAt;
		if (b.name) {
			for (const n of st.numbers) touchContact(n, key, { name: b.name, source: 'inbound' });
		}
		st.recipients.set(key, next);
		return ok({ key, behaviour: next });
	});

	T('POST', '/message-state', (ctx) => {
		const b = ctx.body ?? {};
		const m = st.messages.get(b.message_id);
		if (!m) fail(404, 'not_found');
		const num = st.numbers.find((x) => x.id === m.numberId);
		m.forced = true;
		if (b.state === 'failed') failMessage(num, m, b.error ?? { code: 'whatsapp_send_failed', message: 'WhatsApp refused the message.' });
		else {
			if (m.status.state === 'pending') markSent(num, m);
			if (['delivered', 'read'].includes(b.state)) markReceipt(num, m, 'delivered');
			if (b.state === 'read') markReceipt(num, m, 'read');
		}
		return ok({ state: m.status.state });
	});

	T('POST', '/message-age', (ctx) => {
		const b = ctx.body ?? {};
		const m = st.messages.get(b.message_id);
		if (!m) fail(404, 'not_found');
		m.at -= (b.seconds ?? 0) * 1000;
		return ok({ at: isoSec(m.at) });
	});

	T('POST', '/inject-message', (ctx) => {
		const b = ctx.body ?? {};
		const num = resolveNumberForTest(b.number);
		const from = typeof b.from === 'object' && b.from ? b.from : { number: b.from, name: b.name };
		const digits = normalizePhone(from.number);
		if (!digits) invalid([['from', 'from must be a phone in E.164 format with +, for example +5511977770001']]);
		const at = b.at ? Date.parse(b.at) : Date.now();
		const contact = touchContact(num, digits, { name: from.name ?? b.name, source: 'inbound' });
		contact.lastInteractionAt = at;
		let group = null;
		if (b.group) {
			const gid = typeof b.group === 'string' ? b.group : b.group.id;
			group = gid ? num.groups.get(gid) : [...num.groups.values()].find((g) => g.name === b.group.name);
			if (!group) {
				if (gid && !RE.grp.test(gid)) invalid([['group', 'group id must be grp_ plus 32 hex']]);
				group = addGroup(num, { id: gid, name: b.group.name ?? 'Group', members: [] });
			}
			if (!group.members.some((x) => x.digits === digits)) group.members.push({ digits, name: contact.name });
		}
		let contentType;
		let content;
		if (b.audio) {
			contentType = 'audio';
			content = { url: b.audio.url ?? 'https://storage.example.test/inbound/voice-note.ogg', mime_type: b.audio.mimeType ?? 'audio/ogg', size_bytes: 12_345 };
			if (typeof b.audio.transcript === 'string') content.transcription = compact({ kind: 'available', text: b.audio.transcript, language: b.audio.language });
			else if (b.audio.transcriptionError) content.transcription = { kind: 'unavailable', reason: b.audio.transcriptionError };
		} else if (b.image) {
			contentType = 'image';
			content = compact({ url: b.image.url ?? 'https://storage.example.test/inbound/photo.jpeg', caption: b.image.caption, mime_type: 'image/jpeg', size_bytes: 123_456 });
		} else if (b.location) {
			contentType = 'location';
			content = compact(b.location);
		} else if (b.document) {
			contentType = 'document';
			content = compact({ url: b.document.url ?? 'https://storage.example.test/inbound/file.pdf', filename: b.document.filename, caption: b.document.caption, mime_type: 'application/pdf', size_bytes: 54_321 });
		} else {
			if (typeof b.text !== 'string') invalid([['text', 'give one of text, audio, image, location or document']]);
			contentType = 'text';
			content = { text: b.text };
		}
		const mm = mentionsOf(num, content.text ?? content.caption);
		if (content.text !== undefined) content.text = mm.text;
		const m = {
			id: newId('msg'),
			numberId: num.id,
			direction: 'inbound',
			origin: 'native',
			contentType,
			content,
			contact: group ? null : contact,
			sender: contact,
			group,
			mentions: mm.mentions,
			tokens: mm.tokens,
			replied: null,
			at,
			status: { state: 'delivered', at, error: null },
			deleted: false,
			receipts: [],
			reactions: [],
			responses: [],
			requestId: null,
			isReply: false,
		};
		if (b.reply_to) {
			const q = st.messages.get(b.reply_to);
			if (!q) fail(404, 'not_found');
			m.replied = { message_id: q.id, preview: q.preview };
			m.isReply = true;
		}
		m.preview = previewOf(contentType, content, mm.tokens);
		m.order = (msgOrder += 1);
		st.messages.set(m.id, m);
		const ev = emit(m.isReply ? 'message.replied' : 'message.received', num, eventData(num, m, { at, kind: m.isReply ? 'replied' : 'received' }));
		return ok({ message_id: m.id, event_id: ev.id, contact_id: contact.id, group_id: group?.id ?? null, number_id: num.id });
	});

	T('POST', '/inject-calendar-response', (ctx) => {
		const b = ctx.body ?? {};
		const m = st.messages.get(b.message_id);
		if (!m) fail(404, 'not_found');
		if (m.contentType !== 'calendar') fail(400, 'message_not_calendar');
		const num = st.numbers.find((x) => x.id === m.numberId);
		const aliases = { accepted: 'going', going: 'going', declined: 'not_going', not_going: 'not_going', tentative: 'maybe', maybe: 'maybe' };
		const response = aliases[b.response];
		if (!response) invalid([['response', 'response must be going, not_going or maybe (accepted, declined and tentative are accepted as aliases)']]);
		const from = typeof b.from === 'object' && b.from ? b.from : { number: b.from, name: b.name };
		const digits = normalizePhone(from.number);
		if (!digits) invalid([['from', 'from must be a phone in E.164 format with +']]);
		const contact = touchContact(num, digits, { name: from.name ?? b.name, source: 'inbound' });
		const guests = Number(b.extra_guests ?? 0);
		const at = Date.now();
		const fromJson = compact({ contact_id: contact.id, name: contact.name, number: digits });
		m.responses.push({ from: fromJson, response, extra_guests: guests, at });
		const to = m.group ? compact({ group_id: m.group.id, name: m.group.name }) : compact({ name: num.name, alias: num.alias, number: num.number });
		const ev = emit('message.calendar_responded', num, {
			id: m.id,
			from: fromJson,
			to,
			response,
			...(guests > 0 ? { extra_guests: guests } : {}),
			direction: 'inbound',
			channel: 'whatsapp',
			origin: 'native',
			at: isoSec(at),
		});
		return ok({ event_id: ev.id, response });
	});

	T('POST', '/inject-reaction', (ctx) => {
		const b = ctx.body ?? {};
		const m = st.messages.get(b.message_id);
		if (!m) fail(404, 'not_found');
		const num = st.numbers.find((x) => x.id === m.numberId);
		const from = typeof b.from === 'object' && b.from ? b.from : { number: b.from, name: b.name };
		const digits = normalizePhone(from.number);
		if (!digits) invalid([['from', 'from must be a phone in E.164 format with +']]);
		const contact = touchContact(num, digits, { name: from.name ?? b.name, source: 'inbound' });
		const fromJson = compact({ contact_id: contact.id, name: contact.name, number: digits });
		m.reactions = m.reactions.filter((r) => r.from.number !== digits);
		if (b.emoji) m.reactions.push({ from: fromJson, emoji: b.emoji, at: Date.now(), direction: 'inbound' });
		const ev = emit('message.reacted', num, {
			id: m.id,
			from: fromJson,
			to: compact({ name: num.name, alias: num.alias, number: num.number }),
			preview: b.emoji ?? '',
			content_type: 'text',
			direction: 'inbound',
			channel: 'whatsapp',
			origin: 'native',
			at: isoSec(Date.now()),
		});
		return ok({ event_id: ev.id });
	});

	T('GET', '/log', (ctx) => {
		const q = ctx.query;
		const since = Number(q.get('since') ?? 0);
		const method = q.get('method');
		const path = q.get('path');
		let rows = st.log.filter((r) => r.seq > since);
		if (method) rows = rows.filter((r) => r.method === method.toUpperCase());
		if (path) rows = rows.filter((r) => r.path.includes(path));
		const limit = Number(q.get('limit') ?? 1000);
		return ok({ count: rows.length, next_seq: st.log.length ? st.log[st.log.length - 1].seq : 0, entries: rows.slice(-limit) });
	});
	T('DELETE', '/log', () => {
		st.log = [];
		return ok();
	});

	T('GET', '/messages', (ctx) => {
		const q = ctx.query;
		const to = q.get('to');
		const status = q.get('status');
		const direction = q.get('direction');
		const rows = [...st.messages.values()]
			.filter((m) => !direction || m.direction === direction)
			.filter((m) => !status || m.status.state === status)
			.filter((m) => !to || m.contact?.digits === normalizePhone(to) || m.group?.id === to)
			.map((m) => messageJson(st.numbers.find((n) => n.id === m.numberId), m));
		return ok({ count: rows.length, messages: rows });
	});
	T('GET', '/events', (ctx) => {
		const q = ctx.query;
		const type = q.get('type');
		const rows = st.events.filter((e) => !type || e.type === type || (type.endsWith('*') && e.type.startsWith(type.slice(0, -1))));
		return ok({ count: rows.length, events: rows.map((e) => ({ seq: e.seq, ...publicEvent(e) })) });
	});

	T('POST', '/fault', (ctx) => {
		const b = ctx.body ?? {};
		st.faults.push({ method: b.method ?? null, path: new RegExp(b.path ?? '.*'), status: b.status ?? 503, body: b.body ?? { error: 'service_unavailable' }, headers: b.headers ?? {}, times: b.times ?? 1, delayMs: b.delayMs ?? 0 });
		return ok({ faults: st.faults.length });
	});
	T('DELETE', '/fault', () => {
		st.faults = [];
		return ok();
	});

	T('POST', '/webhook-target', (ctx) => {
		const b = ctx.body ?? {};
		if (!b.url || !/^https?:\/\//.test(b.url)) invalid([['url', 'url must be http or https']]);
		const target = { id: hex(6), url: b.url, secret: b.secret ?? 'whsec_harness_secret', types: Array.isArray(b.events) && b.events.length ? b.events : null, enabled: b.enabled !== false };
		if (b.replace !== false) st.targets = [];
		st.targets.push(target);
		return ok({ id: target.id, url: target.url, types: target.types });
	});
	T('DELETE', '/webhook-target', () => {
		st.targets = [];
		return ok();
	});
	T('POST', '/webhook-deliver', (ctx) => {
		const b = ctx.body ?? {};
		const ev = st.events.find((e) => e.id === b.event_id);
		if (!ev) fail(404, 'not_found');
		const target = st.targets.find((t) => !b.target_id || t.id === b.target_id) ?? (b.url ? { id: 'adhoc', url: b.url, secret: b.secret ?? 'whsec_harness_secret' } : null);
		if (!target) invalid([['target', 'register a target first or give url']]);
		const rec = deliver(target, ev, { tamper: b.tamper, once: true });
		return ok({ delivery_id: rec.id });
	});
	T('GET', '/deliveries', () => ok({ count: st.deliveries.length, deliveries: st.deliveries }));

	T('GET', '/health', () => ok({ ok: true }));

	/* ------------------------------------------------------------ http layer */

	function flatPath(pathname) {
		// Shortcuts for the main number.
		const m = pathname.match(/^\/v1\/(messages|contacts|groups|typing-indicator)(\/.*)?$/);
		if (m) return `/v1/numbers/main/${m[1]}${m[2] ?? ''}`;
		if (pathname === '/v1/usage/messages') return '/v1/numbers/main/messages/quota';
		return pathname;
	}

	function readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			let size = 0;
			req.on('data', (c) => {
				size += c.length;
				if (size > 256 * 1024) reject(new ApiError(413, { error: 'request_too_large', details: { max_bytes: 262144 } }));
				else chunks.push(c);
			});
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});
	}

	async function handle(req, res) {
		const started = Date.now();
		const url = new URL(req.url, 'http://mock');
		const isTest = url.pathname.startsWith('/__test');
		const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : v]));
		const entry = {
			seq: 0,
			at: new Date().toISOString(),
			method: req.method,
			path: url.pathname,
			query: {},
			headers: compact({
				authorization: headers.authorization ? headers.authorization.replace(/^(Bearer\s+)(.{4}).*$/i, '$1$2...') : undefined,
				'idempotency-key': headers['idempotency-key'],
				'content-type': headers['content-type'],
				'user-agent': headers['user-agent'],
			}),
			body: undefined,
			status: 0,
			response: undefined,
		};
		for (const key of new Set(url.searchParams.keys())) {
			const all = url.searchParams.getAll(key);
			entry.query[key] = all.length === 1 ? all[0] : all;
		}
		let status = 500;
		let body;
		let extraHeaders = {};
		try {
			const raw = await readBody(req);
			let parsed;
			if (raw) {
				try {
					parsed = JSON.parse(raw);
				} catch {
					if (!isTest) fail(400, 'invalid_json');
					parsed = undefined;
				}
			}
			entry.body = parsed;
			const ctx = { headers, query: url.searchParams, body: parsed, params: {}, requestId: newId('req') };

			if (req.method === 'GET' && url.pathname === '/healthz') {
				status = 200;
				body = { status: 'ok' };
			} else {
				if (cfg.latencyMs && !isTest) await sleep(cfg.latencyMs);
				if (!isTest) {
					// Faults first: they model outages and throttling in front of everything.
					const fi = st.faults.findIndex((f) => (!f.method || f.method === req.method) && f.path.test(`${url.pathname}`));
					if (fi >= 0) {
						const f = st.faults[fi];
						f.times -= 1;
						if (f.times <= 0) st.faults.splice(fi, 1);
						if (f.delayMs) await sleep(f.delayMs);
						throw new ApiError(f.status, f.body, f.headers);
					}
					const auth = headers.authorization ?? '';
					const token = auth.match(/^Bearer\s+(.+)$/i)?.[1];
					if (!token || token !== cfg.apiKey) fail(401, 'not_authenticated');
				}
				const pathname = isTest ? url.pathname : flatPath(url.pathname);
				let matched = null;
				let pathExists = false;
				for (const r of routes) {
					const mm = pathname.match(r.rx);
					if (!mm) continue;
					pathExists = true;
					if (r.method !== req.method) continue;
					ctx.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(mm[i + 1])]));
					matched = r;
					break;
				}
				if (!matched) {
					if (pathExists) fail(405, 'method_not_allowed');
					fail(404, 'not_found');
				}
				const result = await matched.handler(ctx);
				status = result.status;
				body = result.body;
				extraHeaders = result.headers ?? {};
			}
		} catch (error) {
			if (error instanceof ApiError) {
				status = error.status;
				body = error.body;
				extraHeaders = error.headers;
			} else {
				console.error('[mock] unexpected error:', error);
				status = 500;
				body = { error: 'internal_error' };
			}
		}
		entry.status = status;
		entry.response = body;
		entry.duration_ms = Date.now() - started;
		if (!isTest && st) {
			entry.seq = st.log.length ? st.log[st.log.length - 1].seq + 1 : 1;
			st.log.push(entry);
			if (st.log.length > 20000) st.log.shift();
		}
		const payload = JSON.stringify(body ?? {});
		res.writeHead(status, {
			'content-type': 'application/json',
			'content-length': Buffer.byteLength(payload),
			'x-request-id': extraHeaders['x-request-id'] ?? crypto.randomUUID(),
			...extraHeaders,
		});
		res.end(payload);
	}

	reset();

	return {
		get state() {
			return st;
		},
		get config() {
			return cfg;
		},
		reset,
		async start(port = Number(process.env.MOCK_PORT ?? 9099), host = process.env.MOCK_HOST ?? '127.0.0.1') {
			server = http.createServer((req, res) => {
				handle(req, res).catch((error) => {
					console.error('[mock] fatal:', error);
					res.writeHead(500);
					res.end('{"error":"internal_error"}');
				});
			});
			await new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, host, resolve);
			});
			return { port: server.address().port, host, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}` };
		},
		async stop() {
			for (const t of timers) clearTimeout(t);
			timers.clear();
			if (server) await new Promise((resolve) => server.close(resolve));
			server = null;
		},
	};
}

/* ---------------------------------------------------------------------- CLI */

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		if (key === 'enforce-spacing') out.enforceSpacing = true;
		else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[(i += 1)];
	}
	return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const args = parseArgs(process.argv.slice(2));
	const mock = createMockApi({
		apiKey: args.key,
		delays: args.delays,
		quota: args.quota,
		contactQuota: args.contactQuota,
		plan: args.plan,
		enforceSpacing: args.enforceSpacing,
		spacingMs: args.spacingMs ? Number(args.spacingMs) : undefined,
	});
	const info = await mock.start(Number(args.port ?? process.env.MOCK_PORT ?? 9099), args.host ?? process.env.MOCK_HOST ?? '127.0.0.1');
	console.log(`[mock] Turbo Notify mock API on ${info.url}  key=${mock.config.apiKey}  plan=${mock.config.plan}`);
	const stop = async () => {
		await mock.stop();
		process.exit(0);
	};
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
}
