/**
 * Scenario for T1 (appointment-reminders-with-rsvp). One run, in this order:
 *   E  "Run once: create the table" creates the table, twice is harmless
 *   B  the hourly branch: window, ONE owner message with only exceptions (not reminded, failed, no answer), quota
 *      room (one message kept free), repeat run, crash between send and save, refused send, no_answer flagged once
 *   C  the Polling Trigger: going / not going / maybe, extra guests, unknown id, repeated event, an answer given from
 *      the connected phone (direction outbound) is ignored, a delivery failure tells the owner
 *   A  the form: valid and rejected entries answer 422 with the reason, local phone formats, per day cap, time zone
 *   Z  the time zone mismatch stops the hourly run and the poll with a clear message
 *   Also: the flag step waits for the sends (deterministic order, with and without rows to send), the customer texts
 *   and the date format come from Your settings, no_answer_window_hours 0 switches the no answer report off, answers
 *   given while the workflow was inactive are handled once when it is active again
 *
 * The workflow is imported exactly as exported. Only the owner phone is patched in `prepare` (the placeholder
 * would otherwise stop every run on purpose). Other Settings values are changed the way a person edits the node,
 * through the stored workflow, and put back. No data table is declared: the workflow creates it.
 */
export const timeoutMs = 40 * 60_000;
const OWNER = '+5511977770099';
const FORM_USER = 'staff';
const FORM_PASSWORD = 'harness-form-password';
const FORM_AUTH = `Basic ${Buffer.from(`${FORM_USER}:${FORM_PASSWORD}`).toString('base64')}`;

// The form is protected by Basic Auth: the harness creates the credential the workflow asks for.
export const credentials = [{ type: 'httpBasicAuth', name: 'Form access (Basic Auth)', data: { user: FORM_USER, password: FORM_PASSWORD } }];
export const mock = { delays: '300,600,1200', quota: 500, contactQuota: 500, plan: 'business' };
const NODES = {
	form: 'Form: new appointment',
	hourly: 'Every hour: remind and report',
	poll: 'Poll: guest answered or delivery failed',
	manual: 'Run once: create the table',
};
const TABLE = 'appointments';
const HOUR = 3_600_000;

function setSettings(nodes, patch) {
	const settings = nodes.find((n) => n.name === 'Your settings');
	for (const assignment of settings.parameters.assignments.assignments) {
		if (assignment.name in patch) assignment.value = patch[assignment.name];
	}
}

export async function prepare(workflow) {
	if (process.env.T1_KEEP_PLACEHOLDER !== '1') setSettings(workflow.nodes, { owner_phone: OWNER });
	return workflow;
}

const iso = (ms) => new Date(ms).toISOString();

export default async function scenario(t) {
	const { assert } = t;
	const now = Date.now();
	const row = (over) => ({
		customer_name: 'Test Customer',
		phone: '+5511977770011',
		title: 'Check-up',
		location: '',
		start_at: iso(now + 5 * HOUR),
		duration_min: 30,
		status: 'scheduled',
		reminder_message_id: '',
		reminded_at: '',
		rsvp_at: '',
		extra_guests: 0,
		last_error: '',
		notes: '',
		...over,
	});
	const rowsBy = async (where) => t.tables.rows(TABLE, { where });
	const one = async (where) => {
		const rows = await rowsBy(where);
		assert.count(rows, 1, `one row for ${JSON.stringify(where)}`);
		return rows[0];
	};
	const textsTo = async (mark, number) =>
		(await t.mock.sends({ since: mark })).filter((s) => s.to?.number === number && s.content?.text !== undefined);
	const calendarTo = async (mark, number) =>
		(await t.mock.sends({ since: mark })).filter((s) => s.to?.number === number && s.content?.start_at !== undefined);
	/** Changes values of Your settings on the stored workflow, the way a person edits the node. */
	const config = async (patch) => {
		const wf = await t.workflow.refresh();
		const nodes = JSON.parse(JSON.stringify(wf.nodes));
		setSettings(nodes, patch);
		await t.n8n.rest('PATCH', `/rest/workflows/${wf.id}`, { nodes, versionId: wf.versionId });
		await t.workflow.refresh();
	};

	/* ------------------------------------------------------------------ E: the table */
	await t.step('E: "Run once: create the table" creates the table with 13 columns, sends nothing, saves no row', async () => {
		const mark = await t.mock.mark();
		const execution = await t.run(NODES.manual);
		assert.equal(execution.status, 'success', execution.describe());
		const tables = (await t.n8n.dataTables()).filter((tb) => tb.name === TABLE);
		assert.count(tables, 1, 'one table');
		const names = tables[0].columns.map((c) => c.name).filter((n) => !['id', 'createdAt', 'updatedAt'].includes(n));
		assert.equal(names.sort(), ['customer_name', 'duration_min', 'extra_guests', 'last_error', 'location', 'notes', 'phone', 'reminded_at', 'reminder_message_id', 'rsvp_at', 'start_at', 'status', 'title'], 'the 13 columns');
		assert.count(await rowsBy({}), 0, 'no sample rows: the first row comes from the form');
		assert.count(await t.mock.sends({ since: mark }), 0, 'nothing is sent');
	});
	await t.step('E: running it again reuses the table (no second table, no error)', async () => {
		await t.tables.insert(TABLE, [row({ customer_name: 'Survivor' })]);
		const execution = await t.run(NODES.manual);
		assert.equal(execution.status, 'success', execution.describe());
		assert.count((await t.n8n.dataTables()).filter((tb) => tb.name === TABLE), 1, 'still one table');
		assert.count(await rowsBy({ customer_name: 'Survivor' }), 1, 'the rows are kept');
		await t.tables.clear(TABLE);
	});

	/* ------------------------------------------------------------------ B: hourly run */
	let dueMessageId;
	let dueRowId;
	await t.step('B: only the appointments inside the window get an invitation, once, and ONE owner message lists every exception', async () => {
		const at = (h) => iso(Date.now() + h * HOUR);
		await t.tables.insert(TABLE, [
			row({ customer_name: 'Due Customer', phone: '+5511977770011', title: 'Check-up', start_at: at(5), duration_min: 45, location: 'Main Street 1' }),
			row({ customer_name: 'Later Customer', phone: '+5511977770012', title: 'Cleaning', start_at: at(23) }),
			row({ customer_name: 'Far Customer', phone: '+5511977770013', start_at: at(50) }),
			row({ customer_name: 'Past Customer', phone: '+5511977770014', start_at: at(-2) }),
			row({ customer_name: 'Close Customer', phone: '+5511977770015', start_at: iso(Date.now() + 20 * 60_000) }),
			row({ customer_name: 'Already Customer', phone: '+5511977770016', start_at: at(10), status: 'reminded', reminder_message_id: 'msg_00000000000000000000000000000001', reminded_at: at(-2) }),
			row({ customer_name: 'Invalid Customer', phone: '5511977770017', start_at: at(6) }),
			row({ customer_name: 'Silent Customer', phone: '+5511977770018', title: 'Follow-up', start_at: at(3), status: 'reminded', reminder_message_id: 'msg_00000000000000000000000000000002', reminded_at: at(-3) }),
		]);
		const mark = await t.mock.mark();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());

		const sends = await t.mock.sends({ since: mark });
		const invites = sends.filter((s) => s.content?.start_at !== undefined);
		assert.equal(invites.map((s) => s.to.number).sort(), ['+5511977770011', '+5511977770012'], 'only the two due appointments are invited');

		const due = await one({ customer_name: 'Due Customer' });
		dueRowId = due.id;
		const invite = invites.find((s) => s.to.number === '+5511977770011');
		assert.equal(invite.content.name, 'Check-up at Your Business Name', 'event name = title at business');
		assert.equal(Date.parse(invite.content.start_at), Date.parse(due.start_at), 'event start is the stored start');
		assert.equal(Date.parse(invite.content.end_at) - Date.parse(invite.content.start_at), 45 * 60_000, 'event end = start + duration');
		assert.equal(invite.content.has_reminder, true, 'WhatsApp reminder on');
		assert.equal(invite.content.reminder_offset_sec, 3600, 'alarm 60 minutes before (invite_alarm_minutes_before)');
		assert.match(invite.content.description, /Where: Main Street 1/, 'location is in the text');
		assert.match(invite.content.description, /When: \w+ \d+ \w+ at \d\d:\d\d/, 'date and time are repeated in the text (a personal WhatsApp account shows the invitation without the time card)');
		assert.match(invite.content.description, /If you see the buttons below, tap one, or just reply here\./, 'the text asks for an answer without promising buttons');
		assert.ok(!/Please tap Going/.test(invite.content.description), 'it no longer asks for buttons a personal account may not see');
		const later = invites.find((s) => s.to.number === '+5511977770012');
		assert.ok(!/Where:/.test(later.content.description), 'a row with no location has no Where line');
		assert.ok(!invite.content.extra_guests_allowed, 'extra guests are off by default');
		assert.equal(invite.idempotencyKey, `appt-${due.id}-${Date.parse(due.start_at)}`, 'idempotency key is built from the row id and start');
		dueMessageId = invite.messageId;

		assert.equal(due.status, 'reminded', 'row marked reminded');
		assert.equal(due.reminder_message_id, invite.messageId, 'message id stored for matching the answer');
		assert.ok(Date.now() - Date.parse(due.reminded_at) < 5 * 60_000, 'reminded_at is now');
		assert.equal((await one({ customer_name: 'Later Customer' })).status, 'reminded', 'an appointment 23 hours ahead is inside the 24 hour window');
		assert.equal((await one({ customer_name: 'Far Customer' })).status, 'scheduled', 'too far ahead: left alone');
		assert.equal((await one({ customer_name: 'Already Customer' })).reminder_message_id, 'msg_00000000000000000000000000000001', 'an already reminded row is not touched');
		assert.equal((await one({ customer_name: 'Already Customer' })).status, 'reminded', 'and stays reminded (its appointment is outside the no answer window)');

		// exceptions: never lost silently
		const past = await one({ customer_name: 'Past Customer' });
		const close = await one({ customer_name: 'Close Customer' });
		assert.equal(past.status, 'not_reminded', 'a scheduled row whose start passed is flagged, not forgotten');
		assert.equal(close.status, 'not_reminded', 'a row booked with too little notice is flagged, not forgotten');
		assert.ok(past.last_error.length > 0 && close.last_error.length > 0, 'the row keeps a reason');
		const invalid = await one({ customer_name: 'Invalid Customer' });
		assert.equal(invalid.status, 'invalid_phone', 'a number without + is marked invalid_phone');
		assert.ok(invalid.last_error.length > 0, 'the reason is stored');
		assert.equal((await one({ customer_name: 'Silent Customer' })).status, 'no_answer', 'a reminded row whose appointment is 3 hours away with no answer becomes no_answer');

		// the flag step is chained after the sends: it started only after the last record of an invitation had ended
		const ran = (name) => execution.runData[name][0];
		const recorded = ran('Record the reminder or the failure');
		const flagged = ran('Flag reminders that were not sent');
		assert.ok(flagged.startTime >= recorded.startTime + recorded.executionTime, 'Flag reminders that were not sent started after Record the reminder or the failure ended');
		assert.ok(execution.nodesRun.indexOf('Wait for the invitations to finish') >= 0, 'the Merge that orders them ran');

		const toOwner = await textsTo(mark, OWNER);
		assert.count(toOwner, 1, 'exactly ONE message to the owner for the whole run');
		assert.equal(sends.length, 3, 'two invitations and one owner message, nothing else');
		const text = toOwner[0].content.text;
		assert.match(text, /Not reminded \(2\):/, 'not reminded section');
		assert.match(text, /Past Customer, Check-up, [^\n]*: the appointment had already started/, 'the past row with its reason');
		assert.match(text, /Close Customer, Check-up, [^\n]*: it starts in (19|20) minutes, less than the 60 minutes of notice/, 'the close row with its reason');
		assert.match(text, /Reminder failed \(1\):\n- Invalid Customer, [^\n]*: the phone number is not valid \(5511977770017\)/, 'the invalid phone');
		assert.match(text, /No answer yet \(1\):\n- Silent Customer, Follow-up, [^\n]*, \+5511977770018, in (2\.9|3|3\.1) h/, 'the customer who has not answered, with the phone and the hours left');
		assert.match(text, /America\/Sao_Paulo/, 'the time zone is shown');
		assert.match(text, /set its status back to scheduled/, 'what to do');
		for (const name of ['Due Customer', 'Later Customer', 'Far Customer', 'Already Customer']) assert.ok(!text.includes(name), `${name} is not an exception`);
		assert.ok(!/quota/i.test(text), 'no quota line when the quota was not the cause');
	});
	await t.step('B: a second run sends nothing at all (repeat run, duplicate handling, exceptions are reported once)', async () => {
		const mark = await t.mock.mark();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());
		assert.count(await t.mock.sends({ since: mark }), 0, 'nothing leaves on the second run: not even the owner message again');
	});
	await t.step('B: a crash between the send and the save cannot double send (same idempotency key)', async () => {
		const before = (await t.mock.messages()).length;
		const original = await one({ id: dueRowId });
		await t.tables.update(TABLE, { id: dueRowId }, { status: 'scheduled', reminder_message_id: '', reminded_at: '' });
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());
		assert.equal((await t.mock.messages()).length, before, 'Turbo Notify created no second message');
		const again = await one({ id: dueRowId });
		assert.equal(again.status, 'reminded', 'row is reminded again');
		assert.equal(again.reminder_message_id, original.reminder_message_id, 'the original message id came back from the replay');
	});
	await t.step('B: a send the API refuses is recorded in the row and reported in the one message', async () => {
		await t.tables.clear(TABLE);
		await t.tables.insert(TABLE, [row({ customer_name: 'Refused Customer', phone: '+5511977770018', start_at: iso(Date.now() + 7 * HOUR) })]);
		await t.mock.fault({ method: 'POST', path: '/messages$', status: 422, body: { error: 'validation_error', message: 'The API refused this send.' }, times: 1 });
		const mark = await t.mock.mark();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', `the run goes on (Continue On Fail): ${execution.describe()}`);
		const r = await one({ customer_name: 'Refused Customer' });
		assert.equal(r.status, 'send_failed', 'status send_failed');
		assert.ok(r.last_error.length > 0, 'reason stored');
		assert.ok(!/\.\./.test(r.last_error) && /\.( \S.*)?$/.test(r.last_error), `last_error is the message, a period and the hint, with no doubled period: "${r.last_error}"`);
		t.note('lastErrorOfARefusedSend', r.last_error);
		assert.equal(r.reminder_message_id, '', 'no message id');
		const alerts = await textsTo(mark, OWNER);
		assert.count(alerts, 1, 'one message');
		assert.match(alerts[0].content.text, /Reminder failed \(1\):\n- Refused Customer, [^\n]*: [^\n]+/, 'it names the customer and the reason');
		const mark2 = await t.mock.mark();
		await t.run(NODES.hourly);
		assert.count(await t.mock.sends({ since: mark2 }), 0, 'a send_failed row is not retried by itself, and not reported again');
		await t.tables.update(TABLE, { id: r.id }, { status: 'scheduled' });
		const mark3 = await t.mock.mark();
		await t.run(NODES.hourly);
		assert.equal((await calendarTo(mark3, '+5511977770018')).length, 1, 'setting the status back to scheduled sends it');
		assert.equal((await one({ id: r.id })).status, 'reminded', 'and it is reminded');
	});
	await t.step('B: quota room: one message always stays free for the owner, the rest is flagged with the quota line', async () => {
		await t.tables.clear(TABLE);
		await t.tables.insert(TABLE, [
			row({ customer_name: 'Quota Three', phone: '+5511977770023', start_at: iso(Date.now() + 6 * HOUR) }),
			row({ customer_name: 'Quota Two', phone: '+5511977770022', start_at: iso(Date.now() + 4 * HOUR) }),
			row({ customer_name: 'Quota One', phone: '+5511977770021', start_at: iso(Date.now() + 3 * HOUR) }),
		]);
		await t.mock.quota({ number: 'main', remaining: 3 });
		const mark = await t.mock.mark();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());
		assert.equal((await calendarTo(mark, '+5511977770021')).length, 1, 'the earliest appointment is invited');
		assert.equal((await calendarTo(mark, '+5511977770022')).length, 1, 'the second is invited');
		assert.equal((await calendarTo(mark, '+5511977770023')).length, 0, 'the third does not fit: 3 left, 1 kept for the owner');
		assert.equal((await one({ customer_name: 'Quota Three' })).status, 'not_reminded', 'it is flagged, not left to be forgotten');
		const toOwner = await textsTo(mark, OWNER);
		assert.count(toOwner, 1, 'the owner message still went out (the last unit of the quota was kept for it)');
		assert.match(toOwner[0].content.text, /Not reminded \(1\):\n- Quota Three, [^\n]*: the message quota had no room for it/, 'the reason');
		assert.match(toOwner[0].content.text, /Message quota left: 0 of /, 'the quota line');

		// nothing fits at all
		await t.tables.insert(TABLE, [row({ customer_name: 'Quota None', phone: '+5511977770024', start_at: iso(Date.now() + 3 * HOUR) })]);
		await t.mock.quota({ number: 'main', remaining: 1 });
		const mark2 = await t.mock.mark();
		await t.run(NODES.hourly);
		assert.count(await calendarTo(mark2, '+5511977770024'), 0, 'with 1 message left no invitation is sent');
		const toOwner2 = await textsTo(mark2, OWNER);
		assert.count(toOwner2, 1, 'but the owner is told');
		assert.match(toOwner2[0].content.text, /Quota None[^\n]*: the message quota had no room for it/, 'which row and why');
		assert.equal((await one({ customer_name: 'Quota None' })).status, 'not_reminded', 'flagged');
		await t.mock.quota({ number: 'main', remaining: 400 });
	});
	await t.step('B: no answer is flagged once, only inside the window and after the customer had an hour', async () => {
		await t.tables.clear(TABLE);
		const r = (name, over) => row({ customer_name: name, phone: '+5511977770051', ...over });
		await t.tables.insert(TABLE, [
			r('Silent Soon', { status: 'reminded', reminded_at: iso(Date.now() - 3 * HOUR), start_at: iso(Date.now() + 3 * HOUR) }),
			r('Silent Far', { status: 'reminded', reminded_at: iso(Date.now() - 3 * HOUR), start_at: iso(Date.now() + 10 * HOUR) }),
			r('Fresh Reminder', { status: 'reminded', reminded_at: iso(Date.now() - 10 * 60_000), start_at: iso(Date.now() + 2 * HOUR) }),
			r('Past Reminded', { status: 'reminded', reminded_at: iso(Date.now() - 30 * HOUR), start_at: iso(Date.now() - 1 * HOUR) }),
			r('Old No Answer', { status: 'no_answer', start_at: iso(Date.now() + 2 * HOUR) }),
			r('Confirmed Customer', { status: 'confirmed', start_at: iso(Date.now() + 2 * HOUR) }),
		]);
		const mark = await t.mock.mark();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());
		assert.equal((await one({ customer_name: 'Silent Soon' })).status, 'no_answer', 'reminded 3 hours ago, appointment in 3 hours: no_answer');
		for (const [name, status] of [['Silent Far', 'reminded'], ['Fresh Reminder', 'reminded'], ['Past Reminded', 'reminded'], ['Old No Answer', 'no_answer'], ['Confirmed Customer', 'confirmed']]) {
			assert.equal((await one({ customer_name: name })).status, status, `${name} stays ${status}`);
		}
		const toOwner = await textsTo(mark, OWNER);
		assert.count(toOwner, 1, 'one message');
		assert.match(toOwner[0].content.text, /No answer yet \(1\):\n- Silent Soon,/, 'only the customer just flagged');
		for (const name of ['Silent Far', 'Fresh Reminder', 'Past Reminded', 'Old No Answer', 'Confirmed Customer']) assert.ok(!toOwner[0].content.text.includes(name), `${name} is not listed`);
		const mark2 = await t.mock.mark();
		await t.run(NODES.hourly);
		assert.count(await t.mock.sends({ since: mark2 }), 0, 'the same customer is not listed twice');
	});
	await t.step('B: an hour later the customer who was reminded late is flagged (the hour of grace has passed)', async () => {
		await t.tables.update(TABLE, { customer_name: 'Fresh Reminder' }, { reminded_at: iso(Date.now() - 90 * 60_000) });
		const mark = await t.mock.mark();
		await t.run(NODES.hourly);
		assert.equal((await one({ customer_name: 'Fresh Reminder' })).status, 'no_answer', 'now flagged');
		const toOwner = await textsTo(mark, OWNER);
		assert.count(toOwner, 1, 'one message');
		assert.match(toOwner[0].content.text, /No answer yet \(1\):\n- Fresh Reminder,/, 'listed');
	});

	await t.step('B: no_answer_window_hours = 0 switches the "no answer yet" report off', async () => {
		await t.tables.clear(TABLE);
		await t.tables.insert(TABLE, [row({ customer_name: 'Silent Off', phone: '+5511977770052', status: 'reminded', reminded_at: iso(Date.now() - 3 * HOUR), start_at: iso(Date.now() + 2 * HOUR) })]);
		await config({ no_answer_window_hours: 0 });
		const mark = await t.mock.mark();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());
		assert.equal((await one({ customer_name: 'Silent Off' })).status, 'reminded', 'the row is left alone');
		assert.count(await t.mock.sends({ since: mark }), 0, 'and the owner hears nothing');
		await config({ no_answer_window_hours: 4 });
		const mark2 = await t.mock.mark();
		await t.run(NODES.hourly);
		assert.equal((await one({ customer_name: 'Silent Off' })).status, 'no_answer', 'back at 4 hours it is flagged');
		assert.count(await textsTo(mark2, OWNER), 1, 'and listed');
	});
	await t.step('B: with nothing to send the flag step still runs (it does not depend on a send having happened)', async () => {
		await t.tables.clear(TABLE);
		await t.tables.insert(TABLE, [row({ customer_name: 'Only Past', phone: '+5511977770053', start_at: iso(Date.now() - 1 * HOUR) })]);
		const mark = await t.mock.mark();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());
		assert.ok(!execution.ran('Send the calendar invitation'), 'no invitation was sent');
		assert.ok(execution.ran('Flag reminders that were not sent'), 'the flag step ran');
		assert.equal((await one({ customer_name: 'Only Past' })).status, 'not_reminded', 'the row is flagged');
		assert.count(await textsTo(mark, OWNER), 1, 'and reported');
	});
	await t.step('B: the invitation text, the date format and the customer texts come from Your settings', async () => {
		await t.tables.clear(TABLE);
		await t.tables.insert(TABLE, [
			row({ customer_name: 'Custom Text', phone: '+5511977770054', start_at: iso(Date.now() + 5 * HOUR), location: 'Annex 4' }),
			row({ customer_name: 'No Place', phone: '+5511977770055', start_at: iso(Date.now() + 6 * HOUR) }),
		]);
		await config({ invite_text: 'Hi {name}, see you at {business}, {when}.\\nPlace: {where}\\nReply here.', date_format: 'dd/LL HH:mm' });
		const mark = await t.mock.mark();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());
		const invites = (await t.mock.sends({ since: mark })).filter((s) => s.content?.start_at !== undefined);
		const custom = invites.find((s) => s.to.number === '+5511977770054').content.description;
		assert.match(custom, /^Hi Custom, see you at Your Business Name, \d\d\/\d\d \d\d:\d\d\.\nPlace: Annex 4\nReply here\.$/, 'the invitation text and the date format are the ones in Your settings');
		assert.equal(invites.find((s) => s.to.number === '+5511977770055').content.description.split('\n').length, 2, 'the Where line is dropped when the row has no location');
		await config({
			invite_text: 'Hello {name}, this is a reminder of your appointment at {business}.\\nWhen: {when}\\nWhere: {where}\\nIf you see the buttons below, tap one, or just reply here.',
			date_format: "cccc d LLLL 'at' HH:mm",
		});
	});

	/* ------------------------------------------------------------------ C: guest answers (Polling Trigger, workflow active) */
	const pollSince = async () => t.executionMark();
	const pollExecution = async (since) => {
		const executions = await t.waitExecutions({ since, timeoutMs: 300_000 });
		for (const e of executions) assert.equal(e.status, 'success', e.describe());
		return executions;
	};
	const ids = {};
	await t.step('C: activate and remind four customers (one of them cannot be reached)', async () => {
		await t.tables.clear(TABLE);
		await t.mock.recipient({ number: '+5511977770034', fail: { code: 'whatsapp_send_failed', message: 'This number is not on WhatsApp.' } });
		await t.activate();
		await t.tables.insert(TABLE, [
			row({ customer_name: 'Going Guest', phone: '+5511977770031', start_at: iso(Date.now() + 5 * HOUR), notes: 'keep me' }),
			row({ customer_name: 'Decline Guest', phone: '+5511977770032', start_at: iso(Date.now() + 6 * HOUR) }),
			row({ customer_name: 'Maybe Guest', phone: '+5511977770033', start_at: iso(Date.now() + 7 * HOUR) }),
			row({ customer_name: 'Async Failure Guest', phone: '+5511977770034', start_at: iso(Date.now() + 8 * HOUR) }),
		]);
		const sends0 = await t.mock.mark();
		const execution = await t.run(NODES.hourly);
		assert.equal(execution.status, 'success', execution.describe());
		for (const [key, name] of [['going', 'Going Guest'], ['decline', 'Decline Guest'], ['maybe', 'Maybe Guest'], ['async', 'Async Failure Guest']]) {
			const r = await one({ customer_name: name });
			assert.equal(r.status, 'reminded', `${name} reminded`);
			ids[key] = r.reminder_message_id;
		}
		assert.count(await textsTo(sends0, OWNER), 0, 'nothing failed synchronously: no owner message');
	});
	await t.step('C: a delivery failure reported later is recorded in the row and the owner is told (Polling Trigger, message.send.failed)', async () => {
		await t.waitFor(async () => (await one({ customer_name: 'Async Failure Guest' })).status === 'send_failed', { timeoutMs: 300_000, message: 'the poller to record the failed delivery' });
		const r = await one({ customer_name: 'Async Failure Guest' });
		assert.match(r.last_error, /not on WhatsApp/, 'the reason from WhatsApp is stored');
		assert.equal(r.reminder_message_id, ids.async, 'same row');
		await t.waitFor(async () => (await textsTo(0, OWNER)).some((s) => /Async Failure Guest/.test(s.content.text)), { timeoutMs: 120_000, message: 'the owner text about the failed delivery' });
		const note = (await textsTo(0, OWNER)).find((s) => /Async Failure Guest/.test(s.content.text));
		assert.match(note.content.text, /could not be delivered: This number is not on WhatsApp\. Check the number \+5511977770034, then set the row status back to scheduled\./, 'the owner text says why, names the number to check and what to do, with one period after the reason');
	});
	await t.step('C: going with two extra guests confirms the row and thanks the customer', async () => {
		const sends0 = await t.mock.mark();
		const since = await pollSince();
		await t.mock.injectCalendarResponse({ message_id: ids.going, from: '+5511977770031', name: 'Going Guest', response: 'going', extra_guests: 2 });
		await pollExecution(since);
		await t.waitFor(async () => (await one({ customer_name: 'Going Guest' })).status === 'confirmed', { timeoutMs: 90_000, message: 'row confirmed' });
		await t.waitFor(async () => (await textsTo(sends0, '+5511977770031')).length === 1, { timeoutMs: 90_000, message: 'the thank-you' });
		const r = await one({ customer_name: 'Going Guest' });
		assert.equal(r.extra_guests, 2, 'extra guests recorded');
		assert.equal(r.notes, 'keep me', 'the notes written by the business are left alone');
		assert.match(r.rsvp_at, /^\d{4}-\d\d-\d\dT/, 'answer time stored');
		const [thanks] = await textsTo(sends0, '+5511977770031');
		assert.match(thanks.content.text, /confirmed/, 'says confirmed');
		assert.match(thanks.content.text, /2 extra guest/, 'mentions the extra guests');
		assert.count(await textsTo(sends0, OWNER), 0, 'the owner is not bothered');
	});
	await t.step('C: not going tells the customer we will call, texts the owner and sends the contact card', async () => {
		const sends0 = await t.mock.mark();
		const since = await pollSince();
		await t.mock.injectCalendarResponse({ message_id: ids.decline, from: '+5511977770032', name: 'Decline Guest', response: 'not_going' });
		await pollExecution(since);
		await t.waitFor(async () => (await one({ customer_name: 'Decline Guest' })).status === 'declined', { timeoutMs: 90_000, message: 'row declined' });
		await t.waitFor(async () => (await t.mock.sends({ since: sends0 })).length >= 3, { timeoutMs: 90_000, message: 'three messages' });
		const sends = await t.mock.sends({ since: sends0 });
		assert.count(sends, 3, 'exactly three messages');
		const toCustomer = sends.filter((s) => s.to?.number === '+5511977770032');
		assert.count(toCustomer, 1, 'one text to the customer');
		assert.match(toCustomer[0].content.text, /contact you to reschedule/, 'we will contact you to reschedule');
		const toOwner = sends.filter((s) => s.to?.number === OWNER);
		assert.count(toOwner, 2, 'two messages to the owner');
		const text = toOwner.find((s) => s.content.text);
		const card = toOwner.find((s) => s.content.display_name);
		assert.match(text.content.text, /Decline Guest declined the Check-up appointment/, 'owner text names the customer and the appointment');
		assert.equal(card.content.display_name, 'Decline Guest', 'contact card name');
		assert.equal(card.content.phones.map((p) => p.number), ['+5511977770032'], 'contact card phone');
		assert.ok(sends.indexOf(text) < sends.indexOf(card), 'the note comes before the card');
	});
	await t.step('C: maybe with one extra guest marks the row tentative', async () => {
		const sends0 = await t.mock.mark();
		const since = await pollSince();
		await t.mock.injectCalendarResponse({ message_id: ids.maybe, from: '+5511977770033', name: 'Maybe Guest', response: 'maybe', extra_guests: 1 });
		await pollExecution(since);
		await t.waitFor(async () => (await one({ customer_name: 'Maybe Guest' })).status === 'tentative', { timeoutMs: 90_000, message: 'row tentative' });
		assert.equal((await one({ customer_name: 'Maybe Guest' })).extra_guests, 1, 'guest recorded');
		await t.waitFor(async () => (await textsTo(sends0, '+5511977770033')).length === 1, { timeoutMs: 90_000, message: 'the customer text' });
		const [text] = await textsTo(sends0, '+5511977770033');
		assert.match(text.content.text, /might come/, 'maybe wording');
		assert.count(await textsTo(sends0, OWNER), 0, 'the owner is not bothered');
	});
	await t.step('C: an answer to an event that is not in the table is ignored; a guest who changes their mind is handled', async () => {
		// an event sent to someone outside the table (not by this workflow)
		const stranger = await fetch(`${t.mock.url}/v1/messages`, {
			method: 'POST',
			headers: { authorization: `Bearer ${t.mock.apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify({ to: { number: '+5511977770077' }, content: { name: 'Not ours', start_at: iso(Date.now() + 9 * HOUR) } }),
		}).then((r) => r.json());
		assert.ok(stranger.message_id, 'the stranger event exists');
		const before = JSON.stringify(await rowsBy({}));
		const sends0 = await t.mock.mark();
		const since = await pollSince();
		await t.mock.injectCalendarResponse({ message_id: stranger.message_id, from: '+5511977770077', response: 'not_going' });
		await t.mock.injectCalendarResponse({ message_id: ids.going, from: '+5511977770031', name: 'Going Guest', response: 'not_going' });
		await pollExecution(since);
		await t.waitFor(async () => (await one({ customer_name: 'Going Guest' })).status === 'declined', { timeoutMs: 90_000, message: 'the changed answer is applied' });
		await t.waitFor(async () => (await t.mock.sends({ since: sends0 })).length >= 3, { timeoutMs: 90_000, message: 'messages for the changed answer' });
		const after = await rowsBy({});
		const unchanged = after.filter((r) => r.customer_name !== 'Going Guest');
		assert.equal(JSON.stringify(unchanged), JSON.stringify(JSON.parse(before).filter((r) => r.customer_name !== 'Going Guest')), 'no other row changed');
		const sends = await t.mock.sends({ since: sends0 });
		assert.count(sends.filter((s) => s.to?.number === '+5511977770077'), 0, 'nothing is sent for the stranger event');
		assert.count(sends.filter((s) => s.to?.number === '+5511977770031'), 1, 'the customer who changed their mind gets one text');
		assert.count(sends.filter((s) => s.to?.number === OWNER), 2, 'and the owner gets the decline text and the card');
	});
	await t.step('C: an answer given while the workflow was inactive is handled once, at the next poll after it is active again', async () => {
		await t.deactivate();
		const sends0 = await t.mock.mark();
		await t.mock.injectCalendarResponse({ message_id: ids.maybe, from: '+5511977770033', name: 'Maybe Guest', response: 'going', extra_guests: 0 });
		await t.sleep(4000);
		assert.equal((await one({ customer_name: 'Maybe Guest' })).status, 'tentative', 'nothing is handled while n8n is not polling');
		assert.count(await textsTo(sends0, '+5511977770033'), 0, 'and nobody was thanked yet');
		await t.activate();
		await t.waitFor(async () => (await one({ customer_name: 'Maybe Guest' })).status === 'confirmed', { timeoutMs: 300_000, message: 'the answer given while the workflow was off to be handled' });
		await t.waitFor(async () => (await textsTo(sends0, '+5511977770033')).length >= 1, { timeoutMs: 90_000, message: 'the (late) thank-you' });
		await t.sleep(75_000); // more than one poll interval: a poll that finds nothing new starts no stored execution, so wait it out
		assert.count(await textsTo(sends0, '+5511977770033'), 1, 'one thank-you, not repeated by the next poll');
		assert.match((await textsTo(sends0, '+5511977770033'))[0].content.text, /confirmed/, 'it is the Going text');
	});
	await t.deactivate();
	await t.step('C: the customer texts come from Your settings (Going with a guest, Maybe, Not going)', async () => {
		await config({
			thanks_going_text: 'Great, {name}!{guests} See you {when}.',
			thanks_maybe_text: 'Noted, {name}: maybe.',
			decline_customer_text: 'Sorry {name}, call us for another day.',
		});
		const sends0 = await t.mock.mark();
		const at = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
		const answer = (id, from, name, response, extra) => ({ id: 'evt_0000000000000000000000000000' + String(Math.floor(Math.random() * 9000) + 1000), type: 'message.calendar_responded', data: { id, from: { name, number: from.replace('+', '') }, to: { name: 'Turbo Notify', alias: 'main', number: '5511977770000' }, response, ...(extra ? { extra_guests: extra } : {}), direction: 'inbound', channel: 'whatsapp', origin: 'native', at: at() } });
		for (const event of [
			answer(ids.going, '+5511977770031', 'Going Guest', 'going', 1),
			answer(ids.maybe, '+5511977770033', 'Maybe Guest', 'maybe'),
			answer(ids.decline, '+5511977770032', 'Decline Guest', 'not_going'),
		]) {
			await t.sleep(1100); // a different answer time each, so each one has its own idempotency key
			event.data.at = at();
			const execution = await t.run(NODES.poll, { pin: { [NODES.poll]: [event] } });
			assert.equal(execution.status, 'success', execution.describe());
		}
		assert.match((await textsTo(sends0, '+5511977770031'))[0].content.text, /^Great, Going! We noted 1 extra guest\(s\)\. See you \w+ \d+ \w+ at \d\d:\d\d\.$/, 'thanks_going_text, with {guests} and {when}');
		assert.equal((await textsTo(sends0, '+5511977770033'))[0].content.text, 'Noted, Maybe: maybe.', 'thanks_maybe_text');
		assert.equal((await textsTo(sends0, '+5511977770032'))[0].content.text, 'Sorry Decline, call us for another day.', 'decline_customer_text');
		assert.match((await textsTo(sends0, OWNER)).map((s) => s.content.text).join('\n'), /Decline Guest declined the Check-up appointment/, 'the owner text is still written by the workflow');
		await config({
			thanks_going_text: 'Thank you, {name}. Your {title} appointment at {business} on {when} is confirmed.{guests}',
			thanks_maybe_text: 'Thank you, {name}. We noted that you might come to your {title} appointment on {when}.{guests} Please tell us here as soon as you know.',
			decline_customer_text: 'Thank you for letting us know, {name}. We will contact you to reschedule your {title} appointment.',
		});
	});
	await t.step('C: an answer given from the connected phone itself (direction outbound) is ignored', async () => {
		const before = JSON.stringify(await rowsBy({}));
		const mark = await t.mock.mark();
		const event = {
			id: 'evt_00000000000000000000000000000001',
			type: 'message.calendar_responded',
			data: { id: ids.maybe, from: { name: 'Turbo Notify', alias: 'main', number: '5511977770000' }, to: { name: 'Maybe Guest', number: '5511977770033' }, response: 'not_going', direction: 'outbound', channel: 'whatsapp', origin: 'native', at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') },
		};
		const execution = await t.run(NODES.poll, { pin: { [NODES.poll]: [event] } });
		assert.equal(execution.status, 'success', execution.describe());
		assert.equal(JSON.stringify(await rowsBy({})), before, 'no row changed');
		assert.count(await t.mock.sends({ since: mark }), 0, 'nothing was sent');
		// the same event shaped as an inbound answer would have been applied: only the direction decides
		const inbound = { ...event, data: { ...event.data, direction: 'inbound', from: { name: 'Maybe Guest', number: '5511977770033' }, to: { name: 'Turbo Notify', alias: 'main', number: '5511977770000' } } };
		const applied = await t.run(NODES.poll, { pin: { [NODES.poll]: [inbound] } });
		assert.equal(applied.status, 'success', applied.describe());
		assert.equal((await one({ customer_name: 'Maybe Guest' })).status, 'declined', 'the inbound answer is applied');
	});
	await t.step('C: the same answer processed twice sends nothing twice (idempotency keys)', async () => {
		const events = (await t.mock.events('message.calendar_responded')).filter((e) => e.data.id === ids.decline);
		assert.count(events, 1, 'the decline event');
		const before = (await t.mock.messages()).length;
		const mark = await t.mock.mark();
		const execution = await t.run(NODES.poll, { pin: { [NODES.poll]: [events[0]] } });
		assert.equal(execution.status, 'success', execution.describe());
		assert.equal((await t.mock.messages()).length, before, 'Turbo Notify created no new message');
		const replays = (await t.mock.sends({ since: mark })).length;
		assert.equal(replays, 3, 'the node asked again for the three messages, and the API answered with the originals');
	});

	/* ------------------------------------------------------------------ A: the form */
	const zone = t.n8n.timezone;
	const offsetMs = (ms) => {
		const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
		return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
	};
	const localToUtc = (date, time) => {
		const [y, mo, d] = date.split('-').map(Number);
		const [h, mi] = time.split(':').map(Number);
		const guess = Date.UTC(y, mo - 1, d, h, mi);
		return guess - offsetMs(guess - offsetMs(guess));
	};
	const dayIn = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now() + days * 24 * HOUR);
	const formUrl = () => `${t.urls.n8n}/form/${t.workflow.node(NODES.form).parameters.path}`;
	const formBody = (answers) => {
		const labels = ['Customer name', 'WhatsApp number', 'Appointment', 'Date', 'Time', 'Duration in minutes', 'Location', 'Notes'];
		const body = new FormData();
		labels.forEach((label, i) => body.append(`field-${i}`, String(answers[label] ?? '')));
		return body;
	};
	/** Submits the real production form over HTTP and returns what the person who typed it sees. */
	const submit = async (answers, { auth = FORM_AUTH } = {}) => {
		const since = await t.executionMark();
		const res = await fetch(formUrl(), { method: 'POST', headers: auth ? { authorization: auth } : {}, body: formBody(answers) });
		const text = await res.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
		let execution = null;
		if (res.status === 401 || res.status === 403) await t.expectNoExecutions({ since, ms: 3000 });
		else {
			execution = (await t.waitExecutions({ since, timeoutMs: 60_000 })).find((e) => e.ran(NODES.form)) ?? null;
			assert.ok(execution, 'a run started');
			assert.equal(execution.status, 'success', execution.describe());
		}
		return { status: res.status, text, json, execution };
	};
	const good = (over) => ({ 'Customer name': 'Form Customer', 'WhatsApp number': '+5511977770041', Appointment: 'Cleaning', Date: dayIn(3), Time: '10:00', ...over });

	await t.step('A: the form saves a valid appointment, reads the time in the workflow time zone, answers 200 with what it saved', async () => {
		await t.tables.clear(TABLE);
		await t.activate();
		const date = dayIn(3);
		const sends0 = await t.mock.mark();
		const result = await submit(good({ 'WhatsApp number': '+55 (11) 97777-0041', Date: date, Time: '14:30', Location: 'Room 2', Notes: 'First visit' }));
		assert.equal(result.status, 200, `the form answers 200: ${result.text}`);
		assert.match(result.json.formSubmittedText, /^Saved: Form Customer, \+5511977770041, Cleaning, \w+ \d+ \w+ 14:30 \(America\/Sao_Paulo\)\. The customer is reminded by the first hourly run that falls within 24 hours of the start\.$/, 'and says what was saved, with the phone as it was understood so a typo shows');
		const r = await one({ customer_name: 'Form Customer' });
		assert.equal(r.phone, '+5511977770041', 'phone normalised');
		assert.equal(r.start_at, new Date(localToUtc(date, '14:30')).toISOString(), `14:30 in ${zone} stored as UTC`);
		assert.equal(r.duration_min, 30, 'default duration');
		assert.equal(r.status, 'scheduled', 'scheduled');
		assert.equal(r.location, 'Room 2', 'location');
		assert.equal(r.notes, 'First visit', 'notes');
		assert.count(await t.mock.sends({ since: sends0 }), 0, 'a valid appointment sends nothing yet');
	});
	await t.step('A: local phone formats are accepted when they are unambiguous', async () => {
		for (const [input, expected] of [
			['11 97777-0044', '+5511977770044'],
			['(11) 97777-0045', '+5511977770045'],
			['011977770046', '+5511977770046'],
			['5511977770047', '+5511977770047'],
			['0055 11 97777 0048', '+5511977770048'],
		]) {
			const name = `Phone ${input}`;
			const result = await submit(good({ 'Customer name': name, 'WhatsApp number': input }));
			assert.equal(result.status, 200, `${input}: accepted (${result.text})`);
			assert.equal((await one({ customer_name: name })).phone, expected, `${input} becomes ${expected}`);
		}
	});
	await t.step('A: the same phone at the same start is refused the second time, a different start is accepted', async () => {
		const before = (await rowsBy({ customer_name: 'Form Customer' })).length;
		const again = await submit(good({ 'Customer name': 'Form Customer Again', 'WhatsApp number': '(11) 97777-0041', Date: dayIn(3), Time: '14:30' }));
		assert.equal(again.status, 422, 'the form sent twice: 422');
		assert.match(again.json.formSubmittedText, /An appointment for \+5511977770041 on \w+ \d+ \w+ 14:30 is already in the table\./, 'with the phone and the time');
		assert.count(await rowsBy({ customer_name: 'Form Customer Again' }), 0, 'nothing saved');
		assert.count(await rowsBy({ customer_name: 'Form Customer' }), before, 'still one');
		const other = await submit(good({ 'Customer name': 'Form Customer Later', 'WhatsApp number': '+5511977770041', Date: dayIn(3), Time: '16:00' }));
		assert.equal(other.status, 200, `the same person at another time is a different appointment: ${other.text}`);
		const else_ = await submit(good({ 'Customer name': 'Form Customer Else', 'WhatsApp number': '+5511977770049', Date: dayIn(3), Time: '14:30' }));
		assert.equal(else_.status, 200, `another person at the same time is a different appointment: ${else_.text}`);
	});
	await t.step('A: a booking for later today is explained: reminded at the next run, or no reminder when it is too close', async () => {
		const parts = (ms) => {
			const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
			return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
		};
		const soon = parts(Date.now() + 20 * 60_000);
		const tooClose = await submit(good({ 'Customer name': 'Same Day Close', 'WhatsApp number': '+5511977770056', ...{ Date: soon.date, Time: soon.time } }));
		assert.equal(tooClose.status, 200, tooClose.text);
		assert.match(tooClose.json.formSubmittedText, /It starts in less than 60 minutes, so no reminder will be sent\.$/, 'tells the person that no reminder will go out');
		const later = parts(Date.now() + 5 * HOUR);
		const fine = await submit(good({ 'Customer name': 'Same Day Later', 'WhatsApp number': '+5511977770057', ...{ Date: later.date, Time: later.time } }));
		assert.equal(fine.status, 200, fine.text);
		assert.match(fine.json.formSubmittedText, /The customer is reminded by the first hourly run that falls within 24 hours of the start\.$/, 'a booking inside the window is reminded at the next hourly run');
		assert.ok(!/24 hours before/.test(fine.json.formSubmittedText), 'it no longer promises 24 hours before');
	});
	await t.step('A: a rejected entry answers 422 with the reason, saves nothing and sends nothing', async () => {
		const rowsBefore = (await rowsBy({})).length;
		for (const [label, answers, expected] of [
			['letters in the number', good({ 'Customer name': 'Bad One', 'WhatsApp number': 'call me' }), /number must be digits/],
			['no ninth digit', good({ 'Customer name': 'Bad Two', 'WhatsApp number': '11 7777-0042' }), /lacks the ninth digit/],
			['no area code', good({ 'Customer name': 'Bad Three', 'WhatsApp number': '977770043' }), /needs the area code/],
			['a number without the country code, another country', good({ 'Customer name': 'Bad Four', 'WhatsApp number': '1415555010' }), /area code|country code/],
			['a date in the past', good({ 'Customer name': 'Bad Five', Date: '2020-01-01' }), /not in the future/],
			['a time that is not a time', good({ 'Customer name': 'Bad Six', Time: '25:99' }), /time must look like/],
			['an empty name', good({ 'Customer name': '  ' }), /name is empty/],
		]) {
			const sends0 = await t.mock.mark();
			const result = await submit(answers);
			assert.equal(result.status, 422, `${label}: 422`);
			assert.match(result.json.formSubmittedText, expected, `${label}: the reason`);
			assert.match(result.json.formSubmittedText, /^Not saved\./, `${label}: starts with Not saved`);
			assert.match(result.json.formSubmittedText, /Nothing was saved, please correct the entry and submit it again\.$/, `${label}: what to do`);
			assert.count(await t.mock.sends({ since: sends0 }), 0, `${label}: nothing is sent to anyone`);
		}
		assert.count(await rowsBy({}), rowsBefore, 'nothing was saved');
	});
	await t.step('A: free text is cleaned, capped and refused when it could carry a link or a mention', async () => {
		// control characters and line breaks become single spaces; the row is saved
		const saved = await submit(good({ 'Customer name': 'Text Check', Appointment: 'Clean\u0007ing\nnow', Location: 'Room\t3' }));
		assert.equal(saved.status, 200, saved.text);
		const r = await one({ customer_name: 'Text Check' });
		assert.equal(r.title, 'Clean ing now', 'control characters removed from the title');
		assert.equal(r.location, 'Room 3', 'tabs and line breaks removed from the location');
		for (const [label, answers, expected] of [
			['a web address in the title', good({ 'Customer name': 'Link Entry', Appointment: 'Win a prize at https://evil.example/claim' }), /appointment title cannot contain a web address/],
			['a web address in the name', good({ 'Customer name': 'www.evil.example' }), /customer name cannot contain a web address/],
			['an @mention in the location', good({ 'Customer name': 'Mention Entry', Location: 'Call @5511977770001' }), /location cannot contain a web address or an @mention/],
			['a title longer than the limit', good({ 'Customer name': 'Long Entry', Appointment: 'x'.repeat(101) }), /appointment title is longer than 100 characters/],
			['notes longer than the limit', good({ 'Customer name': 'Long Notes', Notes: 'y'.repeat(101) }), /notes are longer than 100 characters/],
			['a duration of a week', good({ 'Customer name': 'Long Duration', 'Duration in minutes': '10080' }), /duration is longer than 1440 minutes/],
		]) {
			const result = await submit(answers);
			assert.equal(result.status, 422, `${label}: 422`);
			assert.match(result.json.formSubmittedText, expected, `${label}: the reason`);
			assert.ok(!/evil\.example\/claim/.test(result.json.formSubmittedText), `${label}: the answer does not repeat the link`);
			assert.count(await rowsBy({ customer_name: answers['Customer name'] }), 0, `${label}: nothing saved`);
		}
	});
	await t.step('A: max_appointments_per_day stops the form, with the number in the reason', async () => {
		const count = (await rowsBy({})).length;
		await t.deactivate();
		await config({ max_appointments_per_day: count });
		await t.activate();
		const result = await submit(good({ 'Customer name': 'Over The Cap' }));
		assert.equal(result.status, 422, 'the cap is full: 422');
		assert.match(result.json.formSubmittedText, new RegExp(`limit of ${count} new appointments in 24 hours is reached`), 'with the number');
		assert.count(await rowsBy({ customer_name: 'Over The Cap' }), 0, 'nothing saved');
		await t.deactivate();
		await config({ max_appointments_per_day: count + 1 });
		await t.activate();
		const last = await submit(good({ 'Customer name': 'Last One', 'WhatsApp number': '+5511977770058' }));
		assert.equal(last.status, 200, 'one more fits under a cap of count + 1');
		const again = await submit(good({ 'Customer name': 'One Too Many' }));
		assert.equal(again.status, 422, 'and then the cap holds');
		await t.deactivate();
		await config({ max_appointments_per_day: 50 });
		await t.activate();
	});
	await t.step('A: a call without credentials, or with a wrong password, is refused and nothing happens', async () => {
		const rowsBefore = JSON.stringify(await rowsBy({}));
		const sends0 = await t.mock.mark();
		const since = await t.executionMark();
		const answers = good({ 'Customer name': 'Intruder', Appointment: 'Relay' });
		const none = await fetch(formUrl(), { method: 'POST', body: formBody(answers) });
		assert.equal(none.status, 401, 'no credentials: 401');
		const wrong = await fetch(formUrl(), { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${FORM_USER}:not-the-password`).toString('base64')}` }, body: formBody(answers) });
		assert.ok([401, 403].includes(wrong.status), `a wrong password is refused (got ${wrong.status})`);
		const page = await fetch(formUrl());
		assert.equal(page.status, 401, 'the form page itself is not shown without credentials');
		await t.expectNoExecutions({ since, ms: 5000 });
		assert.count(await t.mock.sends({ since: sends0 }), 0, 'nothing is sent');
		assert.equal(JSON.stringify(await rowsBy({})), rowsBefore, 'the table is unchanged');
	});
	await t.step('A: the form path is the random id of the node (n8n gives an imported copy a new one), not a word anybody can guess', async () => {
		const form = t.workflow.node(NODES.form);
		assert.ok(form.webhookId, 'the form has an id');
		assert.equal(form.parameters.path, form.webhookId, 'the form address is that id');
		assert.match(form.parameters.path, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a random looking uuid');
	});
	await t.deactivate();

	/* ------------------------------------------------------------------ Z: time zone */
	await t.step('Z: a time zone that does not match stops every flow with a clear message, nothing is sent', async () => {
		await t.tables.clear(TABLE);
		await t.tables.insert(TABLE, [row({ customer_name: 'Zone Customer', phone: '+5511977770061', start_at: iso(Date.now() + 5 * HOUR), status: 'reminded', reminder_message_id: ids.maybe })]);
		await config({ expected_timezone: 'Asia/Tokyo' });
		const mark = await t.mock.mark();
		const hourly = await t.run(NODES.hourly);
		assert.equal(hourly.status, 'error', 'the hourly run stops');
		assert.match(hourly.nodeError('Write the invitations')?.message ?? '', /Time zone mismatch: this workflow runs in America\/Sao_Paulo but expected_timezone in Your settings is Asia\/Tokyo/, 'with a message that says what to do');
		const event = { id: 'evt_00000000000000000000000000000002', type: 'message.calendar_responded', data: { id: ids.maybe, from: { name: 'Zone Customer', number: '5511977770061' }, response: 'going', direction: 'inbound', channel: 'whatsapp', origin: 'native', at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') } };
		const poll = await t.run(NODES.poll, { pin: { [NODES.poll]: [event] } });
		assert.equal(poll.status, 'error', 'the poll flow stops too');
		assert.match(poll.nodeError('Write the answer messages')?.message ?? '', /Time zone mismatch/, 'with the same message');
		assert.count(await t.mock.sends({ since: mark }), 0, 'nothing is sent');
		await t.activate();
		const refused = await submit(good({ 'Customer name': 'Zone Form' }));
		assert.equal(refused.status, 422, 'the form refuses and tells the person who typed it');
		assert.match(refused.json.formSubmittedText, /This form is not set up yet: the workflow time zone is America\/Sao_Paulo but expected_timezone in Your settings is Asia\/Tokyo/, 'with the reason');
		assert.count(await rowsBy({ customer_name: 'Zone Form' }), 0, 'nothing saved');
		await t.deactivate();
		await config({ expected_timezone: 'America/Sao_Paulo' });
		const fine = await t.run(NODES.hourly);
		assert.equal(fine.status, 'success', 'put back, it runs again');
	});
}
