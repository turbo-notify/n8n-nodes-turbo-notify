/**
 * Real API scenario for T5 (whatsapp-group-daily-digest): the exported workflow against the REAL Turbo Notify API and
 * a REAL chat model. NOT RUN YET: written for a later gate 2 run. Nothing in this file has been executed.
 *
 * What a real run needs, and why it cannot be fully automatic:
 *   - The Turbo Notify API cannot create a WhatsApp group (see docs: "Group limitations"). The owner creates ONE group by
 *     hand on a phone, with the number under test (number A) as a member and himself, and gives it a name that no other
 *     group of that number has (TN_REAL_GROUP_NAME).
 *   - The API cannot write into a group as another person either, and the harness's customer sender only writes private
 *     messages. So the owner types at least 4 messages in that group from his own phone while the run waits (the step
 *     names say when). Include a message with a link, a photo with a caption, a message that tags somebody (@) and a
 *     message that writes a phone number (the stored text must hold neither a number nor a tag token).
 *   - That phone is NOT the phone linked to number A: what is typed on the linked phone arrives as message.sent (origin
 *     native), which the workflow stores as the "Owner" but which this run cannot produce from the API. Also, the owner
 *     receiving the digest must be a phone other than the linked one (a message to the linked number makes no push).
 *   - The only recipient the workflow may reach is the owner's receiving number (TN_REAL_OWNER_PHONE, the guard). A post
 *     into the group is NOT exercised: the guard refuses any recipient but that number, and delivery group needs the
 *     Business plan. To try it, create a group of only yourself on a Business organization and run with --no-guard.
 *
 *   export TN_REAL_OWNER_PHONE='+<the number that may receive the digests>'
 *   export TN_REAL_GROUP_NAME='<the exact name of the test group>'
 *   export T5_LLM_KEY_FILE=<file holding a key `gsk_...` or `sk-or-v1-...`>     (never printed, masked)
 *   node templates/harness/run-template.mjs templates/whatsapp-group-daily-digest/workflow.json \
 *     --real-api --api-key-file <key of the organization of number A> --max-sends 4 \
 *     --scenario templates/whatsapp-group-daily-digest/test/real.mjs --image n8nio/n8n:2.45.5 \
 *     --tz America/Sao_Paulo --run-id t5real --ports 5696,9241
 *
 * Messages sent: the digest (1), the manual digest (1). Both go to the owner number only. A third and a fourth stay
 * in the budget for a repeat that must send nothing new.
 *
 * The model: n8n's OpenAI credential pointed at an OpenAI compatible endpoint (T5_LLM_BASE_URL, default OpenRouter) with
 * the model T5_LLM_MODEL, and "Use Responses API" switched off. Nothing else of the workflow is patched except the
 * values a person types in "Your settings" and the model name.
 */
import fs from 'node:fs';
import { registerSecret } from '../../harness/lib/util.mjs';

export const timeoutMs = 40 * 60_000;
export const llm = false; // the real model, not the fake one

const BASE = process.env.T5_LLM_BASE_URL || 'https://openrouter.ai/api/v1';
const MODEL = process.env.T5_LLM_MODEL || 'nvidia/nemotron-nano-9b-v2:free';
const POLL = 'Poll WhatsApp group messages';
const HOURLY = 'Every hour: look for digests that are due';

function llmKey() {
	const file = process.env.T5_LLM_KEY_FILE;
	if (!file) throw new Error('set T5_LLM_KEY_FILE to a file that holds the chat model key');
	const match = fs.readFileSync(file, 'utf8').match(/(?:gsk_|sk-or-v1-)[A-Za-z0-9_-]+/);
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

function settingsFromEnvironment() {
	const owner = process.env.TN_REAL_OWNER_PHONE;
	const group = process.env.TN_REAL_GROUP_NAME;
	if (!owner || !/^\+[1-9]\d{7,14}$/.test(owner)) throw new Error('set TN_REAL_OWNER_PHONE (the only number that may receive messages), with + and the country code');
	if (!group) throw new Error('set TN_REAL_GROUP_NAME (the exact name of the test group)');
	return { owner, group };
}

const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));

/** The values a person types in "Your settings", plus the model name on the chat model node. Nothing else changes. */
export async function prepare(workflow) {
	const { owner, group } = settingsFromEnvironment();
	const settings = workflow.nodes.find((n) => n.name === 'Your settings');
	const set = { watch_groups: group, owner_phone: owner, delivery: 'owner', digest_hour: hourNow(), min_messages: 4, run_now_group: group };
	for (const a of settings.parameters.assignments.assignments) if (a.name in set) a.value = set[a.name];
	const model = workflow.nodes.find((n) => n.name === 'Chat model for the digest');
	model.parameters.model = { __rl: true, mode: 'id', value: MODEL };
	model.parameters.responsesApiEnabled = false;
	return workflow;
}

export default async function scenario(t) {
	const { assert, real } = t;
	const { owner: OWNER, group: GROUP } = settingsFromEnvironment();
	const sendsSince = async (mark) => real.guard.sends({ since: mark });
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

	await t.step('0 pre-flight: the number is connected, the test group exists on it, the plan and the quota are readable', async () => {
		const number = await real.get('/v1/numbers/main');
		assert.equal(number.status, 'connected', 'the number under test is connected');
		const groups = (await real.get(`/v1/numbers/main/groups?name=${encodeURIComponent(GROUP)}`)).data ?? [];
		const exact = groups.filter((g) => g.name === GROUP && g.is_active);
		assert.equal(exact.length, 1, `exactly one active group is named "${GROUP}" on the number`);
		const quota = await real.quota();
		t.note('plan', { tier: quota.tier, messages_remaining: quota.remaining });
		t.note('group', { participants_count: exact[0].participants_count });
		assert.ok(quota.remaining >= 10, 'enough quota');
		assert.equal(real.guard.messagesAccepted, 0, 'nothing sent yet');
	});

	await t.step('1 the tables are created by the workflow, the workflow is switched on', async () => {
		const execution = await t.run('Run once: create the tables');
		assert.equal(execution.status, 'success', execution.describe());
		await t.activate();
	});

	await t.step('2 NOW: write at least 4 messages in the test group from your own phone (a link, a photo with a caption, a tag with @, a phone number). The real poller (every 10 minutes) must store them with their FULL text and without any phone number', async () => {
		const rows = await until(async () => {
			const found = await stored();
			return found.length >= 4 ? found : null;
		}, 15 * 60_000, 'four messages written in the group to be stored');
		assert.ok(rows.every((r) => !/\d{8,}/.test(r.text.replace(/https?:\/\/\S+/g, '')) && !/@\d{5,}/.test(r.text)), 'no phone number and no @number token was stored');
		assert.ok(rows.every((r) => r.group_name === GROUP), 'all of them belong to the test group');
		assert.ok(rows.every((r) => r.text_source === 'full'), 'each was read in full');
		t.note('storedRows', rows.map((r) => ({ kind: r.kind, length: r.text.length, text_source: r.text_source, has_phone: Boolean(r.sender_phone), has_name: Boolean(r.sender_name) })));
		const reads = (await real.guard.requests()).filter((r) => r.method === 'GET' && /\/messages\/msg_/.test(r.path));
		assert.ok(reads.length >= rows.length, 'one Message Get per stored message');
	});

	await t.step('3 the hourly run builds ONE digest with the real model and sends it to the owner number only', async () => {
		await t.deactivate();
		const mark = await real.guard.mark();
		const execution = await t.run(HOURLY);
		assert.equal(execution.status, 'success', execution.describe());
		const sends = await sendsSince(mark);
		assert.equal(sends.length, 1, 'one message');
		assert.equal(String(sends[0].to?.number ?? '').replace(/\D/g, ''), OWNER.replace(/\D/g, ''), 'to the owner number');
		const text = sends[0].content?.text ?? '';
		t.note('digestText', text.length > 0 ? 'the digest text is in the owner phone: read it there, it is not printed here' : 'EMPTY');
		const [row] = await t.tables.rows('digests');
		t.note('summarySource', row.summary_source);
		assert.equal(row.status, 'delivered', 'recorded as delivered');
		const progress = await real.observe(sends[0].messageId ?? execution.first('Send the digest').id, ['sent', 'delivered', 'read'], { timeoutMs: 120_000 });
		t.note('deliveryStates', progress);
	});

	await t.step('4 a second hourly run sends nothing', async () => {
		const mark = await real.guard.mark();
		const execution = await t.run(HOURLY);
		assert.equal(execution.status, 'success', execution.describe());
		assert.equal((await sendsSince(mark)).length, 0, 'nothing is sent twice');
	});

	await t.step('5 "Run now for one group" sends a manual digest to the owner number, and a second press without news sends no new message', async () => {
		const mark = await real.guard.mark();
		const first = await t.run('Run now for one group');
		assert.equal(first.status, 'success', first.describe());
		const sent = await sendsSince(mark);
		assert.equal(sent.length, 1, 'one message');
		const again = await t.run('Run now for one group');
		assert.ok(['success', 'error'].includes(again.status), 'the second press ends');
		const ids = new Set((await sendsSince(mark)).map((s) => s.messageId));
		assert.equal(ids.size, 1, 'still one message in all: the repeat is the same message');
	});

	await t.step('6 the stored messages are the only chat content kept: count them, then clean up', async () => {
		const rows = await stored();
		t.note('messagesKept', rows.length);
		await t.tables.clear('group_messages');
		await t.tables.clear('digests');
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
