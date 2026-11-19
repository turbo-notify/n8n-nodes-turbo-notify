/**
 * Template T6: a post-purchase NPS survey on WhatsApp.
 *
 * The workflow is imported exactly as exported. The Header Auth credential is the only thing created before the
 * import (the harness creates the Turbo Notify one). The Data Table is created BY THE WORKFLOW, by running its own
 * "Run once" branch, and the Data Table nodes find it by name.
 *
 * The owner phone and the business name in the exported settings are samples on purpose, so the first steps prove
 * that the workflow refuses to survey anybody as exported. Then the values a person must type are typed the way a
 * person would, through the stored workflow: the owner phone, the business name and the sending hours (the exported
 * 09:00 to 20:00 would make the run depend on the clock). A few steps change one more setting and put it back.
 * Nothing else is patched. The clock is moved by writing older timestamps into the table (a person could do the
 * same); delay_hours, cooldown_days and close_after_days stay at their exported values.
 *
 * How each entry point is reached:
 *  - the order branches run from the Webhook node with a pinned request (the harness cannot start a webhook by
 *    hand); the Header Auth behaviour (403) and the real HTTP request are proven in the live block at the end;
 *  - the reply branches run from the Polling Trigger with events taken from the mock's own event feed (the mock
 *    turns an incoming message into the same event the API serves);
 *  - the 30 minute timer and the weekly timer run by hand. The last block activates the workflow: real HTTP
 *    requests, the real poller (every 5 minutes), the real 30 minute timer, and a reply written while the workflow was switched off.
 *
 * Run it with the time zone of the template: --tz America/Sao_Paulo
 */
export const timeoutMs = 100 * 60_000;
export const credentials = [{ type: 'httpHeaderAuth', name: 'Order access (Header Auth)', data: { name: 'X-Order-Token', value: 'harness-order-token-0001' } }];
export const mock = { delays: '300,600,1200', quota: 5000, contactQuota: 5000, plan: 'business' };

const HOOK = 'Receive an order';
const POLL = 'Poll WhatsApp replies';
const TIMER = 'Every 30 minutes: ask the surveys that are due';
const WEEK = 'Every week: send the NPS report';
const TOKEN = 'harness-order-token-0001';
const TABLE = 'surveys';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OWNER = '+5511977770099';
const BUSINESS = 'Green House Bakery';
const phone = (n) => `+55119777700${String(n).padStart(2, '0')}`;
const NAME = { 1: 'Ana Souza', 2: 'Bruno Costa', 3: 'Carla Dias', 4: 'Davi Lima', 5: 'Eva Rocha', 6: 'Fabio Alves' };

const QUESTION = (name, order) => `Hi ${name}, thanks for your order ${order} at ${BUSINESS}. From 0 to 10, how likely are you to recommend us to a friend? Reply with a number (you may add one sentence). To stop these questions, reply STOP.`;
const REASK = 'Sorry, I did not catch that. Please reply with a number from 0 to 10, or STOP to stop these questions.';

export default async function scenario(t) {
	const { assert } = t;

	// ---------------------------------------------------------------- helpers
	const orderBody = (id, extra = {}) => ({ order_id: id, customer_name: 'Ana Souza', phone: phone(1), status: 'delivered', ...extra });
	/** Runs the workflow from the Webhook node with this request. */
	const order = (body, headers = {}) => t.run(HOOK, { pin: { [HOOK]: [{ headers, params: {}, query: {}, body }] } });
	const timer = () => t.run(TIMER, { timeoutMs: 240_000 });
	const week = () => t.run(WEEK);
	const rowOf = async (id) => (await t.tables.rows(TABLE, { where: { order_id: id } }))[0];
	const patchRow = (id, patch) => t.tables.update(TABLE, { order_id: id }, patch);
	const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
	const hoursAgo = (hours) => new Date(Date.now() - hours * HOUR).toISOString();
	const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();
	const blank = { customer_name: '', phone: '', status: 'queued', comment: '', asked_at: '', answered_at: '', due_at: '', message_id: '', category: '', created_at: new Date().toISOString(), reasks: 0, note: '', order_url: '', items: '' };
	/** Writes a row straight into the table (the state a few steps need as a starting point). */
	const put = (row) => t.tables.insert(TABLE, { ...blank, created_at: new Date().toISOString(), ...row });
	/** The question was asked and waits for a score. */
	const asking = (id, who, extra = {}) => put({ order_id: id, customer_name: NAME[who] ?? 'Customer', phone: phone(who), status: 'asked', asked_at: minutesAgo(30), due_at: minutesAgo(40), message_id: `msg_seed_${id}`, ...extra });
	const queue = (id, who, extra = {}) => put({ order_id: id, customer_name: NAME[who] ?? 'Customer', phone: phone(who), status: 'queued', due_at: minutesAgo(10), ...extra });
	/** A person writes to the number: the event is taken from the events feed exactly as the API serves it. */
	const incoming = async (from, text, options = {}) => {
		const injected = await t.mock.injectMessage({ from, name: 'Somebody', text, ...options });
		const event = (await t.mock.events()).find((e) => e.id === injected.event_id);
		assert.ok(event, `the mock holds the event ${injected.event_id}`);
		return event;
	};
	const poll = (...events) => t.run(POLL, { pin: { [POLL]: events }, timeoutMs: 240_000 });
	/** Writes a message and lets the workflow read it. */
	const hears = async (from, text, options) => poll(await incoming(from, text, options));
	const sendsSince = async (mark) =>
		(await t.mock.sends({ since: mark })).map((s) => ({
			to: s.to?.number,
			text: s.content?.text ?? s.content?.body,
			button: s.content?.url_button,
			interactive: s.content?.interactive_type,
			card: s.content?.display_name ? { name: s.content.display_name, phones: (s.content.phones ?? []).map((p) => p.number) } : undefined,
			key: s.idempotencyKey,
			id: s.messageId,
		}));
	const distinct = (sends) => [...new Map(sends.map((s) => [s.id, s])).values()];
	const to = (sends, who) => sends.filter((s) => s.to === who);
	const configure = async (values) => {
		const current = await t.n8n.rest('GET', `/rest/workflows/${t.workflow.id}`);
		const nodes = structuredClone(current.nodes);
		const settings = nodes.find((n) => n.name === 'Your settings');
		for (const assignment of settings.parameters.assignments.assignments) if (assignment.name in values) assignment.value = values[assignment.name];
		await t.n8n.rest('PATCH', `/rest/workflows/${t.workflow.id}`, { nodes, versionId: current.versionId });
	};
	const exported = Object.fromEntries(t.workflow.node('Your settings').parameters.assignments.assignments.map((a) => [a.name, a.value]));
	// What a person types before the first real run. The sending hours are typed too: the whole day.
	const real = { owner_phone: OWNER, business_name: BUSINESS, window_start: '00:00', window_end: '23:59' };
	const ok = (execution) => assert.equal(execution.status, 'success', execution.describe());
	const failed = (execution, pattern, message) => {
		assert.equal(execution.status, 'error', message ?? 'the run fails loudly');
		assert.match(execution.error?.message ?? '', pattern, message ?? 'the error says why');
	};
	const local = () => {
		const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
		return Number(parts.find((p) => p.type === 'hour').value) % 24;
	};
	const reset = async () => {
		await t.tables.clear(TABLE);
	};

	// ---------------------------------------------------------------- the exported file
	await t.step('as exported: samples, Header Auth on the webhook, the explanations on the canvas', async () => {
		assert.equal(exported.owner_phone, '+55XXXXXXXXXXX', 'the owner phone is a placeholder');
		assert.equal(exported.business_name, 'Your Business Name', 'the business is a sample');
		assert.equal(exported.review_url, '', 'no review page by default');
		assert.equal(exported.expected_timezone, 'America/Sao_Paulo', 'time zone');
		assert.equal(exported.start_statuses, 'delivered', 'only delivered starts a survey');
		assert.equal([exported.delay_hours, exported.cooldown_days, exported.max_surveys_per_day, exported.max_surveys_per_run, exported.close_after_days, exported.purge_days], [24, 30, 25, 5, 7, 180], 'delay, cooldown, daily cap, cap per run, close after, purge after');
		assert.equal([exported.number_alias, exported.review_for], ['main', 'everyone'], 'the number is main and a review link goes to everyone who answered');
		assert.equal(exported.optout_words, 'stop, parar, sair, pare, cancelar, descadastrar, unsubscribe, para', 'the opt-out words');
		assert.equal(t.workflow.node(POLL).parameters.pollTimes.item[0], { mode: 'everyX', value: 5, unit: 'minutes' }, 'the poll runs every 5 minutes');
		assert.equal(t.workflow.node(TIMER).parameters.rule.interval[0].minutesInterval, 30, 'the timer runs every 30 minutes');
		const senders = t.workflow.nodes.filter((n) => n.type === '@turbo-notify/n8n-nodes-turbo-notify.turboNotify' && n.parameters.operation !== 'get');
		assert.count(senders, 3, 'three send nodes');
		for (const n of senders) assert.equal(n.parameters.number.value, "={{ $('Your settings').first().json.number_alias }}", `${n.name} sends from number_alias`);
		assert.equal(JSON.stringify(t.workflow.nodes).match(/\d{8,}/g), null, 'no run of 8 or more digits anywhere in the file (a scanner would take it for a phone number)');
		assert.equal([exported.window_start, exported.window_end], ['09:00', '20:00'], 'sending hours');
		assert.equal(t.n8n.timezone, 'America/Sao_Paulo', 'this scenario runs n8n in the time zone of the template');
		const hook = t.workflow.node(HOOK);
		assert.equal(hook.parameters.authentication, 'headerAuth', 'the webhook requires Header Auth');
		assert.equal(hook.parameters.httpMethod, 'POST', 'POST only');
		assert.equal(hook.parameters.path, hook.webhookId, 'the address is the random webhook id, not a guessable name');
		assert.match(hook.webhookId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a random id');
		assert.equal(hook.credentials.httpHeaderAuth.name, 'Order access (Header Auth)', 'the placeholder credential name');
		assert.equal(hook.parameters.responseMode, 'onReceived', 'the shop gets its answer at once');
		assert.equal(t.workflow.node(POLL).parameters.events, ['message.received', 'message.replied'], 'a quoted reply arrives as message.replied');
		assert.equal(t.workflow.node('Gather the answers of the WhatsApp sends').parameters.numberInputs, 3, 'three send nodes are gathered');
		const settings = t.workflow.node('Your settings');
		assert.equal(settings.notesInFlow, true, 'the explanations show on the canvas');
		for (const name of Object.keys(exported)) assert.ok(String(settings.notes).split('\n').some((line) => line.startsWith(`${name}:`)), `the note explains ${name}`);
		assert.equal(JSON.stringify(t.workflow.nodes).includes('pinData'), false, 'no pinned data');
		for (const [name, value] of Object.entries(exported)) {
			if (typeof value === 'string') assert.ok(![0x2013, 0x2014].some((code) => value.includes(String.fromCharCode(code))), `${name} has no em or en dash`);
		}
		assert.match(exported.msg_question, /reply STOP/, 'the question tells how to stop');
	});

	// ---------------------------------------------------------------- the setup branch
	await t.step('the "Run once" branch creates the table and is safe to run twice', async () => {
		ok(await t.run('Run once: create the table'));
		assert.count(await t.tables.rows(TABLE), 0, 'the table exists and is empty');
		ok(await t.run('Run once: create the table'));
		assert.count(await t.tables.rows(TABLE), 0, 'running it again changes nothing');
		await t.tables.insert(TABLE, { ...blank, order_id: 'kept', status: 'closed' });
		ok(await t.run('Run once: create the table'));
		assert.count(await t.tables.rows(TABLE), 1, 'running it again keeps the rows');
		await reset();
	});

	// ---------------------------------------------------------------- the guard
	await t.step('as exported the workflow refuses to survey anybody: every entry point, nothing read, sent or stored', async () => {
		const mark = await t.mock.mark();
		const event = await incoming(phone(1), '9');
		const runs = {
			order: await order(orderBody('guard-1')),
			timer: await timer(),
			week: await week(),
			reply: await poll(event),
		};
		for (const [name, execution] of Object.entries(runs)) {
			failed(execution, /^Not ready to survey anybody: /, `the ${name} run is refused`);
			for (const part of ['owner_phone is not a real number', 'business_name is still the sample']) assert.ok(execution.error.message.includes(part), `the ${name} message says: ${part}`);
			assert.ok(!execution.ran('Read the surveys'), `the ${name} run read nothing`);
		}
		assert.count(await sendsSince(mark), 0, 'nothing was sent');
		assert.count(await t.tables.rows(TABLE), 0, 'nothing was stored');
	});
	await t.step('each setting is checked on its own', async () => {
		const run = async () => (await order(orderBody('guard-2'))).error?.message ?? '';
		await configure({ owner_phone: '12345' });
		assert.ok((await run()).includes('owner_phone is not a real number'), 'a short owner number is refused');
		await configure({ owner_phone: OWNER });
		let message = await run();
		assert.ok(!message.includes('owner_phone') && message.includes('business_name is still the sample'), 'then the business name');
		await configure({ business_name: BUSINESS });
		await configure({ expected_timezone: 'Asia/Tokyo' });
		assert.equal(await run(), '', 'a time zone that is not the workflow one does not stop an order (only the two timers)');
		failed(await timer(), /Time zone mismatch: this workflow runs in America\/Sao_Paulo but expected_timezone in Your settings is Asia\/Tokyo/, 'the timer is refused');
		await t.tables.clear(TABLE);
		await configure({ expected_timezone: 'America/Sao_Paulo', window_start: '20:00', window_end: '09:00' });
		assert.ok((await run()).includes('window_start and window_end must be times'), 'hours that end before they start are refused');
		await configure({ window_start: '9am', window_end: '23:59' });
		assert.ok((await run()).includes('window_start and window_end must be times'), 'hours that are not HH:mm are refused');
		await configure({ window_start: '00:00', delay_hours: -1 });
		assert.ok((await run()).includes('delay_hours must be a number of 0 or more'), 'a negative delay is refused');
		await configure({ delay_hours: 24, max_surveys_per_day: 0 });
		assert.ok((await run()).includes('max_surveys_per_day must be a whole number of 1 or more'), 'a daily cap of 0 is refused');
		await configure({ max_surveys_per_day: 25, max_surveys_per_run: 0 });
		assert.ok((await run()).includes('max_surveys_per_run must be a whole number of 1 or more'), 'a cap per run of 0 is refused');
		await configure({ max_surveys_per_run: 5, purge_days: 30 });
		assert.ok((await run()).includes('purge_days must be 0 (never delete) or a whole number of 60 or more'), 'purging after 30 days is refused');
		await configure({ purge_days: 180, number_alias: '' });
		assert.ok((await run()).includes('number_alias is empty'), 'no number is refused');
		await configure({ number_alias: 'main', review_for: 'sometimes' });
		assert.ok((await run()).includes('review_for must be everyone or promoters'), 'a review_for that is neither is refused');
		await configure({ review_for: 'everyone', close_after_days: 0 });
		assert.ok((await run()).includes('close_after_days must be a number of 1 or more'), 'closing after 0 days is refused');
		await configure({ close_after_days: 7, review_url: 'javascript:alert(1)' });
		assert.ok((await run()).includes('review_url must be empty or a web address'), 'a review link that is not http or https is refused');
		await configure({ review_url: 'https://example.com/review', review_button_text: 'A button text that is far too long' });
		assert.ok((await run()).includes('review_button_text must be 1 to 20 characters'), 'a button text over 20 characters is refused');
		await configure({ review_url: '', review_button_text: 'Leave a review', start_statuses: ' , ' });
		assert.ok((await run()).includes('start_statuses is empty'), 'no start status is refused');
		await configure({ start_statuses: exported.start_statuses, optout_words: '' });
		assert.ok((await run()).includes('optout_words is empty'), 'no opt-out word is refused');
		await configure({ optout_words: exported.optout_words, field_phone: '' });
		assert.ok((await run()).includes('field_phone is empty'), 'a field name left empty is refused');
		await configure({ field_phone: 'phone', msg_question: '' });
		assert.ok((await run()).includes('msg_question is empty'), 'an empty text is refused');
		await configure({ msg_question: exported.msg_question, default_country_code: 'br' });
		assert.ok((await run()).includes('default_country_code must be digits'), 'a country code that is not digits is refused');
		await configure({ default_country_code: '55', ...real });
		const mark = await t.mock.mark();
		ok(await order(orderBody('guard-ok')));
		assert.ok(await rowOf('guard-ok'), 'with real values the run goes on and stores the order');
		assert.count(await sendsSince(mark), 0, 'and still sends nothing at once');
		await reset();
	});

	// ---------------------------------------------------------------- a new order
	await t.step('a delivered order is queued: mapped fields, the survey is due delay_hours later, nothing is sent now', async () => {
		const mark = await t.mock.mark();
		const execution = await order(orderBody('1001', { order_url: 'https://shop.example.com/orders/1001', items: [{ name: 'Chocolate cake' }, { title: 'Tea' }, 'Bread'] }));
		ok(execution);
		assert.ok(!execution.ran('Send the text'), 'no message goes out at the moment of the order');
		assert.count(await sendsSince(mark), 0, 'the mock received nothing');
		const row = await rowOf('1001');
		assert.equal(
			{ name: row.customer_name, phone: row.phone, status: row.status, score: row.score, url: row.order_url, items: row.items, asked: row.asked_at, message: row.message_id, reasks: row.reasks, note: row.note },
			{ name: 'Ana Souza', phone: phone(1), status: 'queued', score: null, url: 'https://shop.example.com/orders/1001', items: 'Chocolate cake, Tea, Bread', asked: '', message: '', reasks: 0, note: '' },
			'the row holds the order',
		);
		assert.ok(Math.abs(Date.parse(row.due_at) - (Date.now() + 24 * HOUR)) < 120_000, 'due 24 hours after the order');
		assert.ok(Math.abs(Date.parse(row.created_at) - Date.now()) < 120_000, 'created now');
		await reset();
	});
	await t.step('only the statuses of start_statuses start a survey (delivered by default, * for any); another status leaves a note row that says which status arrived', async () => {
		for (const status of ['paid', 'pending', 'cancelled', 'refunded', 'created', '']) ok(await order(orderBody(`st-${status || 'none'}`, { status })));
		const noStatus = orderBody('st-missing');
		delete noStatus.status;
		ok(await order(noStatus));
		let rows = await t.tables.rows(TABLE);
		assert.ok(rows.length > 0 && rows.every((r) => /^status-\d\d$/.test(r.order_id)), 'only note rows: no survey was queued');
		assert.ok(rows.every((r) => r.status === 'skipped' && r.phone === '' && r.customer_name === ''), 'skipped, and the note holds no phone and no name');
		const noteOf = (id) => rows.map((r) => r.note).find((n) => n.startsWith(`order ${id}:`));
		assert.equal(noteOf('st-paid'), 'order st-paid: status "paid" does not start a survey (start_statuses: delivered)', 'the note says which status arrived');
		assert.equal(noteOf('st-none'), 'order st-none: the field "status" is empty or missing (start_statuses: delivered)', 'an empty status says so');
		assert.equal(noteOf('st-missing'), 'order st-missing: the field "status" is empty or missing (start_statuses: delivered)', 'a missing status says so');
		ok(await order(orderBody('st-d', { status: ' DELIVERED ', phone: phone(2) })));
		assert.equal((await rowOf('st-d')).status, 'queued', 'DELIVERED with spaces starts a survey');
		ok(await order(orderBody('st-paid', { status: 'delivered', phone: phone(3) })));
		assert.equal((await rowOf('st-paid')).status, 'queued', 'a later delivered event of an order that had a paid event is not blocked by the note');
		await configure({ start_statuses: 'paid, delivered' });
		ok(await order(orderBody('st-two', { status: 'paid', phone: phone(4) })));
		assert.equal((await rowOf('st-two')).status, 'queued', 'start_statuses is a setting: paid and delivered');
		await configure({ start_statuses: '*' });
		ok(await order(orderBody('st-any', { status: 'shipped', phone: phone(5) })));
		assert.equal((await rowOf('st-any')).status, 'queued', '* starts a survey for any status');
		const anyNone = orderBody('st-any2', { phone: phone(6) });
		delete anyNone.status;
		ok(await order(anyNone));
		assert.equal((await rowOf('st-any2')).status, 'queued', '* starts one without a status too');
		await configure({ start_statuses: exported.start_statuses });
		await reset();
		// The notes are a ring of 20 slots: however many orders arrive, they never fill the table.
		for (let i = 1; i <= 26; i++) ok(await order(orderBody(`ring-${i}`, { status: 'pending', phone: phone(20 + (i % 20)) })));
		rows = await t.tables.rows(TABLE);
		assert.ok(rows.length >= 10 && rows.length <= 20, `26 orders with a status that starts nothing left ${rows.length} note rows (at most 20)`);
		assert.ok(rows.every((r) => /^status-\d\d$/.test(r.order_id)), 'and nothing else');
		await reset();
	});
	await t.step('field limits: long text is cut, control and direction characters are removed, a web address in a name or in the items is dropped', async () => {
		const bidi = String.fromCharCode(0x202e, 0x200b, 0x2066);
		ok(await order(orderBody('caps-1', { customer_name: `A${'a'.repeat(300)}`, items: 'x'.repeat(500) })));
		const caps = await rowOf('caps-1');
		assert.equal(caps.customer_name.length, 100, 'the name is cut at max_text_length (100)');
		assert.equal(caps.items.length, 100, 'the items are cut too');
		ok(await order(orderBody('caps-2', { customer_name: `Ana${bidi} Souza${String.fromCharCode(1)}`, phone: phone(2) })));
		assert.equal((await rowOf('caps-2')).customer_name, 'Ana Souza', 'direction, zero-width and control characters are removed');
		ok(await order(orderBody('caps-3', { customer_name: 'Click https://bad.example/x', items: ['www.bad.example offer'], phone: phone(3) })));
		const links = await rowOf('caps-3');
		assert.equal([links.customer_name, links.items], ['', ''], 'a name or a list that carries a web address is dropped');
		ok(await order(orderBody('caps-4', { customer_name: 'Reach me @5511999999999', phone: phone(4) })));
		assert.equal((await rowOf('caps-4')).customer_name, '', 'a name with an @mention is dropped');
		ok(await order(orderBody('caps-5', { order_url: 'javascript:alert(1)', items: 'one text item', phone: phone(5) })));
		const url = await rowOf('caps-5');
		assert.equal([url.order_url, url.items], ['', 'one text item'], 'a link that is not http or https is dropped, a text item is kept');
		ok(await order(orderBody('caps-6', { order_url: `https://shop.example.com/${'a'.repeat(600)}`, phone: phone(6) })));
		assert.equal((await rowOf('caps-6')).order_url, '', 'a link over 500 characters is dropped');
		await configure({ max_text_length: 20 });
		ok(await order(orderBody('caps-7', { customer_name: 'n'.repeat(100), phone: phone(7) })));
		assert.equal((await rowOf('caps-7')).customer_name.length, 20, 'max_text_length is a setting');
		await configure({ max_text_length: 100 });
		await reset();
	});
	await t.step('bad requests fail the run with a plain message and store nothing', async () => {
		const cases = [
			['no order id', orderBody('x', { order_id: undefined }), /Order rejected: the field "order_id" must hold an order id of 1 to 64/],
			['an id over 64 characters', orderBody('x'.repeat(65)), /must hold an order id of 1 to 64/],
			['an id with a slash', orderBody('1001/2'), /must hold an order id of 1 to 64/],
			['an id that is a web address', orderBody('http://x.example'), /must hold an order id of 1 to 64/],
			['an id with spaces', orderBody('order 7'), /must hold an order id of 1 to 64/],
			['an id that the table keeps for itself', orderBody('report-1'), /may not start with report-, optout- or status-/],
			['an id that the table keeps for itself, STOP marker', orderBody('optout-1'), /may not start with report-, optout- or status-/],
			['an id that the table keeps for itself, status note', orderBody('Status-01'), /may not start with report-, optout- or status-/],
			['a body that is a list', [orderBody('1')], /the request has no JSON object in its body/],
			['a body that is text', 'hello', /the request has no JSON object in its body/],
			['no body', undefined, /the request has no JSON object in its body/],
		];
		for (const [name, body, pattern] of cases) failed(await order(body), pattern, name);
		assert.count(await t.tables.rows(TABLE), 0, 'nothing was stored');
		ok(await order(orderBody('#WC-2301_a.b:c')));
		assert.ok(await rowOf('#WC-2301_a.b:c'), 'ids with # . _ : - are fine');
		await reset();
	});
	await t.step('phone numbers: E.164 only when unambiguous, otherwise the order is kept as skipped with the reason', async () => {
		const good = [
			['+5511977770002', '+5511977770002'],
			['+55 (11) 97777-0003', '+5511977770003'],
			['(11) 97777-0004', '+5511977770004'],
			['11977770005', '+5511977770005'],
			['5511977770006', '+5511977770006'],
			['005511977770007', '+5511977770007'],
			['011977770008', '+5511977770008'],
			[' 11 9 7777 0009 ', '+5511977770009'],
		];
		for (const [i, [typed, expected]] of good.entries()) {
			ok(await order(orderBody(`ph-${i}`, { phone: typed })));
			const row = await rowOf(`ph-${i}`);
			assert.equal([row.status, row.phone], ['queued', expected], `${typed} becomes ${expected}`);
			await patchRow(`ph-${i}`, { status: 'closed' });
		}
		await reset();
		const bad = [['12345', 'a Brazilian'], ['', 'not digits'], ['abc', 'not digits'], ['1197777000', 'a local number needs'], ['+55119777700', 'a Brazilian mobile number'], ['+55 11 3777 0001', 'a Brazilian mobile number'], ['+0123456789', 'not a valid international number'], ['11 8777-0001', 'a local number needs']];
		for (const [i, [typed]] of bad.entries()) {
			ok(await order(orderBody(`bad-${i}`, { phone: typed })));
			const row = await rowOf(`bad-${i}`);
			assert.equal([row.status, row.phone], ['skipped', ''], `"${typed}" is not guessed: the order is skipped`);
			assert.match(row.note, /^invalid phone \(/, 'with the reason in the note');
		}
		const missing = orderBody('bad-none');
		delete missing.phone;
		ok(await order(missing));
		assert.equal((await rowOf('bad-none')).status, 'skipped', 'an order without a phone is skipped too');
		await reset();
		await configure({ default_country_code: '44' });
		ok(await order(orderBody('uk-1', { phone: '442079460958' })));
		ok(await order(orderBody('uk-2', { phone: '2079460958' })));
		ok(await order(orderBody('uk-3', { phone: '+442079460959' })));
		assert.equal([(await rowOf('uk-1')).phone, (await rowOf('uk-2')).status, (await rowOf('uk-3')).phone], ['+442079460958', 'skipped', '+442079460959'], 'with another country code only numbers that start with it, or with +, are accepted');
		await configure({ default_country_code: '55' });
		await reset();
	});
	await t.step('the same order again is ignored and leaves the row untouched', async () => {
		ok(await order(orderBody('dup-1', { order_url: 'https://shop.example.com/orders/dup-1' })));
		const before = await rowOf('dup-1');
		const again = await order(orderBody('dup-1', { customer_name: 'Somebody Else', phone: phone(2), status: 'delivered' }));
		ok(again);
		assert.ok(!again.ran('Save the survey before sending'), 'nothing is saved');
		assert.equal(await rowOf('dup-1'), before, 'the row is the same');
		assert.count(await t.tables.rows(TABLE), 1, 'one row');
		await patchRow('dup-1', { status: 'closed' });
		ok(await order(orderBody('dup-1', { phone: phone(2) })));
		assert.equal((await rowOf('dup-1')).phone, phone(1), 'also when the survey is long finished');
		await reset();
	});
	await t.step('cooldown: a customer is surveyed once per period, a skipped order says why, 0 switches it off', async () => {
		ok(await order(orderBody('cd-1')));
		ok(await order(orderBody('cd-2')));
		const second = await rowOf('cd-2');
		assert.equal([second.status, second.phone, second.due_at], ['skipped', phone(1), ''], 'the second order of the same phone is skipped');
		assert.equal(second.note, 'already surveyed in the last 30 days (order cd-1)', 'with the reason');
		await patchRow('cd-1', { status: 'closed', created_at: daysAgo(29) });
		ok(await order(orderBody('cd-3')));
		assert.equal((await rowOf('cd-3')).status, 'skipped', 'still inside the 30 days');
		await patchRow('cd-1', { created_at: daysAgo(31) });
		ok(await order(orderBody('cd-4')));
		assert.equal((await rowOf('cd-4')).status, 'queued', 'after 31 days the customer can be asked again');
		await patchRow('cd-4', { status: 'send_failed' });
		ok(await order(orderBody('cd-5')));
		assert.equal((await rowOf('cd-5')).status, 'queued', 'a survey that never reached the customer does not count');
		ok(await order(orderBody('cd-6', { phone: phone(2) })));
		assert.equal((await rowOf('cd-6')).status, 'queued', 'another customer is not affected');
		await configure({ cooldown_days: 0 });
		ok(await order(orderBody('cd-7')));
		assert.equal((await rowOf('cd-7')).status, 'queued', 'cooldown_days 0: no cooldown');
		await configure({ cooldown_days: 30 });
		await reset();
	});
	await t.step('another tool names its fields differently: the names come from the settings', async () => {
		await configure({ field_order_id: 'number', field_customer_name: 'buyer', field_phone: 'whatsapp', field_status: 'state', field_order_url: 'link', field_items: 'lines' });
		ok(await order({ number: 'W-9', buyer: 'Gabi Neves', whatsapp: phone(7), state: 'delivered', link: 'https://shop.example.com/w9', lines: 'Pie' }));
		const row = await rowOf('W-9');
		assert.equal([row.customer_name, row.phone, row.order_url, row.items], ['Gabi Neves', phone(7), 'https://shop.example.com/w9', 'Pie'], 'every field was read by its configured name');
		failed(await order(orderBody('ignored')), /Order rejected: the field "number" must hold an order id/, 'a body with the old names is not read');
		assert.equal(await rowOf('ignored'), undefined, 'and nothing is stored');
		await configure({ field_order_id: 'order_id', field_customer_name: 'customer_name', field_phone: 'phone', field_status: 'status', field_order_url: 'order_url', field_items: 'items' });
		await reset();
	});

	// ---------------------------------------------------------------- the 30 minute timer: asking
	await t.step('the question: not before it is due, then ONE text with the key of the order, the row is asked and holds the message id', async () => {
		ok(await order(orderBody('q-1', { items: 'Cake' })));
		let mark = await t.mock.mark();
		const early = await timer();
		ok(early);
		assert.count(await sendsSince(mark), 0, 'nothing is sent before it is due');
		assert.equal((await rowOf('q-1')).status, 'queued', 'the row waits');
		await patchRow('q-1', { due_at: hoursAgo(1) });
		mark = await t.mock.mark();
		ok(await timer());
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'one message');
		assert.equal(sends[0].to, phone(1), 'to the customer');
		assert.equal(sends[0].text, QUESTION('Ana', 'q-1'), 'the question');
		assert.equal(sends[0].key, 'nps-question-q-1', 'the idempotency key is built from the order');
		assert.ok(/\bSTOP\b/.test(sends[0].text) && /0 to 10/.test(sends[0].text), 'it asks for 0 to 10 and says how to stop');
		const row = await rowOf('q-1');
		assert.equal([row.status, row.message_id, row.reasks], ['asked', sends[0].id, 0], 'asked, with the message id');
		assert.ok(Math.abs(Date.parse(row.asked_at) - Date.now()) < 120_000, 'asked now');
		mark = await t.mock.mark();
		ok(await timer());
		ok(await timer());
		assert.count(await sendsSince(mark), 0, 'the next runs ask nobody again');
		await configure({ msg_question: 'Hello {name}, {items} from order {order_id} at {business}?\\nReply 0 to 10.' });
		ok(await order(orderBody('q-2', { phone: phone(2), customer_name: '', items: 'Pie' })));
		await patchRow('q-2', { due_at: hoursAgo(1) });
		mark = await t.mock.mark();
		ok(await timer());
		assert.equal((await sendsSince(mark))[0].text, `Hello there, Pie from order q-2 at ${BUSINESS}?\nReply 0 to 10.`, 'the wording is a setting: {items}, {business}, a line break, and "there" without a name');
		await configure({ msg_question: exported.msg_question });
		await reset();
	});
	await t.step('a question marked as asked but never confirmed is sent again with the SAME key: Turbo Notify returns the first message, no second one exists', async () => {
		ok(await order(orderBody('r-1')));
		await patchRow('r-1', { due_at: hoursAgo(1) });
		const mark = await t.mock.mark();
		ok(await timer());
		const first = (await rowOf('r-1')).message_id;
		assert.ok(first.startsWith('msg_'), 'the first send');
		await patchRow('r-1', { message_id: '', asked_at: minutesAgo(5) });
		ok(await timer());
		const sends = await sendsSince(mark);
		assert.count(sends, 2, 'the question was requested twice');
		assert.count(distinct(sends), 1, 'but only ONE message exists');
		assert.equal((await rowOf('r-1')).message_id, first, 'and the row has the same message id again');
		await patchRow('r-1', { message_id: '', asked_at: minutesAgo(1) });
		const recent = await t.mock.mark();
		ok(await timer());
		assert.count(await sendsSince(recent), 0, 'a question asked a minute ago is not repeated yet');
		await reset();
	});
	await t.step('sending hours: outside them nobody is asked and the survey waits, inside they are asked', async () => {
		ok(await order(orderBody('w-1')));
		await patchRow('w-1', { due_at: hoursAgo(1) });
		const h = local();
		await configure(h >= 21 ? { window_start: '05:00', window_end: '06:00' } : { window_start: `${String(h + 2).padStart(2, '0')}:00`, window_end: `${String(h + 3).padStart(2, '0')}:00` });
		let mark = await t.mock.mark();
		ok(await timer());
		assert.count(await sendsSince(mark), 0, 'outside the hours nothing is sent');
		assert.equal((await rowOf('w-1')).status, 'queued', 'the survey waits');
		await configure({ window_start: '00:00', window_end: '23:59' });
		mark = await t.mock.mark();
		ok(await timer());
		assert.count(await sendsSince(mark), 1, 'inside the hours it is asked');
		await reset();
	});
	await t.step('the time zone guard stops the two timers only: an order, a reply and a STOP are never lost to a mismatch', async () => {
		ok(await order(orderBody('tz-1')));
		await patchRow('tz-1', { due_at: hoursAgo(1) });
		await asking('tz-2', 2);
		await asking('tz-3', 3);
		await configure({ expected_timezone: 'Asia/Tokyo' });
		let mark = await t.mock.mark();
		const execution = await timer();
		failed(execution, /Time zone mismatch: this workflow runs in America\/Sao_Paulo but expected_timezone in Your settings is Asia\/Tokyo/);
		assert.ok(!execution.ran('Read the surveys'), 'nothing was read');
		failed(await week(), /Time zone mismatch/, 'the weekly report is stopped too');
		assert.count(await sendsSince(mark), 0, 'nothing was sent');
		assert.equal((await rowOf('tz-1')).status, 'queued', 'and the row is untouched');
		ok(await order(orderBody('tz-4', { phone: phone(4) })));
		assert.equal((await rowOf('tz-4')).status, 'queued', 'a new order is still received and queued');
		mark = await t.mock.mark();
		ok(await hears(phone(2), '9'));
		assert.equal([(await rowOf('tz-2')).score, (await rowOf('tz-2')).status], [9, 'closed'], 'a reply is still read');
		ok(await hears(phone(3), 'STOP'));
		assert.equal((await rowOf('tz-3')).status, 'opted_out', 'a STOP is still honoured');
		assert.count(await sendsSince(mark), 2, 'the thank you and the confirmation went out');
		await configure({ expected_timezone: 'America/Sao_Paulo' });
		await reset();
	});
	await t.step('the daily cap: the earliest due surveys first, the rest the next day, the day is the local day', async () => {
		for (const [i, who] of [1, 2, 3].entries()) await queue(`cap-${i + 1}`, who, { due_at: hoursAgo(3 - i) });
		await configure({ max_surveys_per_day: 2 });
		let mark = await t.mock.mark();
		ok(await timer());
		let sends = await sendsSince(mark);
		assert.equal(sends.map((s) => s.key), ['nps-question-cap-1', 'nps-question-cap-2'], 'two questions, the two that were due first');
		assert.equal((await rowOf('cap-3')).status, 'queued', 'the third waits');
		mark = await t.mock.mark();
		ok(await timer());
		assert.count(await sendsSince(mark), 0, 'the next run sends nothing: the cap of the day is used');
		await patchRow('cap-1', { asked_at: hoursAgo(26) });
		await patchRow('cap-2', { asked_at: hoursAgo(26) });
		mark = await t.mock.mark();
		ok(await timer());
		sends = await sendsSince(mark);
		assert.equal(sends.map((s) => s.key), ['nps-question-cap-3'], 'the next day the third is asked');
		await configure({ max_surveys_per_day: 25 });
		await reset();
	});
	await t.step('the cap per run: a backlog at the opening of the hours goes out a few at a time, the earliest first', async () => {
		for (const [i, who] of [1, 2, 3, 4].entries()) await queue(`run-${i + 1}`, who, { due_at: hoursAgo(5 - i) });
		await configure({ max_surveys_per_run: 2 });
		let mark = await t.mock.mark();
		ok(await timer());
		assert.equal((await sendsSince(mark)).map((s) => s.key), ['nps-question-run-1', 'nps-question-run-2'], 'two questions, the two that were due first');
		mark = await t.mock.mark();
		ok(await timer());
		assert.equal((await sendsSince(mark)).map((s) => s.key), ['nps-question-run-3', 'nps-question-run-4'], 'the next run asks the next two');
		await configure({ max_surveys_per_run: 5 });
		await reset();
	});
	await t.step('one open question per customer: a second order of the same customer waits until the first one is finished', async () => {
		await configure({ cooldown_days: 0 });
		await asking('one-1', 1);
		await queue('one-2', 1, { due_at: hoursAgo(1) });
		await queue('one-3', 2, { due_at: hoursAgo(1) });
		await queue('one-4', 2, { due_at: hoursAgo(1) });
		let mark = await t.mock.mark();
		ok(await timer());
		let sends = await sendsSince(mark);
		assert.equal(sends.map((s) => s.key), ['nps-question-one-3'], 'customer 1 still owes an answer and is not asked again; customer 2 is asked once, not twice in one run');
		await patchRow('one-1', { status: 'closed' });
		mark = await t.mock.mark();
		ok(await timer());
		sends = await sendsSince(mark);
		assert.equal(sends.map((s) => s.key), ['nps-question-one-2'], 'when the first is closed the next one is asked (customer 2 still has an open question)');
		await configure({ cooldown_days: 30 });
		await reset();
	});
	await t.step('a refused question is recorded, the run fails naming the order and no phone number, it is not tried again by itself, and a person can queue it again', async () => {
		ok(await order(orderBody('f-1', { phone: phone(2) })));
		await patchRow('f-1', { due_at: hoursAgo(1) });
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 402, body: { error: 'contact_quota_exceeded', message: 'Distinct-contacts quota exceeded for tier FREE (2/2 this cycle)' }, times: 1 });
		let mark = await t.mock.mark();
		const execution = await timer();
		failed(execution, /^Some messages were not sent\. question for order f-1 was not sent to the customer: /, 'the run says which order');
		assert.ok(!/\d{8,}/.test(execution.error.message), 'and no phone number');
		const row = await rowOf('f-1');
		assert.equal([row.status, row.asked_at, row.message_id], ['send_failed', '', ''], 'the row is send_failed, not asked, and does not count for today');
		assert.match(row.note, /^question not sent: .*(quota|contact)/i, 'the note says why');
		mark = await t.mock.mark();
		ok(await timer());
		assert.count(await sendsSince(mark), 0, 'the next run does not try again by itself');
		await patchRow('f-1', { status: 'queued', note: '' });
		mark = await t.mock.mark();
		ok(await timer());
		assert.count(await sendsSince(mark), 1, 'a person sets it back to queued and it is asked');
		assert.equal((await rowOf('f-1')).status, 'asked', 'asked');
		await reset();
	});
	await t.step('a temporary refusal (number not connected, 503, a new number at its daily limit) puts the question back to queued and the next run tries again; one that needs a person stays send_failed', async () => {
		ok(await order(orderBody('tf-1', { phone: phone(2) })));
		const due = hoursAgo(2);
		await patchRow('tf-1', { due_at: due });
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 409, body: { error: 'number_not_connected' }, times: 1 });
		let mark = await t.mock.mark();
		const execution = await timer();
		failed(execution, /^Some messages were not sent\. question for order tf-1 was not sent to the customer: .*number_not_connected.*tried again at the next run/, 'the run still fails loudly and says it will try again');
		let row = await rowOf('tf-1');
		assert.equal([row.status, row.asked_at, row.message_id], ['queued', '', ''], 'back to queued, not asked, no message id');
		assert.match(row.note, /^will try again, question not sent: /, 'the note says why');
		assert.equal(row.due_at, due, 'the original due time is kept, so the time to give up (close_after_days) runs from it');
		mark = await t.mock.mark();
		ok(await timer());
		const sends = await sendsSince(mark);
		assert.equal(sends.map((s) => s.key), ['nps-question-tf-1'], 'the next run asks it, with the same key');
		row = await rowOf('tf-1');
		assert.equal([row.status, row.note, row.message_id], ['asked', '', sends[0].id], 'asked, and the old note is gone');
		// Turbo Notify answers 503: the same.
		ok(await order(orderBody('tf-2', { phone: phone(3) })));
		await patchRow('tf-2', { due_at: hoursAgo(2) });
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 503, body: { error: 'service_unavailable', message: 'try later' }, times: 1 });
		failed(await timer(), /question for order tf-2 was not sent to the customer: .*tried again at the next run/, 'a 503 is temporary');
		assert.equal((await rowOf('tf-2')).status, 'queued', 'queued again');
		// The new number is at its daily volume: also temporary (tomorrow it goes out).
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 429, body: { error: 'warmup_limit_exceeded', message: 'daily volume' }, times: 1 });
		failed(await timer(), /question for order tf-2 was not sent to the customer: .*tried again at the next run/, 'the warm-up limit is temporary');
		assert.equal((await rowOf('tf-2')).status, 'queued', 'queued again');
		// A reply ratio that is too low does not mend itself: send_failed, a person looks at it.
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 429, body: { error: 'reply_ratio_too_low', message: 'too few replies' }, times: 1 });
		failed(await timer(), /question for order tf-2 was not sent to the customer: /, 'reply_ratio_too_low is refused');
		row = await rowOf('tf-2');
		assert.equal([row.status, row.asked_at], ['send_failed', ''], 'send_failed: only a person can mend it');
		assert.match(row.note, /^question not sent: /, 'with the reason');
		// The time to give up is close_after_days from the due time: a question that could not be sent for 8 days is skipped.
		await put({ order_id: 'tf-3', customer_name: 'Carla Dias', phone: phone(4), status: 'queued', due_at: daysAgo(8), note: 'will try again, question not sent: x' });
		ok(await timer());
		assert.equal([(await rowOf('tf-3')).status, (await rowOf('tf-3')).note], ['skipped', 'not sent in time'], 'a retry never goes on forever');
		await reset();
	});
	await t.step('old surveys are closed: no answer, no comment, and a survey that was never asked is skipped', async () => {
		await asking('old-1', 1, { asked_at: daysAgo(8) });
		await asking('old-2', 2, { asked_at: daysAgo(6) });
		await put({ order_id: 'old-3', customer_name: 'Carla Dias', phone: phone(3), status: 'answered', score: 4, category: 'detractor', asked_at: daysAgo(9), answered_at: daysAgo(8) });
		await put({ order_id: 'old-4', customer_name: 'Davi Lima', phone: phone(4), status: 'answered', score: 8, category: 'passive', asked_at: daysAgo(3), answered_at: daysAgo(2) });
		await queue('old-5', 5, { due_at: daysAgo(8) });
		const mark = await t.mock.mark();
		ok(await timer());
		const state = async (id) => { const r = await rowOf(id); return [r.status, r.note]; };
		assert.equal(await state('old-1'), ['closed', 'no answer in 7 days'], 'asked 8 days ago: closed');
		assert.equal((await rowOf('old-2')).status, 'asked', 'asked 6 days ago: still waiting');
		assert.equal(await state('old-3'), ['closed', 'no comment in 7 days'], 'a comment nobody wrote: closed');
		assert.equal((await rowOf('old-3')).score, 4, 'the score is kept');
		assert.equal((await rowOf('old-4')).status, 'answered', 'answered 2 days ago: still waiting for the comment');
		assert.equal(await state('old-5'), ['skipped', 'not sent in time'], 'queued and due 8 days ago: skipped, not sent');
		assert.count(await sendsSince(mark), 0, 'closing sends nothing');
		await reset();
	});

	// ---------------------------------------------------------------- replies: the score
	await t.step('the score is read from digits and from words in English and Portuguese; a reply without ONE clear number is not a score', async () => {
		const cases = [
			['9', 9], ['10', 10], ['0', 0], ['9 !', 9], ['9!!!', 9], ['10/10', 10], ['7/10', 7], ['7 de 10', 7], ['5 out of 10', 5], ['nota 8', 8], ['nota8', 8], ['Score: 6', 6],
			['nine', 9], ['Ten', 10], ['dez', 10], ['Oito!', 8], ['zero', 0], ['ten out of ten', 10], ['nota dez', 10], ['um', 1], ['uma estrela', 1], ['sete', 7], ['one of the best, ten', 10], ['nove nove', 9], ['9 9', 9], ['Quatro', 4], ['cinco', 5], ['six', 6], ['três', 3], ['two', 2],
			['hello', null], ['thanks!', null], ['👍', null], ['7 or 8', null], ['seven eight', null], ['8.5', null], ['8,5', null], ['11', null], ['100%', null], ['a 5 and a 9', null], ['order 123 was a 9', null], ['nine or ten', null], ['um atendimento ruim', null],
		];
		const rows = cases.map(([text, score], i) => ({ id: `p-${i}`, who: 10 + i, text, score }));
		for (const r of rows) await asking(r.id, r.who);
		const mark = await t.mock.mark();
		// A poll of this many events at a time keeps every run short: the answers of 44 customers in one run is not a case.
		for (let from = 0; from < rows.length; from += 11) {
			const events = [];
			for (const r of rows.slice(from, from + 11)) events.push(await incoming(phone(r.who), r.text));
			ok(await t.run(POLL, { pin: { [POLL]: events }, timeoutMs: 300_000 }));
		}
		for (const r of rows) {
			const row = await rowOf(r.id);
			if (r.score === null) assert.equal([row.score, row.status, row.reasks], [null, 'asked', 1], `"${r.text}" is not a score: one re-ask`);
			else assert.equal([row.score, row.category.length > 0], [r.score, true], `"${r.text}" is ${r.score}`);
		}
		const sends = await sendsSince(mark);
		assert.equal(to(sends, phone(10 + cases.findIndex((c) => c[0] === 'hello'))).map((s) => s.text), [REASK], 'the re-ask text');
		await reset();
	});
	await t.step('a quoted reply (message.replied) counts exactly like a message', async () => {
		ok(await order(orderBody('quote-1')));
		await patchRow('quote-1', { due_at: hoursAgo(1) });
		ok(await timer());
		const question = (await rowOf('quote-1')).message_id;
		assert.ok(question.startsWith('msg_'), 'the question was sent');
		const sent = await t.mock.injectMessage({ from: phone(1), name: 'Ana', text: '10', reply_to: question });
		const event = (await t.mock.events()).find((e) => e.id === sent.event_id);
		assert.equal(event.type, 'message.replied', 'the mock delivers it as message.replied');
		ok(await poll(event));
		const row = await rowOf('quote-1');
		assert.equal([row.score, row.category, row.status], [10, 'promoter', 'closed'], 'read as a 10');
		await reset();
	});
	await t.step('a promoter (9 or 10): ONE thank you as plain text without a review page, no follow-up, the survey is closed', async () => {
		await asking('pro-1', 1);
		const mark = await t.mock.mark();
		ok(await hears(phone(1), '9'));
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'one message');
		assert.equal([sends[0].to, sends[0].text, sends[0].key, sends[0].interactive], [phone(1), 'Thank you, Ana! We are glad you had a good experience.', 'nps-promoter-pro-1', undefined], 'the thank you, plain text, no button because review_url is empty');
		const row = await rowOf('pro-1');
		assert.equal([row.score, row.category, row.status, row.comment], [9, 'promoter', 'closed', ''], 'stored and closed');
		assert.ok(Math.abs(Date.parse(row.answered_at) - Date.now()) < 120_000, 'answered now');
		const later = await t.mock.mark();
		ok(await hears(phone(1), 'thanks again'));
		assert.count(await sendsSince(later), 0, 'whatever the customer writes next is ignored: this is not a chatbot');
		await reset();
	});
	await t.step('a promoter with a review page gets the thank you AND a link button to it, in one message', async () => {
		await configure({ review_url: 'https://reviews.example.com/green-house', review_button_text: 'Review us' });
		await asking('pro-2', 2);
		const mark = await t.mock.mark();
		ok(await hears(phone(2), '10'));
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'one message');
		assert.equal(sends[0].interactive, 'cta_url', 'a link button message');
		assert.equal(sends[0].button, { display_text: 'Review us', url: 'https://reviews.example.com/green-house' }, 'the button opens the review page');
		assert.equal(sends[0].text, 'Thank you, Bruno! We are glad you had a good experience.\nIf you have a minute, a public review helps other people find us.', 'the text above the button');
		assert.equal(sends[0].key, 'nps-promoter-pro-2', 'key');
		await configure({ review_url: '', review_button_text: 'Leave a review' });
		await reset();
	});
	await t.step('a passive (7 or 8): the question "what would make it a 10", the next message is the comment, one short thanks, nobody else is told', async () => {
		await asking('pas-1', 3);
		let mark = await t.mock.mark();
		ok(await hears(phone(3), '8'));
		let sends = await sendsSince(mark);
		assert.equal(sends.map((s) => [s.to, s.text, s.key]), [[phone(3), 'Thank you, Carla. What would make it a 10 for you?', 'nps-passive-pas-1']], 'the follow-up question, only to the customer');
		let row = await rowOf('pas-1');
		assert.equal([row.score, row.category, row.status, row.comment], [8, 'passive', 'answered', ''], 'waiting for the comment');
		mark = await t.mock.mark();
		const comment = 'Faster delivery would do it, the last two orders arrived a day later than promised and the box was wet.';
		ok(await hears(phone(3), comment));
		sends = await sendsSince(mark);
		assert.equal(sends.map((s) => [s.to, s.text, s.key]), [[phone(3), 'Thank you, Carla. Your answer reached us.', 'nps-comment_thanks-pas-1']], 'ONE short thanks, nothing to the owner');
		row = await rowOf('pas-1');
		assert.equal([row.comment, row.status], [comment, 'commented'], 'the WHOLE comment is stored, not the 50 characters of the event');
		mark = await t.mock.mark();
		ok(await hears(phone(3), 'one more thing'));
		assert.count(await sendsSince(mark), 0, 'then silence');
		await reset();
	});
	await t.step('review_for everyone: the review button comes with the last thanks of EVERY customer who answered; promoters only: just a 9 or 10; the owner never gets a button', async () => {
		await configure({ review_url: 'https://reviews.example.com/green-house', review_button_text: 'Review us' });
		const invite = 'If you have a minute, a public review helps other people find us.';
		const asked = [['rv-pas', 3], ['rv-det', 2], ['rv-inl', 4], ['rv-pro', 5]];
		for (const [id, who] of asked) await asking(id, who, { order_url: `https://shop.example.com/orders/${id}` });
		let mark = await t.mock.mark();
		ok(await hears(phone(3), '8'));
		ok(await hears(phone(2), '2'));
		let sends = await sendsSince(mark);
		assert.ok(sends.every((s) => s.interactive === undefined), 'the follow-up questions and the alerts are plain texts: no button yet');
		mark = await t.mock.mark();
		ok(await hears(phone(3), 'It was fine, the delivery could have been a bit faster though.'));
		ok(await hears(phone(2), 'The cake arrived crushed and nobody answered my message about it for days.'));
		ok(await hears(phone(4), '7, good bread but the delivery was late again this time'));
		ok(await hears(phone(5), '10'));
		sends = await sendsSince(mark);
		const buttons = sends.filter((s) => s.interactive === 'cta_url');
		assert.equal(buttons.map((s) => [s.to, s.key]).sort(), [[phone(2), 'nps-comment_thanks-rv-det'], [phone(3), 'nps-comment_thanks-rv-pas'], [phone(4), 'nps-comment_thanks-rv-inl'], [phone(5), 'nps-promoter-rv-pro']], 'a passive, a detractor, a passive with a sentence and a promoter each get ONE link button');
		for (const s of buttons) assert.equal(s.button, { display_text: 'Review us', url: 'https://reviews.example.com/green-house' }, 'the same review page for everyone');
		assert.equal(to(buttons, phone(2))[0].text, `Thank you, Bruno. Your answer reached us.\n${invite}`, 'neutral wording: the same invitation for everyone');
		assert.equal(to(buttons, phone(5))[0].text, `Thank you, Eva! We are glad you had a good experience.\n${invite}`, 'the promoter');
		assert.ok(to(sends, OWNER).every((s) => s.interactive === undefined), 'nothing the owner receives has a button');
		await reset();

		await configure({ review_for: 'promoters' });
		// Other order ids: the same key with another kind of message would be refused as a key conflict.
		for (const [id, who] of asked) await asking(`${id}-b`, who);
		mark = await t.mock.mark();
		ok(await hears(phone(3), '8'));
		ok(await hears(phone(3), 'It was fine, the delivery could have been a bit faster though.'));
		ok(await hears(phone(2), '1, the cake arrived crushed and nobody answered my message about it'));
		ok(await hears(phone(5), '9'));
		sends = await sendsSince(mark);
		assert.equal(sends.filter((s) => s.interactive === 'cta_url').map((s) => s.to), [phone(5)], 'only the 9 or 10 gets the button');
		assert.equal(to(sends, phone(3)).map((s) => s.text), ['Thank you, Carla. What would make it a 10 for you?', 'Thank you, Carla. Your answer reached us.'], 'a passive gets plain texts');
		assert.equal(to(sends, phone(2)).map((s) => s.text), ['Thank you, Bruno. Your answer reached us.'], 'a detractor gets a plain thanks');
		await configure({ review_for: 'everyone', review_url: '', review_button_text: 'Leave a review' });
		await reset();
		// Without review_url nobody gets a button, whoever answers.
		await asking('rv-none', 3);
		mark = await t.mock.mark();
		ok(await hears(phone(3), '7, a long enough sentence about the delivery being late'));
		assert.ok((await sendsSince(mark)).every((s) => s.interactive === undefined), 'no review page, no button');
		await reset();
	});
	await t.step('a detractor (0 to 6): the apology and "what went wrong", AT ONCE the alert and the contact card to the owner, the comment is forwarded to the owner', async () => {
		await asking('det-1', 2, { order_url: 'https://shop.example.com/orders/det-1' });
		let mark = await t.mock.mark();
		ok(await hears(phone(2), '3'));
		let sends = await sendsSince(mark);
		assert.count(sends, 3, 'the alert, the card and the apology');
		const customer = to(sends, phone(2));
		assert.equal(customer.map((s) => [s.text, s.key]), [['I am sorry, Bruno. What went wrong? A person will read your answer.', 'nps-detractor-det-1']], 'the apology and the question');
		const owner = to(sends, OWNER);
		assert.equal(owner[0].text, 'Unhappy customer: Bruno Costa gave 3/10 for order det-1.\nhttps://shop.example.com/orders/det-1', 'the alert with the order, the score and the order link');
		assert.equal(owner[0].key, 'nps-owner_alert-det-1', 'alert key');
		assert.equal(owner[1].card, { name: 'Bruno Costa', phones: [phone(2)] }, 'the contact card of the customer');
		assert.equal(owner[1].key, 'nps-owner_card-det-1', 'card key');
		let row = await rowOf('det-1');
		assert.equal([row.score, row.category, row.status], [3, 'detractor', 'answered'], 'waiting for the comment');
		mark = await t.mock.mark();
		const comment = 'The cake arrived crushed and when I wrote to ask for a refund nobody answered me for three days, very disappointing.';
		ok(await hears(phone(2), comment));
		sends = await sendsSince(mark);
		assert.equal(sends.map((s) => [s.to, s.text]), [
			[OWNER, `Bruno Costa wrote about order det-1 (3/10): ${comment}`],
			[phone(2), 'Thank you, Bruno. Your answer reached us.'],
		], 'the whole comment goes to the owner, the customer is thanked once');
		row = await rowOf('det-1');
		assert.equal([row.comment, row.status], [comment, 'commented'], 'stored complete and the survey is finished');
		await reset();
	});
	await t.step('an alert without an order link drops that line; a name that is missing falls back to the phone', async () => {
		await asking('det-2', 4, { customer_name: '' });
		const mark = await t.mock.mark();
		ok(await hears(phone(4), '0'));
		const sends = await sendsSince(mark);
		assert.equal(to(sends, OWNER)[0].text, `Unhappy customer: ${phone(4)} gave 0/10 for order det-2.`, 'one line, no empty line for the missing link');
		assert.equal(to(sends, phone(4))[0].text, 'I am sorry, there. What went wrong? A person will read your answer.', 'name_fallback in the texts to the customer');
		assert.equal(to(sends, OWNER)[1].card.name, phone(4), 'the card is named by the phone');
		await reset();
	});
	await t.step('a sentence next to the score is already the comment: no follow-up question', async () => {
		await asking('inl-1', 1);
		await asking('inl-2', 2, { order_url: 'https://shop.example.com/orders/inl-2' });
		await asking('inl-3', 3);
		const mark = await t.mock.mark();
		const e1 = await incoming(phone(1), 'nota 10, entrega rapida e atendimento otimo');
		const e2 = await incoming(phone(2), 'I give it a 2, the box was crushed and nobody replied to my messages');
		const e3 = await incoming(phone(3), '8, the bread was good but the delivery was late again');
		ok(await poll(e1, e2, e3));
		const rows = Object.fromEntries(await Promise.all(['inl-1', 'inl-2', 'inl-3'].map(async (id) => [id, await rowOf(id)])));
		assert.equal([rows['inl-1'].status, rows['inl-1'].score, rows['inl-1'].comment], ['commented', 10, 'nota 10, entrega rapida e atendimento otimo'], 'a promoter with a sentence');
		assert.equal([rows['inl-2'].status, rows['inl-2'].score, rows['inl-2'].category], ['commented', 2, 'detractor'], 'a detractor with a sentence');
		assert.equal([rows['inl-3'].status, rows['inl-3'].score], ['commented', 8], 'a passive with a sentence');
		const sends = await sendsSince(mark);
		assert.equal(to(sends, phone(1)).map((s) => s.key), ['nps-promoter-inl-1'], 'the promoter gets the thank you only');
		assert.equal(to(sends, phone(2)).map((s) => s.key), ['nps-comment_thanks-inl-2'], 'the detractor gets the short thanks, not a question');
		assert.equal(to(sends, phone(3)).map((s) => s.key), ['nps-comment_thanks-inl-3'], 'the passive too');
		assert.equal(to(sends, OWNER).map((s) => s.key), ['nps-owner_alert-inl-2', 'nps-owner_comment-inl-2', 'nps-owner_card-inl-2'], 'the owner hears about the detractor only: the alert, the comment, the card');
		await reset();
	});
	await t.step('an unclear answer gets ONE gentle re-ask, then the survey closes without another message', async () => {
		await asking('re-1', 1);
		let mark = await t.mock.mark();
		ok(await hears(phone(1), 'what do you mean?'));
		let sends = await sendsSince(mark);
		assert.equal(sends.map((s) => [s.to, s.text, s.key]), [[phone(1), REASK, 'nps-reask-re-1']], 'the re-ask');
		let row = await rowOf('re-1');
		assert.equal([row.status, row.reasks, row.score], ['asked', 1, null], 'still waiting, re-asked once');
		mark = await t.mock.mark();
		ok(await hears(phone(1), 'banana'));
		assert.count(await sendsSince(mark), 0, 'a second unclear answer sends nothing');
		row = await rowOf('re-1');
		assert.equal([row.status, row.note], ['closed', 'no valid score after one re-ask'], 'the survey closes');
		mark = await t.mock.mark();
		ok(await hears(phone(1), '9'));
		assert.count(await sendsSince(mark), 0, 'a late score after closing is ignored');
		assert.equal((await rowOf('re-1')).score, null, 'and not stored');
		await reset();
	});
	await t.step('two messages of the same customer in one poll are judged in the order they were written', async () => {
		await asking('seq-1', 1);
		await asking('seq-2', 2);
		const mark = await t.mock.mark();
		const a = await incoming(phone(1), '4');
		const b = await incoming(phone(2), 'what?');
		const c = await incoming(phone(1), 'The shipping box was open when it arrived and one cake was missing.');
		const d = await incoming(phone(2), '7');
		ok(await poll(a, b, c, d));
		const first = await rowOf('seq-1');
		assert.equal([first.score, first.status, first.comment], [4, 'commented', 'The shipping box was open when it arrived and one cake was missing.'], 'the score, then the comment, in one poll');
		const second = await rowOf('seq-2');
		assert.equal([second.score, second.status, second.reasks], [7, 'answered', 1], 'an unclear answer, then a score: the re-ask did not cost the survey');
		const sends = await sendsSince(mark);
		assert.equal(to(sends, OWNER).map((s) => s.key), ['nps-owner_alert-seq-1', 'nps-owner_comment-seq-1', 'nps-owner_card-seq-1'], 'the owner: the alert, the comment, the card (every text goes out before the card)');
		await reset();
	});
	await t.step('chat that has nothing to do with a survey is never answered: strangers, closed surveys, the owner, groups, voice notes, our own messages', async () => {
		await asking('ign-1', 1);
		await put({ order_id: 'ign-closed', customer_name: 'Closed', phone: phone(2), status: 'closed', score: 9, category: 'promoter' });
		const mark = await t.mock.mark();
		const own = (await t.mock.events()).filter((e) => (e.type === 'message.sent' || e.type === 'message.replied') && e.data.direction === 'outbound');
		const events = [
			await incoming(phone(30), '9'),
			await incoming(phone(2), '9'),
			await incoming(phone(2), 'where is my order?'),
			await incoming(OWNER, '9'),
			await incoming(phone(1), '9', { group: { name: 'Neighbours' } }),
			await incoming(phone(1), '', { audio: { transcript: 'nine', language: 'en' } }),
			...own,
		];
		const execution = await poll(...events);
		ok(execution);
		assert.ok(!execution.ran('Read the whole message'), 'no message was even read');
		assert.count(await sendsSince(mark), 0, 'nothing was sent');
		const row = await rowOf('ign-1');
		assert.equal([row.status, row.score, row.reasks], ['asked', null, 0], 'the open survey did not change');
		assert.equal((await rowOf('ign-closed')).status, 'closed', 'neither did the closed one');
		await reset();
	});

	await t.step('a reply whose text expired is never read as an answer: nothing is sent, the survey stays, and it closes by itself after close_after_days', async () => {
		await asking('exp-1', 1);
		await put({ order_id: 'exp-2', customer_name: 'Bruno Costa', phone: phone(2), status: 'answered', score: 3, category: 'detractor', asked_at: minutesAgo(90), answered_at: minutesAgo(60), message_id: 'msg_seed_exp-2' });
		const e1 = await incoming(phone(1), '9');
		const e2 = await incoming(phone(2), 'It arrived broken and nobody helped me with the refund at all.');
		const gone = (event) => t.mock.fault({ method: 'GET', path: `/messages/${event.data.id}$`, status: 200, body: { id: event.data.id, content_type: 'text', content_expired: true, preview: '', text: '' }, times: 2 });
		await gone(e1);
		await gone(e2);
		let mark = await t.mock.mark();
		const execution = await poll(e1, e2);
		ok(execution);
		assert.ok(execution.ran('Read the whole message'), 'the full message was asked for');
		assert.count(await sendsSince(mark), 0, 'nobody was answered, not even with a re-ask');
		const first = await rowOf('exp-1');
		assert.equal([first.status, first.score, first.reasks, first.comment], ['asked', null, 0, ''], 'the open question did not change: no score, no re-ask');
		const second = await rowOf('exp-2');
		assert.equal([second.status, second.comment], ['answered', ''], 'neither did the survey that waits for a comment');
		await t.mock.clearFaults();
		// The poll can also carry the marker that replaces an expired preview: the message is not even read.
		const marked = structuredClone(await incoming(phone(1), '9'));
		marked.data.preview = '[content redacted: retention window expired]';
		mark = await t.mock.mark();
		const redacted = await poll(marked);
		ok(redacted);
		assert.ok(!redacted.ran('Read the whole message'), 'a marker preview is dropped before anything is read');
		assert.count(await sendsSince(mark), 0, 'nothing was sent');
		assert.equal((await rowOf('exp-1')).reasks, 0, 'and no re-ask was counted');
		// Nothing of it is lost for good: the survey closes by itself.
		await patchRow('exp-1', { asked_at: daysAgo(8) });
		ok(await timer());
		assert.equal([(await rowOf('exp-1')).status, (await rowOf('exp-1')).note], ['closed', 'no answer in 7 days'], 'closed after close_after_days');
		// A readable answer afterwards is still read.
		ok(await hears(phone(2), 'It arrived broken and nobody helped me with the refund at all.'));
		assert.equal((await rowOf('exp-2')).status, 'commented', 'a reply that can be read is handled as before');
		await reset();
	});
	await t.step('a sender whose number is hidden cannot be matched to a survey: ignored, nothing read, nothing sent', async () => {
		await asking('hid-1', 1);
		const event = structuredClone(await incoming(phone(1), '9'));
		delete event.data.from.number;
		const mark = await t.mock.mark();
		const execution = await poll(event);
		ok(execution);
		assert.ok(!execution.ran('Read the whole message'), 'not even read');
		assert.count(await sendsSince(mark), 0, 'nothing was sent');
		assert.equal([(await rowOf('hid-1')).status, (await rowOf('hid-1')).score], ['asked', null], 'the survey did not change');
		await reset();
	});
	await t.step('number_alias: the questions go out from that number, replies to another number are ignored, an alias and a num_ id both work', async () => {
		const sales = await t.mock.addNumber({ alias: 'sales', number: '+5511977770088', name: 'Sales' });
		await asking('num-1', 1);
		const mark = await t.mock.mark();
		// main is the number: a reply written to the other number is not an answer.
		const other = await incoming(phone(1), '9', { number: 'sales' });
		const execution = await poll(other);
		ok(execution);
		assert.ok(!execution.ran('Read the whole message'), 'a reply to another number is not even read');
		assert.equal((await rowOf('num-1')).score, null, 'the survey is waiting still');
		// The setting names the other number.
		await configure({ number_alias: 'sales' });
		ok(await poll(await incoming(phone(1), '9', { number: 'main' })));
		assert.equal((await rowOf('num-1')).score, null, 'now a reply to main is ignored');
		ok(await poll(other));
		assert.equal((await rowOf('num-1')).score, 9, 'a reply to the number in number_alias is read');
		let sends = await t.mock.sends({ since: mark });
		assert.ok(sends.length === 1 && sends[0].path.includes('/numbers/sales/'), `the thank you left from sales (${sends.map((s) => s.path)})`);
		// The question too, and the owner alert; also by the num_ id.
		await configure({ number_alias: sales.id });
		await queue('num-2', 2, { due_at: hoursAgo(1) });
		const mark2 = await t.mock.mark();
		ok(await timer());
		sends = await t.mock.sends({ since: mark2 });
		assert.ok(sends.length === 1 && sends[0].path.includes(`/numbers/${sales.id}/`), 'the question left from the number given by its num_ id');
		ok(await poll(await incoming(phone(2), '2', { number: 'sales' })));
		assert.equal((await rowOf('num-2')).score, 2, 'a reply to that number is read by the id too');
		await configure({ number_alias: 'main' });
		await reset();
	});

	// ---------------------------------------------------------------- opt-out
	await t.step('STOP, PARAR and SAIR opt the customer out: confirmed once, the open and queued surveys stop, new orders are skipped', async () => {
		await asking('opt-1', 1);
		await queue('opt-2', 1, { due_at: daysAgo(-1) });
		let mark = await t.mock.mark();
		ok(await hears(phone(1), ' Stop! '));
		let sends = await sendsSince(mark);
		assert.equal(sends.map((s) => [s.to, s.text, s.key]), [[phone(1), 'Done. We will not ask you again.', `nps-stop-${phone(1).slice(1)}`]], 'ONE confirmation');
		assert.equal([(await rowOf('opt-1')).status, (await rowOf('opt-2')).status, (await rowOf('opt-1')).note], ['opted_out', 'opted_out', 'asked to stop'], 'both rows are opted out');
		mark = await t.mock.mark();
		ok(await hears(phone(1), 'stop'));
		assert.count(await sendsSince(mark), 0, 'a second STOP is not confirmed again');
		ok(await order(orderBody('opt-3')));
		const skipped = await rowOf('opt-3');
		assert.equal([skipped.status, skipped.note], ['skipped', 'the customer opted out'], 'a new order of that customer is skipped, with the reason');
		await patchRow('opt-3', { due_at: hoursAgo(1) });
		mark = await t.mock.mark();
		ok(await timer());
		assert.count(await sendsSince(mark), 0, 'and nothing is ever asked');
		await reset();
		await asking('opt-4', 2);
		ok(await hears(phone(2), 'PARAR'));
		assert.equal((await rowOf('opt-4')).status, 'opted_out', 'PARAR');
		await asking('opt-5', 3);
		mark = await t.mock.mark();
		ok(await hears(phone(3), 'Sair'));
		assert.equal((await rowOf('opt-5')).status, 'opted_out', 'Sair');
		assert.equal(to(await sendsSince(mark), phone(3)).map((s) => s.text), ['Done. We will not ask you again.'], 'confirmed');
		await reset();
	});
	await t.step('STOP also works after the survey is finished (a marker row remembers it), a stranger is ignored, STOP inside a sentence is not STOP', async () => {
		await put({ order_id: 'fin-1', customer_name: 'Davi Lima', phone: phone(4), status: 'closed', score: 10, category: 'promoter' });
		let mark = await t.mock.mark();
		ok(await hears(phone(4), 'stop'));
		assert.equal(to(await sendsSince(mark), phone(4)).map((s) => s.text), ['Done. We will not ask you again.'], 'confirmed');
		const marker = await rowOf(`optout-${phone(4).slice(1)}`);
		assert.equal([marker.status, marker.phone, marker.customer_name], ['opted_out', phone(4), 'Davi Lima'], 'a marker row');
		ok(await order(orderBody('fin-2', { phone: phone(4) })));
		assert.equal((await rowOf('fin-2')).status, 'skipped', 'the next order of that customer is skipped');
		mark = await t.mock.mark();
		ok(await hears(phone(31), 'stop'));
		assert.count(await sendsSince(mark), 0, 'a stranger is not answered');
		await asking('fin-3', 5);
		mark = await t.mock.mark();
		ok(await hears(phone(5), 'please stop calling me about this'));
		assert.equal(to(await sendsSince(mark), phone(5)).map((s) => s.text), [REASK], 'STOP is a whole message: inside a sentence it is just an unclear answer');
		await reset();
	});
	await t.step('the words that opt out are a setting', async () => {
		await configure({ optout_words: 'basta' });
		await asking('ow-1', 1);
		const mark = await t.mock.mark();
		ok(await hears(phone(1), 'Basta'));
		assert.equal((await rowOf('ow-1')).status, 'opted_out', 'the word from the settings');
		await asking('ow-2', 2);
		ok(await hears(phone(2), 'stop'));
		assert.equal([(await rowOf('ow-2')).status, (await rowOf('ow-2')).reasks], ['asked', 1], 'the old word no longer stops it');
		assert.ok((await sendsSince(mark)).length === 2, 'one confirmation, one re-ask');
		await configure({ optout_words: exported.optout_words });
		await reset();
	});

	await t.step('the default opt-out words (English and Portuguese) all stop the questions; a sentence with one gets the re-ask that tells how to stop', async () => {
		const words = ['unsubscribe', 'Pare', 'cancelar', 'Descadastrar!', 'para', 'STOP', 'Sair'];
		for (const [i, word] of words.entries()) await asking(`dw-${i}`, 10 + i);
		const mark = await t.mock.mark();
		for (const [i, word] of words.entries()) ok(await hears(phone(10 + i), word));
		for (const [i, word] of words.entries()) assert.equal((await rowOf(`dw-${i}`)).status, 'opted_out', `${word} opts out`);
		assert.count(await sendsSince(mark), words.length, 'one confirmation each');
		await reset();
		await asking('dw-s', 1);
		const again = await t.mock.mark();
		ok(await hears(phone(1), 'please stop messaging me'));
		const sends = await sendsSince(again);
		assert.equal(sends.map((s) => s.text), [REASK], 'a phrase is an unclear answer: one re-ask, which says how to stop');
		assert.ok(/STOP/.test(sends[0].text), 'the re-ask names STOP');
		assert.equal((await rowOf('dw-s')).status, 'asked', 'not an opt-out');
		await reset();
	});

	// ---------------------------------------------------------------- the whole way, from the order to the owner
	await t.step('from the order to the end: queued, asked by the timer, answered, commented, nothing is sent twice', async () => {
		const mark = await t.mock.mark();
		ok(await order(orderBody('e2e-1', { customer_name: 'Gabi Neves', phone: phone(8), status: 'delivered', order_url: 'https://shop.example.com/e2e-1' })));
		await patchRow('e2e-1', { due_at: hoursAgo(1) });
		ok(await timer());
		ok(await hears(phone(8), 'Honestly a 5'));
		ok(await hears(phone(8), 'The packaging was damaged and the card with my name was wrong.'));
		ok(await timer());
		ok(await timer());
		const sends = await sendsSince(mark);
		assert.equal(sends.map((s) => s.key), ['nps-question-e2e-1', 'nps-owner_alert-e2e-1', 'nps-detractor-e2e-1', 'nps-owner_card-e2e-1', 'nps-owner_comment-e2e-1', 'nps-comment_thanks-e2e-1'], 'six messages, in this order, each with its own key');
		assert.count(distinct(sends), 6, 'no message was sent twice');
		const row = await rowOf('e2e-1');
		assert.equal([row.status, row.score, row.category], ['commented', 5, 'detractor'], 'finished');
		await reset();
	});

	// ---------------------------------------------------------------- the weekly report
	await t.step('the weekly report: counts, response rate, NPS, the three latest unhappy comments, failures and bad phones, first names only, once per week', async () => {
		let mark = await t.mock.mark();
		ok(await week());
		let sends = await sendsSince(mark);
		assert.count(sends, 1, 'one message');
		assert.equal(sends[0].to, OWNER, 'to the owner');
		assert.equal(sends[0].text, 'NPS report, last 7 days\nQuestions sent: 0\nAnswers: 0 (0% of the questions sent)\nNPS: n/a\nPromoters 0, passives 0, detractors 0\nLatest unhappy comments:\nnone\nNot sent: none\nSkipped, bad phone: none', 'an empty week says so');
		const marker = (await t.tables.rows(TABLE)).find((r) => r.order_id.startsWith('report-'));
		assert.match(marker.order_id, /^report-\d{4}-W\d{2}$/, 'the report is recorded as a row of this week');
		assert.match(sends[0].key, new RegExp(`^nps-report-${marker.order_id.slice(7)}-[0-9a-f]+$`), 'the key is built from the week and the text');
		mark = await t.mock.mark();
		ok(await week());
		assert.count(await sendsSince(mark), 0, 'a second run in the same week sends nothing');
		await t.tables.remove(TABLE, { order_id: marker.order_id });

		const answered = (id, who, score, category, ago, comment = '', extra = {}) => put({ order_id: id, customer_name: NAME[who] ?? 'Customer', phone: phone(who), status: comment ? 'commented' : 'closed', score, category, comment, asked_at: hoursAgo(ago + 2), answered_at: hoursAgo(ago), ...extra });
		await answered('rp-1', 1, 10, 'promoter', 5);
		await answered('rp-2', 2, 9, 'promoter', 30, 'Lovely');
		await answered('rp-3', 3, 9, 'promoter', 50);
		await answered('rp-4', 4, 8, 'passive', 60, 'Could be faster');
		await answered('rp-5', 5, 2, 'detractor', 10, 'Crushed box one');
		await answered('rp-6', 6, 5, 'detractor', 20, 'Late delivery two');
		await answered('rp-7', 7, 0, 'detractor', 40, 'Rude answer three');
		await answered('rp-8', 8, 6, 'detractor', 80, 'Wrong item four');
		await answered('rp-9', 9, 1, 'detractor', 90);
		await answered('rp-old', 11, 0, 'detractor', 24 * 8, 'Too old to count');
		await asking('rp-open', 12, { asked_at: hoursAgo(3) });
		await asking('rp-open2', 13, { asked_at: hoursAgo(100) });
		await put({ order_id: 'rp-fail-1', customer_name: 'Failed One', phone: phone(14), status: 'send_failed', note: 'question not sent: x', created_at: hoursAgo(20) });
		await put({ order_id: 'rp-fail-2', customer_name: 'Failed Two', phone: phone(15), status: 'send_failed', note: 'question not sent: x', created_at: hoursAgo(30) });
		await put({ order_id: 'rp-bad-1', customer_name: 'Bad Phone', phone: '', status: 'skipped', note: 'invalid phone (not digits): abc', created_at: hoursAgo(10) });
		await put({ order_id: 'rp-skip', customer_name: 'Other', phone: phone(16), status: 'skipped', note: 'the customer opted out', created_at: hoursAgo(10) });
		await put({ order_id: 'optout-5511977770017', customer_name: 'Marker', phone: phone(17), status: 'opted_out', score: 3, category: 'detractor', comment: 'must not count', answered_at: hoursAgo(1), asked_at: hoursAgo(2) });
		mark = await t.mock.mark();
		ok(await week());
		sends = await sendsSince(mark);
		assert.count(sends, 1, 'one report');
		const text = sends[0].text;
		// 11 questions in the window: the nine answered rows and the two open ones (3 h and 100 h ago). The row that is
		// 8 days old, the failed and skipped rows and the marker rows are not counted.
		assert.equal(
			text,
			[
				'NPS report, last 7 days',
				'Questions sent: 11',
				'Answers: 9 (82% of the questions sent)',
				'NPS: -22',
				'Promoters 3, passives 1, detractors 5',
				'Latest unhappy comments:',
				'- Eva (2/10): Crushed box one',
				'- Fabio (5/10): Late delivery two',
				'- Customer (0/10): Rude answer three',
				'Not sent: 2 (orders rp-fail-1, rp-fail-2)',
				'Skipped, bad phone: 1 (orders rp-bad-1)',
			].join('\n'),
			'the report',
		);
		assert.ok(!/\+?\d{8,}/.test(text), 'no phone number appears in the report');
		assert.ok(!text.includes('Too old to count') && !text.includes('must not count'), 'old answers and marker rows do not count');
		assert.equal((await t.tables.rows(TABLE)).filter((r) => r.order_id.startsWith('report-')).length, 1, 'the report row was written again');
		await reset();
	});
	await t.step('a refused weekly report fails the run naming the report, and is not sent twice in the week', async () => {
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 409, body: { error: 'number_not_connected' }, times: 1 });
		const execution = await week();
		failed(execution, /^Some messages were not sent\. report for the weekly report was not sent to the owner: /);
		const marker = (await t.tables.rows(TABLE)).find((r) => r.order_id.startsWith('report-'));
		assert.match(marker.note, /report to the owner not sent/, 'the row records it');
		await reset();
	});

	await t.step('the weekly clean-up (purge_days): old closed, skipped and failed rows and status notes go; a STOP, open surveys and recent rows stay; 0 switches it off', async () => {
		const old = daysAgo(200);
		const recent = daysAgo(100);
		await put({ order_id: 'pg-closed', customer_name: 'Old Closed', phone: phone(1), status: 'closed', score: 9, category: 'promoter', created_at: old });
		await put({ order_id: 'pg-commented', customer_name: 'Old Commented', phone: phone(2), status: 'commented', score: 2, category: 'detractor', comment: 'old words', created_at: old });
		await put({ order_id: 'pg-skipped', status: 'skipped', note: 'x', created_at: old });
		await put({ order_id: 'pg-failed', customer_name: 'Old Failed', phone: phone(3), status: 'send_failed', created_at: old });
		await put({ order_id: 'status-05', status: 'skipped', note: 'order x: status "paid" does not start a survey', created_at: old });
		await put({ order_id: 'report-2025-W01', customer_name: 'Weekly report', status: 'closed', created_at: old });
		await put({ order_id: 'pg-stop', customer_name: 'Old Stop', phone: phone(4), status: 'opted_out', note: 'asked to stop', created_at: old });
		await put({ order_id: `optout-${phone(5).slice(1)}`, customer_name: 'Marker', phone: phone(5), status: 'opted_out', created_at: old });
		await put({ order_id: 'pg-asked', customer_name: 'Still Open', phone: phone(6), status: 'asked', asked_at: minutesAgo(5), created_at: old });
		await put({ order_id: 'pg-recent', customer_name: 'Recent Closed', phone: phone(7), status: 'closed', score: 8, category: 'passive', created_at: recent });
		const mark = await t.mock.mark();
		ok(await week());
		const isThisWeeksReport = (id) => /^report-\d{4}-W\d\d$/.test(id) && id !== 'report-2025-W01';
		const left = (await t.tables.rows(TABLE)).map((r) => r.order_id).filter((id) => !isThisWeeksReport(id)).sort();
		assert.equal(left, ['optout-' + phone(5).slice(1), 'pg-asked', 'pg-recent', 'pg-stop'].sort(), "only what must stay is left (this week's own report row is not counted)");
		assert.count(await sendsSince(mark), 1, 'the report still went out once');
		// purge_days 0 deletes nothing.
		await configure({ purge_days: 0 });
		await put({ order_id: 'pg-keep', customer_name: 'Kept', phone: phone(8), status: 'closed', created_at: old });
		const thisWeek = (await t.tables.rows(TABLE)).find((r) => isThisWeeksReport(r.order_id));
		await t.tables.remove(TABLE, { order_id: thisWeek.order_id });
		ok(await week());
		assert.ok(await rowOf('pg-keep'), 'purge_days 0 never deletes');
		await configure({ purge_days: 180 });
		await reset();
	});

	// ---------------------------------------------------------------- live
	// From here the workflow is ACTIVE: real HTTP requests, the real poller (every 5 minutes) and the real 30 minute timer.
	/** Finished runs that were not started by hand, newer than a mark, with the nodes they ran. */
	const liveRuns = async (since) => {
		const list = (await t.n8n.listExecutions(t.workflow.id)).filter((e) => Number(e.id) > since && e.mode !== 'manual' && ['success', 'error'].includes(e.status));
		return Promise.all(list.map((e) => t.execution(e.id)));
	};
	await t.step('live: the real webhook refuses a request without the header or with a wrong one (403 both), and the wrong method, and starts no run', async () => {
		await reset();
		await t.activate();
		const mark = await t.executionMark();
		const none = await t.callWebhook(HOOK, { body: orderBody('http-1') });
		assert.equal(none.status, 403, `no header: ${JSON.stringify(none.body)}`);
		const wrong = await t.callWebhook(HOOK, { body: orderBody('http-1'), headers: { 'X-Order-Token': 'not-the-token' } });
		assert.equal(wrong.status, 403, `a wrong value: ${JSON.stringify(wrong.body)}`);
		assert.equal(wrong.body, none.body, 'the same answer: nothing tells which part was wrong');
		const otherHeader = await t.callWebhook(HOOK, { body: orderBody('http-1'), headers: { Authorization: `Bearer ${TOKEN}` } });
		assert.equal(otherHeader.status, 403, 'the token in another header is refused too');
		const get = await t.callWebhook(HOOK, { method: 'GET', headers: { 'X-Order-Token': TOKEN } });
		assert.ok([404, 405].includes(get.status), `GET is not accepted (${get.status})`);
		await t.sleep(4000);
		assert.count((await liveRuns(mark)).filter((r) => r.ran(HOOK)), 0, 'a refused request starts no run');
		assert.count(await t.tables.rows(TABLE), 0, 'and stores nothing');
	});
	await t.step('live: a real request queues the order, answers 200 at once, the same request again changes nothing, a very long text is cut', async () => {
		const res = await t.callWebhook(HOOK, { body: orderBody('http-2', { customer_name: `Ana ${'x'.repeat(5000)}`, items: ['Cake'] }), headers: { 'X-Order-Token': TOKEN } });
		assert.equal(res.status, 200, 'the shop gets its answer');
		await t.waitFor(async () => rowOf('http-2'), { timeoutMs: 60_000, message: 'the row' });
		assert.equal((await rowOf('http-2')).customer_name.length, 100, 'a very long name was cut to 100 characters');
		const since = await t.executionMark();
		const again = await t.callWebhook(HOOK, { body: orderBody('http-2'), headers: { 'X-Order-Token': TOKEN } });
		assert.equal(again.status, 200, 'accepted');
		await t.waitFor(async () => (await liveRuns(since)).some((r) => r.ran(HOOK)), { timeoutMs: 60_000, message: 'the second run' });
		assert.count(await t.tables.rows(TABLE, { where: { order_id: 'http-2' } }), 1, 'still one row');
	});
	await t.step('live: the real poller reads a reply and the whole survey goes on; our own messages are ignored', async () => {
		await patchRow('http-2', { status: 'asked', asked_at: minutesAgo(5), message_id: 'msg_seed_http', due_at: hoursAgo(1) });
		const mark = await t.mock.mark();
		const since = await t.executionMark();
		await incoming(phone(1), '3');
		await t.waitFor(async () => (await rowOf('http-2')).score === 3, { timeoutMs: 400_000, message: 'the poller (every 5 minutes) to read the reply' });
		await t.waitFor(async () => (await sendsSince(mark)).length >= 3, { timeoutMs: 120_000, message: 'the alert, the card and the apology' });
		await t.waitFor(async () => (await liveRuns(since)).some((r) => r.ran(POLL)), { timeoutMs: 120_000, message: 'the run of the poller to finish' });
		await t.sleep(330_000); // longer than one poll tick (5 minutes)
		const count = distinct(await sendsSince(mark)).length;
		assert.equal(count, 3, 'the echo of our own messages started nothing more');
	});
	await t.step('live: a reply written while the workflow was switched off is read when it is switched on again', async () => {
		await t.deactivate();
		await t.sleep(2000);
		const mark = await t.mock.mark();
		const comment = 'The box was crushed and the card was wrong, I wrote twice and nobody answered.';
		await incoming(phone(1), comment);
		await t.sleep(4000);
		assert.equal((await rowOf('http-2')).status, 'answered', 'nothing happens while it is off');
		await t.activate();
		await t.waitFor(async () => (await rowOf('http-2')).status === 'commented', { timeoutMs: 400_000, message: 'the first poll after switching on' });
		assert.equal((await rowOf('http-2')).comment, comment, 'the reply was not lost, and it is complete');
		await t.waitFor(async () => (await sendsSince(mark)).length >= 2, { timeoutMs: 30_000, message: 'the forward and the thanks' });
		assert.equal(to(await sendsSince(mark), OWNER).length, 1, 'the owner got the comment once');
	});
	await t.step('live: the real 30 minute timer asks a survey that is due', async () => {
		await configure({ cooldown_days: 0 });
		await queue('timer-1', 2, { due_at: hoursAgo(1) });
		const mark = await t.mock.mark();
		const since = await t.executionMark();
		await t.waitFor(async () => (await rowOf('timer-1')).status === 'asked', { timeoutMs: 33 * 60_000, message: 'the 30 minute timer to ask the survey' });
		assert.equal(to(await sendsSince(mark), phone(2)).map((s) => s.key), ['nps-question-timer-1'], 'asked once, by the clock');
		await t.waitFor(async () => (await liveRuns(since)).some((r) => r.ran(TIMER)), { timeoutMs: 120_000, message: 'the timer run to finish' });
		assert.ok((await liveRuns(since)).some((r) => r.ran(TIMER)), 'the timer started the run');
		await configure({ cooldown_days: 30 });
	});
	await t.step('live: switch off again', () => t.deactivate());
}
