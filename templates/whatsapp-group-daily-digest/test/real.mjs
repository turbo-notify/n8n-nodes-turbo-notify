/**
 * Real API scenario for T5 (whatsapp-group-daily-digest): the exported workflow against the REAL Turbo Notify API, a REAL
 * test group and a REAL chat model.
 *
 * Who is who. Three phones of the same owner are members of one WhatsApp group made by hand (the API cannot create a
 * group and cannot list its members, so the owner checks it):
 *   - number A, the NUMBER UNDER TEST: the organization of --api-key-file. The workflow runs on it, its poller reads the
 *     group, and the digest in group mode is posted by it (origin tn).
 *   - number B, the OWNER NUMBER: the organization of --customer-key-file. It plays the group member who writes (the
 *     customer helper posts plain text INTO the group with B's key), and it is `owner_phone`, the only private recipient
 *     of the digest. A different phone from A, which is the point of `owner_phone`.
 *   - number C: a third phone of the owner in the group. It writes nothing in this run.
 * The guard allows, besides B, plain text INTO that one group (--allow-group) and nothing else.
 *
 *   export TN_REAL_OWNER_PHONE='+<number B>'            (the only private recipient, owner_phone)
 *   export TN_REAL_PERSONAL_PHONE='+<number A>'         (the number under test)
 *   export TN_REAL_THIRD_PHONE='+<number C>'            (the third phone of the owner in the group)
 *   export T5_LLM_KEY_FILE=<file holding an `sk-or-v1-` key>   (never printed, masked)
 *   export T5_LLM_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
 *   node templates/harness/run-template.mjs templates/whatsapp-group-daily-digest/workflow.json \
 *     --real-api --api-key-file <key of A> --customer-key-file <key of B> --allow-group <the test group> --max-sends 5 \
 *     --scenario templates/whatsapp-group-daily-digest/test/real.mjs --image n8nio/n8n:2.45.5 \
 *     --tz America/Sao_Paulo --run-id t5real --ports 5696,9241
 *
 * Messages sent: 3 by B into the group, the manual digest to B (1) and the
 * digest in group mode (1, the origin tn check): 5 in all, budget 5. Nothing else is patched in the workflow except the values a person types
 * in "Your settings", the poll interval (1 minute, the smallest n8n allows, instead of 10) and the model name.
 */
import fs from 'node:fs';
import { registerPhone, registerSecret } from '../../harness/lib/util.mjs';

export const timeoutMs = 45 * 60_000;
export const llm = false; // the real model, not the fake one

const BASE = process.env.T5_LLM_BASE_URL || 'https://openrouter.ai/api/v1';
const MODEL = process.env.T5_LLM_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
const POLL = 'Poll WhatsApp group messages';
const HOURLY = 'Every hour: look for digests that are due';
const NOW = 'Run now for one group';
const SETTINGS = 'Your settings';
const TZ = 'America/Sao_Paulo';

function llmKey() {
	const file = process.env.T5_LLM_KEY_FILE;
	if (!file) throw new Error('set T5_LLM_KEY_FILE to a file that holds the chat model key');
	const text = fs.readFileSync(file, 'utf8');
	const match = (/openrouter/i.test(BASE) ? text.match(/sk-or-v1-[A-Za-z0-9_-]+/) : text.match(/(?:gsk_|sk-or-v1-)[A-Za-z0-9_-]+/)) ?? text.match(/(?:gsk_|sk-or-v1-)[A-Za-z0-9_-]+/);
	if (!match) throw new Error('no gsk_ or sk-or-v1- key in T5_LLM_KEY_FILE');
	registerSecret(match[0]);
	return match[0];
}

export const credentials = [
	{
		type: 'openAiApi',
		name: 'OpenAI compatible provider',
		data: { apiKey: llmKey(), organizationId: '', url: BASE, header: false, headerName: '', headerValue: '', allowedHttpRequestDomains: 'all', allowedDomains: '' },
	},
];

const digits = (v) => String(v ?? '').replace(/\D/g, '');

function phones() {
	const owner = process.env.TN_REAL_OWNER_PHONE; // B
	const under = process.env.TN_REAL_PERSONAL_PHONE; // A
	const third = process.env.TN_REAL_THIRD_PHONE; // C
	for (const p of [owner, under, third]) if (!p || !/^\+[1-9]\d{7,14}$/.test(p)) throw new Error('set TN_REAL_OWNER_PHONE (B), TN_REAL_PERSONAL_PHONE (A) and TN_REAL_THIRD_PHONE (C), with + and the country code');
	registerPhone(under, 'number under test');
	registerPhone(third, 'third owner phone');
	return { owner, under, third };
}

/** The values a person types in "Your settings", the poll interval and the model name. Nothing else changes. */
export async function prepare(workflow, ctx) {
	const { owner } = phones();
	const group = ctx.realGroup?.id;
	if (!group) throw new Error('pass --allow-group: this scenario needs the test group');
	const settings = workflow.nodes.find((n) => n.name === SETTINGS);
	// digest_hour 23: the hourly timer of the live workflow does nothing before 23:00 of the zone, so only the manual runs of this scenario send.
	const set = { watch_groups: group, owner_phone: owner, delivery: 'owner', digest_hour: 23, min_messages: 3, run_now_group: group };
	for (const a of settings.parameters.assignments.assignments) if (a.name in set) a.value = set[a.name];
	const poll = workflow.nodes.find((n) => n.name === POLL);
	poll.parameters.pollTimes = { item: [{ mode: 'everyX', value: 1, unit: 'minutes' }] };
	const model = workflow.nodes.find((n) => n.name === 'Chat model for the digest');
	model.parameters.model = { __rl: true, mode: 'id', value: MODEL };
	model.parameters.responsesApiEnabled = false;
	return workflow;
}

const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));

export default async function scenario(t) {
	const { assert, real } = t;
	const { owner: OWNER, under: UNDER, third: THIRD } = phones();
	const customer = real.customer;
	const GROUP = real.testGroup;
	assert.ok(customer && GROUP, 'the customer sender (--customer-key-file) and the test group (--allow-group) are configured');
	const ownerDigits = digits(OWNER);
	const sendsSince = async (mark) => real.guard.sends({ since: mark });
	const budgetLeft = () => real.maxSends - real.guard.messagesAccepted - customer.count;
	const until = async (predicate, ms, label) => {
		const start = Date.now();
		while (Date.now() - start < ms) {
			const value = await predicate();
			if (value) return value;
			await t.sleep(5000);
		}
		assert.fail(`timed out after ${Math.round(ms / 1000)} s waiting for: ${label}`);
	};
	const stored = () => t.tables.rows('group_messages');
	const configure = async (values) => {
		const current = await t.n8n.rest('GET', `/rest/workflows/${t.workflow.id}`);
		const nodes = structuredClone(current.nodes);
		const settings = nodes.find((n) => n.name === SETTINGS);
		for (const assignment of settings.parameters.assignments.assignments) if (assignment.name in values) assignment.value = values[assignment.name];
		await t.n8n.rest('PATCH', `/rest/workflows/${t.workflow.id}`, { nodes, versionId: current.versionId });
	};
	let customerGroup;
	let manualDigest;
	let groupDigest;
	const shape = (value) => (Array.isArray(value) ? ['array', value.length, value.length ? shape(value[0]) : null] : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)])) : typeof value);

	await t.step('0 pre-flight: number A connected, the test group has the 3 owner phones, only owner phones ever wrote in it, plan and quota', async () => {
		const number = await real.get('/v1/numbers/main');
		assert.equal(number.status?.status ?? number.status, 'connected', 'the number under test is connected');
		assert.equal(GROUP.participantsCount, 3, 'the test group has exactly 3 members (the owner phones A, B and C)');
		await customer.verify();
		customerGroup = await customer.resolveGroup();
		assert.equal(customerGroup.participantsCount, 3, 'B sees the same 3 members');
		assert.ok(hourNow() <= 21, 'the hourly timer (digest_hour 23) cannot fire during the run: start before 22:00 of the zone');
		// who wrote in the group so far: only A (outbound), B and C
		let cursor = null;
		const senders = new Set();
		for (let i = 0; i < 10; i += 1) {
			const page = await real.get(`/v1/numbers/main/messages?group_id=${GROUP.id}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
			for (const m of page.data ?? []) senders.add(m.direction === 'outbound' ? 'A' : digits(m.from?.number) === ownerDigits ? 'B' : digits(m.from?.number) === digits(THIRD) ? 'C' : 'SOMEONE ELSE');
			cursor = page.cursor;
			if (!page.has_more) break;
		}
		t.note('groupSenders', [...senders].sort());
		assert.ok(!senders.has('SOMEONE ELSE'), 'no one but the owner phones ever wrote in the test group');
		const usage = await real.get('/v1/usage');
		t.note('plan', { tier: usage.messages?.tier, messages_remaining: usage.messages?.remaining });
		assert.equal(real.guard.messagesAccepted + customer.count, 0, 'nothing sent yet');
		assert.ok(budgetLeft() >= 5, 'budget for the run');
	});

	await t.step('1 the setup branch creates the tables, the workflow is switched on (the first poll only records what exists)', async () => {
		const execution = await t.run('Run once: create the tables');
		assert.equal(execution.status, 'success', execution.describe());
		await t.activate();
		await t.sleep(75_000); // the first poll runs at activation
	});

	const conversation = [
		'Hello all, this is a test group: an automated test of a message digest template is running. Please ignore it. Question: should we move the weekly review to Thursday at 15:00?',
		'Decision: yes, the review moves to Thursday 19 November at 15:00. The draft is due on 25 November 2026. Agenda link: https://example.com/agenda/review-2026',
		`@${digits(UNDER)} can you confirm the room before Friday?`,
	];

	await t.step('2 B writes 3 short messages INTO the group (a question, a decision, a deadline, a link, a mention of the other participant)', async () => {
		const ids = [];
		for (const text of conversation) {
			const sent = await customer.sendToGroup(text);
			ids.push(sent.id);
			const seen = await customer.observe(sent.id, ['sent', 'delivered', 'read', 'failed'], { timeoutMs: 120_000 });
			assert.ok(seen.reached && seen.state !== 'failed', 'the message left the queue');
			await t.sleep(3000);
		}
		t.note('customerPosts', { count: ids.length });
	});

	await t.step('3 the real poller (every minute) stores the 3 messages of B with their FULL text, names, and the mention scrubbed', async () => {
		const mine = async () => (await stored()).filter((r) => digits(r.sender_phone) === ownerDigits);
		await until(async () => ((await mine()).length >= 3 ? true : null), 12 * 60_000, 'three messages written in the group to be stored');
		await t.sleep(70_000); // one more poll
		const all = await stored();
		const after = await mine();
		assert.equal(after.length, 3, 'exactly the 3 messages of B are stored');
		// the owner may type in the group meanwhile (a native message of the number under test): the template stores it as designed
		t.note('otherRowsStored', all.length - after.length);
		assert.ok(all.every((r) => r.text_source === 'full'), 'each message was read in full (Message Get)');
		assert.ok(all.every((r) => r.group_id === GROUP.id), 'the group id is the group id of the number under test');
		assert.ok(all.every((r) => !/\d{8,}/.test(r.text.replace(/https?:\/\/\S+/g, '')) && !/@\d{5,}/.test(r.text)), 'no phone number and no @number token was stored');
		const mention = after.find((r) => /confirm the room/.test(r.text));
		assert.ok(mention && /@\S/.test(mention.text) && !/\d{5,}/.test(mention.text), 'the mention token was replaced by a name');
		assert.ok(after.some((r) => /https:\/\/example\.com\/agenda\/review-2026/.test(r.text)), 'the link is stored exactly');
		t.note('storedRows', all.map((r) => ({ kind: r.kind, length: r.text.length, text_source: r.text_source, has_phone: Boolean(r.sender_phone), sender_name: r.sender_name ? 'set' : 'empty', from_b: digits(r.sender_phone) === ownerDigits })));
		t.note('mentionAsStored', mention.text.replace(/\d{6,}/g, '<digits>'));
		const reads = (await real.guard.requests()).filter((r) => r.method === 'GET' && /\/messages\/msg_/.test(r.path));
		assert.ok(reads.length >= all.length, 'one Message Get per stored message');
		const detail = await real.get(`/v1/messages/${mention.message_id}`);
		t.note('mentionMessageShape', shape({ to: detail.to, mentions: detail.mentions, content: detail.content, content_type: detail.content_type, origin: detail.origin, direction: detail.direction }));
	});

	await t.step('4 "Run now for one group" sends the real model digest to the owner number B, once; the digest is read back from the real API; a second press sends nothing new', async () => {
		const mark = await real.guard.mark();
		const before = (await customer.list('direction=inbound&limit=50')).data ?? [];
		const first = await t.run(NOW);
		assert.equal(first.status, 'success', first.describe());
		const sent = await sendsSince(mark);
		assert.equal(sent.length, 1, 'one message');
		assert.equal(digits(sent[0].to?.number), ownerDigits, 'to the owner number only');
		manualDigest = sent[0];
		const text = manualDigest.content?.text ?? '';
		const [row] = await t.tables.rows('digests', { where: { digest_key: `${GROUP.id}|${new Date().toLocaleDateString('en-CA', { timeZone: TZ })}|manual` } });
		t.note('manualDigest', { chars: text.length, summary_source: row?.summary_source, status: row?.status, text });
		assert.ok(row, 'a digest row was recorded');
		const progress = await real.observe(manualDigest.messageId, ['sent', 'delivered', 'read', 'failed'], { timeoutMs: 120_000 });
		t.note('manualDeliveryStates', progress.seen);
		assert.ok(progress.reached && progress.state !== 'failed', 'the digest was delivered');
		// read back from the real API, from the side of B: exactly one new inbound message that starts like the digest
		const head = text.slice(0, 40);
		const inbound = await until(async () => {
			const list = ((await customer.list('direction=inbound&limit=50')).data ?? []).filter((m) => !before.some((b) => b.id === m.id));
			const hit = list.filter((m) => !m.to?.group_id && String(m.preview ?? '').startsWith(head.slice(0, 30)));
			return hit.length ? hit : null;
		}, 120_000, 'the digest to appear in the inbox of B');
		assert.equal(inbound.length, 1, 'the digest exists once in the inbox of B');
		const again = await t.run(NOW);
		assert.ok(['success', 'error'].includes(again.status), 'the second press ends');
		const ids = new Set((await sendsSince(mark)).map((s) => s.messageId));
		assert.equal(ids.size, 1, 'still one message in all: the repeat is the same message');
		await t.sleep(20_000);
		const afterList = ((await customer.list('direction=inbound&limit=50')).data ?? []).filter((m) => !before.some((b) => b.id === m.id) && !m.to?.group_id && String(m.preview ?? '').startsWith(head.slice(0, 30)));
		assert.equal(afterList.length, 1, 'B still has one copy of the digest');
		t.note('secondPress', { status: again.status, sendsAttempted: (await sendsSince(mark)).length });
	});

	await t.step('5 delivery group + mention_most_active: the hourly run posts the digest INTO the group once, with a real mention; a second hourly run sends nothing', async () => {
		await configure({ delivery: 'group', mention_most_active: true, digest_hour: hourNow() });
		const mark = await real.guard.mark();
		const first = await t.run(HOURLY);
		assert.equal(first.status, 'success', first.describe());
		const sent = await sendsSince(mark);
		assert.equal(sent.length, 1, 'one post');
		assert.equal(sent[0].to?.group_id, GROUP.id, 'into the test group');
		assert.ok(!sent[0].to?.number, 'not to a phone');
		groupDigest = sent[0];
		const [row] = await t.tables.rows('digests', { where: { delivery: 'group' } });
		t.note('groupDigest', { chars: (groupDigest.content?.text ?? '').length, summary_source: row?.summary_source, status: row?.status, text: groupDigest.content?.text });
		assert.equal(row?.status, 'delivered', 'recorded as delivered');
		const progress = await real.observe(groupDigest.messageId, ['sent', 'delivered', 'read', 'failed'], { timeoutMs: 120_000 });
		t.note('groupDeliveryStates', progress.seen);
		assert.ok(progress.reached && progress.state !== 'failed', 'the post reached WhatsApp');
		const detail = await real.get(`/v1/messages/${groupDigest.messageId}`);
		t.note('groupPostMessageShape', shape({ to: detail.to, mentions: detail.mentions, content_type: detail.content_type, origin: detail.origin }));
		t.note('groupPostMentions', { count: (detail.mentions ?? []).length, tokens_in_text: ((groupDigest.content?.text ?? '').match(/@\d{7,15}/g) ?? []).length });
		// B (a member) received the post in the group
		let received = null;
		for (let i = 0; i < 24 && !received; i += 1) {
			const list = (await customer.get(`/v1/numbers/main/messages?group_id=${customerGroup.id}&direction=inbound&limit=20`)).data ?? [];
			const hit = list.filter((m) => String(m.preview ?? '').startsWith((groupDigest.content?.text ?? '').slice(0, 30)));
			if (hit.length) received = hit;
			else await t.sleep(5000);
		}
		t.note('postReachedB', { arrived: Boolean(received), copies: received?.length ?? 0 });
		const second = await t.run(HOURLY);
		assert.equal(second.status, 'success', second.describe());
		const ids = new Set((await sendsSince(mark)).map((s) => s.messageId));
		assert.equal(ids.size, 1, 'the second hourly run sent nothing new');
		await configure({ digest_hour: 23 });
	});

	await t.step('6 the digest posted by A into the group (origin tn) is not stored by the poller', async () => {
		await t.sleep(130_000);
		const rows = await stored();
		assert.ok(rows.every((r) => !String(r.text).includes((groupDigest.content?.text ?? '').slice(0, 30))), 'the text of the digest is not stored');
		assert.ok(rows.every((r) => !/^Daily digest/.test(String(r.text))), 'no digest is stored as a message');
		const events = await real.get('/v1/events?limit=100&types[]=message.sent');
		const mine = (events.data ?? []).filter((e) => JSON.stringify(e).includes(groupDigest.messageId));
		t.note('groupDigestEvent', mine.map((e) => ({ type: e.type, origin: e.data?.origin })));
		assert.ok(mine.some((e) => e.data?.origin === 'tn'), 'the digest post arrives as message.sent with origin tn');
	});

	await t.step('7 the messages kept are the only chat content stored: count them, then clean up', async () => {
		const rows = await stored();
		t.note('messagesKept', rows.length);
		await t.tables.clear('group_messages');
		await t.tables.clear('digests');
		t.note('messagesSentInAll', { guard: real.guard.messagesAccepted, customer: customer.count });
	});
}

/** Always runs at the end, also after a failure: the workflow is switched off. The harness deletes the messages it sent. */
export async function cleanup(t) {
	try {
		await t.deactivate();
	} catch {
		// the workflow may already be inactive
	}
}
