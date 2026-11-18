import { execFile } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const randomHex = (bytes = 3) => crypto.randomBytes(bytes).toString('hex');
export const uuid = () => crypto.randomUUID();

/* Secrets (the real API key) are registered once and masked in every line the harness prints or writes. */
const secrets = new Set();
export function registerSecret(value) {
	if (value && String(value).length >= 8) secrets.add(String(value));
}
const phones = new Map();
/** A phone number that must never appear in output (the owner test number): every common spelling is masked. */
export function registerPhone(value, label = 'owner test number') {
	const d = String(value).replace(/\D/g, '');
	if (d.length < 8) return;
	phones.set(d, label);
	if (d.startsWith('55') && d.length >= 12) phones.set(d.slice(2), label);
}
const groupIds = new Set();
const groupNames = new Set();
/**
 * The one test group of a real run (`--allow-group`): its ids (`grp_` + 32 hex, also the dashed UUID form that appears in
 * media URLs) and its name are masked in every line the harness prints or writes. The name is masked as a whole word,
 * case sensitive, because it can be short.
 */
export function registerGroup({ id, name }) {
	if (id) {
		const hex = String(id).replace(/^grp_/, '');
		groupIds.add(String(id));
		groupIds.add(hex);
		if (/^[0-9a-f]{32}$/.test(hex)) groupIds.add(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
	}
	if (name && String(name).length >= 2) groupNames.add(String(name));
}
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function redact(text) {
	let out = String(text);
	for (const id of groupIds) out = out.split(id).join('<test group id>');
	for (const name of groupNames) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'gu'), '<test group>');
	for (const [d, label] of phones) out = out.split(`+${d}`).join(`<${label}>`).split(d).join(`<${label}>`);
	for (const secret of secrets) out = out.split(secret).join('tn_live_***MASKED***');
	return out.replace(/tn_(live|test)_[A-Za-z0-9_-]{12,}/g, 'tn_$1_***MASKED***').replace(/gsk_[A-Za-z0-9]{20,}/g, 'gsk_***MASKED***').replace(/sk-or-v1-[A-Za-z0-9]{20,}/g, 'sk-or-***MASKED***');
}

/** Progress goes to stderr, so stdout stays the JSON report. */
export const log = (...args) => console.error('[harness]', ...args.map((a) => (typeof a === 'string' ? redact(a) : a)));

/** Runs a command and resolves { code, stdout, stderr }; never rejects on a non zero exit. */
export function run(command, args, options = {}) {
	return new Promise((resolve) => {
		execFile(command, args, { maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
			resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), error });
		});
	});
}

/** True when nothing listens on the port: no one answers on loopback and a bind on every interface works. */
export async function portIsFree(port) {
	const answered = await new Promise((resolve) => {
		const socket = net.connect({ port, host: '127.0.0.1' });
		socket.once('connect', () => (socket.destroy(), resolve(true)));
		socket.once('error', () => resolve(false));
		socket.setTimeout(1000, () => (socket.destroy(), resolve(false)));
	});
	if (answered) return false;
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.once('listening', () => server.close(() => resolve(true)));
		server.listen(port, '0.0.0.0');
	});
}

export async function firstFreePort(candidates) {
	for (const port of candidates) {
		if (await portIsFree(port)) return port;
	}
	throw new Error(`no free port among ${candidates[0]}..${candidates[candidates.length - 1]}`);
}

export const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * Parses what n8n stores for an execution: the "flatted" format. Every string inside an object or
 * array is an index into the top level array, numbers, booleans and null stay inline.
 */
export function flattedParse(text) {
	const input = JSON.parse(text);
	const resolved = new Map();
	const resolve = (index) => {
		const i = Number(index);
		if (resolved.has(i)) return resolved.get(i);
		const value = input[i];
		if (value && typeof value === 'object') {
			const out = Array.isArray(value) ? [] : {};
			resolved.set(i, out);
			for (const key of Object.keys(value)) {
				const item = value[key];
				out[key] = typeof item === 'string' ? resolve(item) : item;
			}
			return out;
		}
		resolved.set(i, value);
		return value;
	};
	return resolve(0);
}

export function deepClone(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Replaces {{mockUrl}} style tokens in every string of a value. */
export function fillTokens(value, tokens) {
	if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in tokens ? tokens[key] : whole));
	if (Array.isArray(value)) return value.map((v) => fillTokens(v, tokens));
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTokens(v, tokens)]));
	return value;
}

/** Polls fn until it returns a truthy value; returns that value. Throws with `message` on timeout. */
export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 250, message = 'condition' } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	for (;;) {
		try {
			last = await fn();
			if (last) return last;
		} catch (error) {
			last = error;
		}
		if (Date.now() >= deadline) {
			const detail = last instanceof Error ? ` (last error: ${last.message})` : '';
			throw new Error(`timed out after ${timeoutMs} ms waiting for ${message}${detail}`);
		}
		await sleep(intervalMs);
	}
}
