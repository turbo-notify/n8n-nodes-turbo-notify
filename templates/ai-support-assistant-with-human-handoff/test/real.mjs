/**
 * Gate 2 scenario for T3 (ai-support-assistant-with-human-handoff): the exported workflow with a REAL chat model and
 * REAL WhatsApp messages between two numbers of the same owner.
 *
 *   The assistant runs on number A (the "number under test", the key passed with --api-key-file).
 *   The "customer" is number B, an owned number of ANOTHER organization, which writes to A with its own key
 *   (--customer-key-file). The only recipient the workflow may reach is B (the guard), and B's key can only send
 *   plain text to A (the customer sender). Both count in the same budget (--max-sends).
 *
 *   export TN_REAL_OWNER_PHONE='+<number B: the customer, the only number the assistant may message>'
 *   export TN_REAL_PERSONAL_PHONE='+<number A: the number under test>'
 *   export T3_LLM_KEY_FILE=<file holding a Groq key, `gsk_...`>        (never printed, masked)
 *   node templates/harness/run-template.mjs templates/ai-support-assistant-with-human-handoff/workflow.json \
 *     --real-api --api-key-file <key of A> --customer-key-file <key of B> --max-sends 6 \
 *     --scenario templates/ai-support-assistant-with-human-handoff/test/real.mjs --image n8nio/n8n:2.45.5 \
 *     --run-id t3real --ports 5693,9221
 *
 * Messages: the customer's question, its STOP, its second question (and START when the budget allows), plus every
 * reply of the assistant. A handover cannot be exercised for real without a third owned number (the owner alert would
 * go to a number that may not receive anything): owner_phone is number A itself, so the guard refuses an alert.
 *
 * The model: n8n's OpenAI credential pointed at an OpenAI compatible endpoint (T3_LLM_BASE_URL, default Groq) with the
 * model T3_LLM_MODEL, and "Use Responses API" switched off (T3_RESPONSES_API_OFF=1). Groq's openai/gpt-oss models do not
 * work with n8n's agent after a tool call (see the README), so the final run used OpenRouter. Nothing else of the
 * workflow is patched except the values a person types in "Your settings".
 */
import fs from 'node:fs';
import { registerSecret } from '../../harness/lib/util.mjs';

export const timeoutMs = 30 * 60_000;
export const llm = false; // the real model, not the fake one

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const MODEL = process.env.T3_LLM_MODEL || 'openai/gpt-oss-120b';
const GROQ = process.env.T3_LLM_BASE_URL || 'https://api.groq.com/openai/v1'; // any OpenAI compatible endpoint (Groq, OpenRouter)
const TRIGGER = 'Poll new WhatsApp messages';
const BUSINESS_FACTS = 'Open Monday to Saturday, 7am to 7pm, closed on Sunday. Cakes need 48 hours notice. We accept card, cash and Pix.';

function llmKey() {
	const file = process.env.T3_LLM_KEY_FILE;
	if (!file) throw new Error('set T3_LLM_KEY_FILE to a file that holds the Groq key');
	const match = fs.readFileSync(file, 'utf8').match(/(?:gsk_|sk-or-v1-)[A-Za-z0-9_-]+/);
	if (!match) throw new Error('no gsk_ or sk-or-v1- key in T3_LLM_KEY_FILE');
	registerSecret(match[0]);
	return match[0];
}
const KEY = llmKey();

/**
 * Optional trace of what n8n sends to the model (T3_LLM_TRACE=<file>): a pass-through on the host that appends the
 * request body (never the Authorization header) and the status of the answer to the file. For debugging a provider.
 */
let LLM_URL = GROQ;
if (process.env.T3_LLM_TRACE) {
	const http = await import('node:http');
	const TRACE_PORT = 9331;
	http
		.createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = Buffer.concat(chunks);
			const headers = { 'content-type': 'application/json', authorization: String(req.headers.authorization ?? '') };
			const upstream = await fetch(`${new URL(GROQ).origin}${req.url}`, { method: req.method, headers, body: req.method === 'POST' ? body : undefined });
			const text = await upstream.text();
			fs.appendFileSync(process.env.T3_LLM_TRACE, `${JSON.stringify({ path: req.url, status: upstream.status, request: safeJson(body.toString()), response: safeJson(text) })}\n`);
			res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
			res.end(text);
		})
		.listen(TRACE_PORT, '0.0.0.0');
	LLM_URL = `http://host.docker.internal:${TRACE_PORT}${new URL(GROQ).pathname}`;
}
function safeJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return text.slice(0, 2000);
	}
}

export const credentials = [
	{
		type: 'openAiApi',
		name: 'Groq (OpenAI compatible)',
		data: { apiKey: KEY, organizationId: '', url: LLM_URL, header: false, headerName: '', headerValue: '', allowedHttpRequestDomains: 'all', allowedDomains: '' },
	},
];

function phones() {
	const customer = process.env.TN_REAL_OWNER_PHONE;
	const under = process.env.TN_REAL_PERSONAL_PHONE;
	for (const p of [customer, under]) if (!p || !/^\+[1-9]\d{7,14}$/.test(p)) throw new Error('set TN_REAL_OWNER_PHONE (the customer) and TN_REAL_PERSONAL_PHONE (the number under test), with + and the country code');
	return { customer, under };
}

/** The values a person types in "Your settings", plus the model name on the chat model node. Nothing else changes. */
export async function prepare(workflow) {
	const { under } = phones();
	const settings = workflow.nodes.find((n) => n.name === 'Your settings');
	const set = { owner_phone: under, business_name: 'Green House Bakery', business_facts: BUSINESS_FACTS };
	for (const a of settings.parameters.assignments.assignments) if (a.name in set) a.value = set[a.name];
	const model = workflow.nodes.find((n) => n.name === 'OpenAI Chat Model');
	model.parameters.model = { __rl: true, mode: 'id', value: MODEL };
	if (process.env.T3_RESPONSES_API_OFF === '1') model.parameters.responsesApiEnabled = false; // Groq: the Chat Completions path (top-level parameter of the node, default true)
	return workflow;
}

export default async function scenario(t) {
	const { assert, real } = t;
	const { customer: CUSTOMER, under: UNDER } = phones();
	const customer = real.customer;
	assert.ok(customer, 'the customer sender is configured (--customer-key-file)');
	const bodyKeys = (o) => Object.keys(o ?? {}).sort();
	const sendsSince = async (mark) => real.guard.sends({ since: mark });
	const stateOf = async () => (await t.tables.rows('contacts_state', { where: { phone: CUSTOMER } }))[0];
	const budgetLeft = () => real.maxSends - real.guard.messagesAccepted - customer.count;
	const secs = (ms) => Math.round(ms / 100) / 10;

	/** Waits until `predicate()` is truthy (polls every 5 s) or the time is up; returns what it returned. */
	const until = async (predicate, ms, label) => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			const value = await predicate();
			if (value) return value;
			await t.sleep(5000);
		}
		assert.fail(`timed out after ${secs(ms)} s waiting for: ${label}`);
	};
	/** A finished (not manual) execution whose poll handed over an inbound message with this preview (the first 50 characters). */
	const handled = async (since, text) => {
		const all = (await t.n8n.listExecutions(t.workflow.id)).filter((e) => Number(e.id) > since && e.mode !== 'manual');
		for (const e of all.reverse()) {
			if (e.status === 'running' || e.status === 'new' || e.status === 'waiting') continue;
			const full = await t.execution(e.id);
			if (full.items(TRIGGER).some((i) => i.data?.direction === 'inbound' && String(i.data?.preview ?? '').startsWith(text.slice(0, 50)))) return full;
		}
		return null;
	};

	await t.step('0 pre-flight: the assistant number is connected, the customer number is the one the guard allows, the model answers with the tool-calling request', async () => {
		const numbers = await real.numbers();
		const main = numbers.data.find((n) => n.alias === 'main');
		assert.equal(digits(main.number), digits(UNDER), 'the main number of the key is the number under test');
		assert.equal((await real.get('/v1/numbers/main')).status, 'connected', 'connected');
		const from = await customer.verify();
		assert.equal(digits(from.number), digits(CUSTOMER), 'the customer key sends from the allowed customer number');
		const quota = await real.quota();
		t.note('plan', { tier: quota.tier, messages_remaining: quota.remaining });
		assert.ok(quota.remaining >= 20, 'enough quota');
		// the model, outside n8n and without any WhatsApp message: does the endpoint take a tool-calling request?
		const res = await fetch(`${GROQ}/chat/completions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
			body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say OK.' }], max_completion_tokens: 50 }),
		});
		t.note('modelProbe', { model: MODEL, status: res.status });
		assert.equal(res.status, 200, `the model ${MODEL} answers on the model endpoint`);
		assert.equal(real.guard.messagesAccepted + customer.count, 0, 'nothing sent yet');
	});

	let faqRows;
	await t.step('1 the setup branch creates the tables; the two FAQ rows are real (sample false), so the guard passes', async () => {
		const run = await t.run('Run once: set up the tables');
		assert.equal(run.status, 'success', run.describe());
		await t.tables.clear('faq');
		await t.tables.insert('faq', [
			{ question: 'What are your opening hours?', answer: 'We are open Monday to Saturday from 7am to 7pm, and closed on Sunday.', keywords: 'hours, open, opening, saturday, sunday, schedule', sample: false },
			{ question: 'How can I pay?', answer: 'We accept card, cash and Pix.', keywords: 'pay, payment, card, cash, pix', sample: false },
		]);
		faqRows = await t.tables.rows('faq');
		assert.count(faqRows, 2, 'two real FAQ rows');
		assert.equal(faqRows.every((r) => r.sample === false), true, 'none flagged sample');
		const settings = Object.fromEntries(t.workflow.node('Your settings').parameters.assignments.assignments.map((a) => [a.name, a.value]));
		assert.equal(digits(settings.owner_phone), digits(UNDER), 'owner_phone is the number under test itself: the assistant cannot alert anybody else');
		assert.notEqual(digits(settings.owner_phone), digits(CUSTOMER), 'and it is not the customer');
	});

	await t.step('1b dry run of the real model through the workflow (every send node pinned, a fictitious phone): no WhatsApp message, the model and the FAQ tool are real', async () => {
		const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
		const dryPhone = '5511977770090';
		const event = {
			id: `evt_${hex(16)}`,
			type: 'message.received',
			organization_id: `org_${hex(16)}`,
			number_alias: 'main',
			number_id: `num_${hex(16)}`,
			created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
			data: { id: `msg_${hex(16)}`, from: { name: 'Dry Customer', number: dryPhone }, to: { name: 'Green House Bakery', alias: 'main', number: digits(UNDER) }, direction: 'inbound', channel: 'whatsapp', origin: 'native', content_type: 'text', preview: 'What time do you open on Saturdays?', at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') },
		};
		const pin = {
			[TRIGGER]: [event],
			'Read the whole message': [{ id: event.data.id, text: 'What time do you open on Saturdays?', content_type: 'text' }],
			'Show typing': [{ is_typing: true }],
			'Send the reply': [{ message_id: `msg_${hex(16)}`, status: { state: 'pending' } }],
			'Tell the customer a person will answer': [{ message_id: `msg_${hex(16)}` }],
			'Alert the owner': [{ message_id: `msg_${hex(16)}` }],
			'Send the customer contact card to the owner': [{ message_id: `msg_${hex(16)}` }],
		};
		const before = real.guard.messagesAccepted + customer.count;
		const started = Date.now();
		const execution = await t.run(TRIGGER, { pin, timeoutMs: 240_000 });
		t.note('dryRun', { status: execution.status, totalMs: Date.now() - started, nodes: execution.nodesRun });
		if (execution.status !== 'success') t.note('dryRunError', execution.describe());
		assert.equal(real.guard.messagesAccepted + customer.count, before, 'no WhatsApp message was sent');
		const agent = execution.runData['Support AI Agent']?.[0];
		const tool = execution.runData['Search the FAQ'] ?? [];
		const decision = execution.first('Read the agent decision');
		t.note('dryModel', {
			model: MODEL,
			agentMs: agent?.executionTime,
			agentError: agent?.error ? String(agent.error.message).slice(0, 300) : null,
			toolRuns: tool.length,
			toolRows: tool.map((r) => (r.data?.ai_tool?.[0] ?? []).length),
			rawOutputStart: String(execution.first('Support AI Agent')?.output ?? '').slice(0, 400),
			agentItem: JSON.stringify(execution.first('Support AI Agent') ?? null).slice(0, 1500),
			chatModelRuns: JSON.stringify(execution.runData['OpenAI Chat Model']?.map((r) => ({ err: r.error?.message, desc: r.error?.description, ms: r.executionTime })) ?? null).slice(0, 1500),
			decision: decision ? { answer: decision.answer, confidence: decision.confidence, needs_person: decision.needs_person, reason: decision.reason } : null,
		});
		await t.tables.clear('contacts_state'); // the dry run saved a state row for the fictitious phone
		assert.equal(execution.status, 'success', execution.describe());
		assert.ok(tool.length >= 1, 'the real model called the FAQ tool');
		assert.ok(decision, 'the decision was read');
		assert.equal(decision.needs_person, false, `no handoff: ${decision.reason}`);
	});

	let activeSince;
	await t.step('2 activate and let the first poll record "now"', async () => {
		activeSince = await t.executionMark();
		await t.activate();
		await t.sleep(8000);
	});

	/** The customer writes `text`; returns the id of the message and when it was sent. */
	const customerWrites = async (text) => {
		const sent = await customer.send(text);
		return { ...sent, at: Date.now() };
	};

	await t.step('3 the customer asks a question the FAQ answers: real poll, Get Message, typing, the real model calls the FAQ tool and answers, the Reply reaches the customer', async () => {
		const mark = await real.guard.mark();
		const question = await customerWrites('Hi! What time do you open on Saturdays?');
		t.note('customerQuestion', { sendStatus: question.status?.state ?? question.status });
		// the poll sees message.received on the number under test, then the workflow handles it
		const execution = await until(async () => handled(activeSince, 'Hi! What time do you open on Saturdays?'), 6 * 60_000, 'the poller to hand over the question and the workflow to finish');
		const waitedMs = Date.now() - question.at;
		t.note('timeFromCustomerSendToHandledMs', waitedMs);
		t.note('executionStatus', execution.status);
		if (execution.status !== 'success') t.note('executionError', execution.describe());
		assert.equal(execution.status, 'success', execution.describe());
		const reads = (await real.guard.requests({ method: 'GET', since: mark })).filter((r) => /\/messages\/msg_/.test(r.path));
		assert.ok(reads.length >= 1 && reads.every((r) => r.status === 200), 'Get Message read the whole text (200)');

		// typing: accepted or refused by the real plan, either way the answer goes on
		const typing = (await real.guard.requests({ method: 'POST', since: mark })).filter((r) => /typing-indicator$/.test(r.path));
		t.note('typingIndicator', typing.map((r) => ({ status: r.status, error: r.status >= 400 ? r.response : undefined, response: r.status < 400 ? r.response : undefined })));
		assert.count(typing, 1, 'one typing request');

		// the model
		const agent = execution.runData['Support AI Agent']?.[0];
		const tool = execution.runData['Search the FAQ'] ?? [];
		const decision = execution.first('Read the agent decision');
		t.note('agent', {
			agentMs: agent?.executionTime,
			agentOutputShape: bodyKeys(execution.first('Support AI Agent')),
			toolRuns: tool.length,
			toolInput: tool.map((r) => r.inputOverride ?? r.data?.ai_tool?.[0]?.[0]?.json?.query ?? null),
			toolReturnedRows: tool.map((r) => (r.data?.ai_tool?.[0] ?? []).length),
			decision: decision ? { answer: decision.answer, confidence: decision.confidence, needs_person: decision.needs_person, reason: decision.reason } : null,
			rawOutputStart: String(execution.first('Support AI Agent')?.output ?? '').slice(0, 300),
		});
		assert.ok(tool.length >= 1, 'the real model called the FAQ tool');
		assert.ok(decision, 'the JSON decision parsed');
		assert.equal(decision.needs_person, false, `no handoff for a question the FAQ answers (${decision.reason})`);
		assert.ok(Number(decision.confidence) >= 0.7, `confidence ${decision.confidence} is above the threshold`);
		assert.match(String(decision.answer), /7\s*(am|h|:00)|7.*19|7am|07/i, 'the answer carries the opening hour from the FAQ');

		// the reply left through the real API, quoted, and reached the customer
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'exactly one message: the reply');
		assert.equal(digits(sends[0].to?.number), digits(CUSTOMER), 'the reply goes to the customer');
		assert.ok(sends[0].reply, 'it is a Reply (quotes the customer message)');
		assert.ok(sends[0].status === 202 || sends[0].status === 200, `accepted (${sends[0].status})`);
		const text = sends[0].content?.text ?? '';
		t.note('replyLength', text.length);
		assert.equal(text, decision.answer, 'the text sent is the model answer, nothing else');
		const arrived = await until(async () => {
			const list = await customer.list('direction=inbound&limit=10');
			return list.data.find((m) => m.content_type === 'text' && digits(m.from?.number) === digits(UNDER) && (m.preview ?? '').startsWith(text.slice(0, 30)));
		}, 90_000, 'the reply to show up in the customer organization as a received message');
		t.note('replyArrivedAtCustomer', { id: Boolean(arrived.id), origin: arrived.origin });
		const state = await stateOf();
		t.note('stateRow', state ? { ai_answers: state.ai_answers, opted_out: state.opted_out, hasLastEventIds: Boolean(state.recent_event_ids) } : null);
		assert.ok(state, 'the contact state row was written');
		assert.equal(Number(state.ai_answers), 1, 'one automatic reply counted');
		assert.equal(Boolean(state.opted_out), false, 'not opted out');
	});

	await t.step('4 STOP: the workflow confirms once with its fixed text and saves the opt-out', async () => {
		const mark = await real.guard.mark();
		const since = await t.executionMark();
		const stop = await customerWrites('STOP');
		t.note('stopSend', { state: stop.status?.state ?? stop.status });
		await until(async () => (await sendsSince(mark)).length >= 1, 6 * 60_000, 'the opt-out confirmation to be sent');
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'one confirmation');
		assert.equal(digits(sends[0].to?.number), digits(CUSTOMER), 'to the customer');
		const optoutReply = Object.fromEntries(t.workflow.node('Your settings').parameters.assignments.assignments.map((a) => [a.name, a.value])).optout_reply;
		assert.equal(sends[0].content?.text, optoutReply, 'the fixed opt-out text, not model text');
		await until(async () => (await stateOf())?.opted_out === true, 60_000, 'opted_out to be saved');
		const runs = (await t.n8n.listExecutions(t.workflow.id)).filter((e) => Number(e.id) > since && e.mode !== 'manual');
		const aiRuns = [];
		for (const e of runs) if ((await t.execution(e.id)).ran('Support AI Agent')) aiRuns.push(e.id);
		assert.count(aiRuns, 0, 'no model call for the STOP message');
	});

	/** An event shaped like message.received from the customer, for a pinned run (no WhatsApp message is involved). */
	const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
	const pinnedFromCustomer = (text) => {
		const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
		const event = {
			id: `evt_${hex(16)}`,
			type: 'message.received',
			organization_id: `org_${hex(16)}`,
			number_alias: 'main',
			number_id: `num_${hex(16)}`,
			created_at: at,
			data: { id: `msg_${hex(16)}`, from: { name: 'Customer', number: digits(CUSTOMER) }, to: { name: 'Green House Bakery', alias: 'main', number: digits(UNDER) }, direction: 'inbound', channel: 'whatsapp', origin: 'native', content_type: 'text', preview: text, at },
		};
		const none = (id) => [{ message_id: `msg_${id}` }];
		return {
			[TRIGGER]: [event],
			'Read the whole message': [{ id: event.data.id, text, content_type: 'text' }],
			'Show typing': [{ is_typing: true }],
			'Send the reply': none(hex(16)),
			'Tell the customer a person will answer': none(hex(16)),
			'Alert the owner': none(hex(16)),
			'Send the customer contact card to the owner': none(hex(16)),
		};
	};

	await t.step('5 the customer asks again while opted out: the workflow stays silent (no model call, no message)', async () => {
		const mark = await real.guard.mark();
		if (budgetLeft() >= 1) {
			// over the wire: a real second question
			const since = await t.executionMark();
			await customerWrites('And what time do you close?');
			const t0 = Date.now();
			let handledRun = null;
			while (Date.now() - t0 < 5 * 60_000 && !handledRun) {
				await t.sleep(10_000);
				handledRun = await handled(since, 'And what time do you close?');
			}
			assert.ok(handledRun, 'a poll handed the second question over');
			t.note('silentRun', { overTheWire: true, nodes: handledRun.nodesRun });
			assert.equal(handledRun.ran('Support AI Agent'), false, 'the model was not called');
			assert.equal(handledRun.ran('Send the reply'), false, 'no reply');
			await t.sleep(70_000);
		} else {
			// the budget has no message left for the customer: the same event is fed by pinning, against the REAL state row the real STOP wrote
			const execution = await t.run(TRIGGER, { pin: pinnedFromCustomer('And what time do you close?') });
			t.note('silentRun', { overTheWire: false, status: execution.status, nodes: execution.nodesRun });
			assert.equal(execution.status, 'success', execution.describe());
			assert.equal(execution.ran('Support AI Agent'), false, 'the model was not called');
			assert.equal(execution.ran('Send the reply'), false, 'no reply');
			assert.equal(execution.ran('Tell the customer a person will answer'), false, 'no handover either');
			assert.equal((await stateOf())?.opted_out, true, 'the real state row still says opted out');
		}
		assert.count(await sendsSince(mark), 0, 'nothing was sent to the customer');
	});

	await t.step('6 START brings the chat back (real when the budget allows its message and the confirmation, else pinned)', async () => {
		const optinReply = Object.fromEntries(t.workflow.node('Your settings').parameters.assignments.assignments.map((a) => [a.name, a.value])).optin_reply;
		const mark = await real.guard.mark();
		if (budgetLeft() >= 2) {
			await customerWrites('START');
			await until(async () => (await sendsSince(mark)).length >= 1, 6 * 60_000, 'the opt-in confirmation to be sent');
			const sends = await sendsSince(mark);
			assert.count(sends, 1, 'one confirmation');
			assert.equal(sends[0].content?.text, optinReply, 'the fixed opt-in text');
			t.note('startRun', { overTheWire: true });
		} else {
			const execution = await t.run(TRIGGER, { pin: pinnedFromCustomer('START') });
			t.note('startRun', { overTheWire: false, status: execution.status });
			assert.equal(execution.status, 'success', execution.describe());
			assert.equal(execution.first('Decide how to handle the message')?.route, 'fixed', 'the fixed opt-in route');
			assert.equal(execution.first('Decide how to handle the message')?.reply_text, optinReply, 'with the opt-in text');
			assert.equal(execution.ran('Support AI Agent'), false, 'no model call');
			assert.count(await sendsSince(mark), 0, 'the confirmation send node was pinned: nothing real was sent');
		}
		await until(async () => (await stateOf())?.opted_out === false, 60_000, 'opted_out to be cleared');
	});

	await t.step('7 the whole run: only the customer was messaged, inside the budget, nothing blocked', async () => {
		await t.deactivate();
		const total = real.guard.messagesAccepted + customer.count;
		t.note('messages', { byAssistant: real.guard.messagesAccepted, byCustomer: customer.count, total });
		assert.ok(total <= real.maxSends, `inside the budget (${total} of ${real.maxSends})`);
		const all = (await real.guard.requests({ method: 'POST' })).filter((e) => /\/messages(\/msg_\w+\/reply)?$/.test(e.path));
		assert.ok(all.every((e) => e.status < 300 || e.status === 429), 'every send was accepted (a 429 spacing is retried by the node)');
		t.note('guard', { blockedCalls: real.guard.blocked, requests: (await real.guard.requests()).length });
		assert.equal(real.guard.blocked, 0, 'the guard blocked nothing: the assistant never tried another number');
	});
}

export async function cleanup(t) {
	try {
		await t.deactivate();
	} catch {
		// already inactive
	}
	try {
		const tables = await t.n8n.dataTables();
		for (const name of ['faq', 'contacts_state']) {
			const table = tables.find((x) => x.name === name);
			if (table) await t.n8n.rest('DELETE', `/rest/projects/${t.n8n.projectId}/data-tables/${table.id}`);
		}
		t.note('dataTablesDeleted', true);
	} catch (error) {
		t.note('dataTablesDeleted', `failed: ${error.message}`);
	}
}
