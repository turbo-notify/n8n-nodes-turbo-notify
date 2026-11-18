#!/usr/bin/env node
/**
 * Contract check of the mock against public-docs-web/public/openapi.json, with no Docker and no n8n.
 *
 *   node templates/harness/selftest/contract.mjs
 *
 * It calls every endpoint the n8n package uses (and the other message endpoints), then validates
 * each answer against the response schema of the OpenAPI document (types, required fields, id
 * patterns, enums, nested objects). Without the document (this folder outside the monorepo) it
 * says so and passes. Set OPENAPI_PATH to point at a copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockApi } from '../mock-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const specPath = process.env.OPENAPI_PATH ?? path.resolve(here, '../../../../public-docs-web/public/openapi.json');
if (!fs.existsSync(specPath)) {
	console.log(`contract check skipped: ${specPath} not found (set OPENAPI_PATH)`);
	process.exit(0);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

/* ------------------------------------------------ a small JSON schema validator */

function check(schema, value, where, errors, depth = 0) {
	if (!schema || depth > 12) return;
	if (schema.$ref) return check(spec.components.schemas[schema.$ref.split('/').pop()], value, where, errors, depth + 1);
	if (schema.allOf) schema.allOf.forEach((s) => check(s, value, where, errors, depth + 1));
	for (const key of ['anyOf', 'oneOf']) {
		if (!schema[key]) continue;
		const attempts = schema[key].map((s) => {
			const e = [];
			check(s, value, where, e, depth + 1);
			return e;
		});
		if (!attempts.some((e) => e.length === 0)) {
			errors.push(`${where}: matches none of ${schema[key].length} alternatives (${attempts.map((e) => e[0]).join(' | ')})`);
		}
		return;
	}
	if (schema.const !== undefined && value !== schema.const) errors.push(`${where}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
	if (schema.enum && !schema.enum.includes(value)) errors.push(`${where}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
	const type = schema.type;
	if (type) {
		const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
		const ok = type === actual || (type === 'number' && actual === 'integer');
		if (!ok) return void errors.push(`${where}: expected ${type}, got ${actual}`);
	}
	if (typeof value === 'string') {
		if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${where}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
		if (schema.maxLength && value.length > schema.maxLength) errors.push(`${where}: longer than ${schema.maxLength}`);
		if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${where}: not a date-time`);
	}
	if (Array.isArray(value) && schema.items) value.forEach((v, i) => check(schema.items, v, `${where}[${i}]`, errors, depth + 1));
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${where}: missing required "${key}"`);
		for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in value) check(sub, value[key], `${where}.${key}`, errors, depth + 1);
	}
}

const operationFor = (method, pathname) => {
	for (const [template, ops] of Object.entries(spec.paths)) {
		const rx = new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`);
		if (rx.test(pathname) && ops[method.toLowerCase()]) return ops[method.toLowerCase()];
	}
	return null;
};

/* ------------------------------------------------------------------- the run */

const mock = createMockApi({ apiKey: 'k', delays: '40,80,120' });
const { url } = await mock.start(0);
const H = { authorization: 'Bearer k', 'content-type': 'application/json' };
let failures = 0;
let checked = 0;

async function call(method, pathname, body, headers = {}, { expect } = {}) {
	const res = await fetch(url + pathname, { method, headers: { ...H, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	const json = text ? JSON.parse(text) : null;
	const label = `${method} ${pathname.replace(/msg_[0-9a-f]{32}/g, 'msg_*').replace(/ct_[0-9a-f]{32}/g, 'ct_*').replace(/grp_[0-9a-f]{32}/g, 'grp_*').split('?')[0]} -> ${res.status}`;
	if (expect !== undefined && res.status !== expect) {
		failures += 1;
		console.log(`FAIL ${label}: expected status ${expect}: ${text.slice(0, 200)}`);
		return json;
	}
	const op = operationFor(method, pathname.split('?')[0]);
	const schema = op?.responses?.[String(res.status)]?.content?.['application/json']?.schema;
	if (schema) {
		const errors = [];
		check(schema, json, '$', errors);
		checked += 1;
		if (errors.length) {
			failures += 1;
			console.log(`FAIL ${label}\n  ${errors.slice(0, 6).join('\n  ')}`);
		} else console.log(`ok   ${label}`);
	} else {
		console.log(`ok   ${label} (no schema in the document for this status)`);
	}
	return json;
}

const N = '/v1/numbers/main';
await call('GET', '/v1/usage', undefined, {}, { expect: 200 });
await call('GET', '/v1/numbers', undefined, {}, { expect: 200 });
await call('GET', `${N}`, undefined, {}, { expect: 200 });
const sent = await call('POST', `${N}/messages`, { to: { number: '+5511977770001' }, content: { text: 'one @5511977770002' } }, { 'idempotency-key': 'c-1' }, { expect: 202 });
await call('POST', `${N}/messages`, { to: { number: '+5511977770001' }, content: { image_url: 'https://example.com/a.jpg', caption: 'a' } }, {}, { expect: 202 });
await call('POST', `${N}/messages`, { to: { number: '+5511977770001' }, content: { document_url: 'https://example.com/a.pdf', filename: 'a.pdf' } }, {}, { expect: 202 });
await call('POST', `${N}/messages`, { to: { number: '+5511977770001' }, content: { latitude: -23.5, longitude: -46.6, name: 'Place' } }, {}, { expect: 202 });
await call('POST', `${N}/messages`, { to: { number: '+5511977770001' }, content: { display_name: 'Ana', phones: [{ number: '+5511977770003' }] } }, {}, { expect: 202 });
const cal = await call('POST', `${N}/messages`, { to: { number: '+5511977770001' }, content: { name: 'Visit', start_at: '2026-12-01T14:00:00-03:00', end_at: '2026-12-01T15:00:00-03:00', has_reminder: true, reminder_offset_sec: 600 } }, {}, { expect: 202 });
await call('POST', `${N}/messages`, { to: { number: '+5511977770001' }, content: { interactive_type: 'cta_url', body: 'Track it', url_button: { display_text: 'Open', url: 'https://example.com/t' } } }, {}, { expect: 202 });
await call('POST', `${N}/messages`, { to: { number: '+5511977770001' }, content: { text: 'bad', content_type: 'text' } }, {}, { expect: 422 });
await call('POST', `${N}/messages`, { to: { number: '+5511977770001' }, content: { text: 'other' } }, { 'idempotency-key': 'c-1' }, { expect: 409 });
await new Promise((r) => setTimeout(r, 300));
await call('GET', `${N}/messages/${sent.message_id}`, undefined, {}, { expect: 200 });
await call('GET', `${N}/messages/${cal.message_id}`, undefined, {}, { expect: 200 });
await call('GET', `${N}/messages/${sent.message_id}/status`, undefined, {}, { expect: 200 });
await call('GET', `${N}/messages/${sent.message_id}/receipts`, undefined, {}, { expect: 200 });
await call('GET', `${N}/messages?limit=2`, undefined, {}, { expect: 200 });
await call('GET', `${N}/messages/quota`, undefined, {}, { expect: 200 });
await call('GET', `${N}/contacts/quota`, undefined, {}, { expect: 200 });
await call('POST', `${N}/messages/${sent.message_id}/reply`, { content: { text: 'reply' } }, {}, { expect: 202 });
await call('POST', `${N}/messages/${sent.message_id}/react`, { reaction: '+1' }, {}, { expect: 202 });
await call('POST', `${N}/messages/${sent.message_id}/edit`, { text: 'edited' }, {}, { expect: 202 });
await call('POST', `${N}/typing-indicator`, { to: { number: '+5511977770001' }, is_typing: true }, {}, { expect: 202 });
await call('POST', `${N}/messages/${cal.message_id}/delete`, undefined, {}, { expect: 202 });
const contacts = await call('GET', `${N}/contacts`, undefined, {}, { expect: 200 });
await call('GET', `${N}/contacts/${contacts.data[0].id}`, undefined, {}, { expect: 200 });
await call('GET', `${N}/contacts?phone=%2B5511977770001`, undefined, {}, { expect: 200 });
const gmock = await fetch(`${url}/__test/group`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Team', members: [{ phone: '+5511977770009', name: 'Caio' }] }) }).then((r) => r.json());
await call('GET', `${N}/groups`, undefined, {}, { expect: 200 });
await call('GET', `${N}/groups/${gmock.id}`, undefined, {}, { expect: 200 });
await call('POST', `${N}/messages`, { to: { group_id: gmock.id }, content: { text: 'hello team' } }, {}, { expect: 202 });
const injected = await fetch(`${url}/__test/inject-message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '+5511977770004', name: 'Bia', text: 'in', group: gmock.id }) }).then((r) => r.json());
await call('GET', `${N}/messages?group_id=${gmock.id}&direction=inbound`, undefined, {}, { expect: 200 });
await call('GET', `${N}/messages/${injected.message_id}`, undefined, {}, { expect: 200 });
await fetch(`${url}/__test/inject-calendar-response`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message_id: cal.message_id, from: '+5511977770001', response: 'accepted', extra_guests: 1 }) });
await call('GET', `${N}/messages/${cal.message_id}/responses`, undefined, {}, { expect: 200 });
const events = await call('GET', '/v1/events?limit=100', undefined, {}, { expect: 200 });
await call('GET', `/v1/events?types[]=message.sent&types[]=message.read&limit=5&starting_after=${events.data[0].id}`, undefined, {}, { expect: 200 });
await call('GET', `/v1/events?created[gte]=2020-01-01T00:00:00Z`, undefined, {}, { expect: 200 });
await call('GET', '/v1/events?number_id=num_bad', undefined, {}, { expect: 400 });
await call('GET', `${N}/messages/msg_bad`, undefined, {}, { expect: 400 });
await call('GET', '/v1/usage', undefined, { authorization: 'Bearer wrong' }, { expect: 401 });

// Every event of the feed has the envelope the docs describe.
let envelopeFailures = 0;
for (const e of events.data) {
	const missing = ['id', 'type', 'organization_id', 'created_at', 'data'].filter((k) => !(k in e));
	const shapeOk = /^evt_[0-9a-f]{32}$/.test(e.id) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(e.created_at);
	if (missing.length || !shapeOk) {
		envelopeFailures += 1;
		console.log(`FAIL event envelope ${e.type}: missing ${missing.join(',')} shapeOk=${shapeOk}`);
	}
}
failures += envelopeFailures;
console.log(envelopeFailures ? '' : `ok   ${events.data.length} events carry the documented envelope`);

await mock.stop();
console.log(failures ? `\ncontract check FAILED (${failures} problem(s), ${checked} schema checks)` : `\ncontract check passed (${checked} schema checks)`);
process.exit(failures ? 1 : 0);
