/**
 * Template T3: AI support assistant with human handoff.
 *
 * The workflow is imported exactly as exported. The only thing created before the import is the
 * credentials the harness always creates (a Turbo Notify key pointing at the mock, an OpenAI key
 * pointing at the scripted fake model). The data tables are created BY THE WORKFLOW, by running
 * its own "Run once" branch, and the Data Table nodes find them by name.
 *
 * The exported settings are placeholders on purpose, so the first steps prove that the workflow refuses to
 * answer anybody as exported. Then the settings a person must change (owner phone, business name and facts,
 * the sample FAQ rows) are changed the way a person would: through the stored workflow and the faq table.
 * Nothing else is patched.
 *
 * The branches behind the Polling Trigger are run by pinning real events (taken from the mock's own
 * event feed) on the trigger. One block at the end activates the workflow and lets the real poller
 * deliver real events, to prove the trigger settings (three event types) and that the workflow
 * ignores the echo of its own replies.
 *
 * The model is a scripted fake: this scenario proves the wiring, the prompt that reaches the model,
 * the tool call and what the workflow does with the answer. It does NOT prove answer quality.
 */
export const timeoutMs = 25 * 60_000;
export const llm = true;

const TRIGGER = 'Poll new WhatsApp messages'; // the real, unmodified trigger of the template
const OWNER = '+5511977770099'; // the owner_phone this scenario types into the settings (the export holds a placeholder)
const BUSINESS_FACTS = 'Open Monday to Saturday, 7am to 7pm, closed on Sunday. Cakes need 48 hours notice. We accept card, cash and Pix.';
const HANDOFF_REPLY = 'Thank you. I passed your message to our team. A person will answer you here.';

const decision = (answer, confidence = 0.9, handoff = false, handoff_reason = '') => JSON.stringify({ answer, confidence, handoff, handoff_reason });

export default async function scenario(t) {
	const { assert } = t;

	// ---------------------------------------------------------------- helpers
	let counter = 10;
	const nextPhone = () => `+55119777700${counter++}`;

	/** Writes to the number through the mock and returns the event exactly as the events API serves it. */
	const incoming = async (options) => {
		const injected = await t.mock.injectMessage(options);
		const event = (await t.mock.events()).find((e) => e.id === injected.event_id);
		assert.ok(event, `the mock holds the event ${injected.event_id}`);
		return { event, messageId: injected.message_id };
	};
	const runEvents = (...events) => t.run(TRIGGER, { pin: { [TRIGGER]: events } });
	const stateOf = async (phone) => (await t.tables.rows('contacts_state', { where: { phone } }))[0];
	/** The sends since a mark, each with `number`: the recipient (a reply carries no recipient, so it is read from the message the mock stored). */
	const sendsSince = async (mark) => {
		const sends = await t.mock.sends({ since: mark });
		const stored = new Map((await t.mock.messages()).map((m) => [m.id, m]));
		return sends.map((x) => ({ ...x, number: x.to?.number ?? `+${String(stored.get(x.messageId)?.to?.number ?? '').replace(/\D/g, '')}` }));
	};
	const textsSentTo = (sends, number) => sends.filter((s) => s.number === number && s.content?.text !== undefined).map((s) => s.content.text);
	const llmCalls = () => t.llm.requests.length;
	/** The rows of the request log that went to a path matching `regex`, from a mark on. */
	const calls = async (mark, regex, method = 'POST') => (await t.mock.requests({ method, since: mark })).filter((r) => regex.test(r.path));
	const ran = (execution, name) => execution.nodesRun.includes(name);
	/** Types values into the settings node of the stored workflow, the way a person edits "Your settings". */
	const configure = async (values) => {
		const current = await t.n8n.rest('GET', `/rest/workflows/${t.workflow.id}`);
		const nodes = structuredClone(current.nodes);
		const settings = nodes.find((n) => n.name === 'Your settings');
		for (const assignment of settings.parameters.assignments.assignments) if (assignment.name in values) assignment.value = values[assignment.name];
		await t.n8n.rest('PATCH', `/rest/workflows/${t.workflow.id}`, { nodes, versionId: current.versionId });
	};
	const settingsAsExported = () => Object.fromEntries(t.workflow.node('Your settings').parameters.assignments.assignments.map((a) => [a.name, a.value]));

	// ---------------------------------------------------------------- the exported settings
	await t.step('as exported: placeholders, a plain explanation of every setting, no leftover sample facts', async () => {
		const values = settingsAsExported();
		assert.equal(values.owner_phone, '+55XXXXXXXXXXX', 'owner_phone is a placeholder, never a number that could receive customer data');
		assert.equal(values.business_name, 'Your Business Name', 'business_name is a placeholder');
		assert.match(values.business_facts, /^Replace this with/, 'business_facts is a placeholder, not sample bakery facts');
		assert.equal(values.ignore_phones, '', 'ignore_phones starts empty');
		assert.ok(!/as soon as possible/i.test(values.handoff_reply), 'the default handoff reply promises no time');
		assert.equal(values.handoff_reply, HANDOFF_REPLY, 'neutral handoff reply');
		const node = t.workflow.node('Your settings');
		assert.equal(node.notesInFlow, true, 'the explanations show on the canvas');
		for (const name of Object.keys(values)) assert.ok(String(node.notes).split('\n').some((line) => line.startsWith(`${name}:`)), `the note explains ${name}`);
	});

	// ---------------------------------------------------------------- setup branch
	await t.step('the "Run once" branch creates both tables and the sample rows (flagged sample), and is safe to run twice', async () => {
		const first = await t.run('Run once: set up the tables');
		assert.equal(first.status, 'success', first.describe());
		const faq = await t.tables.rows('faq');
		assert.count(faq, 4, 'four sample FAQ rows');
		assert.includes(faq.map((r) => r.question), 'What are your opening hours?', 'opening hours row');
		assert.equal(faq.map((r) => r.sample), [true, true, true, true], 'every sample row carries the sample flag');
		assert.count(await t.tables.rows('contacts_state'), 0, 'contacts_state exists and is empty');
		const second = await t.run('Run once: set up the tables');
		assert.equal(second.status, 'success', second.describe());
		assert.count(await t.tables.rows('faq'), 4, 'running it again adds no duplicate row');
	});

	// ---------------------------------------------------------------- the guard: never answer as a sample business
	await t.step('as exported the workflow refuses to run: it names every setting still to change and sends nothing', async () => {
		const { event } = await incoming({ from: nextPhone(), name: 'First Customer', text: 'What are your opening hours?' });
		const before = llmCalls();
		const mark = await t.mock.mark();
		const execution = await runEvents(event);
		assert.equal(execution.status, 'error', 'the run fails instead of answering with sample data');
		const message = execution.error?.message ?? '';
		assert.match(message, /^Not ready to answer customers: /, 'a plain message');
		for (const part of ['owner_phone', 'business_name is still the sample', 'business_facts is still the sample', 'still has 4 sample row(s)']) assert.ok(message.includes(part), `the message says: ${part}`);
		assert.ok(!ran(execution, 'Loop over events'), 'no event was handled');
		assert.ok(!ran(execution, 'Read the whole message'), 'the message was not even read');
		assert.count(await sendsSince(mark), 0, 'nothing was sent to anybody');
		assert.equal(llmCalls(), before, 'the model was not called');
	});

	await t.step('each setting is checked on its own: a real owner phone, then the business, then the FAQ rows', async () => {
		const { event } = await incoming({ from: nextPhone(), name: 'Second Customer', text: 'Where are you?' });
		const run = async () => (await runEvents(event)).error?.message ?? '';
		await configure({ owner_phone: '12345' });
		assert.ok((await run()).includes('owner_phone'), 'a short number is not accepted');
		await configure({ owner_phone: OWNER });
		let message = await run();
		assert.ok(!message.includes('owner_phone') && message.includes('business_name'), 'with a real owner phone the business is next');
		await configure({ business_name: 'Green House Bakery' });
		message = await run();
		assert.ok(!message.includes('business_name') && message.includes('business_facts'), 'then the facts');
		await configure({ business_facts: BUSINESS_FACTS });
		message = await run();
		assert.match(message, /the faq table still has 4 sample row\(s\)/, 'then the sample FAQ rows');
		await t.tables.update('faq', { question: 'How can I pay?' }, { sample: false });
		assert.match(await run(), /still has 3 sample row\(s\)/, 'a row with sample set to false no longer counts');
		await t.tables.clear('faq');
		assert.match(await run(), /the faq table is empty/, 'an empty FAQ is refused too');
		const again = await t.run('Run once: set up the tables');
		assert.equal(again.status, 'success', again.describe());
		assert.count(await t.tables.rows('faq'), 4, 'the setup branch put the four samples back');
		// The person rewrites the FAQ: the samples are replaced by their own rows (sample false).
		await t.tables.update('faq', { sample: true }, { sample: false });
		t.llm.script([{ reply: decision('Our shop is at 100 Example Street, Springfield.', 0.9) }]);
		assert.equal(await run(), '', 'with real settings and no sample row the run goes on');
	});

	// ---------------------------------------------------------------- 1. normal FAQ answer
	const bia = nextPhone();
	await t.step('normal answer: the FAQ tool is called, the model sees the configured prompt, the reply quotes the message', async () => {
		t.llm.script([
			{ user: /opening|hours/i, toolCalls: [{ name: 'Search the FAQ', arguments: { keyword: 'hours' } }] },
			{ afterTool: /Monday to Saturday/, reply: decision('We are open Monday to Saturday, from 7am to 7pm.', 0.93) },
			{ reply: decision('fallback', 0.1, true, 'unscripted') },
		]);
		const { event, messageId } = await incoming({ from: bia, name: 'Bia Costa', text: 'What are your opening hours?' });
		const firstRequest = t.llm.requests.length; // the guard steps already called the model once
		const mark = await t.mock.mark();
		const execution = await runEvents(event);
		assert.equal(execution.status, 'success', execution.describe());
		for (const name of ['Check the settings', 'Read the whole message', 'Show typing', 'Search the FAQ', 'Support AI Agent', 'Send the reply', 'Save the contact state', 'Record what failed for this event']) {
			assert.ok(ran(execution, name), `${name} ran (${execution.describe()})`);
		}
		assert.ok(!ran(execution, 'Alert the owner'), 'no owner alert for a normal answer');

		const first = t.llm.requests[firstRequest].ctx;
		assert.match(first.system, /assistant of Green House Bakery/, 'business name reached the system prompt');
		assert.match(first.system, /Never invent prices/, 'rules reached the system prompt');
		assert.match(first.system, /Open Monday to Saturday/, 'business facts reached the system prompt');
		assert.match(first.system, /ONE JSON object/, 'the JSON decision format is in the prompt');
		assert.includes(first.tools, 'Search_the_FAQ', 'the FAQ tool is offered to the model');
		assert.equal(first.lastUser, 'What are your opening hours?', 'the model got the customer text, not the preview');

		const typing = await calls(mark, /\/typing-indicator$/);
		assert.count(typing, 1, 'one typing indicator');
		assert.equal(typing[0].body.to, { number: bia }, 'typing goes to the customer');
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'exactly one message was sent');
		assert.match(sends[0].path, new RegExp(`/messages/${messageId}/reply$`), 'it is a Reply to the customer message (quoting)');
		assert.equal(sends[0].content, { text: 'We are open Monday to Saturday, from 7am to 7pm.' }, 'text is the validated answer');
		assert.equal(sends[0].idempotencyKey, `reply-${event.id}`, 'idempotency key is built from the event id');
		const row = await stateOf(bia);
		assert.subset(row, { opted_out: false, ai_answers: 1 }, 'state row after one answer');
		assert.ok(row.recent_event_ids.includes(event.id), 'the event id is remembered');
		assert.ok(row.ai_window_start, 'the hourly window started');
	});

	await t.step('per-customer memory: the same phone sees its history, another phone does not', async () => {
		t.llm.script([{ reply: decision('Yes, on Saturday we close at 7pm.', 0.9) }]);
		const { event } = await incoming({ from: bia, name: 'Bia Costa', text: 'And on Saturday?' });
		const execution = await runEvents(event);
		assert.equal(execution.status, 'success', execution.describe());
		const history = JSON.stringify(t.llm.requests.at(-1).ctx.messages);
		assert.ok(history.includes('What are your opening hours?'), 'the earlier question is in the history of the same phone');

		const other = nextPhone();
		const { event: eventOther } = await incoming({ from: other, name: 'Caio Lima', text: 'Hello there' });
		const executionOther = await runEvents(eventOther);
		assert.equal(executionOther.status, 'success', executionOther.describe());
		const historyOther = JSON.stringify(t.llm.requests.at(-1).ctx.messages);
		assert.ok(!historyOther.includes('What are your opening hours?'), 'another phone does not see it');
	});

	// ---------------------------------------------------------------- 2. filters
	await t.step('a group message is ignored', async () => {
		const before = llmCalls();
		const { event } = await incoming({ from: nextPhone(), name: 'Dani', text: 'Anyone knows the opening hours?', group: { name: 'Neighbours' } });
		assert.ok(event.data.to.group_id, 'the event carries a group id');
		const mark = await t.mock.mark();
		const execution = await runEvents(event);
		assert.equal(execution.status, 'success', execution.describe());
		assert.ok(!ran(execution, 'Read the whole message'), 'the message was not even read');
		assert.count(await sendsSince(mark), 0, 'nothing sent');
		assert.equal(llmCalls(), before, 'the model was not called');
	});

	await t.step('own messages are ignored: the echo of the replies, a message from the owner phone, a message from the number itself', async () => {
		const own = (await t.mock.events()).filter((e) => (e.type === 'message.replied' || e.type === 'message.sent') && e.data.direction === 'outbound' && e.data.origin === 'tn');
		assert.ok(own.length >= 1, 'the mock produced events for the workflow own replies');
		const ownerWrites = await incoming({ from: OWNER, name: 'The owner', text: 'What are your opening hours?' });
		const selfWrites = {
			...ownerWrites.event,
			id: 'evt_00000000000000000000000000000f01',
			data: { ...ownerWrites.event.data, from: { name: 'Number', number: '5511977770000' } },
		};
		const before = llmCalls();
		const mark = await t.mock.mark();
		const execution = await runEvents(...own.slice(0, 2), ownerWrites.event, selfWrites);
		assert.equal(execution.status, 'success', execution.describe());
		assert.ok(!ran(execution, 'Read the whole message'), 'none of them was read');
		assert.count(await sendsSince(mark), 0, 'nothing sent');
		assert.equal(llmCalls(), before, 'the model was not called');
	});

	await t.step('a quoted answer from a customer (message.replied) is answered like a new message', async () => {
		const phone = nextPhone();
		t.llm.script([{ reply: decision('Thank you, see you soon.', 0.88) }]);
		const first = await incoming({ from: phone, name: 'Eva', text: 'Hello' });
		const quoted = await incoming({ from: phone, name: 'Eva', text: 'Do you open on Sunday?', reply_to: first.messageId });
		assert.equal(quoted.event.type, 'message.replied', 'the mock delivers it as message.replied');
		assert.equal(quoted.event.data.direction, 'inbound', 'inbound');
		const mark = await t.mock.mark();
		const execution = await runEvents(quoted.event);
		assert.equal(execution.status, 'success', execution.describe());
		assert.count(textsSentTo(await sendsSince(mark), phone), 1, 'one answer');
	});

	await t.step('ignore_phones: those numbers are never read, answered or paused, in any written format; others still are', async () => {
		await configure({ ignore_phones: '+55 11 97777-0050, 5511977770051' });
		try {
			const before = llmCalls();
			const first = await incoming({ from: '+5511977770050', name: 'Supplier', text: 'Your order is ready' });
			const second = await incoming({ from: '+5511977770051', name: 'Aunt', text: 'Are you coming on Sunday?' });
			const typedToSupplier = {
				...first.event,
				id: 'evt_00000000000000000000000000000b01',
				type: 'message.sent',
				data: { ...first.event.data, direction: 'outbound', origin: 'native', from: { name: 'Turbo Notify', alias: 'main', number: '5511977770000' }, to: { name: 'Supplier', number: '5511977770050' } },
			};
			const mark = await t.mock.mark();
			const execution = await runEvents(first.event, second.event, typedToSupplier);
			assert.equal(execution.status, 'success', execution.describe());
			assert.ok(!ran(execution, 'Read the whole message'), 'none of them was read');
			assert.ok(!ran(execution, 'Pause the assistant while the owner writes'), 'writing to an ignored number does not pause anything');
			assert.count(await sendsSince(mark), 0, 'nothing sent');
			assert.equal(llmCalls(), before, 'the model was not called');
			assert.count(await t.tables.rows('contacts_state', { where: { phone: '+5511977770050' } }), 0, 'no state row for an ignored number');
			assert.count(await t.tables.rows('contacts_state', { where: { phone: '+5511977770051' } }), 0, 'neither for the other one');

			// A customer who is not on the list is still answered.
			const phone = nextPhone();
			t.llm.script([{ reply: decision('We accept card, cash and Pix.', 0.91) }]);
			const { event } = await incoming({ from: phone, name: 'Regular', text: 'How can I pay?' });
			const markOther = await t.mock.mark();
			const executionOther = await runEvents(event);
			assert.equal(executionOther.status, 'success', executionOther.describe());
			assert.count(textsSentTo(await sendsSince(markOther), phone), 1, 'a number that is not listed is answered');
		} finally {
			await configure({ ignore_phones: '' });
		}
		const { event } = await incoming({ from: '+5511977770050', name: 'Supplier', text: 'Your order is ready, second message' });
		t.llm.script([{ reply: decision('Thank you.', 0.9) }]);
		const mark = await t.mock.mark();
		const execution = await runEvents(event);
		assert.equal(execution.status, 'success', execution.describe());
		assert.count(textsSentTo(await sendsSince(mark), '+5511977770050'), 1, 'with the list emptied again the number is answered like any other');
	});

	// ---------------------------------------------------------------- 3. non-text
	await t.step('a non-text message gets the fixed reply, no model call, and the cap counts it', async () => {
		const phone = nextPhone();
		const before = llmCalls();
		const { event } = await incoming({ from: phone, name: 'Fabio', image: { caption: 'my receipt' } });
		assert.equal(event.data.content_type, 'image', 'the event says image');
		const mark = await t.mock.mark();
		const execution = await runEvents(event);
		assert.equal(execution.status, 'success', execution.describe());
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'one reply');
		assert.equal(sends[0].content, { text: 'I can only read text messages. Please write your question in text.' }, 'fixed text');
		assert.equal(llmCalls(), before, 'the model was not called');
		assert.ok(!ran(execution, 'Show typing'), 'no typing for a fixed reply');
		assert.equal((await stateOf(phone)).ai_answers, 1, 'it counted as an automatic reply');

		const audio = await incoming({ from: phone, name: 'Fabio', audio: { transcript: 'what time do you open', language: 'en' } });
		assert.equal(audio.event.data.content_type, 'audio', 'audio is non-text too');
		const markAudio = await t.mock.mark();
		const executionAudio = await runEvents(audio.event);
		assert.equal(executionAudio.status, 'success', executionAudio.describe());
		assert.equal(textsSentTo(await sendsSince(markAudio), phone).length, 1, 'audio gets the same fixed reply (the template reads text only)');
	});

	// ---------------------------------------------------------------- 4. duplicates
	await t.step('duplicate events: the same event twice in one batch and again in a later run is answered once', async () => {
		const phone = nextPhone();
		t.llm.script([{ reply: decision('We accept card, cash and Pix.', 0.91) }]);
		const { event } = await incoming({ from: phone, name: 'Gabi', text: 'How can I pay?' });
		const before = llmCalls();
		const mark = await t.mock.mark();
		const execution = await runEvents(event, event);
		assert.equal(execution.status, 'success', execution.describe());
		assert.equal(textsSentTo(await sendsSince(mark), phone).length, 1, 'one answer for two copies in one batch');
		assert.equal(llmCalls() - before, 1, 'one model call');
		const again = await runEvents(event);
		assert.equal(again.status, 'success', again.describe());
		assert.equal(textsSentTo(await sendsSince(mark), phone).length, 1, 'still one answer after a second run');
		assert.equal(llmCalls() - before, 1, 'still one model call');
		assert.equal((await stateOf(phone)).ai_answers, 1, 'counted once');
	});

	// ---------------------------------------------------------------- 5. STOP and START
	await t.step('STOP, START: confirmation once, silence while opted out, accents and punctuation, back again', async () => {
		const phone = nextPhone();
		t.llm.script([{ reply: decision('We accept card, cash and Pix.', 0.91) }]);
		const before = llmCalls();
		const stop = await incoming({ from: phone, name: 'Hana', text: 'PARAR!' });
		let mark = await t.mock.mark();
		let execution = await runEvents(stop.event);
		assert.equal(execution.status, 'success', execution.describe());
		let sends = await sendsSince(mark);
		assert.count(sends, 1, 'one confirmation');
		assert.match(sends[0].content.text, /will not get more automatic messages/, 'opt-out confirmation text');
		assert.equal((await stateOf(phone)).opted_out, true, 'opted_out saved');

		const stopAgain = await incoming({ from: phone, name: 'Hana', text: 'stop' });
		mark = await t.mock.mark();
		execution = await runEvents(stopAgain.event);
		assert.count(await sendsSince(mark), 0, 'a second STOP gets no second confirmation');

		const hello = await incoming({ from: phone, name: 'Hana', text: 'How can I pay?' });
		mark = await t.mock.mark();
		execution = await runEvents(hello.event);
		assert.equal(execution.status, 'success', execution.describe());
		assert.count(await sendsSince(mark), 0, 'never messaged again while opted out');
		assert.equal(llmCalls(), before, 'and the model is not called');
		assert.ok(!ran(execution, 'Show typing'), 'no typing either');

		const start = await incoming({ from: phone, name: 'Hana', text: 'Start' });
		mark = await t.mock.mark();
		execution = await runEvents(start.event);
		sends = await sendsSince(mark);
		assert.count(sends, 1, 'one welcome back');
		assert.match(sends[0].content.text, /Welcome back/, 'opt-in text');
		assert.equal((await stateOf(phone)).opted_out, false, 'opted_out cleared');

		const pay = await incoming({ from: phone, name: 'Hana', text: 'How can I pay?' });
		mark = await t.mock.mark();
		execution = await runEvents(pay.event);
		assert.equal((await sendsSince(mark)).length, 1, 'answered again after START');
		assert.equal(llmCalls() - before, 1, 'the model answered once');
	});

	await t.step('STOP and a question in the same batch: the question after STOP is not answered', async () => {
		const phone = nextPhone();
		const before = llmCalls();
		const stop = await incoming({ from: phone, name: 'Ivo', text: 'sair' });
		const question = await incoming({ from: phone, name: 'Ivo', text: 'How can I pay?' });
		const mark = await t.mock.mark();
		const execution = await runEvents(stop.event, question.event);
		assert.equal(execution.status, 'success', execution.describe());
		const sent = textsSentTo(await sendsSince(mark), phone);
		assert.count(sent, 1, 'only the confirmation went out');
		assert.match(sent[0], /will not get more automatic messages/, 'the confirmation');
		assert.equal(llmCalls(), before, 'the model was not called');
	});

	// ---------------------------------------------------------------- 6. a person is handling the chat
	await t.step('human_until in the future keeps the assistant silent; in the past it answers again', async () => {
		const phone = nextPhone();
		await t.tables.insert('contacts_state', [{ phone, opted_out: false, human_until: new Date(Date.now() + 3600_000).toISOString(), ai_answers: 0 }]);
		t.llm.script([{ reply: decision('We accept card, cash and Pix.', 0.91) }]);
		const before = llmCalls();
		const quiet = await incoming({ from: phone, name: 'Jo', text: 'How can I pay?' });
		let mark = await t.mock.mark();
		let execution = await runEvents(quiet.event);
		assert.equal(execution.status, 'success', execution.describe());
		assert.count(await sendsSince(mark), 0, 'silent while a person is handling the chat');
		assert.equal(llmCalls(), before, 'the model is not called');
		assert.ok(!ran(execution, 'Show typing'), 'no typing');

		await t.tables.update('contacts_state', { phone }, { human_until: new Date(Date.now() - 60_000).toISOString() });
		const later = await incoming({ from: phone, name: 'Jo', text: 'How can I pay, please?' });
		mark = await t.mock.mark();
		execution = await runEvents(later.event);
		assert.equal(execution.status, 'success', execution.describe());
		assert.equal(textsSentTo(await sendsSince(mark), phone).length, 1, 'answers again once human_until has passed');
	});

	await t.step('the owner writes in the chat from the phone: the assistant pauses, an opt-out is kept, STOP still works', async () => {
		const phone = nextPhone();
		await t.tables.insert('contacts_state', [{ phone, opted_out: true, ai_answers: 3 }]);
		const digits = phone.replace(/\D/g, '');
		const typedByOwner = {
			id: 'evt_00000000000000000000000000000a01',
			type: 'message.sent',
			organization_id: 'org_00000000000000000000000000000001',
			number_alias: 'main',
			number_id: (await t.mock.events())[0].number_id,
			created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
			data: {
				id: 'msg_00000000000000000000000000000a01',
				from: { name: 'Turbo Notify', alias: 'main', number: '5511977770000' },
				to: { name: 'Customer', number: digits },
				preview: 'Hi, I am looking at your order now',
				content_type: 'text',
				direction: 'outbound',
				channel: 'whatsapp',
				origin: 'native',
				at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
			},
		};
		const mark = await t.mock.mark();
		const execution = await runEvents(typedByOwner);
		assert.equal(execution.status, 'success', execution.describe());
		assert.count(await sendsSince(mark), 0, 'writing to a customer sends nothing');
		const row = await stateOf(phone);
		const hours = (new Date(row.human_until).getTime() - Date.now()) / 3600_000;
		assert.ok(hours > 3.9 && hours <= 4.01, `human_until is about 4 hours ahead (got ${hours.toFixed(2)})`);
		assert.equal(row.opted_out, true, 'the opt-out was not lost when the pause was saved');
		assert.equal(row.ai_answers, 3, 'the counters were not lost either');

		// A customer who is not opted out: the pause silences the assistant.
		const other = nextPhone();
		const otherEvent = { ...typedByOwner, id: 'evt_00000000000000000000000000000a02', data: { ...typedByOwner.data, to: { name: 'Other', number: other.replace(/\D/g, '') } } };
		await runEvents(otherEvent);
		t.llm.script([{ reply: decision('We accept card, cash and Pix.', 0.91) }]);
		const quiet = await incoming({ from: other, name: 'Other', text: 'How can I pay?' });
		const markQuiet = await t.mock.mark();
		await runEvents(quiet.event);
		assert.count(await sendsSince(markQuiet), 0, 'silent after the owner wrote in the chat');

		// STOP is honored even while a person is handling the chat.
		const stop = await incoming({ from: other, name: 'Other', text: 'STOP' });
		const markStop = await t.mock.mark();
		await runEvents(stop.event);
		assert.equal(textsSentTo(await sendsSince(markStop), other).length, 1, 'STOP is confirmed during a takeover');
		assert.equal((await stateOf(other)).opted_out, true, 'and saved');
	});

	// ---------------------------------------------------------------- 7. handoffs
	const expectHandoff = async ({ phone, name, text, reasonPattern, modelLeak, expectModelCalls }) => {
		const before = llmCalls();
		const { event } = await incoming({ from: phone, name, text });
		const mark = await t.mock.mark();
		const execution = await runEvents(event);
		assert.equal(execution.status, 'success', execution.describe());
		if (expectModelCalls !== undefined) assert.equal(llmCalls() - before, expectModelCalls, 'model calls');
		const sends = await sendsSince(mark);
		const toCustomer = textsSentTo(sends, phone);
		assert.equal(toCustomer, [HANDOFF_REPLY], 'the customer gets only the fixed handover message');
		if (modelLeak) for (const s of sends) assert.ok(!JSON.stringify(s.content).includes(modelLeak), `AI text "${modelLeak}" never reaches anyone`);
		const toOwner = textsSentTo(sends, OWNER);
		assert.count(toOwner, 1, 'one alert to the owner');
		assert.match(toOwner[0], /^Handover needed: /, 'alert starts with the reason');
		assert.match(toOwner[0], reasonPattern, 'alert names the reason');
		assert.ok(toOwner[0].includes(`Customer: ${name} ${phone}`), 'alert names the customer and phone');
		assert.ok(toOwner[0].includes(`Last message: "${text}"`), 'alert quotes the last message');
		assert.match(toOwner[0], /stays silent in this chat until \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, 'alert says until when');
		const card = sends.find((s) => s.number === OWNER && s.content?.text === undefined);
		assert.ok(card, 'a contact card went to the owner');
		const cardText = JSON.stringify(card.content);
		assert.ok(cardText.includes(name), 'the card carries the customer name');
		assert.ok(cardText.includes(phone), 'the card carries the customer phone');
		assert.count(sends, 3, 'reply + alert + card, nothing else');
		const row = await stateOf(phone);
		const hours = (new Date(row.human_until).getTime() - Date.now()) / 3600_000;
		assert.ok(hours > 3.9 && hours <= 4.01, `human_until is about 4 hours ahead (got ${hours.toFixed(2)})`);
		// The assistant is silent from now on.
		const follow = await incoming({ from: phone, name, text: 'Hello? Anyone there?' });
		const markFollow = await t.mock.mark();
		await runEvents(follow.event);
		assert.count(await sendsSince(markFollow), 0, 'silent after the handover');
		return { sends, card };
	};

	let lastCard;
	await t.step('low confidence from the model becomes a handoff (and the AI text is never sent)', async () => {
		t.llm.script([{ reply: decision('It costs about 40 euros.', 0.4) }]);
		const { card } = await expectHandoff({
			phone: nextPhone(),
			name: 'Kai Souza',
			text: 'How much is a wedding cake for 80 people?',
			reasonPattern: /low confidence \(0\.40 is below 0\.7\)/,
			modelLeak: '40 euros',
			expectModelCalls: 1,
		});
		lastCard = card;
	});

	await t.step('the model asking for a person (handoff true) is a handoff even with a high confidence', async () => {
		t.llm.script([{ reply: decision('Let me get someone.', 0.95, true, 'the customer wants a custom quote') }]);
		await expectHandoff({
			phone: nextPhone(),
			name: 'Lia Prado',
			text: 'Can you make a vegan cake with my own recipe?',
			reasonPattern: /the assistant asked for a person: the customer wants a custom quote/,
			modelLeak: 'Let me get someone',
			expectModelCalls: 1,
		});
	});

	await t.step('a trigger word hands over BEFORE the model is called (also with accents and capitals)', async () => {
		t.llm.script([{ reply: decision('We use free-range eggs.', 0.9) }]);
		await expectHandoff({
			phone: nextPhone(),
			name: 'Mia Rocha',
			text: 'I want to talk to a human please',
			reasonPattern: /the customer wrote "a human"/,
			expectModelCalls: 0,
		});
		await expectHandoff({
			phone: nextPhone(),
			name: 'Noa Reis',
			text: 'Quero fazer uma RECLAMAÇÃO sobre o pedido',
			reasonPattern: /the customer wrote "reclamacao"/,
			expectModelCalls: 0,
		});
	});

	await t.step('a word that only contains a trigger word (humanely) is not a trigger', async () => {
		const phone = nextPhone();
		t.llm.script([{ reply: decision('Our eggs come from free-range farms.', 0.9) }]);
		const before = llmCalls();
		const { event } = await incoming({ from: phone, name: 'Ola', text: 'Are your eggs humanely sourced?' });
		const mark = await t.mock.mark();
		const execution = await runEvents(event);
		assert.equal(execution.status, 'success', execution.describe());
		assert.equal(llmCalls() - before, 1, 'the model answered');
		assert.equal(textsSentTo(await sendsSince(mark), phone).length, 1, 'a normal answer');
	});

	await t.step('default handoff phrases: "speak to a person" hands over (also in Portuguese and with extra spaces); "per person", "travel agent" and "a person pick it up" do not', async () => {
		const before = llmCalls();
		t.llm.script([{ reply: decision('Our eggs come from free-range farms.', 0.9) }]);
		for (const text of ['How much per person?', 'Can a travel agent book a table for us?', 'Can a person pick it up for me?']) {
			const phone = nextPhone();
			const { event } = await incoming({ from: phone, name: 'Careful Customer', text });
			const mark = await t.mock.mark();
			const execution = await runEvents(event);
			assert.equal(execution.status, 'success', execution.describe());
			const sends = await sendsSince(mark);
			assert.equal(textsSentTo(sends, phone), ['Our eggs come from free-range farms.'], `"${text}" is answered by the model, not handed over`);
			assert.count(textsSentTo(sends, OWNER), 0, `no owner alert for "${text}"`);
		}
		assert.equal(llmCalls() - before, 3, 'the model answered the three questions');
		await expectHandoff({ phone: nextPhone(), name: 'Sam Ferraz', text: 'I want to speak to a person', reasonPattern: /the customer wrote "speak to a person"/, expectModelCalls: 0 });
		await expectHandoff({ phone: nextPhone(), name: 'Tati Gomes', text: 'Oi, quero  FALAR   com uma pessoa, por favor', reasonPattern: /the customer wrote "falar com uma pessoa"/, expectModelCalls: 0 });
		await expectHandoff({ phone: nextPhone(), name: 'Ugo Lima', text: 'Can I talk to someone?', reasonPattern: /the customer wrote "talk to someone"/, expectModelCalls: 0 });
	});

	await t.step('audio_to_person on: a voice note is handed to a person (no fixed "text only" reply, no model call); off again, it gets the fixed reply', async () => {
		await configure({ audio_to_person: true });
		try {
			const phone = nextPhone();
			const before = llmCalls();
			const audio = await incoming({ from: phone, name: 'Vera Luz', audio: { transcript: 'what time do you open', language: 'en' } });
			assert.equal(audio.event.data.content_type, 'audio', 'the event says audio');
			const mark = await t.mock.mark();
			const execution = await runEvents(audio.event);
			assert.equal(execution.status, 'success', execution.describe());
			assert.equal(llmCalls(), before, 'the model was not called');
			const sends = await sendsSince(mark);
			assert.equal(textsSentTo(sends, phone), [HANDOFF_REPLY], 'the customer gets the handover text, not "I can only read text messages"');
			const alert = textsSentTo(sends, OWNER);
			assert.count(alert, 1, 'one alert');
			assert.match(alert[0], /^Handover needed: the customer sent a voice note/, 'the alert says it was a voice note');
			assert.ok(sends.find((x) => x.number === OWNER && x.content?.text === undefined), 'and a contact card went to the owner');
			assert.ok(new Date((await stateOf(phone)).human_until).getTime() > Date.now(), 'the chat is held for a person');
			// An image is still a fixed reply: the setting is about voice notes only.
			const other = nextPhone();
			const image = await incoming({ from: other, name: 'Wes Ito', image: { caption: 'a receipt' } });
			const markImage = await t.mock.mark();
			await runEvents(image.event);
			assert.equal(textsSentTo(await sendsSince(markImage), other), ['I can only read text messages. Please write your question in text.'], 'an image still gets the fixed reply');
		} finally {
			await configure({ audio_to_person: false });
		}
		const phone = nextPhone();
		const audio = await incoming({ from: phone, name: 'Xena Paz', audio: { transcript: 'hello', language: 'en' } });
		const mark = await t.mock.mark();
		await runEvents(audio.event);
		assert.equal(textsSentTo(await sendsSince(mark), phone), ['I can only read text messages. Please write your question in text.'], 'off again: the fixed reply');
	});

	await t.step('an unreadable decision (prose, not JSON) becomes a handoff', async () => {
		t.llm.script([{ reply: 'Sure! The price is 12 euros, I promise.' }]);
		await expectHandoff({
			phone: nextPhone(),
			name: 'Pam Dias',
			text: 'What is the price of the carrot cake?',
			reasonPattern: /did not return a readable decision/,
			modelLeak: '12 euros',
			expectModelCalls: 1,
		});
	});

	await t.step('an agent that fails (the model service answers an error) becomes a handoff, not silence', async () => {
		t.llm.script([
			{
				reply: () => {
					throw new Error('the model service is down');
				},
			},
		]);
		await expectHandoff({
			phone: nextPhone(),
			name: 'Quim Alves',
			text: 'Do you have gluten free bread?',
			reasonPattern: /the assistant failed to run/,
		});
	});

	await t.step('a message the API cannot read becomes a handoff instead of a guess', async () => {
		const phone = nextPhone();
		const { event, messageId } = await incoming({ from: phone, name: 'Rui Faria', text: 'Is the shop open now?' });
		await t.mock.fault({ method: 'GET', path: `/messages/${messageId}$`, status: 500, body: { error: 'internal_error', message: 'boom' }, times: 1 });
		const before = llmCalls();
		const mark = await t.mock.mark();
		const execution = await runEvents(event);
		assert.equal(execution.status, 'success', execution.describe());
		assert.equal(llmCalls(), before, 'no model call without a text');
		const sends = await sendsSince(mark);
		assert.equal(textsSentTo(sends, phone), [HANDOFF_REPLY], 'fixed message to the customer');
		const alert = textsSentTo(sends, OWNER)[0];
		assert.match(alert, /the message text could not be read/, 'alert says why');
	});

	// ---------------------------------------------------------------- 8. hourly cap
	await t.step('hourly cap: six automatic answers, the seventh message in the same hour is a handoff', async () => {
		const phone = nextPhone();
		t.llm.script([{ reply: decision('We accept card, cash and Pix.', 0.91) }]);
		const events = [];
		for (let i = 1; i <= 7; i += 1) events.push((await incoming({ from: phone, name: 'Sol Nunes', text: `Question number ${i} about paying` })).event);
		const before = llmCalls();
		const mark = await t.mock.mark();
		const execution = await runEvents(...events);
		assert.equal(execution.status, 'success', execution.describe());
		assert.equal(llmCalls() - before, 6, 'the model answered six times, not seven');
		const sends = await sendsSince(mark);
		const toCustomer = textsSentTo(sends, phone);
		assert.count(toCustomer, 7, 'six answers and one handover message');
		assert.equal(toCustomer.slice(0, 6), Array(6).fill('We accept card, cash and Pix.'), 'six answers');
		assert.equal(toCustomer[6], HANDOFF_REPLY, 'then the fixed handover message');
		const alert = textsSentTo(sends, OWNER);
		assert.count(alert, 1, 'one alert');
		assert.match(alert[0], /more than 6 automatic replies to this phone in one hour/, 'alert names the cap');
		assert.ok(new Date((await stateOf(phone)).human_until).getTime() > Date.now(), 'the chat is held for a person');
	});

	// ---------------------------------------------------------------- 9. typing on a plan without it
	await t.step('typing fails on a Free-plan-like fault and the flow carries on', async () => {
		await t.mock.config({ plan: 'free' });
		try {
			const phone = nextPhone();
			t.llm.script([{ reply: decision('We accept card, cash and Pix.', 0.91) }]);
			const { event } = await incoming({ from: phone, name: 'Tia Melo', text: 'How can I pay?' });
			const mark = await t.mock.mark();
			const execution = await runEvents(event);
			assert.equal(execution.status, 'success', execution.describe());
			const typing = await calls(mark, /\/typing-indicator$/);
			assert.count(typing, 1, 'typing was tried');
			assert.equal(typing[0].status, 402, 'and refused (feature_not_available)');
			assert.equal(typing[0].response.error, 'feature_not_available', 'with the documented code');
			assert.equal(textsSentTo(await sendsSince(mark), phone).length, 1, 'the answer still went out');
			assert.ok(ran(execution, 'Send the reply'), 'the reply node ran');
		} finally {
			await t.mock.config({ plan: 'business' });
		}
	});

	// ---------------------------------------------------------------- 10. a failed send is never silent
	const errorOf = (execution) => execution.error?.message ?? '';
	await t.step('the owner alert fails: the other events are still handled and the run ends in an error naming the customer', async () => {
		const phone = nextPhone();
		const good = nextPhone();
		t.llm.script([{ reply: decision('We accept card, cash and Pix.', 0.91) }]);
		const urgent = await incoming({ from: phone, name: 'Uma Reis', text: 'This is urgent, call me' });
		const fine = await incoming({ from: good, name: 'Val Costa', text: 'How can I pay?' });
		await t.mock.fault({ method: 'POST', path: '/v1/numbers/[^/]+/messages$', status: 500, body: { error: 'internal_error', message: 'boom' }, times: 1 });
		const mark = await t.mock.mark();
		const execution = await runEvents(urgent.event, fine.event);
		assert.equal(execution.status, 'error', 'the execution ends in an error so you notice it');
		assert.match(errorOf(execution), /The owner could not be alerted about: /, 'the error says what failed');
		assert.ok(errorOf(execution).includes(`${phone} (Uma Reis)`), 'and names the customer to contact by hand');
		assert.ok(!errorOf(execution).includes('No answer reached'), 'the customer WAS told, so this is not a customer failure');
		assert.ok(!errorOf(execution).includes(good), 'the customer who was answered is not named');
		const sends = await sendsSince(mark);
		assert.equal(textsSentTo(sends, phone), [HANDOFF_REPLY], 'the customer was told');
		assert.equal(textsSentTo(sends, good), ['We accept card, cash and Pix.'], 'the next event was still answered');
		assert.ok((await stateOf(phone)).human_until, 'the chat is held');
		assert.ok(ran(execution, 'Fail the run if a reply or an alert failed'), 'the run was failed by the end-of-run check, after the loop');
	});

	await t.step('a customer gets no answer because the contact quota is used up: the run fails and names them, the others are answered first', async () => {
		const known = nextPhone();
		const urgentOne = nextPhone();
		t.llm.script([{ reply: decision('We accept card, cash and Pix.', 0.91) }]);
		await t.mock.config({ contactQuota: 1000 });
		const warm = await incoming({ from: known, name: 'Known Customer', text: 'How can I pay?' });
		const warmUrgent = await incoming({ from: urgentOne, name: 'Urgent Customer', text: 'How can I pay?' });
		assert.equal((await runEvents(warm.event, warmUrgent.event)).status, 'success', 'two customers answered while quota is left');
		const newcomer = nextPhone();
		const again = await incoming({ from: known, name: 'Known Customer', text: 'And can I pay by card?' });
		const refused = await incoming({ from: newcomer, name: 'New Customer', text: 'How can I pay?' });
		const urgent = await incoming({ from: urgentOne, name: 'Urgent Customer', text: 'I want a human' });
		t.llm.script([{ reply: decision('Yes, card is fine.', 0.9) }]);
		await t.mock.config({ contactQuota: 0 }); // every contact already reached still works, a new one is refused
		try {
			const mark = await t.mock.mark();
			const execution = await runEvents(refused.event, again.event, urgent.event);
			assert.equal(execution.status, 'error', 'the run ends in an error');
			const message = errorOf(execution);
			assert.match(message, /^No answer reached these customers, write to them by hand: /, 'the message leads with who got no answer');
			assert.ok(message.includes(`${newcomer} (New Customer)`), 'it names the customer');
			assert.match(message, /contact_quota_exceeded|contact quota|Distinct-contacts quota/i, 'and says why (the contact quota)');
			assert.ok(!message.includes(known) && !message.includes(urgentOne), 'the other customers are not blamed');
			assert.ok(!message.includes('The owner could not be alerted'), 'the owner was alerted for the handover');
			const sends = await sendsSince(mark);
			assert.equal(textsSentTo(sends, known), ['Yes, card is fine.'], `the customer after the failing one was still answered (error: ${message}; sends: ${JSON.stringify(sends.map((x) => [x.number, x.content?.text]))})`);
			assert.equal(textsSentTo(sends, newcomer), [], 'the refused customer got nothing');
		} finally {
			await t.mock.config({ contactQuota: 1000 });
		}
	});

	await t.step('the "a person will answer" message fails, the alert and card still go out, and the run names the customer', async () => {
		const phone = nextPhone();
		const { event, messageId } = await incoming({ from: phone, name: 'Wanda Ruiz', text: 'I need a refund today' });
		await t.mock.fault({ method: 'POST', path: `/messages/${messageId}/reply$`, status: 500, body: { error: 'internal_error', message: 'boom' }, times: 1 });
		const mark = await t.mock.mark();
		const execution = await runEvents(event);
		assert.equal(execution.status, 'error', 'the run ends in an error');
		assert.match(errorOf(execution), /^No answer reached these customers, write to them by hand: .*Wanda Ruiz/, 'it names the customer');
		assert.ok(!errorOf(execution).includes('The owner could not be alerted'), 'the owner was alerted');
		const sends = await sendsSince(mark);
		assert.count(textsSentTo(sends, OWNER), 1, 'the owner alert still went out');
		assert.ok(sends.find((x) => x.number === OWNER && x.content?.text === undefined), 'and the contact card');
		assert.ok((await stateOf(phone)).human_until, 'the chat is held for a person');
	});

	await t.step('a reply and an owner alert fail in the same run: both are listed, each with its customer', async () => {
		const a = nextPhone();
		const b = nextPhone();
		const first = await incoming({ from: a, name: 'Ana Prado', text: 'I need a refund today' });
		const second = await incoming({ from: b, name: 'Bento Dias', text: 'I want to talk to an attendant' });
		await t.mock.fault({ method: 'POST', path: `/messages/${first.messageId}/reply$`, status: 500, body: { error: 'internal_error', message: 'boom' }, times: 1 });
		await t.mock.fault({ method: 'POST', path: '/v1/numbers/[^/]+/messages$', status: 500, body: { error: 'internal_error', message: 'boom' }, times: 1 });
		const execution = await runEvents(first.event, second.event);
		assert.equal(execution.status, 'error', 'the run ends in an error');
		const message = errorOf(execution);
		assert.match(message, /No answer reached these customers, write to them by hand: [^|]*Ana Prado/, 'the unanswered customer is named');
		assert.match(message, /The owner could not be alerted about: .*/, 'the failed owner alert is listed');
		assert.ok(message.indexOf(a) < message.indexOf('The owner could not be alerted'), 'the customer list comes first');
	});

	// ---------------------------------------------------------------- 11. the real poller
	await t.step('activated: the real poller delivers received and replied events and ignores the echo of the replies', async () => {
		t.llm.script([{ reply: decision('We accept card, cash and Pix.', 0.91) }]);
		const phone = nextPhone();
		await t.mock.injectMessage({ from: nextPhone(), name: 'Before', text: 'written before activation' });
		await t.sleep(3000); // event times have a precision of one second: keep the history clearly before the activation
		await t.activate();
		const since = await t.executionMark();
		const mark = await t.mock.mark();
		const first = await t.mock.injectMessage({ from: phone, name: 'Wil Pinto', text: 'How can I pay?' });

		/**
		 * Waits for a successful tick that satisfies `predicate`. A tick that fails because the machine is slow ("did not answer
		 * in time" at the poll) is counted and skipped: the next tick reads the last two minutes again, which is what a real
		 * installation relies on too.
		 */
		const tick = async (after, predicate, label) => {
			const deadline = Date.now() + 10 * 60_000;
			let want = 1;
			let failedTicks = 0;
			while (Date.now() < deadline) {
				const found = await t.waitExecutions({ since: after, count: want, timeoutMs: 240_000 });
				failedTicks = found.filter((e) => e.status !== 'success').length;
				const hit = found.find((e) => e.status === 'success' && predicate(e));
				if (hit) return { hit, failedTicks };
				want = found.length + 1;
			}
			assert.fail(`no successful tick: ${label}`);
		};

		const { hit: one, failedTicks } = await tick(since, (e) => e.items(TRIGGER).some((i) => i.data?.id === first.message_id), 'the new message');
		if (failedTicks) t.log(`${failedTicks} poll tick(s) failed before this one (machine under load); the next tick recovered`);
		assert.equal(one.items(TRIGGER).map((i) => i.data.preview), ['How can I pay?'], 'one item: the message written before activation was not handed over');
		assert.equal(textsSentTo(await sendsSince(mark), phone).length, 1, 'answered once');

		// The reply produced message.replied / message.sent events with origin tn. A later tick delivers them and the workflow must stay silent.
		const markEcho = await t.mock.mark();
		const { hit: echo } = await tick(Number(one.id), (e) => e.items(TRIGGER).length >= 1, 'the echo of the replies');
		const types = echo.items(TRIGGER).map((e) => `${e.type}/${e.data.origin}`);
		assert.ok(types.every((x) => x.endsWith('/tn')), `only own events: ${types.join(', ')}`);
		assert.ok(!ran(echo, 'Read the whole message'), 'none of them was read');
		assert.count(await sendsSince(markEcho), 0, 'nothing sent in answer to its own messages');
		await t.deactivate();
	});

	// ---------------------------------------------------------------- 12. inactive for a while, then active again
	await t.step('inactive, then active again: a message that arrived meanwhile is handed over by the next poll, not lost', async () => {
		const phone = nextPhone();
		t.llm.script([{ reply: decision('We accept card, cash and Pix.', 0.91) }]);
		const since = await t.executionMark();
		const mark = await t.mock.mark();
		await t.mock.injectMessage({ from: phone, name: 'Late Customer', text: 'How can I pay?' }); // arrives while the workflow is inactive
		await t.sleep(3000);
		await t.activate();
		const deadline = Date.now() + 8 * 60_000;
		let want = 1;
		let answered = false;
		while (Date.now() < deadline && !answered) {
			const found = await t.waitExecutions({ since, count: want, timeoutMs: 240_000 });
			answered = found.some((e) => e.status === 'success' && e.items(TRIGGER).some((i) => i.data?.preview === 'How can I pay?'));
			want = found.length + 1;
		}
		assert.ok(answered, 'a poll handed over the message that arrived while the workflow was inactive');
		assert.count(textsSentTo(await sendsSince(mark), phone), 1, 'and it was answered once');
		await t.deactivate();
	});
}
