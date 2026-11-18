/**
 * Template T4: on-call alerts that escalate on WhatsApp until someone answers.
 *
 * The workflow is imported exactly as exported. The Header Auth credential is the only thing created before the
 * import (the harness creates the Turbo Notify one). The Data Table is created BY THE WORKFLOW, by running its own
 * "Run once" branch, and the Data Table nodes find it by name.
 *
 * The phone numbers in the exported settings are placeholders on purpose, so the first steps prove that the
 * workflow refuses to page anybody as exported. Then the values a person must type (the on-call numbers and the
 * owner) are typed the way a person would, through the stored workflow. A few steps change one more setting
 * (small limits, other field names) and put it back. Nothing else is patched.
 *
 * How each entry point is reached:
 *  - the alert branches run from the Webhook node with a pinned request (the harness cannot start a webhook
 *    manually); the Header Auth behaviour (401, 403, the real HTTP request) is proven in the live block at the end;
 *  - the reply branches run from the Polling Trigger with events taken from the mock's own event feed;
 *  - the escalation branches run from the Schedule Trigger by hand. The clock is moved by writing older
 *    timestamps into the table (a person could do the same); ack_minutes stays at its exported value of 5.
 * The last block activates the workflow: real HTTP calls, the real poller, the real minute timer, and a reply that
 * is written while the workflow is switched off.
 *
 * Timing: a level is due ack_minutes (5) plus one minute of grace after its page, so the helpers age a row by 7
 * minutes to make the timer fire, and 5.5 minutes to prove the grace. Races are made on purpose: the mock answers
 * after a delay (latencyMs) so that a timer run is still sending while a poll run or a webhook run writes the same
 * row. Because the send nodes try a refused first message three times, a refusal that must stay a refusal is
 * injected three times (times: 3), and a failure that must be recovered is injected once.
 */
export const timeoutMs = 40 * 60_000;
export const credentials = [{ type: 'httpHeaderAuth', name: 'Alert access (Header Auth)', data: { name: 'X-Alert-Token', value: 'harness-alert-token-0001' } }];

const HOOK = 'Receive an alert';
const POLL = 'Poll WhatsApp replies';
const TIMER = 'Every minute: look for unanswered alerts';
const TOKEN = 'harness-alert-token-0001';
const P = { owner: '+5511977770020', l1: '+5511977770021', l2: '+5511977770022', l3: '+5511977770023', stranger: '+5511977770029' };
const NAMES = { [P.l1]: 'Ana Level One', [P.l2]: 'Bruno Level Two', [P.l3]: 'Carla Level Three', [P.stranger]: 'Dario Stranger' };
const CODE = /^[2-9A-HJKMNP-Z]{4}$/;
// The same small hash, code and key as the workflow: the scenario recomputes them to prove they are deterministic.
const hash = (value) => {
	let h = 5381;
	for (const char of String(value)) h = (Math.imul(h, 33) + char.codePointAt(0)) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
	return (h ^ (h >>> 12)) >>> 0;
};
const ALPHABET = '23456ABCDEFGHJKMNPQRSTUVWXYZ789';
const codeFor = (seed) => {
	let n = hash(seed) % ALPHABET.length ** 4;
	return Array.from({ length: 4 }, () => {
		const char = ALPHABET[n % ALPHABET.length];
		n = Math.floor(n / ALPHABET.length);
		return char;
	}).join('');
};
/** The idempotency key of an incident without its suffix: the alert, a hash of its id and the minute it opened. */
const keyBase = (row) => `oncall-${row.alert_id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}-${hash(row.alert_id).toString(36)}-${Math.floor(Date.parse(row.opened_at) / 60000)}`;

export default async function scenario(t) {
	const { assert } = t;

	// ---------------------------------------------------------------- helpers
	const alertBody = (id, extra = {}) => ({ alert_id: id, service: `service-${id}`, severity: 'critical', status: 'firing', message: `message of ${id}`, ...extra });
	/** Runs the workflow from the Webhook node with this request. */
	const fire = (body, headers = {}) => t.run(HOOK, { pin: { [HOOK]: [{ headers, params: {}, query: {}, body }] } });
	const tick = () => t.run(TIMER);
	const rowOf = async (id) => (await t.tables.rows('oncall_alerts', { where: { alert_id: id } }))[0];
	const patchRow = (id, patch) => t.tables.update('oncall_alerts', { alert_id: id }, patch);
	const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
	/** Moves the clock for one alert: its current level was paged this many minutes ago. */
	const age = (id, minutes) => patchRow(id, { notified_at: minutesAgo(minutes) });
	/**
	 * A new incident of the same alert always opens at least a minute after the last one (reopen_minutes is never
	 * below one minute, rearm_hours is hours), so its idempotency key, which holds the minute, is new. The scenario
	 * moves the timestamps of the row but not the real clock, so it waits for the next minute where it matters.
	 */
	const nextMinute = () => t.sleep(60_000 - (Date.now() % 60_000) + 500);
	/** A person writes to the number: the event is taken from the events feed exactly as the API serves it. */
	const incoming = async (from, text, options = {}) => {
		const injected = await t.mock.injectMessage({ from, name: NAMES[from] ?? 'Somebody', text, ...options });
		const event = (await t.mock.events()).find((e) => e.id === injected.event_id);
		assert.ok(event, `the mock holds the event ${injected.event_id}`);
		return event;
	};
	const poll = (...events) => t.run(POLL, { pin: { [POLL]: events } });
	/** The messages the workflow sent since a mark: recipient, text, button, key and the id of the message. */
	const sendsSince = async (mark) =>
		(await t.mock.sends({ since: mark })).map((s) => ({
			to: s.to?.number,
			text: s.content?.text ?? s.content?.body,
			button: s.content?.url_button,
			interactive: s.content?.interactive_type,
			key: s.idempotencyKey,
			id: s.messageId,
		}));
	const distinct = (sends) => [...new Map(sends.map((s) => [s.id, s])).values()];
	const to = (sends, phone) => sends.filter((s) => s.to === phone);
	const configure = async (values) => {
		const current = await t.n8n.rest('GET', `/rest/workflows/${t.workflow.id}`);
		const nodes = structuredClone(current.nodes);
		const settings = nodes.find((n) => n.name === 'Your settings');
		for (const assignment of settings.parameters.assignments.assignments) if (assignment.name in values) assignment.value = values[assignment.name];
		await t.n8n.rest('PATCH', `/rest/workflows/${t.workflow.id}`, { nodes, versionId: current.versionId });
	};
	const exported = Object.fromEntries(t.workflow.node('Your settings').parameters.assignments.assignments.map((a) => [a.name, a.value]));
	const real = { oncall_phone_1: P.l1, oncall_phone_2: P.l2, oncall_phone_3: P.l3, owner_phone: P.owner };
	const levels = { ...real };
	const ok = (execution) => assert.equal(execution.status, 'success', execution.describe());
	const failed = (execution, pattern, message) => {
		assert.equal(execution.status, 'error', message ?? 'the run fails loudly');
		assert.match(execution.error?.message ?? '', pattern, message ?? 'the error says why');
	};
	/** Opens an alert (level 1 is paged) and returns its row. */
	const open = async (id, extra = {}) => {
		ok(await fire(alertBody(id, extra)));
		const row = await rowOf(id);
		assert.ok(row, `the row of ${id} exists`);
		return row;
	};
	/** Pages the next level by moving the clock past ack_minutes (5) and the minute of grace, as the minute timer would. */
	const escalate = async (id) => {
		await age(id, 7);
		ok(await tick());
	};

	// ---------------------------------------------------------------- the exported file
	await t.step('as exported: placeholders, Header Auth on the webhook, the explanations on the canvas', async () => {
		assert.equal(exported.oncall_phone_1, '+55XXXXXXXXXXX', 'level 1 is a placeholder');
		assert.equal(exported.oncall_phone_2, '+55XXXXXXXXXXX', 'level 2 is a placeholder');
		assert.equal(exported.oncall_phone_3, '', 'level 3 starts empty');
		assert.equal(exported.owner_phone, '+55XXXXXXXXXXX', 'the owner is a placeholder');
		assert.equal(exported.ack_minutes, 5, 'ack_minutes');
			assert.equal(exported.reopen_minutes, 2, 'reopen_minutes');
			assert.equal('max_pages_per_alert' in exported, false, 'the redundant page limit is gone: the ladder is the limit');
			for (const name of ['Send the page with the runbook button', 'Send the text message']) {
				const send = t.workflow.node(name);
				assert.equal([send.retryOnFail, send.maxTries, send.waitBetweenTries, send.onError], [true, 3, 2000, 'continueRegularOutput'], `${name} is tried again when the first message of a batch fails`);
			}
			assert.ok(String(t.workflow.node('Your settings').notes).includes('NEVER the phone linked to Turbo Notify'), 'the notes say that the linked phone cannot be on call');
		const hook = t.workflow.node(HOOK);
		assert.equal(hook.parameters.authentication, 'headerAuth', 'the webhook requires Header Auth');
		assert.equal(hook.parameters.httpMethod, 'POST', 'POST only');
		assert.equal(hook.parameters.path, hook.webhookId, 'the address is the random webhook id, not a guessable name');
		assert.match(hook.webhookId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a random id');
		assert.equal(hook.credentials.httpHeaderAuth.name, 'Alert access (Header Auth)', 'the placeholder credential name');
		assert.equal(hook.parameters.responseMode, 'onReceived', 'the monitoring tool gets its answer at once');
		assert.equal(t.workflow.node(POLL).parameters.events, ['message.received', 'message.replied'], 'a quoted reply arrives as message.replied');
		const settings = t.workflow.node('Your settings');
		assert.equal(settings.notesInFlow, true, 'the explanations show on the canvas');
		for (const name of Object.keys(exported)) assert.ok(String(settings.notes).split('\n').some((line) => line.startsWith(`${name}:`)), `the note explains ${name}`);
		assert.equal(JSON.stringify(t.workflow.nodes).includes('pinData'), false, 'no pinned data');
		for (const text of ['msg_page', 'msg_escalated', 'msg_ack_confirm', 'msg_ack_note', 'msg_final', 'msg_resolved']) {
			assert.ok(![0x2013, 0x2014].some((code) => exported[text].includes(String.fromCharCode(code))), `${text} has no em or en dash`);
		}
	});

	// ---------------------------------------------------------------- the setup branch
	await t.step('the "Run once" branch creates the table and is safe to run twice', async () => {
		const first = await t.run('Run once: create the table');
		ok(first);
		assert.count(await t.tables.rows('oncall_alerts'), 0, 'the table exists and is empty');
		const second = await t.run('Run once: create the table');
		ok(second);
		assert.count(await t.tables.rows('oncall_alerts'), 0, 'running it again changes nothing');
		await t.tables.insert('oncall_alerts', { alert_id: 'kept', status: 'resolved' });
		ok(await t.run('Run once: create the table'));
		assert.count(await t.tables.rows('oncall_alerts'), 1, 'running it again keeps the rows');
		await t.tables.clear('oncall_alerts');
	});

	// ---------------------------------------------------------------- the guard
	await t.step('as exported the workflow refuses to page: the error names every number to change, nothing is sent or stored', async () => {
		const mark = await t.mock.mark();
		const alertRun = await fire(alertBody('guard-1'));
		failed(alertRun, /^Not ready to page anybody: /, 'an alert is refused');
		const message = alertRun.error.message;
		for (const part of ['oncall_phone_1 is not a real number', 'oncall_phone_2 is not a real number', 'owner_phone is not a real number']) assert.ok(message.includes(part), `the message says: ${part}`);
		assert.ok(!alertRun.ran('Find the alert in the table'), 'the alert was not even looked up');
		failed(await tick(), /Not ready to page anybody/, 'the minute timer is refused');
		failed(await poll(await incoming(P.l1, 'OK')), /Not ready to page anybody/, 'a reply is refused');
		assert.count(await sendsSince(mark), 0, 'nothing was sent');
		assert.count(await t.tables.rows('oncall_alerts'), 0, 'nothing was stored');
	});
	await t.step('each setting is checked on its own', async () => {
		const run = async () => (await fire(alertBody('guard-2'))).error?.message ?? '';
		await configure({ oncall_phone_1: '12345' });
		assert.ok((await run()).includes('oncall_phone_1 is not a real number'), 'a short number is refused');
		await configure({ oncall_phone_1: P.l1 });
		let message = await run();
		assert.ok(!message.includes('oncall_phone_1') && message.includes('oncall_phone_2'), 'then level 2');
		await configure({ oncall_phone_2: '' });
		message = await run();
		assert.ok(!message.includes('oncall_phone_2') && message.includes('owner_phone'), 'level 2 may be emptied: fewer levels are allowed');
		await configure({ oncall_phone_2: P.l1 });
		assert.ok((await run()).includes('two on-call levels hold the same number'), 'the same number twice is refused');
		await configure({ oncall_phone_2: P.l2, owner_phone: P.owner, ack_minutes: 0 });
		assert.ok((await run()).includes('ack_minutes must be a number above 0'), 'a wait of zero is refused');
		await configure({ ack_minutes: 5, min_severity: 'urgent' });
		assert.ok((await run()).includes('min_severity must be one of severity_order'), 'an unknown minimum severity is refused');
		await configure({ min_severity: 'warning', runbook_button_text: 'A button text that is far too long' });
		assert.ok((await run()).includes('runbook_button_text must be 1 to 20 characters'), 'a button text over 20 characters is refused');
		await configure({ runbook_button_text: 'Open runbook', ack_words: ' , ' });
		assert.ok((await run()).includes('ack_words is empty'), 'no acknowledgement word is refused');
		await configure({ ack_words: exported.ack_words, reopen_minutes: -1 });
			assert.ok((await run()).includes('reopen_minutes must be a number of 0 or more'), 'a negative reopen time is refused');
			await configure({ ...real, reopen_minutes: 0 });
		const mark = await t.mock.mark();
		const execution = await fire(alertBody('guard-ok'));
		ok(execution);
		assert.count(distinct(await sendsSince(mark)), 1, 'with real numbers the run goes on and pages level 1 (a reopen time of 0 is allowed)');
			await configure({ reopen_minutes: exported.reopen_minutes });
		await t.tables.clear('oncall_alerts');
	});

	// ---------------------------------------------------------------- level 1
	let first;
	await t.step('a new alert pages level 1 only: the text with the code and the instruction, the runbook button, the key, the row', async () => {
		const mark = await t.mock.mark();
		first = await open('db-down', { service: 'Database primary', severity: 'critical', message: 'Connections refused', runbook_url: 'https://example.com/runbooks/db-down' });
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'one message');
		const [page] = sends;
		assert.equal(page.to, P.l1, 'to level 1');
		assert.equal(page.interactive, 'cta_url', 'a link button message');
		assert.equal(page.button, { display_text: 'Open runbook', url: 'https://example.com/runbooks/db-down' }, 'the button opens the runbook');
		assert.equal(page.text, `ALERT [critical] Database primary: Connections refused\nReply OK ${first.short_code} to take it.\nhttps://example.com/runbooks/db-down`, 'the page text ends with the runbook link, so the button is a convenience');
		assert.equal(first.short_code, codeFor(`db-down|${Math.floor(Date.parse(first.opened_at) / 60000)}|0`), 'the code comes from the alert id and the minute, not from chance');
		assert.match(first.short_code, CODE, 'a 4 character code without 0 O 1 I L');
		assert.equal(page.key, `${keyBase(first)}-L1`, 'the key is built from the alert, the incident and the level');
		assert.ok(page.text.length <= 1000, 'a button message body stays under 1024 characters');
		assert.equal(
			{ status: first.status, level: first.level, phone: first.notified_phone, message_id: first.message_id, pages: first.pages, paged: first.paged_phones, error: first.last_error, by: first.acknowledged_by },
			{ status: 'open', level: 1, phone: P.l1, message_id: page.id, pages: 1, paged: P.l1, error: '', by: '' },
			'the row records the level, the phone, the message id and the pages',
		);
		assert.ok(Math.abs(Date.parse(first.notified_at) - Date.now()) < 60_000, 'notified_at is now');
		assert.equal(first.runbook_url, 'https://example.com/runbooks/db-down', 'the runbook is kept');
		assert.equal([first.service, first.severity, first.message], ['Database primary', 'critical', 'Connections refused'], 'service, severity and message');
		assert.count(to(await sendsSince(mark), P.l2), 0, 'level 2 heard nothing');
	});
	await t.step('an alert without a runbook link gets a plain text, and a link that is not http or https is dropped', async () => {
		const mark = await t.mock.mark();
		const row = await open('no-runbook');
		let sends = await sendsSince(mark);
		assert.equal(sends[0].interactive, undefined, 'no button');
		assert.equal(sends[0].text, `ALERT [critical] service-no-runbook: message of no-runbook\nReply OK ${row.short_code} to take it.`, 'the plain text');
		const bad = await open('bad-link', { runbook_url: 'javascript:alert(1)' });
		assert.equal(bad.runbook_url, '', 'a javascript link is dropped');
		const long = await open('long-link', { runbook_url: `https://example.com/${'a'.repeat(600)}` });
		assert.equal(long.runbook_url, '', 'a link over 500 characters is dropped');
		sends = await sendsSince(mark);
		assert.ok(sends.every((s) => s.interactive === undefined), 'no button for any of them');
		await t.tables.clear('oncall_alerts');
	});

	// ---------------------------------------------------------------- what is accepted
	await t.step('severity: below min_severity is ignored, an unknown or missing severity still pages', async () => {
		const mark = await t.mock.mark();
		ok(await fire(alertBody('low', { severity: 'info' })));
		assert.equal(await rowOf('low'), undefined, 'info is below warning: no row');
		assert.count(await sendsSince(mark), 0, 'and nothing is sent');
		ok(await fire(alertBody('warn', { severity: 'WARNING' })));
		assert.ok(await rowOf('warn'), 'warning (any capitals) pages');
		ok(await fire(alertBody('strange', { severity: 'banana' })));
		assert.ok(await rowOf('strange'), 'a severity the list does not know pages: never miss an alert');
		const noSeverity = alertBody('nosev');
		delete noSeverity.severity;
		ok(await fire(noSeverity));
		assert.equal((await rowOf('nosev')).severity, '', 'a missing severity is stored empty');
		assert.ok(distinct(await sendsSince(mark)).some((s) => /ALERT \[n\/a\] service-nosev/.test(s.text)), 'and shows as n/a in the page');
		await configure({ min_severity: 'critical' });
		ok(await fire(alertBody('warn2', { severity: 'warning' })));
		assert.equal(await rowOf('warn2'), undefined, 'with min_severity critical a warning is ignored');
		await configure({ min_severity: 'warning' });
		await t.tables.clear('oncall_alerts');
	});
	await t.step('field limits: long text is cut, control and direction characters are removed, nothing else is stored', async () => {
		const bidi = String.fromCharCode(0x202e, 0x200b, 0x2066);
		const body = alertBody('caps', { service: `S${'s'.repeat(200)}`, message: `${'m'.repeat(1000)}${bidi}`, severity: 'critical' });
		const mark = await t.mock.mark();
		const row = await open('caps', { service: body.service, message: body.message });
		assert.equal(row.service.length, 80, 'the service is cut at 80');
		assert.equal(row.message.length, 300, 'the message is cut at max_text_length (300)');
		const clean = await open('bidi', { message: `before${bidi}after`, service: `ser${String.fromCharCode(1)}vice` });
		assert.equal(clean.message, 'beforeafter', 'direction and zero-width characters are removed');
		assert.equal(clean.service, 'service', 'a control character is removed');
		const sends = await sendsSince(mark);
		assert.ok(sends.every((s) => s.text.length <= 1000), 'no page is longer than a button allows');
		await configure({ max_text_length: 20 });
		const short = await open('short', { message: 'x'.repeat(100) });
		assert.equal(short.message.length, 20, 'max_text_length is a setting');
		await configure({ max_text_length: 300 });
		await t.tables.clear('oncall_alerts');
	});
	await t.step('only a body that is not a JSON object, or an id over 100 characters, is rejected: nothing is stored or sent', async () => {
		const mark = await t.mock.mark();
		failed(await fire(alertBody('x'.repeat(101))), /holds an id longer than 100 characters/, 'an id over 100 characters');
		for (const [name, body] of [['an array', [1, 2]], ['a text', 'hello']]) {
			const execution = await t.run(HOOK, { pin: { [HOOK]: [{ headers: {}, params: {}, query: {}, body }] } });
			failed(execution, /has no JSON object in its body/, `${name}: the run fails`);
		}
		assert.count(await t.tables.rows('oncall_alerts'), 0, 'nothing was stored');
		assert.count(await sendsSince(mark), 0, 'nothing was sent');
	});
	await t.step('fail open: odd ids, no id, an unknown status and an empty object still page, and ids that differ only in punctuation keep their own keys', async () => {
		const mark = await t.mock.mark();
		const monitor = await open('Servidor São Paulo (prod) #1', { service: 'Servidor São Paulo' });
		assert.equal(monitor.status, 'open', 'accents, spaces, parentheses and a hash sign are fine in an id');
		const a = await open('Website (prod)');
		const b = await open('Website [prod]');
		const keys = (await sendsSince(mark)).map((x) => x.key);
		assert.equal(new Set(keys).size, 3, 'three pages, three different keys (the punctuation is kept apart by a hash of the id)');
		assert.ok(keys.every((key) => /^[A-Za-z0-9._-]+$/.test(key) && key.length <= 255), 'every key is plain and short');
		assert.ok(a.message_id && b.message_id, 'both were accepted by Turbo Notify, not refused as a key conflict');
		await t.tables.clear('oncall_alerts');
		const noId = { service: 'Nightly backup', severity: 'critical', message: 'backup failed' };
		const sinceNoId = await t.mock.mark();
		ok(await fire(noId));
		const autos = (await t.tables.rows('oncall_alerts')).map((r) => r.alert_id);
		assert.equal(autos.length, 1, 'one row');
		assert.match(autos[0], /^auto-[0-9a-z]+$/, 'the id was built from the service and the text');
		ok(await fire(noId));
		assert.count(distinct(await sendsSince(sinceNoId)), 1, 'the same service and text again is the same alert: no second page');
		ok(await fire({ ...noId, message: 'disk full' }));
		assert.count(await t.tables.rows('oncall_alerts'), 2, 'another text is another alert');
		const statusMark = await t.mock.mark();
		ok(await fire(alertBody('status-ok', { status: 'ok' })));
		assert.equal((await rowOf('status-ok')).status, 'open', 'an unknown status counts as firing: never miss an alert');
		assert.count(distinct(await sendsSince(statusMark)), 1, 'and pages');
		const emptyMark = await t.mock.mark();
		ok(await t.run(HOOK, { pin: { [HOOK]: [{ headers: {}, params: {}, query: {}, body: {} }] } }));
		assert.count(distinct(await sendsSince(emptyMark)), 1, 'an empty JSON object is still a firing alert with no id: it pages');
		await t.tables.clear('oncall_alerts');
	});
	await t.step('the field names are settings: another tool can map its own fields', async () => {
		await configure({ field_alert_id: 'fingerprint', field_service: 'host', field_severity: 'level', field_status: 'state', field_message: 'summary', field_runbook_url: 'playbook' });
		const mark = await t.mock.mark();
		ok(await fire({ fingerprint: 'fp-77', host: 'web-3', level: 'critical', state: 'FIRING', summary: 'Disk 97% full', playbook: 'https://example.com/pb' }));
		const row = await rowOf('fp-77');
		assert.equal([row.service, row.severity, row.message, row.runbook_url], ['web-3', 'critical', 'Disk 97% full', 'https://example.com/pb'], 'every field was read from its own name');
		assert.ok((await sendsSince(mark))[0].text.includes('web-3'), 'and paged');
		ok(await fire({ fingerprint: 'fp-77', state: 'Resolved' }));
		assert.equal((await rowOf('fp-77')).status, 'resolved', 'a resolved request needs only the id and the state');
		await configure({ field_alert_id: 'alert_id', field_service: 'service', field_severity: 'severity', field_status: 'status', field_message: 'message', field_runbook_url: 'runbook_url' });
		await t.tables.clear('oncall_alerts');
	});

	// ---------------------------------------------------------------- repeated firing
	await t.step('the same alert firing again sends nothing new, and does not change the row', async () => {
		const before = await open('repeat', { runbook_url: 'https://example.com/r' });
		const mark = await t.mock.mark();
		for (let i = 0; i < 3; i++) ok(await fire(alertBody('repeat', { runbook_url: 'https://example.com/r', message: 'another text' })));
		assert.count(await sendsSince(mark), 0, 'no message');
		const after = await rowOf('repeat');
		assert.equal([after.short_code, after.level, after.pages, after.message, after.opened_at], [before.short_code, 1, 1, before.message, before.opened_at], 'the row is untouched');
		assert.count(await t.tables.rows('oncall_alerts', { where: { alert_id: 'repeat' } }), 1, 'still one row');
	});

	// ---------------------------------------------------------------- acknowledgement
	await t.step('an acknowledgement with the code: marks the alert, tells the owner of the reply, tells the other levels already paged and nobody else', async () => {
		const row = await open('ack-code', { service: 'Queue', message: 'Backlog growing' });
		await escalate('ack-code'); // level 2 is paged too
		const mid = await t.mock.mark();
		const reply = await incoming(P.l2, `ok ${row.short_code.toLowerCase()}`);
		const execution = await poll(reply);
		ok(execution);
		const after = await rowOf('ack-code');
		assert.equal([after.status, after.acknowledged_by], ['acknowledged', P.l2], 'acknowledged by level 2');
		assert.ok(Math.abs(Date.parse(after.acknowledged_at) - Date.now()) < 60_000, 'when');
		const sends = await sendsSince(mid);
		assert.count(sends, 2, 'a confirmation and ONE note');
		assert.equal(to(sends, P.l2)[0].text, `Acknowledged, you own Queue (${row.short_code}).`, 'the confirmation to the person who answered');
		assert.equal(to(sends, P.l1)[0].text, `Bruno Level Two took Queue (${row.short_code}). You do not need to act.`, 'the note to level 1, with the name WhatsApp shows');
		assert.count(to(sends, P.l3), 0, 'level 3 was never paged and hears nothing');
		assert.count(to(sends, P.owner), 0, 'the owner is not told');
		// An acknowledged alert is never escalated again.
		await age('ack-code', 60);
		const timer = await t.mock.mark();
		ok(await tick());
		assert.count(await sendsSince(timer), 0, 'the timer leaves an acknowledged alert alone');
	});
	await t.step('an acknowledgement without a code takes the NEWEST open alert of that person, once', async () => {
		await t.tables.clear('oncall_alerts');
		const a = await open('plain-old');
		await patchRow('plain-old', { opened_at: minutesAgo(30) });
		const b = await open('plain-new');
		const mark = await t.mock.mark();
		ok(await poll(await incoming(P.l1, 'OK')));
		assert.equal((await rowOf('plain-new')).status, 'acknowledged', 'the newest alert is taken');
		assert.equal((await rowOf('plain-old')).status, 'open', 'the older one is not');
		const sends = await sendsSince(mark);
		assert.equal(sends[0].text, `Acknowledged, you own service-plain-new (${b.short_code}).`, 'the confirmation names the newest alert');
		// Two plain replies in one poll take one alert, not two.
		const events = [await incoming(P.l1, 'ok'), await incoming(P.l1, 'ok')];
		const mark2 = await t.mock.mark();
		const second = await poll(...events);
		ok(second);
		assert.equal((await rowOf('plain-old')).status, 'acknowledged', 'the older alert is taken now');
		assert.count(distinct(await sendsSince(mark2)), 1, 'one confirmation, not two: the second reply did not take another alert');
		assert.equal(a.status, 'open', 'sanity');
	});
	await t.step('with several open alerts the code picks the alert, even an older one', async () => {
		const old = await open('code-old');
		await patchRow('code-old', { opened_at: minutesAgo(40) });
		const fresh = await open('code-new');
		const mark = await t.mock.mark();
		ok(await poll(await incoming(P.l1, `Ok ${old.short_code}`)));
		assert.equal((await rowOf('code-old')).status, 'acknowledged', 'the code names the older alert');
		assert.equal((await rowOf('code-new')).status, 'open', 'the newer one stays open');
		assert.ok((await sendsSince(mark))[0].text.includes(old.short_code), 'the confirmation names the older alert');
		assert.equal(fresh.status, 'open', 'sanity');
	});
	await t.step('every acknowledgement word works, with capitals, accents and punctuation', async () => {
		await t.tables.clear('oncall_alerts');
		const wordsRun = [
			['ok', 'ok'], ['ack', 'ACK'], ['got it', 'Got it!'], ['visto', 'VISTO.'], ['ciente', 'Ciente'], ['ok', 'Ok, '], ['got it', 'got   it'],
		];
		for (const [index, [, text]] of wordsRun.entries()) {
			const id = `word-${index}`;
			const row = await open(id);
			ok(await poll(await incoming(P.l1, `${text} ${row.short_code}`.trim())));
			assert.equal((await rowOf(id)).status, 'acknowledged', `"${text} ${row.short_code}" takes the alert`);
		}
		await configure({ ack_words: 'roger, afirmativo' });
		const row = await open('custom-word');
		ok(await poll(await incoming(P.l1, 'ok')));
		assert.equal((await rowOf('custom-word')).status, 'open', 'a word that is not in ack_words does nothing');
		ok(await poll(await incoming(P.l1, 'Afirmativo')));
		assert.equal((await rowOf('custom-word')).status, 'acknowledged', 'a configured word works');
		assert.equal(row.status, 'open', 'sanity');
		await configure({ ack_words: exported.ack_words });
	});
	await t.step('anything else from a notified phone is ignored: chatter, a wrong code, two codes, a sticker, a message to a group', async () => {
		await t.tables.clear('oncall_alerts');
		const row = await open('chatter');
		const mark = await t.mock.mark();
		const events = [
			await incoming(P.l1, 'ok thanks I will look at it later'),
			await incoming(P.l1, 'hello'),
			await incoming(P.l1, 'ok ZZZZ'),
			await incoming(P.l1, `ok ${row.short_code} and more`),
			await incoming(P.l1, 'okay'),
			await incoming(P.l1, 'sticker', { image: { caption: 'ok' } }),
			await incoming(P.l1, 'ok', { group: { name: 'Ops group' } }),
		];
		ok(await poll(...events));
		assert.equal((await rowOf('chatter')).status, 'open', 'still open');
		assert.count(await sendsSince(mark), 0, 'no reply to chatter');
	});
	await t.step('a message from a phone that is not on the list, or not paged for the alert, is ignored', async () => {
		await t.tables.clear('oncall_alerts');
		const row = await open('who');
		const mark = await t.mock.mark();
		ok(await poll(await incoming(P.stranger, `OK ${row.short_code}`), await incoming(P.stranger, 'OK')));
		assert.equal((await rowOf('who')).status, 'open', 'an unlisted phone cannot take it');
		ok(await poll(await incoming(P.l3, `OK ${row.short_code}`), await incoming(P.l3, 'OK')));
		assert.equal((await rowOf('who')).status, 'open', 'level 3 was never paged for this alert');
		ok(await poll(await incoming(P.owner, `OK ${row.short_code}`)));
		assert.equal((await rowOf('who')).status, 'open', 'the owner is not an on-call level');
		assert.count(await sendsSince(mark), 0, 'nobody got a reply');
	});
	await t.step('a quoted reply (message.replied), an own message, and an event twice', async () => {
		await t.tables.clear('oncall_alerts');
		const row = await open('quoted');
		const pageId = row.message_id;
		const mark = await t.mock.mark();
		const reply = await incoming(P.l1, 'ok', { reply_to: pageId });
		assert.equal(reply.type, 'message.replied', 'swiping the page and answering arrives as message.replied');
		ok(await poll({ ...reply, data: { ...reply.data, direction: 'outbound' } }));
		assert.equal((await rowOf('quoted')).status, 'open', 'an outgoing message is not an answer');
		ok(await poll(reply, reply));
		assert.equal((await rowOf('quoted')).status, 'acknowledged', 'the quoted answer takes the alert');
		assert.count(distinct(await sendsSince(mark)), 1, 'the same event twice is one confirmation');
		const late = await t.mock.mark();
		ok(await poll(reply));
		assert.count(await sendsSince(late), 0, 'an answer to an alert that is already taken sends nothing');
	});
	await t.step('an acknowledgement after the alert was resolved does nothing', async () => {
		await t.tables.clear('oncall_alerts');
		const row = await open('late');
		ok(await fire(alertBody('late', { status: 'resolved' })));
		const mark = await t.mock.mark();
		ok(await poll(await incoming(P.l1, `OK ${row.short_code}`)));
		assert.equal((await rowOf('late')).status, 'resolved', 'still resolved');
		assert.count(await sendsSince(mark), 0, 'no message');
	});
	await t.step('once everything is handled, clean the table', () => t.tables.clear('oncall_alerts'));

	// ---------------------------------------------------------------- escalation
	await t.step('escalation timing: nothing before ack_minutes plus one minute of grace, then level 2 is paged', async () => {
		const row = await open('esc', { runbook_url: 'https://example.com/esc' });
		const mark = await t.mock.mark();
		ok(await tick());
		assert.count(await sendsSince(mark), 0, 'a fresh alert is not due');
		await age('esc', 4);
		ok(await tick());
		assert.count(await sendsSince(mark), 0, '4 minutes of 5: not due');
		await age('esc', 5.5);
		ok(await tick());
		assert.count(await sendsSince(mark), 0, 'past ack_minutes but inside the minute of grace: not due');
		await age('esc', 7);
		const timer = await tick();
		ok(timer);
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'one page');
		assert.equal(sends[0].to, P.l2, 'to level 2');
		assert.equal(sends[0].text, `ESCALATED, nobody answered level 1. [critical] service-esc: message of esc\nReply OK ${row.short_code} to take it.\nhttps://example.com/esc`, 'the text says level 1 did not answer and carries the runbook link');
		assert.equal(sends[0].button, { display_text: 'Open runbook', url: 'https://example.com/esc' }, 'the runbook button comes along');
		assert.equal(sends[0].key, `${keyBase(row)}-L2`, 'the key names the level');
		const after = await rowOf('esc');
		assert.equal([after.level, after.pages, after.paged_phones, after.notified_phone, after.message_id, after.status], [2, 2, `${P.l1},${P.l2}`, P.l2, sends[0].id, 'open'], 'the row follows');
		assert.equal(after.short_code, row.short_code, 'the same code');
		await age('esc', 7);
		ok(await tick());
		const third = (await sendsSince(mark)).filter((s) => s.to === P.l3);
		assert.count(third, 1, 'level 3 is paged next');
		assert.match(third[0].text, /nobody answered level 2/, 'it says level 2 did not answer');
	});
	await t.step('after the last level: ONE final message to every level and the owner, the alert is unacknowledged, and it stops', async () => {
		const mark = await t.mock.mark();
		await age('esc', 7);
		ok(await tick());
		const sends = await sendsSince(mark);
		assert.count(sends, 4, 'level 1, 2, 3 and the owner');
		assert.equal(sends.map((s) => s.to).sort(), [P.owner, P.l1, P.l2, P.l3].sort(), 'everybody once');
		for (const s of sends) assert.match(s.text, /^Nobody acknowledged service-esc \(.{4}\): message of esc\nNo more messages will follow for this alert\. Check it now\.$/, 'the final text');
		assert.ok(sends.every((s) => s.key.includes('-final-')), 'with its own keys');
		const row = await rowOf('esc');
		assert.equal([row.status, row.level, row.pages], ['unacknowledged', 3, 3], 'the row is closed as unacknowledged');
		// It stops: no endless loop.
		const later = await t.mock.mark();
		for (let i = 0; i < 3; i++) {
			await age('esc', 600);
			ok(await tick());
		}
		assert.count(await sendsSince(later), 0, 'nothing more is ever sent for it');
		// A reply to it does nothing either.
		ok(await poll(await incoming(P.l1, `OK ${row.short_code}`)));
		assert.count(await sendsSince(later), 0, 'a reply after the final message is ignored');
		assert.equal((await rowOf('esc')).status, 'unacknowledged', 'it stays unacknowledged');
	});
	await t.step('the owner who is also a level gets one final message, and two levels only means a shorter ladder', async () => {
		await t.tables.clear('oncall_alerts');
		await configure({ oncall_phone_3: '', owner_phone: P.l1 });
		const row = await open('short-ladder');
		const mark = await t.mock.mark();
		await escalate('short-ladder');
		assert.equal((await sendsSince(mark))[0].to, P.l2, 'level 2 is paged');
		const mark2 = await t.mock.mark();
		await escalate('short-ladder');
		const sends = await sendsSince(mark2);
		assert.equal(sends.map((s) => s.to).sort(), [P.l1, P.l2], 'level 3 does not exist and the owner is level 1: two final messages');
		assert.equal((await rowOf('short-ladder')).status, 'unacknowledged', 'closed');
		assert.ok(row.short_code, 'sanity');
		await configure({ ...real });
	});
	await t.step('empty levels are supported: one level only, or level 3 standing in for an empty level 2', async () => {
		await t.tables.clear('oncall_alerts');
		await configure({ oncall_phone_2: '', oncall_phone_3: '', owner_phone: P.l1 });
		await open('one-level');
		const mark = await t.mock.mark();
		await escalate('one-level');
		const sends = await sendsSince(mark);
		assert.equal(sends.map((s) => s.to), [P.l1], 'one level, and the owner is that person: one final message');
		assert.equal((await rowOf('one-level')).status, 'unacknowledged', 'closed');
		await t.tables.clear('oncall_alerts');
		await configure({ oncall_phone_2: '', oncall_phone_3: P.l3, owner_phone: P.owner });
		await open('skip-level');
		const mark2 = await t.mock.mark();
		await escalate('skip-level');
		const next = await sendsSince(mark2);
		assert.equal([next.length, next[0].to], [1, P.l3], 'level 3 stands in for the empty level 2');
		assert.match(next[0].text, /nobody answered level 1/, 'as the next level');
		const mark3 = await t.mock.mark();
		await escalate('skip-level');
		assert.equal((await sendsSince(mark3)).map((s) => s.to).sort(), [P.owner, P.l1, P.l3].sort(), 'then the final message to both levels and the owner');
		await configure({ ...real });
	});
	await t.step('two alerts due in one run: each goes to its own next level with its own text and button', async () => {
		await t.tables.clear('oncall_alerts');
		const a = await open('multi-a', { runbook_url: 'https://example.com/a' });
		const b = await open('multi-b');
		const c = await open('multi-c', { runbook_url: 'https://example.com/c' });
		await t.tables.update('oncall_alerts', { status: 'open' }, { notified_at: minutesAgo(8) });
		const mark = await t.mock.mark();
		ok(await tick());
		const sends = await sendsSince(mark);
		assert.count(sends, 3, 'three pages');
		const find = (id) => sends.find((s) => s.text.includes(`service-${id}`));
		assert.equal(find('multi-a').button?.url, 'https://example.com/a', 'a has its button');
		assert.equal(find('multi-b').button, undefined, 'b has none');
		assert.equal(find('multi-c').button?.url, 'https://example.com/c', 'c has its button, not a');
		for (const [id, row] of [['multi-a', a], ['multi-b', b], ['multi-c', c]]) {
			assert.ok(find(id).text.includes(row.short_code), `${id}: its own code`);
			const after = await rowOf(id);
			assert.equal([after.level, after.message_id], [2, find(id).id], `${id}: its row got its own message id`);
		}
	});
	await t.step('an alert that was opened but never paged (the run stopped) is paged by the timer, not before a minute has passed', async () => {
		await t.tables.clear('oncall_alerts');
		const row = {
			alert_id: 'stuck', service: 'Stuck', severity: 'critical', message: 'never paged', status: 'open', level: 0, notified_phone: '', message_id: '', notified_at: '',
			acknowledged_by: '', acknowledged_at: '', resolved_at: '', runbook_url: '', short_code: 'ABCD', opened_at: new Date().toISOString(), pages: 0, paged_phones: '', last_error: '',
		};
		await t.tables.insert('oncall_alerts', row);
		const mark = await t.mock.mark();
		ok(await tick());
		assert.count(await sendsSince(mark), 0, 'just opened: the run that opened it is probably still paging');
		await patchRow('stuck', { opened_at: minutesAgo(1.5) });
		ok(await tick());
		assert.count(await sendsSince(mark), 0, 'a minute and a half: still not due');
		await patchRow('stuck', { opened_at: minutesAgo(3) });
		ok(await tick());
		const sends = await sendsSince(mark);
		assert.equal([sends.length, sends[0]?.to], [1, P.l1], 'three minutes later level 1 is paged');
		assert.match(sends[0].text, /^ALERT \[critical\] Stuck: never paged/, 'as a first page, not as an escalation');
		assert.equal((await rowOf('stuck')).level, 1, 'the row follows');
	});
	await t.step('a send that is repeated (the run stopped before the row was saved) goes out once', async () => {
		await t.tables.clear('oncall_alerts');
		const row = await open('replay');
		await escalate('replay');
		const after = await rowOf('replay');
		const messagesBefore = (await t.mock.messages()).length;
		// Put the row back the way it was before the save, and let the timer run again.
		await patchRow('replay', { level: 1, pages: 1, paged_phones: P.l1, notified_phone: P.l1, message_id: row.message_id, notified_at: minutesAgo(7) });
		const mark = await t.mock.mark();
		ok(await tick());
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'the page is requested again');
		assert.equal(sends[0].id, after.message_id, 'with the same key the API answers with the first message');
		assert.equal((await t.mock.messages()).length, messagesBefore, 'no second message exists');
	});

	// ---------------------------------------------------------------- resolved
	await t.step('a resolved request closes the alert and tells exactly the people who were paged', async () => {
		await t.tables.clear('oncall_alerts');
		const row = await open('res', { service: 'API' });
		await escalate('res');
		const mark = await t.mock.mark();
		ok(await fire(alertBody('res', { status: 'resolved', service: 'ignored here' })));
		const sends = await sendsSince(mark);
		assert.equal(sends.map((s) => s.to).sort(), [P.l1, P.l2], 'level 1 and 2 (level 3 was never paged)');
		for (const s of sends) assert.equal(s.text, `Resolved: API (${row.short_code}).`, 'the resolved text');
		const after = await rowOf('res');
		assert.equal(after.status, 'resolved', 'closed');
		assert.ok(Math.abs(Date.parse(after.resolved_at) - Date.now()) < 60_000, 'with the time');
		const timer = await t.mock.mark();
		await age('res', 600);
		ok(await tick());
		assert.count(await sendsSince(timer), 0, 'a resolved alert is never escalated');
		ok(await fire(alertBody('res', { status: 'resolved' })));
		assert.count(await sendsSince(timer), 0, 'a second resolved sends nothing');
		ok(await fire(alertBody('never-seen', { status: 'resolved' })));
		assert.equal(await rowOf('never-seen'), undefined, 'a resolved alert that was never open is ignored');
		assert.count(await sendsSince(timer), 0, 'and sends nothing');
	});
	await t.step('resolving an acknowledged alert tells the person who took it too', async () => {
		const row = await open('res-ack');
		ok(await poll(await incoming(P.l1, `ok ${row.short_code}`)));
		const mark = await t.mock.mark();
		ok(await fire(alertBody('res-ack', { status: 'resolved', severity: 'info' })));
		const sends = await sendsSince(mark);
		assert.equal(sends.map((s) => s.to), [P.l1], 'the one who was paged');
		assert.equal((await rowOf('res-ack')).status, 'resolved', 'closed');
	});
	await t.step('firing again: a flap is ignored for reopen_minutes, then it is a new incident with a new code', async () => {
		const before = await rowOf('res');
		const mark = await t.mock.mark();
		ok(await fire(alertBody('res')));
		assert.count(await sendsSince(mark), 0, 'fired again right after it was resolved: ignored');
		assert.equal((await rowOf('res')).status, 'resolved', 'still resolved');
		await nextMinute();
		await patchRow('res', { opened_at: minutesAgo(30), resolved_at: minutesAgo(10) });
		ok(await fire(alertBody('res', { message: 'back again' })));
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'a new page');
		const after = await rowOf('res');
		assert.equal([after.status, after.level, after.pages, after.paged_phones, after.message], ['open', 1, 1, P.l1, 'back again'], 'a fresh incident on the same row');
		assert.ok(after.short_code && CODE.test(after.short_code), 'with a code');
		assert.notEqual(sends[0].key, `${keyBase(before)}-L1`, 'and a key of its own (the old key would only replay the old message)');
		assert.count(await t.tables.rows('oncall_alerts', { where: { alert_id: 'res' } }), 1, 'still one row per alert id');
	});
	await t.step('an alert that was taken, or that nobody took, pages again only after rearm_hours', async () => {
		await t.tables.clear('oncall_alerts');
		const row = await open('rearm');
		ok(await poll(await incoming(P.l1, `ok ${row.short_code}`)));
		const mark = await t.mock.mark();
		ok(await fire(alertBody('rearm')));
		assert.count(await sendsSince(mark), 0, 'an acknowledged alert that fires again is ignored');
		await nextMinute();
		await patchRow('rearm', { opened_at: minutesAgo(14 * 60), acknowledged_at: minutesAgo(13 * 60) });
		ok(await fire(alertBody('rearm')));
		assert.count(await sendsSince(mark), 1, 'after 13 hours it pages again');
		await patchRow('rearm', { status: 'unacknowledged', notified_at: minutesAgo(60) });
		const mark2 = await t.mock.mark();
		ok(await fire(alertBody('rearm')));
		assert.count(await sendsSince(mark2), 0, 'an unacknowledged alert that fires again within 12 hours is ignored');
		await nextMinute();
		await patchRow('rearm', { opened_at: minutesAgo(14 * 60), notified_at: minutesAgo(13 * 60) });
		ok(await fire(alertBody('rearm')));
		assert.count(await sendsSince(mark2), 1, 'and pages again after 13 hours');
	});
	await t.step('an alert that nobody took is closed by a resolved request, and the next outage with the same id pages again', async () => {
		await t.tables.clear('oncall_alerts');
		const row = await open('nobody', { service: 'Mail' });
		await escalate('nobody');
		await escalate('nobody');
		await escalate('nobody'); // the final message
		assert.equal((await rowOf('nobody')).status, 'unacknowledged', 'nobody took it');
		const mark = await t.mock.mark();
		ok(await fire(alertBody('nobody', { status: 'resolved' })));
		const after = await rowOf('nobody');
		assert.equal(after.status, 'resolved', 'a resolved request closes an alert that nobody took');
		assert.ok(Math.abs(Date.parse(after.resolved_at) - Date.now()) < 60_000, 'with the time');
		const sends = await sendsSince(mark);
		assert.equal(sends.map((s) => s.to).sort(), [P.l1, P.l2, P.l3].sort(), 'the three people who were paged are told, and nobody else');
		for (const send of sends) assert.equal(send.text, `Resolved: Mail (${row.short_code}).`, 'the resolved text');
		ok(await fire(alertBody('nobody')));
		assert.count(await sendsSince(mark), 3, 'a flap inside reopen_minutes pages nobody');
		await nextMinute();
		await patchRow('nobody', { opened_at: minutesAgo(40), resolved_at: minutesAgo(5) });
		ok(await fire(alertBody('nobody', { message: 'second outage' })));
		const again = await rowOf('nobody');
		assert.equal([again.status, again.level, again.paged_phones, again.message], ['open', 1, P.l1, 'second outage'], 'the next outage with the same id is paged, not ignored for rearm_hours');
		assert.count(distinct(await sendsSince(mark)).filter((s) => s.to === P.l1 && s.text.startsWith('ALERT')), 1, 'level 1 was paged');
		await t.tables.clear('oncall_alerts');
	});
	await t.step('a flood of new alerts is stopped: past max_new_alerts_per_hour the run fails, naming the alert, and pages nobody, but the highest severity is never held back', async () => {
		await t.tables.clear('oncall_alerts');
		await configure({ max_new_alerts_per_hour: 3 });
		for (const id of ['flood-1', 'flood-2', 'flood-3']) ok(await fire(alertBody(id, { severity: 'warning' })));
		const mark = await t.mock.mark();
		const pattern = /Alert flood-4 \(service-flood-4\) was NOT paged: 3 other alerts were opened in the last hour and the limit is 3/;
		failed(await fire(alertBody('flood-4', { severity: 'warning' })), pattern, 'the fourth alert');
		assert.equal(await rowOf('flood-4'), undefined, 'it was not stored');
		assert.count(await sendsSince(mark), 0, 'and nobody was paged');
		failed(await fire(alertBody('flood-4', { severity: 'warning' })), pattern, 'a repeat firing is held back again while the hour is full (and fails the run again)');
		failed(await fire(alertBody('flood-5', { severity: 'banana' })), /Alert flood-5 .* was NOT paged/, 'an unknown severity is held back like a low one');
		ok(await fire(alertBody('flood-crit', { severity: 'critical' })));
		assert.ok(await rowOf('flood-crit'), 'the highest severity is never held back');
		assert.count(distinct(await sendsSince(mark)), 1, 'it was paged');
		ok(await fire(alertBody('flood-1', { status: 'resolved' })));
		await configure({ max_new_alerts_per_hour: 10 });
		ok(await fire(alertBody('flood-4', { severity: 'warning' })));
		assert.ok(await rowOf('flood-4'), 'with the limit back at 10 it pages');
	});

	// ---------------------------------------------------------------- races: three runs that write the same row
	await t.step('a reply written just before the deadline is read before escalation can fire: the alert stays acknowledged and level 2 is not paged', async () => {
		await t.tables.clear('oncall_alerts');
		const row = await open('grace');
		await age('grace', 5.5);
		const event = await incoming(P.l1, `ok ${row.short_code}`);
		const mark = await t.mock.mark();
		const [timer, reply] = await Promise.all([tick(), poll(event)]);
		ok(timer);
		ok(reply);
		const after = await rowOf('grace');
		assert.equal([after.status, after.acknowledged_by, after.level], ['acknowledged', P.l1, 1], 'acknowledged by level 1 and still at level 1');
		const sends = distinct(await sendsSince(mark));
		assert.equal(sends.map((s) => s.to), [P.l1], 'only the confirmation went out: level 2 was not paged');
		await age('grace', 120);
		const later = await t.mock.mark();
		ok(await tick());
		assert.count(await sendsSince(later), 0, 'and the timer leaves it alone');
	});
	await t.step('a slow timer run cannot undo an acknowledgement that was written while it was sending', async () => {
		await t.tables.clear('oncall_alerts');
		const row = await open('overlap');
		await age('overlap', 7); // due: the timer pages level 2 and the API takes 6 seconds to answer
		const event = await incoming(P.l1, `ok ${row.short_code}`);
		const mark = await t.mock.mark();
		await t.mock.config({ latencyMs: 6000 });
		const slowTimer = tick();
		await t.sleep(2500); // the timer has read the row (still open) and waits for the API
		await t.mock.config({ latencyMs: 0 });
		const quickReply = poll(event); // the acknowledgement is written long before the timer saves
		const [timer, reply] = await Promise.all([slowTimer, quickReply]);
		ok(timer);
		ok(reply);
		const after = await rowOf('overlap');
		assert.equal([after.status, after.acknowledged_by], ['acknowledged', P.l1], 'the acknowledgement survived the late save of the timer');
		assert.equal([after.level, after.paged_phones, after.message_id !== ''], [2, `${P.l1},${P.l2}`, true], 'the timer still recorded what it owns: the page to level 2');
		assert.equal(distinct(await sendsSince(mark)).map((s) => s.to).sort(), [P.l1, P.l2].sort(), 'level 2 was paged before the reply was read (the race is real), level 1 got its confirmation');
		const later = await t.mock.mark();
		await age('overlap', 600);
		ok(await tick());
		assert.count(await sendsSince(later), 0, 'an acknowledged alert is never escalated again');
	});
	await t.step('a slow timer run cannot undo a resolved request that was written while it was sending', async () => {
		await t.tables.clear('oncall_alerts');
		await open('overlap-res', { service: 'Overlap' });
		await age('overlap-res', 7);
		await t.mock.config({ latencyMs: 6000 });
		const slowTimer = tick();
		await t.sleep(2500);
		await t.mock.config({ latencyMs: 0 });
		const resolveRun = fire(alertBody('overlap-res', { status: 'resolved' }));
		const [timer, resolved] = await Promise.all([slowTimer, resolveRun]);
		ok(timer);
		ok(resolved);
		const after = await rowOf('overlap-res');
		assert.equal(after.status, 'resolved', 'the resolution survived the late save of the timer');
		assert.ok(after.resolved_at, 'with its time');
		assert.equal([after.level, after.message_id !== ''], [2, true], 'the timer recorded its own page');
		const later = await t.mock.mark();
		await age('overlap-res', 600);
		ok(await tick());
		assert.count(await sendsSince(later), 0, 'a resolved alert is never escalated');
	});

	// ---------------------------------------------------------------- pace
	await t.step('the pace of the plan is respected: four final messages in a row, with a 1.5 s spacing, all arrive', async () => {
		await t.tables.clear('oncall_alerts');
		await open('pace');
		await escalate('pace');
		await escalate('pace');
		await t.mock.config({ enforceSpacing: true, spacingMs: 1500, plan: 'lone_wolf' });
		const mark = await t.mock.mark();
		await age('pace', 7);
		const started = Date.now();
		ok(await tick());
		const sends = await sendsSince(mark);
		assert.count(distinct(sends), 4, 'the four final messages arrive');
		assert.ok(Date.now() - started >= 3 * 1500 - 500, 'they were spaced, not fired at once');
		assert.ok((await t.mock.requests({ since: mark })).some((r) => r.status === 429), 'the API did ask the node to wait at least once');
		await t.mock.config({ enforceSpacing: false, plan: 'business' });
	});

	// ---------------------------------------------------------------- failures
	await t.step('a refused page (number not connected) is recorded in the row, fails the run naming the alert, and the next level is paged on the next tick without waiting', async () => {
		await t.tables.clear('oncall_alerts');
		// n8n tries a refused first message three times: the refusal has to outlast the three tries.
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 409, body: { error: 'number_not_connected' }, times: 3 });
		const before = await t.mock.mark();
		const first = await fire(alertBody('refused', { runbook_url: 'https://example.com/refused' }));
		failed(first, /Alert refused \(service-refused\): page to \+5511977770021 failed: .*not.connected/i, 'a refused page is never silent, also when other levels remain');
		assert.ok(!/NOBODY/.test(first.error.message), 'it is not the "nobody could be paged" alarm: levels remain');
		assert.count(await t.mock.requests({ since: before, method: 'POST' }), 3, 'the page was tried three times');
		let row = await rowOf('refused');
		assert.equal([row.level, row.message_id, row.paged_phones, row.status, row.pages], [1, '', '', 'open', 1], 'level 1 is recorded as not reached');
		assert.match(row.last_error, /^page to \+5511977770021: .*not_connected/i, 'the reason is in the row');
		const mark = await t.mock.mark();
		ok(await tick());
		const sends = await sendsSince(mark);
		assert.equal([sends.length, sends[0].to], [1, P.l2], 'level 2 is paged at once, no wait for ack_minutes');
		assert.match(sends[0].text, /^ALERT \[critical\]/, 'as a first page, not "nobody answered level 1"');
		assert.ok(sends[0].text.endsWith('https://example.com/refused'), 'with the runbook link in the text');
		assert.equal(sends[0].interactive, undefined, 'and without the button that may have been the reason');
		row = await rowOf('refused');
		assert.equal([row.level, row.paged_phones, row.last_error], [2, P.l2, ''], 'the row follows and the error is cleared');
		// The person who was reached can take the alert; the person who was not reached cannot, and is not told.
		const takeMark = await t.mock.mark();
		ok(await poll(await incoming(P.l1, 'OK'), await incoming(P.l2, 'OK')));
		row = await rowOf('refused');
		assert.equal([row.status, row.acknowledged_by], ['acknowledged', P.l2], 'level 2 takes it, level 1 was never reached');
		assert.equal(distinct(await sendsSince(takeMark)).map((s) => s.to), [P.l2], 'only level 2 is told: level 1 never got the page');
	});
	await t.step('a send that fails once is tried again by n8n: the message goes out once, nothing is reported, the row has no error', async () => {
		await t.tables.clear('oncall_alerts');
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 503, body: { error: 'service_unavailable' }, times: 1 });
		const mark = await t.mock.mark();
		const row = await open('retry', { runbook_url: 'https://example.com/retry' }); // the button node
		const posts = await t.mock.requests({ since: mark, method: 'POST' });
		assert.equal(posts.filter((r) => r.status === 503).length, 1, 'the first try was refused');
		assert.count(distinct(await sendsSince(mark)), 1, 'the second try went out: one message');
		assert.ok(row.message_id && row.last_error === '', 'the row has the message id and no error');
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 503, body: { error: 'service_unavailable' }, times: 1 });
		const mark2 = await t.mock.mark();
		await escalate('retry'); // the text node (the run passes: a failure that n8n recovered is not reported)
		assert.count(distinct(await sendsSince(mark2)), 1, 'the next level got one message');
		assert.equal((await rowOf('retry')).level, 2, 'and the row follows');
	});
	await t.step('every level refused: every refusal fails the run, the last one with the "nobody" alarm, the final message follows, and it stops', async () => {
		await t.tables.clear('oncall_alerts');
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 409, body: { error: 'number_not_connected' }, times: 100 });
		failed(await fire(alertBody('unreachable', { service: 'Payments' })), /Alert unreachable \(Payments\): page to \+5511977770021 failed/, 'level 1 is refused');
		failed(await tick(), /Alert unreachable \(Payments\): page to \+5511977770022 failed/, 'level 2 is refused'); // level 3 remains
		let row = await rowOf('unreachable');
		assert.equal([row.level, row.paged_phones], [2, ''], 'two levels tried');
		const last = await tick();
		failed(last, /Alert unreachable \(Payments\): NOBODY could be paged, every level failed/, 'the last level fails: the run ends in the "nobody" alarm');
		assert.match(last.error.message, /not.connected/i, 'with the reason');
		row = await rowOf('unreachable');
		assert.equal([row.level, row.status], [3, 'open'], 'the row is saved before the run fails');
		const mark = await t.mock.mark();
		const finals = await tick();
		failed(finals, /final to \+5511977770020 failed/, 'the final messages are refused too, and the run says so');
		row = await rowOf('unreachable');
		assert.equal(row.status, 'unacknowledged', 'the alert is closed anyway: no loop');
		const after = await t.mock.mark();
		ok(await tick());
		assert.count(await t.mock.requests({ since: after, method: 'POST' }), 0, 'and nothing is tried again');
		assert.ok((await t.mock.requests({ since: mark, method: 'POST' })).length >= 4, 'the final messages were really tried');
		await t.mock.clearFaults();
	});
	await t.step('contact quota used up for level 2: it is recorded and reported, level 3 is paged next', async () => {
		await t.tables.clear('oncall_alerts');
		await open('quota');
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 402, body: { error: 'contact_quota_exceeded', message: 'Distinct-contacts quota exceeded for tier FREE (2/2 this cycle)' }, times: 3 });
		await age('quota', 7);
		failed(await tick(), /Alert quota \(service-quota\): page to \+5511977770022 failed/, 'level 2 is refused and the run says so');
		let row = await rowOf('quota');
		assert.equal([row.level, row.paged_phones], [2, P.l1], 'level 2 was not reached, level 1 still was');
		assert.match(row.last_error, /contact_quota_exceeded|contacts? quota|allowance/i, 'the quota is the reason in the row');
		const mark = await t.mock.mark();
		ok(await tick());
		assert.equal((await sendsSince(mark))[0].to, P.l3, 'level 3 is paged next, and that run passes');
		row = await rowOf('quota');
		assert.equal(row.paged_phones, `${P.l1},${P.l3}`, 'the people reached');
	});
	await t.step('a refused confirmation, a refused note and a refused "resolved" fail the run and name the alert, and the row is still right', async () => {
		await t.tables.clear('oncall_alerts');
		const row = await open('ack-fail');
		await escalate('ack-fail');
		await t.mock.fault({ method: 'POST', path: '/messages/[^/]+/reply$|/messages$', status: 402, body: { error: 'contact_quota_exceeded', message: 'Distinct-contacts quota exceeded for tier FREE (2/2 this cycle)' }, times: 6 });
		const execution = await poll(await incoming(P.l2, `ok ${row.short_code}`));
		failed(execution, /Alert ack-fail \(service-ack-fail\): ack_confirm to \+5511977770022 failed/, 'the run fails and names the alert');
		assert.match(execution.error.message, /ack_note to \+5511977770021 failed/, 'and the note');
		const after = await rowOf('ack-fail');
		assert.equal([after.status, after.acknowledged_by], ['acknowledged', P.l2], 'the alert is acknowledged anyway');
		assert.match(after.last_error, /ack_confirm/, 'the row says what failed');
		await t.mock.clearFaults();
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 409, body: { error: 'number_not_connected' }, times: 100 });
		failed(await fire(alertBody('ack-fail', { status: 'resolved' })), /Alert ack-fail \(service-ack-fail\): resolved to .* failed/, 'resolved messages that cannot be sent');
		assert.equal((await rowOf('ack-fail')).status, 'resolved', 'the alert is closed anyway');
		await t.mock.clearFaults();
	});
	await t.step('in one run some sends are refused and some are not: each row gets its own result', async () => {
		await t.tables.clear('oncall_alerts');
		// mix-a has a runbook link (the button node), mix-b has none (the text node): the two send nodes answer separately.
		await open('mix-a', { runbook_url: 'https://example.com/mix' });
		await open('mix-b');
		await t.tables.update('oncall_alerts', { status: 'open' }, { notified_at: minutesAgo(8) });
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 409, body: { error: 'number_not_connected' }, times: 3 });
		const mark = await t.mock.mark();
		// The button node runs first and its one message is refused on all three tries; the text node then sends its message.
		const execution = await tick();
		failed(execution, /Alert mix-a \(service-mix-a\): page to \+5511977770022 failed/, 'the refused page is reported');
		assert.ok(!execution.error.message.includes('mix-b'), 'and only that one');
		const rows = [await rowOf('mix-a'), await rowOf('mix-b')];
		const refused = rows.filter((r) => r.message_id === '');
		const reached = rows.filter((r) => r.message_id !== '');
		assert.equal([refused.length, reached.length, refused[0]?.alert_id, reached[0]?.alert_id], [1, 1, 'mix-a', 'mix-b'], 'mix-a refused, mix-b reached');
		assert.ok(refused[0].last_error.includes('not_connected') || /not connected/i.test(refused[0].last_error), 'the refused one says why');
		assert.equal(reached[0].last_error, '', 'the other has no error');
		assert.equal(reached[0].paged_phones, `${P.l1},${P.l2}`, 'and records level 2');
		assert.equal(refused[0].paged_phones, P.l1, 'the refused one still counts only level 1');
		assert.count(distinct(await sendsSince(mark)), 1, 'one message really went out');
		await t.mock.clearFaults();
	});

	// ---------------------------------------------------------------- the placeholders at the end of the file
	await t.step('wording: every text a person receives comes from Your settings, and none has an em or en dash', async () => {
		await t.tables.clear('oncall_alerts');
		await configure({
			msg_page: 'PAGE {service} {code}', msg_escalated: 'ESC {previous_level}>{level} {service}', msg_ack_confirm: 'YOURS {service}', msg_ack_note: 'TAKEN {name} {service}',
			msg_final: 'GIVEUP {service}', msg_resolved: 'DONE {service}', runbook_button_text: 'Runbook',
		});
		const mark = await t.mock.mark();
		const row = await open('words', { runbook_url: 'https://example.com/w' });
		await escalate('words');
		ok(await poll(await incoming(P.l2, `ok ${row.short_code}`)));
		ok(await fire(alertBody('words', { status: 'resolved' })));
		const texts = (await sendsSince(mark)).map((s) => s.text);
		assert.equal(texts, [`PAGE service-words ${row.short_code}\nhttps://example.com/w`, `ESC 1>2 service-words\nhttps://example.com/w`, 'YOURS service-words', 'TAKEN Bruno Level Two service-words', 'DONE service-words', 'DONE service-words'], 'the six wordings, in order');
		await configure({ msg_page: exported.msg_page, msg_escalated: exported.msg_escalated, msg_ack_confirm: exported.msg_ack_confirm, msg_ack_note: exported.msg_ack_note, msg_final: exported.msg_final, msg_resolved: exported.msg_resolved, runbook_button_text: exported.runbook_button_text });
		const stored = await t.n8n.rest('GET', `/rest/workflows/${t.workflow.id}`);
		assert.equal(stored.nodes.find((n) => n.name === 'Your settings').parameters.assignments.assignments.find((a) => a.name === 'msg_page').value, exported.msg_page, 'the settings are back as exported');
	});

	// ---------------------------------------------------------------- live
	// From here the workflow is ACTIVE: real HTTP requests, the real poller and the real minute timer.
	/** Finished runs that were not started by hand, newer than a mark, with the nodes they ran. */
	const liveRuns = async (since) => {
		const list = (await t.n8n.listExecutions(t.workflow.id)).filter((e) => Number(e.id) > since && e.mode !== 'manual' && ['success', 'error'].includes(e.status));
		return Promise.all(list.map((e) => t.execution(e.id)));
	};
	await t.step('live: the real webhook refuses a request without the header or with a wrong one (403 both), and the wrong method, and starts no run', async () => {
		await t.tables.clear('oncall_alerts');
		await t.activate();
		const mark = await t.executionMark();
		const none = await t.callWebhook(HOOK, { body: alertBody('http-1') });
		assert.equal(none.status, 403, `no header: ${JSON.stringify(none.body)}`);
		const wrong = await t.callWebhook(HOOK, { body: alertBody('http-1'), headers: { 'X-Alert-Token': 'not-the-token' } });
		assert.equal(wrong.status, 403, `a wrong value: ${JSON.stringify(wrong.body)}`);
		assert.equal(wrong.body, none.body, 'the same answer: nothing tells which part was wrong');
		const otherHeader = await t.callWebhook(HOOK, { body: alertBody('http-1'), headers: { Authorization: `Bearer ${TOKEN}` } });
		assert.equal(otherHeader.status, 403, 'the token in another header is refused too');
		const get = await t.callWebhook(HOOK, { method: 'GET', headers: { 'X-Alert-Token': TOKEN } });
		assert.ok([404, 405].includes(get.status), `GET is not accepted (${get.status})`);
		await t.sleep(4000);
		const runs = await liveRuns(mark);
		assert.count(runs.filter((r) => r.ran(HOOK)), 0, 'a refused request starts no run');
		assert.count(await t.tables.rows('oncall_alerts'), 0, 'and stores nothing');
	});
	await t.step('live: a real request pages level 1; the same request again sends nothing; a very long message is cut', async () => {
		const mark = await t.mock.mark();
		const res = await t.callWebhook(HOOK, { body: alertBody('http-2', { service: 'Live service', runbook_url: 'https://example.com/live' }), headers: { 'X-Alert-Token': TOKEN } });
		assert.equal(res.status, 200, 'the monitoring tool gets its answer');
		await t.waitFor(async () => (await rowOf('http-2'))?.message_id, { timeoutMs: 60_000, message: 'the page to level 1' });
		const sends = distinct(await sendsSince(mark));
		assert.equal(sends.map((s) => s.to), [P.l1], 'level 1 was paged');
		assert.equal(sends[0].button?.url, 'https://example.com/live', 'with the button');
		const since = await t.executionMark();
		const again = await t.callWebhook(HOOK, { body: alertBody('http-2', { service: 'Live service' }), headers: { 'X-Alert-Token': TOKEN } });
		assert.equal(again.status, 200, 'accepted');
		await t.waitFor(async () => (await liveRuns(since)).some((r) => r.ran(HOOK)), { timeoutMs: 60_000, message: 'the second run' });
		assert.count(distinct(await sendsSince(mark)), 1, 'firing again sent nothing new');
		const huge = await t.callWebhook(HOOK, { body: alertBody('http-3', { message: 'x'.repeat(200_000) }), headers: { 'X-Alert-Token': TOKEN } });
		assert.equal(huge.status, 200, 'a very long message is accepted by the webhook');
		await t.waitFor(async () => (await rowOf('http-3'))?.message_id, { timeoutMs: 60_000, message: 'the long alert to be paged' });
		assert.equal((await rowOf('http-3')).message.length, 300, 'and was cut to 300 characters');
	});
	await t.step('live: two identical alerts at the same moment send the same text with the same key, so Turbo Notify sends one message', async () => {
		let attempt = 0;
		for (;;) {
			attempt++;
			const id = `race-${attempt}`;
			const mark = await t.mock.mark();
			const request = () => t.callWebhook(HOOK, { body: alertBody(id, { service: 'Race' }), headers: { 'X-Alert-Token': TOKEN } });
			const minuteBefore = Math.floor(Date.now() / 60000);
			const answers = await Promise.all([request(), request()]);
			const minuteAfter = Math.floor(Date.now() / 60000);
			assert.equal(answers.map((a) => a.status), [200, 200], 'both are accepted');
			await t.waitFor(async () => (await rowOf(id))?.message_id, { timeoutMs: 60_000, message: 'the page' });
			await t.sleep(6000);
			assert.count(await t.tables.rows('oncall_alerts', { where: { alert_id: id } }), 1, 'one row');
			const sent = (await sendsSince(mark)).filter((s) => s.to === P.l1);
			const row = await rowOf(id);
			t.note('twoIdenticalAlertsAtOnce', { requestsToTurboNotify: sent.length, distinctMessages: distinct(sent).length, straddledAMinute: minuteBefore !== minuteAfter });
			if (minuteBefore !== minuteAfter && attempt < 3) continue; // the two requests fell on both sides of a minute: the key changes with the minute, try again
			assert.ok(sent.length >= 1 && sent.length <= 2, 'level 1 was asked for a page once or twice');
			assert.equal(new Set(sent.map((s) => s.key)).size, 1, 'with the same key');
			assert.equal(new Set(sent.map((s) => s.text)).size, 1, 'and the same text (the code comes from the alert id and the minute)');
			assert.count(distinct(sent), 1, 'so level 1 got ONE message');
			assert.equal(row.short_code, codeFor(`${id}|${Math.floor(Date.parse(row.opened_at) / 60000)}|0`), 'the code is the one derived from the id and the minute');
			break;
		}
	});
	await t.step('live: a reply is read by the real poller and takes the alert; the echo of our own messages is ignored', async () => {
		const row = await rowOf('http-2');
		const mark = await t.mock.mark();
		const since = await t.executionMark();
		await incoming(P.l1, `OK ${row.short_code}`);
		await t.waitFor(async () => (await rowOf('http-2')).status === 'acknowledged', { timeoutMs: 170_000, message: 'the poller to take the alert' });
		assert.equal((await rowOf('http-2')).acknowledged_by, P.l1, 'by the sender');
		await t.waitFor(async () => distinct(await sendsSince(mark)).some((s) => s.to === P.l1 && /^Acknowledged, you own Live service/.test(s.text)), { timeoutMs: 30_000, message: 'the confirmation' });
		const runs = await liveRuns(since);
		assert.ok(runs.some((r) => r.ran(POLL)), 'the poller started the run');
		const count = distinct(await sendsSince(mark)).length;
		await t.sleep(1500);
		assert.equal(distinct(await sendsSince(mark)).length, count, 'nothing more is sent');
	});
	await t.step('live: the real minute timer escalates an alert nobody took', async () => {
		const mark = await t.mock.mark();
		const since = await t.executionMark();
		await age('http-3', 7);
		await t.waitFor(async () => (await rowOf('http-3'))?.level === 2, { timeoutMs: 170_000, message: 'the timer to page level 2' });
		const sends = distinct(await sendsSince(mark));
		assert.equal(sends.filter((s) => s.to === P.l2).length, 1, 'level 2 was paged once, by the clock');
		await t.waitFor(async () => (await liveRuns(since)).some((r) => r.ran(TIMER)), { timeoutMs: 60_000, message: 'the timer run to finish' });
		assert.ok((await liveRuns(since)).some((r) => r.ran(TIMER)), 'the timer started the run');
	});
	await t.step('live: a reply written while the workflow was switched off is read when it is switched on again', async () => {
		await t.deactivate();
		await t.sleep(2000);
		const row = await rowOf('http-3');
		const mark = await t.mock.mark();
		await incoming(P.l2, `OK ${row.short_code}`);
		await t.sleep(4000);
		assert.equal((await rowOf('http-3')).status, 'open', 'nothing happens while it is off');
		await t.activate();
		await t.waitFor(async () => (await rowOf('http-3')).status === 'acknowledged', { timeoutMs: 170_000, message: 'the first poll after switching on' });
		assert.equal((await rowOf('http-3')).acknowledged_by, P.l2, 'the reply was not lost');
		await t.waitFor(async () => distinct(await sendsSince(mark)).some((s) => s.to === P.l2 && /^Acknowledged/.test(s.text)), { timeoutMs: 30_000, message: 'the confirmation' });
	});
	await t.step('live: switch off again', () => t.deactivate());
}
