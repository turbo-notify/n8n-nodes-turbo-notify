/**
 * Real API scenario for T1 (appointment-reminders-with-rsvp): the exported workflow against the REAL Turbo Notify API,
 * with real WhatsApp delivery, to the owner's own test number only.
 *
 *   export TN_REAL_OWNER_PHONE='+<the owner test number>'
 *   node templates/harness/run-template.mjs templates/appointment-reminders-with-rsvp/workflow.json \
 *     --real-api --api-key-file <file with the line "- Value: tn_live_...">  --max-sends 8 \
 *     --scenario templates/appointment-reminders-with-rsvp/test/real.mjs --image n8nio/n8n:2.45.5 --tz America/Sao_Paulo \
 *     --run-id t1real --ports 5691,9201
 *
 * It SENDS REAL MESSAGES (at most 8, to the owner test number, enforced by the harness guard) and deletes them
 * for everyone at the end. The number is never written in this file: it comes from TN_REAL_OWNER_PHONE.
 *
 * What it runs: "Run once: create the table"; the production FORM over HTTP (Basic Auth) with a local phone format
 * (it must be stored as E.164) for Check-up in 3 h; two more rows added to the table (Follow-up in 20 h, First visit in
 * 75 h); the hourly branch (twice, plus a replay of one send with the same idempotency key); two exception rows (a phone
 * without "+" and an appointment booked with too little notice) reported in the ONE owner message; a mismatching
 * expected_timezone stopping the run; the Polling Trigger live for a few ticks, and the guest answer branch fed with
 * answers shaped exactly like the documented `message.calendar_responded` event, incl. an answer given from the phone
 * itself (direction outbound, ignored).
 * A real RSVP tap cannot be automated: the real answer path is NOT exercised here.
 * Budget: 2 invitations + 1 owner message + 1 thank-you + 3 messages of a decline = 7 of the 8 allowed.
 */
export const timeoutMs = 40 * 60_000;
export const credentials = [{ type: 'httpBasicAuth', name: 'Form access (Basic Auth)', data: { user: 'staff', password: 'real-run-form-password' } }];

const NODES = {
	hourly: 'Every hour: remind and report',
	poll: 'Poll: guest answered or delivery failed',
	manual: 'Run once: create the table',
};
const TABLE = 'appointments';
const HOUR = 3_600_000;
const FORM_AUTH = `Basic ${Buffer.from('staff:real-run-form-password').toString('base64')}`;
const digits = (v) => String(v ?? '').replace(/\D/g, '');

/** The Schedule Trigger fires at minute 5 of every hour while the workflow is active: never be active across it. */
async function avoidHourlyMinute(windowSeconds) {
	for (;;) {
		const now = new Date();
		const sec = now.getUTCMinutes() * 60 + now.getUTCSeconds();
		const start = 4 * 60; // 00:04:00 is early enough to be safe
		const end = 6 * 60 + 30;
		if (sec + windowSeconds < start || sec > end) return;
		await new Promise((r) => setTimeout(r, 15_000));
	}
}

function ownerPhone() {
	const phone = process.env.TN_REAL_OWNER_PHONE;
	if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('set TN_REAL_OWNER_PHONE to the owner test number, with + and the country code');
	return phone;
}

export async function prepare(workflow) {
	const settings = workflow.nodes.find((n) => n.name === 'Your settings');
	settings.parameters.assignments.assignments.find((a) => a.name === 'owner_phone').value = ownerPhone();
	return workflow;
}

export default async function scenario(t) {
	const { assert, real } = t;
	const OWNER = ownerPhone();
	const iso = (ms) => new Date(ms).toISOString();
	const rowsAll = async () => t.tables.rows(TABLE);
	const one = async (where) => {
		const rows = await t.tables.rows(TABLE, { where });
		assert.count(rows, 1, `one row for ${JSON.stringify(where)}`);
		return rows[0];
	};

	/** The safety net the scenario asserts itself, before every run that can send: nothing targets another number. */
	const assertOnlyOwner = async (label) => {
		const settingsNode = t.workflow.node('Your settings');
		const configured = settingsNode.parameters.assignments.assignments.find((a) => a.name === 'owner_phone').value;
		assert.equal(digits(configured), digits(OWNER), `${label}: owner_phone in Your settings is the owner test number`);
		const rows = await rowsAll();
		for (const r of rows) assert.equal(digits(r.phone), digits(OWNER), `${label}: row ${r.customer_name} targets the owner test number only`);
	};
	const sendsSince = async (mark) => real.guard.sends({ since: mark });
	const invitesSince = async (mark) => (await sendsSince(mark)).filter((s) => s.content?.start_at !== undefined);
	const textsSince = async (mark) => (await sendsSince(mark)).filter((s) => s.content?.text !== undefined);
	const bodyKeys = (o) => Object.keys(o ?? {}).sort();

	let quotaBefore;
	let invA;
	let invB;

	await t.step('0 pre-flight on the real API: the key works, the number is connected, the quota is readable', async () => {
		const numbers = await real.numbers();
		const main = numbers.data.find((n) => n.alias === 'main');
		assert.ok(main, 'a main number exists');
		assert.equal(digits(main.number) === digits(OWNER), false, 'the sending number is not the recipient (it is the owner other number)');
		const single = await real.get('/v1/numbers/main');
		assert.equal(single.status, 'connected', 'GET /v1/numbers/main: status is a plain string and the number is connected');
		quotaBefore = await real.quota();
		const contactQuota = await real.contactQuota();
		t.note('plan', { tier: quotaBefore.tier, messages_quota: quotaBefore.quota, messages_remaining: quotaBefore.remaining, contact_quota: contactQuota.quota, contact_tier: contactQuota.tier });
		t.note('numberListStatusShape', typeof main.status === 'object' ? 'object {status, at, reason} in the list' : typeof main.status);
		t.note('numberGetStatusShape', typeof single.status + ' with `at` at the top level');
		assert.ok(quotaBefore.remaining >= 20, 'enough quota for a handful of messages');
		assert.equal(real.guard.messagesAccepted, 0, 'nothing sent yet');
	});

	await t.step('1 "Run once: create the table" creates the table, then two rows are added that target only the owner test number', async () => {
		const mark = await real.guard.mark();
		const execution = await t.run(NODES.manual);
		assert.equal(execution.status, 'success', execution.describe());
		assert.count(await rowsAll(), 0, 'no row yet: rows come from the form');
		const base = { phone: OWNER, location: '', duration_min: 30, status: 'scheduled', reminder_message_id: '', reminded_at: '', rsvp_at: '', extra_guests: 0, last_error: '', notes: '' };
		await t.tables.insert(TABLE, [
			{ ...base, customer_name: 'Sample Customer B', title: 'Follow-up', start_at: iso(Date.now() + 20 * HOUR) },
			{ ...base, customer_name: 'Sample Customer C', title: 'First visit', start_at: iso(Date.now() + 75 * HOUR) },
		]);
		assert.count(await rowsAll(), 2, 'two rows added by hand');
		await assertOnlyOwner('rows');
		assert.count(await sendsSince(mark), 0, 'creating the table and adding rows sends nothing');
	});

	await t.step('1b the production FORM (Basic Auth over HTTP) saves Sample Customer A: local phone format becomes E.164, time read in the workflow zone', async () => {
		const zone = t.n8n.timezone;
		const fmt = (ms, opts) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', ...opts }).format(ms);
		const at = Date.now() + 3 * HOUR;
		const date = fmt(at, { year: 'numeric', month: '2-digit', day: '2-digit' });
		const time = fmt(at, { hour: '2-digit', minute: '2-digit' });
		const national = digits(OWNER).slice(2);
		assert.equal(digits(OWNER).startsWith('55') && national.length === 11, true, 'the test number is a Brazilian mobile number (the local format is tested)');
		const local = `${national.slice(0, 2)} ${national.slice(2, 7)}-${national.slice(7)}`;
		await avoidHourlyMinute(240);
		await t.activate();
		const url = `${t.urls.n8n}/form/${t.workflow.node('Form: new appointment').parameters.path}`;
		const labels = ['Customer name', 'WhatsApp number', 'Appointment', 'Date', 'Time', 'Duration in minutes', 'Location', 'Notes'];
		const answers = { 'Customer name': 'Sample Customer A', 'WhatsApp number': local, Appointment: 'Check-up', Date: date, Time: time };
		const body = new FormData();
		labels.forEach((label, i) => body.append(`field-${i}`, String(answers[label] ?? '')));
		const since = await t.executionMark();
		const mark = await real.guard.mark();
		const noAuth = await fetch(url, { method: 'POST', body });
		assert.equal(noAuth.status, 401, 'the form refuses a call without credentials');
		const res = await fetch(url, { method: 'POST', headers: { authorization: FORM_AUTH }, body });
		const text = await res.text();
		assert.equal(res.status, 200, `the form answers 200: ${text}`);
		const saved = JSON.parse(text).formSubmittedText;
		assert.match(saved, /^Saved: Sample Customer A, \+\d{12,13}, Check-up, \w+ \d+ \w+ \d\d:\d\d \(America\/Sao_Paulo\)\. The customer is reminded by the first hourly run that falls within 24 hours of the start\.$/, 'and says what it saved, with the phone as understood');
		assert.ok(saved.includes(OWNER), 'the phone shown is the E.164 form of the one typed');
		// the form sent twice is refused (same phone, same start)
		const body2 = new FormData();
		labels.forEach((label, i) => body2.append(`field-${i}`, String(answers[label] ?? '')));
		const again = await fetch(url, { method: 'POST', headers: { authorization: FORM_AUTH }, body: body2 });
		assert.equal(again.status, 422, 'the second submission of the same appointment is refused');
		assert.match(JSON.parse(await again.text()).formSubmittedText, /is already in the table\./, 'with the reason');
		assert.count(await rowsAll(), 3, 'and nothing was saved twice');
		const a = await one({ customer_name: 'Sample Customer A' });
		assert.equal(a.phone, OWNER, 'the local phone format was stored as E.164');
		assert.equal(a.status, 'scheduled', 'scheduled');
		const drift = Math.abs(Date.parse(a.start_at) - at);
		assert.ok(drift < 60_000, `the form time was read in ${zone} and stored in UTC (drift ${drift} ms)`);
		assert.equal(Number(a.duration_min), 30, 'default duration');
		t.note('form', { unauthenticated: noAuth.status, authenticated: res.status, storedPhoneIsE164: true, startDriftMs: drift });
		await t.deactivate();
		assert.count(await sendsSince(mark), 0, 'the form sends nothing');
		assert.count(await rowsAll(), 3, 'three rows now');
		await assertOnlyOwner('form');
	});

	await t.step('1c a rejected form entry (a past date) answers 422 with the reason and saves nothing', async () => {
		await avoidHourlyMinute(120);
		await t.activate();
		const url = `${t.urls.n8n}/form/${t.workflow.node('Form: new appointment').parameters.path}`;
		const body = new FormData();
		['Reject Me', digits(OWNER).slice(2), 'Check-up', '2020-01-01', '10:00', '', '', ''].forEach((v, i) => body.append(`field-${i}`, v));
		const res = await fetch(url, { method: 'POST', headers: { authorization: FORM_AUTH }, body });
		const text = await res.text();
		await t.deactivate();
		t.note('formRejected', { status: res.status });
		assert.equal(res.status, 422, `422: ${text}`);
		assert.count(await t.tables.rows(TABLE, { where: { customer_name: 'Reject Me' } }), 0, 'nothing saved');
		assert.equal(real.guard.messagesAccepted, 0, 'nothing sent');
	});

	await t.step('2 the hourly branch sends two REAL calendar invitations (A in 3 h, B in 20 h) and records them', async () => {
		await assertOnlyOwner('hourly 1');
		const mark = await real.guard.mark();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());

		const invites = await invitesSince(mark);
		assert.count(invites, 2, 'two invitations, not three (sample C is 75 hours ahead)');
		for (const s of invites) {
			assert.equal(digits(s.to?.number), digits(OWNER), 'invitation goes to the owner test number');
			assert.ok(s.status === 202 || s.status === 200, `the real API accepted the send (status ${s.status})`);
			assert.match(String(s.messageId), /^msg_[0-9a-f]{32}$/, 'a real message id came back');
		}
		invA = invites.find((s) => s.content.name.startsWith('Check-up'));
		invB = invites.find((s) => s.content.name.startsWith('Follow-up'));
		assert.ok(invA && invB, 'both samples invited');
		assert.match(invA.content.description, /If you see the buttons below, tap one, or just reply here\./, 'the invitation text of Your settings');
		const flagged = execution.runData['Flag reminders that were not sent'][0];
		const recorded = execution.runData['Record the reminder or the failure'][0];
		assert.ok(flagged.startTime >= recorded.startTime + recorded.executionTime, 'the flag step ran after the invitations were recorded');
		t.note('realSendResponse', { status: invA.status, keys: bodyKeys(invA.response) });
		t.note('realSendRequestContentKeys', bodyKeys(invA.content));

		const a = await one({ customer_name: 'Sample Customer A' });
		const b = await one({ customer_name: 'Sample Customer B' });
		assert.equal(a.status, 'reminded', 'A reminded');
		assert.equal(b.status, 'reminded', 'B reminded');
		assert.equal(a.reminder_message_id, invA.messageId, 'A stores the real message id');
		assert.equal(b.reminder_message_id, invB.messageId, 'B stores the real message id');
		assert.equal((await one({ customer_name: 'Sample Customer C' })).status, 'scheduled', 'C waits');
		assert.count(await textsSince(mark), 0, 'no owner message: nothing failed, nothing was missed');

		// Get Quota, as the workflow saw it
		const quotaOut = execution.first('Get the message quota');
		t.note('getQuotaOutput', { keys: bodyKeys(quotaOut), tier: quotaOut.tier, tierType: typeof quotaOut.tier, remainingType: typeof quotaOut.remaining });
		assert.equal(typeof quotaOut.remaining, 'number', 'Get Quota gives remaining as a number');
	});

	await t.step('3 the real API shows the invitations: type, status progression sent then delivered, responses and receipts', async () => {
		for (const [label, inv] of [['A', invA], ['B', invB]]) {
			const msg = await real.message(inv.messageId);
			t.note(`message${label}`, { content_type: msg.content_type, origin: msg.origin, direction: msg.direction, keys: bodyKeys(msg) });
			assert.equal(msg.content_type, 'calendar', `${label} is a calendar event on the real API`);
			assert.equal(digits(msg.to?.number), digits(OWNER), `${label} is addressed to the owner test number`);
			const obs = await real.observe(inv.messageId, ['delivered', 'read'], { timeoutMs: 90_000, intervalMs: 3000 });
			t.note(`progression${label}`, { reached: obs.state, seen: obs.seen });
			assert.ok(obs.seen.length >= 1, `${label}: at least one state seen`);
			const responses = await real.responses(inv.messageId);
			assert.equal(responses.counts, { going: 0, not_going: 0, maybe: 0, extra_guests: 0 }, `${label}: no answers yet, counts carry the four keys`);
		}
		const quotaAfter = await real.quota();
		t.note('quotaUsedDelta', quotaAfter.used - quotaBefore.used);
	});

	await t.step('4 a second hourly run sends nothing (duplicate handling against the real API)', async () => {
		await assertOnlyOwner('hourly 2');
		const mark = await real.guard.mark();
		const before = await rowsAll();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());
		assert.count(await sendsSince(mark), 0, 'nothing leaves on the second run');
		assert.count((await real.guard.requests({ method: 'POST', since: mark })), 0, 'no POST at all');
		assert.equal(JSON.stringify(await rowsAll()), JSON.stringify(before), 'the table did not change');
	});

	await t.step('4b the time zone guard with the REAL $now.zoneName: a mismatching expected_timezone stops the run, nothing is sent', async () => {
		const setZone = async (value) => {
			const wf = await t.workflow.refresh();
			const nodes = JSON.parse(JSON.stringify(wf.nodes));
			nodes.find((n) => n.name === 'Your settings').parameters.assignments.assignments.find((a) => a.name === 'expected_timezone').value = value;
			await t.n8n.rest('PATCH', `/rest/workflows/${wf.id}`, { nodes, versionId: wf.versionId });
			await t.workflow.refresh();
		};
		await setZone('Asia/Tokyo');
		const mark = await real.guard.mark();
		const execution = await t.run(NODES.hourly);
		await setZone('America/Sao_Paulo');
		assert.equal(execution.status, 'error', 'the hourly run stops');
		const message = execution.nodeError('Write the invitations')?.message ?? '';
		t.note('timeZoneGuard', message.slice(0, 200));
		assert.match(message, /Time zone mismatch: this workflow runs in America\/Sao_Paulo but expected_timezone in Your settings is Asia\/Tokyo/, 'the real $now.zoneName is America/Sao_Paulo and the message says both zones');
		assert.count(await sendsSince(mark), 0, 'nothing is sent');
		const fine = await t.run(NODES.hourly);
		assert.equal(fine.status, 'success', 'put back, it runs again');
		assert.count(await sendsSince(mark), 0, 'and still sends nothing (all reminded)');
	});

	await t.step('5 a crash between the send and the save (row put back) replays the SAME idempotency key: the real API returns the original message', async () => {
		await assertOnlyOwner('replay');
		const a = await one({ customer_name: 'Sample Customer A' });
		const quota1 = await real.quota();
		await t.tables.update(TABLE, { id: a.id }, { status: 'scheduled', reminder_message_id: '', reminded_at: '' });
		const mark = await real.guard.mark();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());
		const posts = (await real.guard.requests({ method: 'POST', since: mark })).filter((r) => /\/messages$/.test(r.path));
		assert.count(posts, 1, 'one send request: the replay');
		t.note('replay', { status: posts[0].status, sameMessageId: posts[0].response?.message_id === invA.messageId, headers: posts[0].responseHeaders, responseKeys: bodyKeys(posts[0].response) });
		assert.equal(posts[0].response?.message_id, invA.messageId, 'the real API answered with the original message id');
		assert.equal(real.guard.messagesAccepted, 2, 'no third message exists');
		assert.equal((await one({ id: a.id })).reminder_message_id, invA.messageId, 'the row stores the original id again');
		const quota2 = await real.quota();
		t.note('replayQuotaUsedDelta', quota2.used - quota1.used);
		assert.equal(quota2.used - quota1.used, 0, 'a replay costs no quota');
	});

	await t.step('6 a row whose phone has no "+" (the owner test number): the node refuses it before any request, the row says why, the owner gets one real alert', async () => {
		const rowPhone = digits(OWNER);
		await t.tables.insert(TABLE, [
			{ customer_name: 'No Plus Customer', phone: rowPhone, title: 'Walk-in', location: '', start_at: iso(Date.now() + 9 * HOUR), duration_min: 30, status: 'scheduled', reminder_message_id: '', reminded_at: '', rsvp_at: '', extra_guests: 0, last_error: '', notes: '' },
		]);
		await t.tables.insert(TABLE, [
			{ customer_name: 'Too Soon Customer', phone: OWNER, title: 'Quick call', location: '', start_at: iso(Date.now() + 20 * 60_000), duration_min: 30, status: 'scheduled', reminder_message_id: '', reminded_at: '', rsvp_at: '', extra_guests: 0, last_error: '', notes: '' },
		]);
		await assertOnlyOwner('no plus');
		const mark = await real.guard.mark();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());
		const posts = (await real.guard.requests({ method: 'POST', since: mark })).filter((r) => /\/messages$/.test(r.path));
		assert.count(posts, 1, 'one request: the one owner message');
		assert.equal(posts[0].body?.content?.start_at, undefined, 'no calendar request was made for the row: the node refused the number itself');
		assert.equal(digits(posts[0].body?.to?.number), digits(OWNER), 'the owner message goes to the owner test number');
		assert.match(String(posts[0].body?.content?.text), /Not reminded \(1\):\n- Too Soon Customer, Quick call, [^\n]*: it starts in \d+ minutes, less than the 60 minutes of notice a reminder needs/, 'it lists the booked-too-late row with its reason');
		assert.match(String(posts[0].body?.content?.text), /Reminder failed \(1\):\n- No Plus Customer, Walk-in, [^\n]*: the phone number is not valid/, 'it lists the row and says why');
		assert.match(String(posts[0].body?.content?.text), /America\/Sao_Paulo/, 'and shows the time zone');
		const row = await one({ customer_name: 'No Plus Customer' });
		assert.equal(row.status, 'invalid_phone', 'the row is invalid_phone');
		assert.equal((await one({ customer_name: 'Too Soon Customer' })).status, 'not_reminded', 'the too-soon row is not_reminded');
		t.note('ownerMessageSent', { status: posts[0].status, sections: String(posts[0].body?.content?.text).split('\n\n').map((x) => x.split('\n')[0]) });
		t.note('noPlusPhone', { calendarRequestMade: false, rowStatus: row.status, rowError: row.last_error, alertStatus: posts[0].status });
	});

	await t.step('7 the Polling Trigger runs live for a few ticks on the real events feed without an error', async () => {
		await assertOnlyOwner('polling');
		const mark = await real.guard.mark();
		const execMark = await t.executionMark();
		await avoidHourlyMinute(200);
		await t.activate();
		await t.sleep(150_000); // two ticks (n8n cannot poll faster than once a minute)
		const executions = (await t.n8n.listExecutions(t.workflow.id)).filter((e) => Number(e.id) > execMark);
		await t.deactivate();
		const polls = (await real.guard.requests({ method: 'GET', path: '/v1/events', since: mark }));
		t.note('polling', { eventRequests: polls.length, statuses: [...new Set(polls.map((p) => p.status))], firstQuery: polls[0]?.query, executionsStarted: executions.length, executionStatuses: executions.map((e) => e.status) });
		assert.ok(polls.length >= 2, `the trigger polled the real events feed at least twice (saw ${polls.length})`);
		assert.ok(polls.every((p) => p.status === 200), 'every poll got 200');
		assert.ok(executions.every((e) => e.status !== 'error' && e.status !== 'crashed'), 'no execution failed while it was live');
		assert.equal(real.guard.messagesAccepted, 3, 'the live window sent nothing new (3 so far: two invitations and one owner message)');
	});

	const eventFor = (messageId, response, name, extra) => ({
		id: `evt_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
		type: 'message.calendar_responded',
		organization_id: 'org_00000000000000000000000000000000',
		number_alias: 'main',
		number_id: 'num_00000000000000000000000000000000',
		created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
		data: {
			id: messageId,
			from: { name, number: digits(OWNER) }, // documented shape: the number without +
			to: { name: 'Turbo Notify', alias: 'main', number: '5511000000000' },
			response,
			...(extra ? { extra_guests: extra } : {}),
			direction: 'inbound',
			channel: 'whatsapp',
			origin: 'native',
			at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
		},
	});

	let declineEvent;
	await t.step('8 the guest-answer branch, fed documented-shape answers (NOT a real RSVP tap): an outbound answer is ignored, then going, then not going', async () => {
		await assertOnlyOwner('answers');
		// an answer given from the connected phone itself (direction outbound) is the owner answering: nothing happens
		const outbound = eventFor(invA.messageId, 'not_going', 'Sample Customer A');
		outbound.data.direction = 'outbound';
		let mark0 = await real.guard.mark();
		const ignored = await t.run(NODES.poll, { pin: { [NODES.poll]: [outbound] } });
		assert.equal(ignored.status, 'success', ignored.describe());
		assert.equal((await one({ customer_name: 'Sample Customer A' })).status, 'reminded', 'an outbound answer changes nothing');
		assert.count(await sendsSince(mark0), 0, 'and sends nothing');
		// going
		let mark = await real.guard.mark();
		let execution = await t.run(NODES.poll, { pin: { [NODES.poll]: [eventFor(invA.messageId, 'going', 'Sample Customer A')] } });
		assert.equal(execution.status, 'success', execution.describe());
		const a = await one({ customer_name: 'Sample Customer A' });
		assert.equal(a.status, 'confirmed', 'A is confirmed');
		const thanks = await textsSince(mark);
		assert.count(thanks, 1, 'one thank-you text');
		assert.equal(digits(thanks[0].to.number), digits(OWNER), 'to the owner test number');
		assert.ok(thanks[0].status === 202 || thanks[0].status === 200, `accepted by the real API (${thanks[0].status})`);

		// not going
		declineEvent = eventFor(invB.messageId, 'not_going', 'Sample Customer B');
		mark = await real.guard.mark();
		execution = await t.run(NODES.poll, { pin: { [NODES.poll]: [declineEvent] } });
		assert.equal(execution.status, 'success', execution.describe());
		const b = await one({ customer_name: 'Sample Customer B' });
		assert.equal(b.status, 'declined', 'B is declined');
		const sends = await sendsSince(mark);
		assert.count(sends, 3, 'a text to the owner, a text to the customer, the contact card');
		const card = sends.find((s) => s.content?.display_name !== undefined);
		assert.ok(card, 'the contact card was sent');
		for (const s of sends) assert.ok(s.status === 202 || s.status === 200, `accepted by the real API (${s.status})`);
		t.note('contactCardSend', { status: card.status, requestKeys: bodyKeys(card.content), responseKeys: bodyKeys(card.response) });
		assert.ok(real.guard.messagesAccepted <= 8, 'inside the budget');
	});

	await t.step('9 the same decline answer processed again creates no new message (real idempotency)', async () => {
		const before = real.guard.messagesAccepted;
		const mark = await real.guard.mark();
		const execution = await t.run(NODES.poll, { pin: { [NODES.poll]: [declineEvent] } });
		assert.equal(execution.status, 'success', execution.describe());
		const posts = (await real.guard.requests({ method: 'POST', since: mark })).filter((r) => /\/messages$/.test(r.path));
		t.note('answerReplay', { requests: posts.length, statuses: posts.map((p) => p.status) });
		assert.equal(real.guard.messagesAccepted, before, 'no new message id: the replays returned the originals');
	});

	await t.step('10 what the real API holds matches what was sent: only the owner test number, nothing else', async () => {
		const all = [...new Set(real.guard.acceptedMessageIds())];
		assert.ok(all.length <= 8, `the budget of 8 real messages holds (${all.length} sent)`);
		const list = await real.listSent(40);
		const mine = list.data.filter((m) => m.origin !== 'native' && Date.parse(m.at) >= Date.parse(real.startedAt) - 2000);
		assert.equal(mine.length, all.length, 'the real API lists exactly the messages the harness counted');
		for (const m of mine) assert.equal(digits(m.to?.number), digits(OWNER), 'every message went to the owner test number');
		t.note('messagesSent', all.length);
		t.note('guard', { blockedCalls: real.guard.blocked, requests: (await real.guard.requests()).length });
		assert.equal(real.guard.blocked, 0, 'the guard blocked nothing: the workflow never tried another number or a forbidden call');
	});
}

/** Runs before the harness deletes the messages: the table goes first. */
export async function cleanup(t) {
	try {
		const table = (await t.n8n.dataTables()).find((x) => x.name === TABLE);
		if (table) {
			await t.n8n.rest('DELETE', `/rest/projects/${t.n8n.projectId}/data-tables/${table.id}`);
			t.note('dataTableDeleted', true);
		}
	} catch (error) {
		t.note('dataTableDeleted', `failed: ${error.message}`);
	}
	const results = [];
	for (const id of t.real.guard.acceptedMessageIds()) {
		const r = await t.real.deleteWhenSent(id);
		results.push({ state: r.state, status: r.status, deleted: r.deleted, error: r.error });
	}
	t.note('deleteForEveryone', results);
}
