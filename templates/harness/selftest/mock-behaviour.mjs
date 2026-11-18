#!/usr/bin/env node
/**
 * Behaviour checks of the mock itself (no Docker, no n8n): lifecycle, failures, idempotency, quota,
 * spacing, pagination, calendar answers and signed webhooks.
 *
 *   node templates/harness/selftest/mock-behaviour.mjs
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { createMockApi } from '../mock-api.mjs';
import { createAssert } from '../lib/assert.mjs';
import { mockClient } from '../lib/mock-client.mjs';
import { sleep } from '../lib/util.mjs';

const assert = createAssert();
const mock = createMockApi({ apiKey: 'k', delays: '60,120,240', quota: 3, enforceSpacing: true, spacingMs: 1000 });
const { url } = await mock.start(0);
const ctl = mockClient(url, 'k');
const H = { authorization: 'Bearer k', 'content-type': 'application/json' };
const api = async (method, path, body, headers = {}) => {
	const res = await fetch(url + path, { method, headers: { ...H, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
	return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.json() };
};
const send = (to, text, headers) => api('POST', '/v1/numbers/main/messages', { to: { number: to }, content: { text } }, headers);
// reset() restores the configuration the mock started with (here: quota 3, spacing on), so relax it again.
const fresh = async () => {
	await ctl.reset();
	await ctl.config({ enforceSpacing: false, quota: 100 });
};
const names = [];
const run = async (name, fn) => {
	try {
		await fn();
		names.push(`ok   ${name}`);
	} catch (error) {
		names.push(`FAIL ${name}: ${error.message}`);
	}
};

await run('auth: wrong key and missing key answer 401 not_authenticated', async () => {
	const a = await fetch(`${url}/v1/usage`, { headers: { authorization: 'Bearer nope' } });
	assert.equal([a.status, await a.json()], [401, { error: 'not_authenticated' }], 'wrong key');
	const b = await fetch(`${url}/v1/usage`);
	assert.equal(b.status, 401, 'missing key');
});

await run('lifecycle: pending, then sent, delivered, read with events in order', async () => {
	const r = await send('+5511977770001', 'hello');
	assert.equal(r.status, 202, 'accepted');
	assert.equal(r.body.status.state, 'pending', 'starts pending');
	await ctl.waitForMessageState(r.body.message_id, 'read', { timeoutMs: 5000 });
	const types = (await ctl.events()).filter((e) => e.data.id === r.body.message_id).map((e) => e.type);
	assert.equal(types, ['message.sent', 'message.delivered', 'message.read'], 'event order');
});

await run('spacing: a second send inside the interval is 429 send_rate_spacing with Retry-After', async () => {
	await send('+5511977770001', 'first');
	const r = await send('+5511977770001', 'too soon');
	assert.equal([r.status, r.body.error], [429, 'send_rate_spacing'], 'spacing refused');
	assert.match(r.headers['retry-after'], /^\d+$/, 'Retry-After in seconds');
	await ctl.config({ enforceSpacing: false });
});

await run('quota: counts every accepted send and refuses with 429 messages_quota_exceeded', async () => {
	await ctl.reset();
	await ctl.config({ quota: 3, enforceSpacing: false });
	const q0 = await api('GET', '/v1/numbers/main/messages/quota');
	assert.subset(q0.body, { used: 0, quota: 3, remaining: 3, tier: 'BUSINESS' }, 'fresh quota');
	for (let i = 0; i < 3; i += 1) assert.equal((await send(`+551197777000${i + 1}`, `n${i}`)).status, 202, `send ${i + 1}`);
	const r = await send('+5511977770009', 'one too many');
	assert.equal([r.status, r.body.error], [429, 'messages_quota_exceeded'], 'quota refused');
	assert.ok(Number(r.headers['retry-after']) > 0, 'Retry-After until the cycle resets');
	await ctl.quota({ remaining: 5 });
	assert.equal((await send('+5511977770009', 'now it fits')).status, 202, 'after raising the remaining');
});

await run('idempotency: same key and body returns the original, other body is 409', async () => {
	await fresh();
	const a = await send('+5511977770001', 'once', { 'idempotency-key': 'order-1' });
	const b = await send('+5511977770001', 'once', { 'idempotency-key': 'order-1' });
	assert.equal(b.body.message_id, a.body.message_id, 'replay returns the original id');
	const c = await send('+5511977770001', 'twice', { 'idempotency-key': 'order-1' });
	assert.equal([c.status, c.body.error], [409, 'idempotency_key_conflict'], 'conflict');
	const q = await api('GET', '/v1/numbers/main/messages/quota');
	assert.equal(q.body.used, 1, 'a replay costs no quota');
	const e = await send('+5511977770001', 'x', { 'idempotency-key': 'k'.repeat(256) });
	assert.equal([e.status, e.body.error], [400, 'invalid_idempotency_key'], 'key too long');
});

await run('failure: a flagged recipient fails with the reason and message.send.failed', async () => {
	await fresh();
	await ctl.recipient({ number: '+5511977770013', fail: { code: 'whatsapp_send_failed', message: 'WhatsApp refused the message.' } });
	const r = await send('+5511977770013', 'will fail');
	const m = await ctl.waitForMessageState(r.body.message_id, 'failed', { timeoutMs: 5000 });
	assert.equal(m.status.error.code, 'whatsapp_send_failed', 'error code on the message');
	const status = await api('GET', `/v1/numbers/main/messages/${r.body.message_id}/status`);
	assert.equal(status.body.status.state, 'failed', 'status endpoint');
	const ev = (await ctl.events('message.send.failed')).find((e) => e.data.id === r.body.message_id);
	assert.equal(ev.data.error.code, 'whatsapp_send_failed', 'event carries the error');
	await ctl.recipient({ number: '+5511977770014', stopAt: 'delivered' });
	const d = await send('+5511977770014', 'delivered only');
	await sleep(500);
	assert.equal((await api('GET', `/v1/numbers/main/messages/${d.body.message_id}/status`)).body.status.state, 'delivered', 'never read');
});

await run('pagination: cursor walks the list and a foreign cursor is 400 invalid_cursor', async () => {
	await fresh();
	for (let i = 0; i < 5; i += 1) await send(`+551197777002${i}`, `m${i}`);
	const p1 = await api('GET', '/v1/numbers/main/messages?limit=2');
	assert.equal([p1.body.data.length, p1.body.has_more], [2, true], 'first page');
	const p2 = await api('GET', `/v1/numbers/main/messages?limit=2&cursor=${p1.body.cursor}`);
	assert.equal(p2.body.data.length, 2, 'second page');
	const p3 = await api('GET', `/v1/numbers/main/messages?limit=2&cursor=${p2.body.cursor}`);
	assert.equal([p3.body.data.length, p3.body.has_more, p3.body.cursor], [1, false, null], 'last page');
	const bad = await api('GET', `/v1/numbers/main/messages?limit=2&direction=outbound&cursor=${p1.body.cursor}`);
	assert.equal([bad.status, bad.body.error], [400, 'invalid_cursor'], 'cursor of another list');
	const ev = await api('GET', '/v1/events?limit=3');
	const older = await api('GET', `/v1/events?limit=3&starting_after=${ev.body.data[2].id}`);
	assert.ok(older.body.data[0].id !== ev.body.data[2].id, 'starting_after moves to older events');
	const newer = await api('GET', `/v1/events?limit=100&ending_before=${older.body.data[0].id}`);
	assert.equal(newer.body.data[0].id, ev.body.data[0].id, 'ending_before returns newer events, newest first');
});

await run('inbound: injected messages are events and readable messages, groups included', async () => {
	await fresh();
	const g = await ctl.addGroup({ name: 'Neighbours', members: [{ phone: '+5511977770031', name: 'Caio' }] });
	const one = await ctl.injectMessage({ from: '+5511977770030', name: 'Dora', text: 'Hi @5511977770031' });
	const grp = await ctl.injectMessage({ from: '+5511977770031', text: 'group hello', group: g.id });
	const voice = await ctl.injectMessage({ from: '+5511977770030', audio: { transcript: 'please call me', language: 'en' } });
	const feed = await api('GET', '/v1/events?types[]=message.received&limit=10');
	assert.count(feed.body.data, 3, 'three received events');
	const gm = await api('GET', `/v1/numbers/main/messages/${grp.message_id}`);
	assert.subset(gm.body, { direction: 'inbound', to: { group_id: g.id }, text: 'group hello' }, 'group message');
	const vm = await api('GET', `/v1/numbers/main/messages/${voice.message_id}`);
	assert.equal(vm.body.audio.transcription.text, 'please call me', 'transcription on the message');
	const ve = feed.body.data.find((e) => e.data.id === voice.message_id);
	assert.equal(ve.data.preview, 'please call me', 'preview is the transcription');
	const single = await api('GET', `/v1/numbers/main/messages/${one.message_id}`);
	assert.equal(single.body.mentions[0].number, '5511977770031', 'mention parsed');
	const byContact = await api('GET', `/v1/numbers/main/messages?contact_id=${one.contact_id}`);
	assert.equal(byContact.body.data.length, 2, 'contact filter holds what the contact sent');
	const byGroup = await api('GET', `/v1/numbers/main/messages?group_id=${g.id}`);
	assert.equal(byGroup.body.data.length, 1, 'group filter');
});

await run('calendar: answers become events and the responses endpoint keeps the latest per guest', async () => {
	await fresh();
	const cal = await api('POST', '/v1/numbers/main/messages', { to: { number: '+5511977770040' }, content: { name: 'Visit', start_at: '2026-12-01T14:00:00-03:00' } });
	await ctl.injectCalendarResponse({ message_id: cal.body.message_id, from: '+5511977770040', response: 'tentative' });
	await ctl.injectCalendarResponse({ message_id: cal.body.message_id, from: '+5511977770040', response: 'accepted', extra_guests: 2 });
	await ctl.injectCalendarResponse({ message_id: cal.body.message_id, from: '+5511977770041', response: 'declined' });
	const ev = await api('GET', '/v1/events?types[]=message.calendar_responded');
	assert.count(ev.body.data, 3, 'one event per answer');
	assert.equal(ev.body.data[1].data.extra_guests, 2, 'extra_guests present when above zero');
	assert.ok(!('extra_guests' in ev.body.data[2].data), 'extra_guests omitted at zero');
	const r = await api('GET', `/v1/numbers/main/messages/${cal.body.message_id}/responses`);
	assert.equal(r.body.counts, { going: 1, not_going: 1, maybe: 0, extra_guests: 2 }, 'counts use the latest answer');
});

await run('webhook: signed delivery, verifiable with the documented scheme, with retry', async () => {
	await fresh();
	const seen = [];
	let hits = 0;
	const sink = http.createServer((req, res) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			hits += 1;
			seen.push({ headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') });
			res.writeHead(hits === 1 ? 500 : 200).end();
		});
	});
	await new Promise((r) => sink.listen(0, '127.0.0.1', r));
	const target = `http://127.0.0.1:${sink.address().port}/hook`;
	await ctl.config({ webhookRetryMs: 100 });
	await ctl.webhookTarget({ url: target, secret: 'whsec_check', events: ['message.received'] });
	await ctl.injectMessage({ from: '+5511977770050', name: `Jo${String.fromCharCode(0xe3)}o`, text: `ol${String.fromCharCode(0xe1)}` });
	await sleep(800);
	sink.close();
	assert.equal(hits, 2, 'first attempt 500 then a retry');
	const d = seen[1];
	const expected = `sha256=${crypto.createHmac('sha256', 'whsec_check').update(`${d.headers['x-webhook-timestamp']}.${d.raw}`).digest('hex')}`;
	assert.equal(d.headers['x-webhook-signature'], expected, 'HMAC over timestamp.rawBody');
	assert.equal([d.headers['x-webhook-attempt'], d.headers['user-agent']], ['2', 'TurboNotify-Webhook/1.0'], 'attempt counter and user agent');
	assert.ok(!/[^\x00-\x7f]/.test(d.raw), 'non ASCII is escaped in the signed body');
	assert.equal(JSON.parse(d.raw).type, 'message.received', 'body is the event');
});

await run('faults and plan gating: injected failure, free plan refuses typing and groups', async () => {
	await fresh();
	await ctl.fault({ method: 'GET', path: '/v1/numbers/main/messages/quota', status: 503, body: { error: 'service_unavailable' }, headers: { 'retry-after': '1' }, times: 1 });
	assert.equal((await api('GET', '/v1/numbers/main/messages/quota')).status, 503, 'first call hits the fault');
	assert.equal((await api('GET', '/v1/numbers/main/messages/quota')).status, 200, 'the fault is used up');
	await ctl.config({ plan: 'free' });
	const t = await api('POST', '/v1/numbers/main/typing-indicator', { to: { number: '+5511977770001' }, is_typing: true });
	assert.equal([t.status, t.body.error], [402, 'feature_not_available'], 'typing needs Lone Wolf');
	const g = await ctl.addGroup({ name: 'G', members: [] });
	const gs = await api('POST', '/v1/numbers/main/messages', { to: { group_id: g.id }, content: { text: 'x' } });
	assert.equal([gs.status, gs.body.error], [402, 'feature_not_available'], 'group send needs Business');
	await ctl.numberStatus({ number: 'main', status: 'disconnected' });
	await ctl.config({ plan: 'business' });
	const nc = await send('+5511977770001', 'offline');
	assert.equal([nc.status, nc.body.error], [409, 'number_not_connected'], 'number not connected');
});

await mock.stop();
console.log(names.join('\n'));
const failed = names.filter((n) => n.startsWith('FAIL')).length;
console.log(failed ? `\nmock behaviour FAILED (${failed})` : `\nmock behaviour passed (${names.length} groups, ${assert.counter.passed} assertions)`);
process.exit(failed ? 1 : 0);
