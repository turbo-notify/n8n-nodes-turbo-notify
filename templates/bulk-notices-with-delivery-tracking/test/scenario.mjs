/**
 * Scenario for "Send WhatsApp notices to a list and track delivery with Turbo Notify".
 *
 * Run (one at a time, from the module folder):
 *   node templates/harness/run-template.mjs templates/bulk-notices-with-delivery-tracking/workflow.json \
 *     --scenario templates/bulk-notices-with-delivery-tracking/test/scenario.mjs --run-id t2 --ports 5692,9211,9212 \
 *     --image n8nio/n8n:2.45.5
 *
 * The workflow is imported exactly as exported. The only changes are values of the Settings node
 * (see `TEST_SETTINGS`, listed in the README) and the Data Table nodes, which the harness points at the
 * table it created and which this scenario points back to "By Name" so the exported setup is what runs.
 * The form is called over real HTTP with its Basic Auth header (a Form Trigger cannot be started from pinned data).
 * Delivery news reaches the workflow two ways: pinned events (the events the mock produced, fed to the Polling
 * Trigger so every branch is reachable at once) and ONE live round trip through the activated Polling Trigger.
 */
export const timeoutMs = 3_000_000;
// Messages become "sent" quickly and stay there until the scenario moves them, so every state is under control.
export const mock = { quota: 500, delays: '300,36000000,72000000' };

const COLUMNS = ['name', 'phone', 'message', 'status', 'message_id', 'error', 'batch_id', 'label', 'sent_at', 'delivered_at', 'read_at', 'reported_at'];
export const tables = [{ name: 'notices', columns: COLUMNS.map((name) => ({ name, type: 'string' })) }];

export const credentials = [{ type: 'httpBasicAuth', name: 'Form access (Basic Auth)', data: { user: 'notices-team', password: 'harness-form-password' } }];
const AUTH = 'Basic ' + Buffer.from('notices-team:harness-form-password').toString('base64');
const OWNER = '+5511977770009';
const TEST_SETTINGS = { owner_phone: OWNER, batch_size: 2, pause_between_batches_seconds: 1 };
const TRIGGER = 'New delivery and failure events';
const NEWS = ['message.delivered', 'message.read', 'message.send.failed'];

function setSettings(nodes, patch) {
	const settings = nodes.find((n) => n.name === 'Settings');
	for (const assignment of settings.parameters.assignments.assignments) {
		if (assignment.name in patch) assignment.value = patch[assignment.name];
	}
}

export async function prepare(workflow) {
	setSettings(workflow.nodes, TEST_SETTINGS);
	return workflow;
}

export default async function scenario(t) {
	const { assert } = t;

	/* ------------------------------------------------------------ helpers */
	const tableId = async () => (await t.n8n.dataTables()).find((x) => x.name === 'notices')?.id;
	const rows = async (where = {}) => {
		const filters = Object.entries(where).map(([columnName, value]) => ({ columnName, condition: 'eq', value }));
		return t.n8n.dataTableRows(await tableId(), filters.length ? { filter: { type: 'and', filters } } : {});
	};
	const update = async (where, data) =>
		t.n8n.dataTableUpdate(await tableId(), { type: 'and', filters: Object.entries(where).map(([columnName, value]) => ({ columnName, condition: 'eq', value })) }, data);
	const insert = async (data) => t.n8n.dataTableInsert(await tableId(), data);
	const byName = (list, name) => list.find((r) => r.name === name);
	const latestBatch = async () => (await rows()).at(-1).batch_id;
	const snapshot = async () => (await rows()).map((r) => [r.id, r.status, r.delivered_at, r.read_at, r.error, r.reported_at].join('|'));

	/** Changes values of Settings on the stored workflow, the way a person edits the node. */
	const config = async (patch) => {
		const wf = await t.workflow.refresh();
		const nodes = JSON.parse(JSON.stringify(wf.nodes));
		setSettings(nodes, patch);
		await t.n8n.rest('PATCH', `/rest/workflows/${wf.id}`, { nodes, versionId: wf.versionId });
		await t.workflow.refresh();
	};
	const formId = () => t.workflow.node('New batch form').parameters.path;
	/**
	 * Submits the real production form over HTTP, with the Basic Auth header unless told otherwise, and waits for the run.
	 * The workflow is active only for the length of one submission.
	 */
	const submit = async (recipients, message, label = '', { auth = AUTH, extra = {} } = {}) => {
		await t.activate();
		const since = await t.executionMark();
		const body = new FormData();
		body.set('field-0', recipients);
		body.set('field-1', message);
		body.set('field-2', label);
		for (const [key, value] of Object.entries(extra)) body.set(key, value);
		const response = await fetch(`${t.urls.n8n}/form/${formId()}`, { method: 'POST', headers: auth ? { authorization: auth } : {}, body });
		const answeredAt = Date.now();
		const text = await response.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
		let execution = null;
		if (response.status === 401 || response.status === 403) await t.expectNoExecutions({ since, ms: 2500 });
		else execution = (await t.waitExecutions({ since, timeoutMs: 240_000 })).find((e) => e.ran('New batch form')) ?? null;
		await t.deactivate();
		return { status: response.status, text, json, execution, answeredAt };
	};
	const okRun = (execution) => assert.equal(execution.status, 'success', execution.describe());
	/** A submission the form accepted and the run finished without error. */
	const accepted = async (...args) => {
		const result = await submit(...args);
		assert.equal(result.status, 200, `the form accepted the submission: ${result.text}`);
		assert.ok(result.execution, 'a run started');
		okRun(result.execution);
		return result;
	};
	const exec = async (...args) => (await accepted(...args)).execution;
	const hourly = () => t.run('Every hour');
	const sendsSince = async (mark) => t.mock.sends({ since: mark });
	const toOwner = (sends) => sends.filter((s) => s.to?.number === OWNER);
	const reportsOf = (sends, batch) => toOwner(sends).filter((s) => String(s.content?.text).includes(batch));
	const forceState = async (row, state) => t.mock.messageState({ message_id: row.message_id, state });
	const apiStatus = async (row) => (await t.mock.messages()).find((m) => m.id === row.message_id)?.status;
	/** The delivery news the mock produced, in the shape the Polling Trigger hands on (oldest first). */
	const news = async (filter = () => true) => (await t.mock.events()).filter((e) => NEWS.includes(e.type)).filter(filter);
	const newsOf = async (row, ...types) => news((e) => e.data?.id === row.message_id && (!types.length || types.includes(e.type)));
	/** Feeds events to the Polling Trigger as if it had polled them, and runs the whole workflow behind it. */
	const deliver = async (events) => t.run(TRIGGER, { pin: { [TRIGGER]: events } });
	/** Moves every message the workflow sent on to delivered, then hands all the news to the workflow. */
	const settleEverything = async () => {
		for (const row of await rows()) {
			if (row.status === 'sent' && row.message_id) {
				const state = (await apiStatus(row))?.state;
				if (state !== 'failed') await forceState(row, 'delivered');
			}
		}
		return deliver(await news());
	};

	/* ---------------------------------------------------------- 0. setup */
	await t.step('0a the exported Data Table references (By Name "notices") are what run, and the form address is a random id, not a name', async () => {
		const wf = await t.workflow.refresh();
		const nodes = JSON.parse(JSON.stringify(wf.nodes));
		const tableNodes = nodes.filter((n) => n.type === 'n8n-nodes-base.dataTable' && n.parameters.resource === 'row');
		assert.ok(tableNodes.length >= 8, 'the workflow has many Data Table nodes');
		for (const node of tableNodes) node.parameters.dataTableId = { __rl: true, mode: 'name', value: 'notices' };
		await t.n8n.rest('PATCH', `/rest/workflows/${wf.id}`, { nodes, versionId: wf.versionId });
		await t.workflow.refresh();
		for (const node of t.workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.dataTable' && n.parameters.resource === 'row')) {
			assert.equal(node.parameters.dataTableId, { __rl: true, mode: 'name', value: 'notices' }, `${node.name} refers to the table by name`);
		}
		const form = t.workflow.node('New batch form');
		assert.ok(form.webhookId, 'the form has an id');
		assert.equal(form.parameters.path, form.webhookId, 'the form address is that id (n8n gives an imported copy a new one), not a name anybody can guess');
		assert.match(form.parameters.path, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a random looking uuid');
		assert.excludes(t.workflow.nodes.map((n) => n.name).join('|'), 'Retry', 'no retry branch');
		assert.excludes(t.workflow.nodes.map((n) => n.name).join('|'), 'connected', 'no connected-number check');
		// What ships in Settings: no live announcement, a twelve hour summary deadline.
		const settingsOf = (name) => t.workflow.node('Settings').parameters.assignments.assignments.find((a) => a.name === name).value;
		assert.equal(settingsOf('default_message'), '', 'default_message ships empty: a forgotten message can never reach real people');
		assert.equal(settingsOf('report_after_hours'), 12, 'report_after_hours ships as 12');
		assert.equal(t.workflow.node('New batch form').parameters.formFields.values.find((f) => f.fieldLabel === 'Message').requiredField, true, 'the Message field of the form is required');
		assert.includes(t.workflow.node('New batch form').parameters.formDescription, 'The message is required', 'and the form says so');
		assert.match(t.workflow.node('Settings').notes, /pick the same number in the Polling Trigger options \(that option only filters the events\)/, 'the Settings note says where the sending number is chosen');
		// Layout: no note sits inside, or touches, another note (at least 20 px apart), and no node is half inside a note.
		const box = (n) => (n.type === 'n8n-nodes-base.stickyNote' ? { x: n.position[0], y: n.position[1], w: n.parameters.width, h: n.parameters.height } : { x: n.position[0], y: n.position[1], w: 100, h: 100 });
		const apart = (a, b) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
		const gap = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
		const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
		const notes = t.workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote');
		for (const a of notes) for (const b of notes) if (a.name < b.name) assert.ok(apart(box(a), box(b)) && gap(box(a), box(b)) >= 20, `${a.name} and ${b.name} do not overlap or nest and are at least 20 px apart`);
		for (const note of notes) for (const n of t.workflow.nodes.filter((x) => x.type !== 'n8n-nodes-base.stickyNote')) assert.ok(apart(box(n), box(note)) || inside(box(n), box(note)), `${n.name} is not half inside ${note.name}`);
		assert.excludes(notes.map((n) => n.name + n.parameters.content).join('|'), 'Section:', 'no "Section:" prefix in the names or the headings');
		assert.excludes(t.workflow.nodes.map((n) => n.name).join('|'), 'Mark rows not sent', 'the plan is saved on every row before the branch');
	});

	await t.step('0b with no table the flow stops with the n8n message, "Create the notices table" makes it with 12 columns, twice is harmless', async () => {
		await t.n8n.rest('DELETE', `/rest/projects/${t.n8n.projectId}/data-tables/${await tableId()}`);
		assert.equal(await tableId(), undefined, 'the table is gone');
		const lost = await submit('Ana,+5511977770001', 'Hello {name}');
		assert.equal(lost.execution?.status, 'error', 'without the table the run stops');
		assert.match(lost.execution.error.message, /not found/i, 'n8n says the table was not found');

		okRun(await t.run('Create the notices table (run once)'));
		const created = (await t.n8n.dataTables()).filter((x) => x.name === 'notices');
		assert.count(created, 1, 'one table');
		const columns = created[0].columns.map((c) => c.name).filter((n) => !['id', 'createdAt', 'updatedAt'].includes(n));
		assert.equal([...columns].sort(), [...COLUMNS].sort(), 'the 12 columns');
		assert.equal(created[0].columns.filter((c) => COLUMNS.includes(c.name)).every((c) => c.type === 'string'), true, 'all text columns');
		okRun(await t.run('Create the notices table (run once)'));
		assert.count((await t.n8n.dataTables()).filter((x) => x.name === 'notices'), 1, 'running it again does not make a second table');
		assert.count(await rows(), 0, 'the table is empty');
	});

	/* ------------------------------------------------ 1. refusals */
	await t.step('1 the placeholder owner phone, an empty list, no message, a long list and a long text are refused on the form before anything is saved or sent', async () => {
		const mark = await t.mock.mark();
		await config({ owner_phone: '+55XXXXXXXXXXX' });
		const placeholder = await submit('Ana,+5511977770001', 'Hello {name}');
		await config({ owner_phone: OWNER });
		assert.equal(placeholder.status, 422, 'the placeholder owner phone is refused');
		assert.match(placeholder.json.formSubmittedText, /owner_phone/, 'and the form tells the person to set it');

		const empty = await submit('   \n  ', 'Hello {name}');
		assert.equal(empty.status, 422, 'an empty list is refused');
		assert.match(empty.json.formSubmittedText, /Not sent\. The list of recipients is empty\. Nothing was saved\./, 'and the form says why');

		// default_message ships empty, so an empty or blank message is refused and nothing is sent.
		const noMessage = await submit('Ana,+5511977770001', '');
		assert.equal(noMessage.status, 422, 'an empty message is refused with 422');
		assert.match(noMessage.json.formSubmittedText, /Not sent\. Write a message in the form: it is required\. Nothing was saved\./, 'the form says it is required');
		const blank = await submit('Ana,+5511977770001', '   ');
		assert.equal(blank.status, 422, 'a message with only spaces is refused too');

		await config({ max_recipients_per_submission: 3 });
		const tooMany = await submit('A,+5511977770101\nB,+5511977770102\nC,+5511977770103\nD,+5511977770104', 'Hello {name}');
		await config({ max_recipients_per_submission: 200 });
		assert.equal(tooMany.status, 422, 'more lines than the cap is refused');
		assert.match(tooMany.json.formSubmittedText, /4 lines, the limit for one submission is 3\. Nothing was saved\./, 'with the numbers');

		await config({ max_message_length: 20 });
		const tooLong = await submit('A,+5511977770101', 'This message has more than twenty characters');
		await config({ max_message_length: 1000 });
		assert.equal(tooLong.status, 422, 'a long message is refused');
		assert.match(tooLong.json.formSubmittedText, /limit is 20/, 'with the limit');
		for (const refused of [placeholder, empty, noMessage, blank, tooMany, tooLong]) {
			assert.equal(refused.execution.status, 'success', 'a refusal is a normal end of the run');
			assert.equal(refused.execution.ran('Save the rows as queued'), false, 'nothing is saved');
			assert.equal(refused.execution.ran('Send the notice'), false, 'nothing is sent');
		}
		assert.count(await rows(), 0, 'nothing was saved');
		assert.count(await sendsSince(mark), 0, 'nothing was sent');
	});

	/* ---------------------------------------- 2. first batch */
	const LIST = [
		'name,phone',
		'Ana Souza,+5511977770001',
		'Bruno Lima;11 97777-0002',
		'Carla, 11977770003',
		'Duda,11 7777-0004',
		'Edu,12345',
		'Fábio,5511977770005',
		'Ana again,+55 11 97777-0001',
		'Gil,011 97777-0006',
		'Heitor,abc',
		'+5511977770007',
		'"Silva, Ana",+5511977770008',
		'Tabi Costa\t+5511977770012', // two columns pasted from a spreadsheet are separated by a TAB
		'Teo Dias\t(11) 97777-0014',
	].join('\n');
	let batch1;

	await t.step('2 a first batch: lines cleaned (comma, semicolon and TAB), merge field, invalid and duplicate lines kept, one quota read, sends in batches of 2', async () => {
		const mark = await t.mock.mark();
		const result = await accepted(LIST, 'Hi {name}, your order is ready.', 'Orders');
		const run = result.execution;
		const saved = await rows();
		batch1 = saved[0].batch_id;
		assert.count(saved, 13, 'the header is skipped, the other 13 lines are saved');
		assert.ok(saved.every((r) => r.batch_id === batch1 && r.label === 'Orders'), 'one batch id and the label on every row');
		assert.match(batch1, /^\d{8}-\d{4}-[a-z0-9]{3}$/, 'batch id shape');
		assert.equal(result.json.formSubmittedText, 'Batch received: 9 to send, 4 left out (invalid number, duplicate or stop list, see the table). You get one WhatsApp summary when the batch is done.', 'the form says what was accepted');

		const expected = [
			['Ana Souza', '+5511977770001', 'sent', 'Hi Ana Souza, your order is ready.'],
			['Bruno Lima', '+5511977770002', 'sent', 'Hi Bruno Lima, your order is ready.'],
			['Carla', '+5511977770003', 'sent', 'Hi Carla, your order is ready.'],
			['Duda', '11 7777-0004', 'invalid_phone', ''],
			['Edu', '12345', 'invalid_phone', ''],
			['Fábio', '+5511977770005', 'sent', 'Hi Fábio, your order is ready.'],
			['Ana again', '+5511977770001', 'duplicate', 'Hi Ana again, your order is ready.'],
			['Gil', '+5511977770006', 'sent', 'Hi Gil, your order is ready.'],
			['Heitor', 'abc', 'invalid_phone', ''],
			['', '+5511977770007', 'sent', 'Hi, your order is ready.'],
			['Silva, Ana', '+5511977770008', 'sent', 'Hi Silva, Ana, your order is ready.'],
			['Tabi Costa', '+5511977770012', 'sent', 'Hi Tabi Costa, your order is ready.'],
			['Teo Dias', '+5511977770014', 'sent', 'Hi Teo Dias, your order is ready.'],
		];
		expected.forEach(([name, phone, status, message], index) => {
			assert.subset(saved[index], { name, phone, status, message }, `row ${index + 1} (${name || 'no name'})`);
		});
		assert.match(byName(saved, 'Duda').error, /ninth digit/, 'a ten digit mobile is ambiguous, so it is not guessed');
		assert.match(byName(saved, 'Edu').error, /area code/, 'too short');
		assert.match(byName(saved, 'Heitor').error, /Not a phone number/, 'letters');
		assert.match(byName(saved, 'Ana again').error, /earlier in this batch/, 'duplicate inside the batch');
		assert.ok(saved.filter((r) => r.status === 'sent').every((r) => /^msg_/.test(r.message_id) && r.sent_at && r.error === ''), 'sent rows hold the message id, the time and no error');

		const sends = await sendsSince(mark);
		assert.count(sends, 9, 'nine valid lines were sent, nothing else');
		assert.equal(sends.map((s) => s.to.number), ['+5511977770001', '+5511977770002', '+5511977770003', '+5511977770005', '+5511977770006', '+5511977770007', '+5511977770008', '+5511977770012', '+5511977770014'], 'recipients in row order, every phone with +');
		assert.equal(sends.map((s) => s.idempotencyKey), saved.filter((r) => r.status === 'sent').map((r) => `${batch1}-${r.id}`), 'Idempotency-Key is <batch id>-<row id>');
		assert.equal(sends[0].content, { text: 'Hi Ana Souza, your order is ready.' }, 'merged text');
		assert.count(await t.mock.requests({ method: 'GET', path: '/messages/quota', since: mark }), 1, 'Get Quota is called once for the whole run');
		assert.count((await t.mock.requests({ method: 'GET', path: '/v1/numbers/main', since: mark })).filter((r) => r.path === '/v1/numbers/main'), 0, 'there is no separate number check: the send reports a disconnected number itself');
		assert.equal(run.runData['Pause between batches'].length, 5, 'nine rows in batches of two make five passes through the loop');
		assert.equal(run.items('Is this row to be sent?', { output: 0 }).length, 9, 'all nine fit');
		assert.count(toOwner(sends), 0, 'no summary yet: the batch still waits for delivery news');
		assert.ok(Date.parse(run.stoppedAt) - result.answeredAt > 2000, 'the form was answered while the batch was still being sent (not after the last pause)');
		assert.equal(run.ran('Decide which batches are ready'), true, 'the summary check ran at the end of the batch');
		assert.equal(run.ran('Send the summary to the owner'), false, 'and found nothing ready');
	});

	/* ----------------------------------------------- 3. duplicates */
	let batch2;
	await t.step('3 sending the same list again sends nothing; the same people with another text are a new notice', async () => {
		const mark = await t.mock.mark();
		const again = (await accepted(LIST, 'Hi {name}, your order is ready.', 'Orders again')).execution;
		const saved = (await rows()).filter((r) => r.batch_id !== batch1);
		batch2 = saved[0].batch_id;
		assert.count(saved, 13, 'the lines are saved');
		assert.equal([...new Set(saved.map((r) => r.status))].sort(), ['duplicate', 'invalid_phone'], 'nine valid lines are duplicates now, the rest stay invalid');
		assert.count(saved.filter((r) => r.status === 'duplicate'), 10, 'nine repeated numbers plus the repeated number inside the batch');
		assert.match(saved[0].error, /last 3 days/, 'the reason names the window');
		assert.count(await sendsSince(mark), 0, 'a repeated submission sends nothing');
		assert.equal(again.ran('Loop over batches'), false, 'the loop is not even entered');

		const other = await exec('Ana Souza,+5511977770001\nBruno Lima,+5511977770002', 'Payment due on Monday, {name}.', 'Payment');
		okRun(other);
		const sends = await sendsSince(mark);
		const paid = sends.filter((s) => s.to.number !== OWNER);
		assert.count(paid, 2, 'a different text to the same numbers is a different notice');
		assert.equal(paid.map((s) => s.content.text), ['Payment due on Monday, Ana Souza.', 'Payment due on Monday, Bruno Lima.'], 'texts');
		// The batch with nothing to send is final at once. It is summarised by the next run that reaches the summary check.
		const summaries = reportsOf(sends, batch2);
		assert.count(summaries, 1, 'the batch of invalid and duplicate lines is summarised once, by the next run');
		assert.match(summaries[0].content.text, /"Orders again" \(.+\) is done: 13 people\./, 'header');
		assert.match(summaries[0].content.text, /delivered 0 \(read so far 0\), invalid number 3, duplicate 10\./, 'counts');
	});

	/* ------------------------------------------------- 4. spacing */
	await t.step('4 the node spaces the sends itself when the plan asks for it', async () => {
		await t.mock.config({ enforceSpacing: true, spacingMs: 4000 });
		const mark = await t.mock.mark();
		const run = await exec('Lia,+5511977770010\nMia,+5511977770011\nNeo,+5511977770013', 'Spacing test for {name}', 'Spacing');
		await t.mock.config({ enforceSpacing: false });
		okRun(run);
		assert.count((await sendsSince(mark)).filter((s) => s.to.number !== OWNER), 3, 'all three went out');
		const refused = (await t.mock.requests({ method: 'POST', path: '/messages', since: mark })).filter((r) => r.status === 429);
		assert.ok(refused.length >= 2, `the API asked for spacing ${refused.length} times and the node waited and retried`);
		assert.ok(refused.every((r) => r.response?.error === 'send_rate_spacing'), 'only spacing answers');
		const batch = await latestBatch();
		assert.equal((await rows({ batch_id: batch })).map((r) => r.status), ['sent', 'sent', 'sent'], 'no row failed because of spacing');
	});

	/* ---------------------------------------------- 5. quota short */
	let quotaBatch;
	await t.step('5 not enough quota: only what fits is sent, one message is kept for the summary, the rest is marked skipped_quota with its reason', async () => {
		await t.mock.quota({ number: 'main', limit: 500, used: 497 });
		const mark = await t.mock.mark();
		const run = await exec(
			['Ada,+5511977770021', 'Bia,+5511977770022', 'Caio,+5511977770023', 'Dani,+5511977770024', 'Edna,+5511977770025'].join('\n'),
			'Quota test for {name}',
			'Quota',
		);
		okRun(run);
		quotaBatch = await latestBatch();
		const saved = await rows({ batch_id: quotaBatch });
		assert.equal(saved.map((r) => r.status), ['sent', 'sent', 'skipped_quota', 'skipped_quota', 'skipped_quota'], '3 left, one kept, so 2 go out and 3 are skipped');
		assert.match(saved[2].error, /Not sent: 3 messages were left in this billing cycle \(it resets \d{4}-\d{2}-\d{2}\)/, 'the reason says why and when it resets');
		const sends = await sendsSince(mark);
		assert.count(sends.filter((s) => s.to.number !== OWNER), 2, 'two recipients');
		assert.equal(run.items('Get message quota')[0].remaining, 3, 'Get Quota saw 3');
		assert.equal(run.ran('Alert the owner about the quota'), false, 'there is no separate alert: the summary carries it');
		await t.mock.quota({ number: 'main', limit: 500, used: 20 });
	});

	await t.step('5b every row skipped for quota: the batch is final at once, so its summary goes out in the same run and the loop is never entered', async () => {
		await t.mock.quota({ number: 'main', limit: 500, used: 499 }); // 1 left, and it is kept for the summary
		const mark = await t.mock.mark();
		const run = await exec('Fred,+5511977770026\nGia,+5511977770027', 'Nothing fits for {name}', 'Nothing fits');
		await t.mock.quota({ number: 'main', limit: 500, used: 20 });
		okRun(run);
		const batch = await latestBatch();
		assert.equal((await rows({ batch_id: batch })).map((r) => r.status), ['skipped_quota', 'skipped_quota'], 'both skipped');
		assert.equal(run.ran('Loop over batches'), false, 'nothing to send: the loop is not entered');
		const sends = await sendsSince(mark);
		assert.count(sends.filter((s) => s.to.number !== OWNER), 0, 'no notice was sent');
		const summaries = reportsOf(sends, batch);
		assert.count(summaries, 1, 'one summary, in the same run');
		assert.match(summaries[0].content.text, /is done: 2 people\./, 'the batch is done');
		assert.match(summaries[0].content.text, /delivered 0 \(read so far 0\), not sent, quota short 2\./, 'with the quota shortfall');
	});

	let queuedByQuotaFailure;
	await t.step('5c the quota read fails: the form already answered, nothing is sent, the line stays queued and goes out with the next submission', async () => {
		await t.mock.fault({ method: 'GET', path: '/messages/quota$', status: 403, body: { error: 'insufficient_scope', message: 'This key cannot read the quota.', required_scope: 'messages:read' }, times: 1 });
		const mark = await t.mock.mark();
		const failed = await submit('Quin,+5511977770028', 'Quota read test for {name}', 'Quota read');
		assert.equal(failed.status, 200, 'the form had already answered 200');
		assert.equal(failed.execution.status, 'error', 'the run stops at the plan');
		assert.match(failed.execution.error.message, /Could not read your quota, so nothing was sent/, 'with a message that says so');
		assert.equal(failed.execution.nodeError('Plan the send') !== undefined, true, 'the error is on the planning step');
		queuedByQuotaFailure = byName(await rows(), 'Quin');
		assert.equal(queuedByQuotaFailure.status, 'queued', 'the line stays queued');
		assert.count(await sendsSince(mark), 0, 'nothing was sent, not even a summary');

		const mark2 = await t.mock.mark();
		okRun(await exec('Rita,+5511977770029', 'Quota read test for {name}', 'Quota read 2'));
		const sends = (await sendsSince(mark2)).filter((s) => s.to.number !== OWNER);
		assert.equal(sends.map((s) => s.to.number), ['+5511977770028', '+5511977770029'], 'the next submission sends the waiting line first, then the new one');
		assert.equal(sends[0].idempotencyKey, `${queuedByQuotaFailure.batch_id}-${queuedByQuotaFailure.id}`, 'with the key of its own batch');
		assert.equal(byName(await rows(), 'Quin').status, 'sent', 'and the row is sent');
	});

	/* --------------------------------------------- 6. failures */
	let failBatch;
	await t.step('6 a refused send, a contact quota refusal, the two held refusals and a recipient that fails later each keep their own reason', async () => {
		await t.mock.recipient({ number: '+5511977770035', fail: { code: 'whatsapp_send_failed', message: 'The number is not on WhatsApp.', hint: 'Check the number with the person.' } });
		const post = '/v1/numbers/main/messages$';
		await t.mock.fault({ method: 'POST', path: post, status: 402, body: { error: 'contact_quota_exceeded', message: 'Distinct-contacts quota exceeded' }, times: 1 });
		await t.mock.fault({ method: 'POST', path: post, status: 422, body: { error: 'validation_error', message: 'Invalid request', details: { errors: [{ field: 'to', message: 'bad' }] } }, times: 1 });
		await t.mock.fault({ method: 'POST', path: post, status: 429, body: { error: 'duplicate_burst_blocked', message: 'The same text was sent to more than 20 recipients in the last hour.' }, times: 1 });
		await t.mock.fault({ method: 'POST', path: post, status: 429, body: { error: 'reply_ratio_too_low', message: 'Too few replies compared with what the number sent.' }, times: 1 });
		const mark = await t.mock.mark();
		const run = await exec('Fay,+5511977770031\nGus,+5511977770032\nHal,+5511977770033\nIna,+5511977770034\nDora,+5511977770035\nEli,+5511977770036', 'Failure test for {name}', 'Failures');
		okRun(run);
		failBatch = await latestBatch();
		const saved = await rows({ batch_id: failBatch });
		assert.subset(saved[0], { name: 'Fay', status: 'skipped_quota', message_id: '', sent_at: '' }, 'contact quota refusal is a quota skip, not a failure');
		assert.match(saved[0].error, /contact_quota_exceeded/, 'reason with the code');
		assert.subset(saved[1], { name: 'Gus', status: 'failed', message_id: '', sent_at: '' }, 'another refusal is a failure of that row only');
		assert.match(saved[1].error, /rejected a value/, 'reason from the node');
		assert.subset(saved[2], { name: 'Hal', status: 'held', message_id: '', sent_at: '' }, 'duplicate_burst_blocked holds the row, it is not a failure');
		assert.match(saved[2].error, /^Held: the same text went to more than 20 people in an hour \(duplicate_burst_blocked\), so it was not sent\. Personalise the text with \{name\} or wait/, 'with a clear reason and what to do');
		assert.subset(saved[3], { name: 'Ina', status: 'held', message_id: '' }, 'reply_ratio_too_low holds the row too');
		assert.match(saved[3].error, /reply_ratio_too_low/, 'with its own reason');
		assert.equal([saved[4].status, saved[5].status], ['sent', 'sent'], 'the next rows still go out');
		assert.count((await sendsSince(mark)).filter((s) => s.status === 202), 2, 'two accepted sends');

		// Dora was accepted and then failed on the WhatsApp side: only the failure event knows.
		await t.mock.waitForMessageState(saved[4].message_id, 'failed', { timeoutMs: 15_000 });
		assert.equal(saved[4].status, 'sent', 'until the news is applied the table still says sent');
		const faults = (await t.mock.requests({ method: 'POST', path: '/messages', since: mark })).filter((r) => r.status === 429);
		assert.count(faults, 2, 'the two held refusals were not retried: waiting does not help');
	});

	await t.step('6b held rows are not blocked as duplicates: the same lines through the form again are sent', async () => {
		const mark = await t.mock.mark();
		const run = await exec('Hal,+5511977770033\nIna,+5511977770034', 'Failure test for {name}', 'Held again');
		okRun(run);
		const batch = await latestBatch();
		assert.equal((await rows({ batch_id: batch })).map((r) => r.status), ['sent', 'sent'], 'held lines are sent when sent again');
		assert.count((await sendsSince(mark)).filter((s) => s.to.number !== OWNER), 2, 'two sends');
	});

	/* ------------------------------------------- 7. delivery news */
	await t.step('7a the news moves rows forward only: sent, delivered, read, failed with its reason, and Get Status is never called', async () => {
		let saved = await rows({ batch_id: batch1 });
		const ana = byName(saved, 'Ana Souza');
		const bruno = byName(saved, 'Bruno Lima');
		const carla = byName(saved, 'Carla');
		await forceState(ana, 'read');
		await forceState(bruno, 'delivered');
		const anaNews = await newsOf(ana);
		assert.equal(anaNews.map((e) => e.type), ['message.delivered', 'message.read'], 'the API says delivered, then read');
		for (const e of anaNews) {
			assert.equal([e.data.id, e.data.direction, e.data.origin], [ana.message_id, 'inbound', 'native'], 'a receipt for our message carries its id in data.id and says inbound and native: the recipient sent it');
		}
		const first = await deliver(await news());
		okRun(first);

		saved = await rows({ batch_id: batch1 });
		const readEvent = anaNews.find((e) => e.type === 'message.read');
		const deliveredEvent = anaNews.find((e) => e.type === 'message.delivered');
		assert.subset(byName(saved, 'Ana Souza'), { status: 'read', read_at: readEvent.data.at, delivered_at: deliveredEvent.data.at }, 'read, with the times of the events');
		assert.subset(byName(saved, 'Bruno Lima'), { status: 'delivered', read_at: '' }, 'delivered');
		assert.ok(byName(saved, 'Bruno Lima').delivered_at, 'with its time');
		assert.equal(byName(saved, 'Carla').status, 'sent', 'rows with no news stay sent');
		const dora = byName(await rows({ batch_id: failBatch }), 'Dora');
		assert.equal(dora.status, 'failed', 'the late failure arrives');
		assert.match(dora.error, /^whatsapp_send_failed: The number is not on WhatsApp/, 'with its code and reason');
		assert.ok(first.items('Save progress').length >= 2, 'the changed rows were saved (Dora may already have failed through a live poll while the form run was active)');
		assert.equal((await t.mock.requests({ path: '/status' })).length, 0, 'the workflow never asks Get Status: the news arrives by itself');
		void carla;
	});

	await t.step('7b news about other messages is ignored; a read row stays read; a late failure cannot overwrite a delivered row; a replay changes nothing', async () => {
		let before = await snapshot();
		const stranger = (await news((e) => e.type === 'message.delivered'))[0];
		const unknown = { ...stranger, id: 'evt_' + 'a'.repeat(32), data: { ...stranger.data, id: 'msg_' + 'b'.repeat(32) } };
		const ignored = await deliver([unknown]);
		okRun(ignored);
		assert.equal(await snapshot(), before, 'an event for a message that is not in the table changes nothing');
		assert.ok(ignored.ran('Read unreported rows'), 'the summary check still runs');

		const replay = await deliver(await news());
		okRun(replay);
		assert.equal(await snapshot(), before, 'the same news again changes nothing');

		const ana = byName(await rows({ batch_id: batch1 }), 'Ana Souza');
		const late = await newsOf(ana, 'message.delivered');
		okRun(await deliver(late));
		assert.equal(await snapshot(), before, 'a delivered event that arrives after the read one does not bring the row back');

		const bruno = byName(await rows({ batch_id: batch1 }), 'Bruno Lima');
		const brunoDelivered = await newsOf(bruno, 'message.delivered');
		await forceState(bruno, 'read');
		const brunoRead = await newsOf(bruno, 'message.read');
		assert.count(brunoRead, 1, 'a read event');
		okRun(await deliver(brunoRead));
		let after = byName(await rows({ batch_id: batch1 }), 'Bruno Lima');
		assert.subset(after, { status: 'read', delivered_at: bruno.delivered_at, read_at: brunoRead[0].data.at }, 'delivered then read: the delivered time is kept');
		before = await snapshot();
		okRun(await deliver(brunoDelivered));
		assert.equal(await snapshot(), before, 'the old delivered event is ignored');

		// News out of order inside one poll: read first, delivered after. The row stays read and learns when it was delivered.
		const carla = byName(await rows({ batch_id: batch1 }), 'Carla');
		await forceState(carla, 'read');
		const carlaNews = await newsOf(carla);
		okRun(await deliver([...carlaNews].reverse().map((e) => ({ ...e, created_at: carlaNews[0].created_at }))));
		after = byName(await rows({ batch_id: batch1 }), 'Carla');
		assert.equal(after.status, 'read', 'read is final');
		assert.ok(after.delivered_at && after.read_at, 'both times were learned');

		// The failure event of a row that is still "sent" marks it failed with the reason, once, whatever else was polled live before.
		const dora = byName(await rows({ batch_id: failBatch }), 'Dora');
		const failure = (await newsOf(dora, 'message.send.failed'))[0];
		assert.equal([failure.data.id, failure.data.error.code], [dora.message_id, 'whatsapp_send_failed'], 'the failure event carries the message id and the error');
		await update({ id: dora.id }, { status: 'sent', error: '' });
		okRun(await deliver([failure]));
		assert.subset(byName(await rows({ batch_id: failBatch }), 'Dora'), { status: 'failed', error: 'whatsapp_send_failed: The number is not on WhatsApp.' }, 'a sent row becomes failed with the code and the message');
		// A failure event for a message that already reached the phone is ignored.
		const gil = byName(await rows({ batch_id: batch1 }), 'Gil');
		await update({ id: gil.id }, { status: 'delivered', delivered_at: '2026-11-17T09:00:00Z' });
		before = await snapshot();
		okRun(await deliver([{ ...failure, id: 'evt_' + 'c'.repeat(32), data: { ...failure.data, id: gil.message_id } }]));
		assert.equal(await snapshot(), before, 'a failure event cannot overwrite a delivered row');
		assert.equal((await apiStatus(gil)).state, 'sent', 'the API really said sent: the table was ahead of it');
	});

	await t.step('7c one live round trip: the activated Polling Trigger picks up a delivery on its own, with the filters of the node', async () => {
		const fabio = byName(await rows({ batch_id: batch1 }), 'Fábio');
		assert.equal(fabio.status, 'sent');
		await t.activate();
		const mark = await t.executionMark();
		const apiMark = await t.mock.mark();
		await t.sleep(3000); // the first poll runs at activation and only records history
		await forceState(fabio, 'delivered');
		const executions = await t.waitExecutions({ since: mark, timeoutMs: 170_000 });
		await t.deactivate();
		const run = executions.find((e) => e.ran(TRIGGER));
		assert.ok(run, 'the Polling Trigger started a run');
		okRun(run);
		assert.equal(run.items(TRIGGER).map((e) => e.type), ['message.delivered'], 'one event, delivered, and no history');
		assert.equal(run.items(TRIGGER)[0].data.id, fabio.message_id, 'for Fábio');
		assert.equal(byName(await rows({ batch_id: batch1 }), 'Fábio').status, 'delivered', 'the row moved on its own');
		const polls = await t.mock.requests({ method: 'GET', path: '/v1/events', since: apiMark });
		assert.ok(polls.length >= 1, 'the trigger polled the events feed');
		assert.equal([...polls.at(-1).query['types[]']].sort(), ['message.delivered', 'message.read', 'message.send.failed'], 'type filters of the node');
		assert.equal((await t.mock.requests({ path: '/status' })).length, 0, 'still no Get Status');
	});

	await t.step('7d a pause loses nothing: news that arrives while the workflow is inactive is read when it is activated again, once, and not read again', async () => {
		const tabi = byName(await rows({ batch_id: batch1 }), 'Tabi Costa');
		assert.equal(tabi.status, 'sent', 'Tabi Costa is still waiting for news');
		// The workflow is inactive here: nobody is polling when the phone confirms the delivery.
		await forceState(tabi, 'delivered');
		const deliveredEvent = (await newsOf(tabi, 'message.delivered'))[0];
		assert.ok(deliveredEvent, 'the API produced the delivered event');
		await t.sleep(2000);
		assert.equal(byName(await rows({ batch_id: batch1 }), 'Tabi Costa').status, 'sent', 'while the workflow is inactive nothing reads the news');
		const mark = await t.executionMark();
		await t.activate();
		await t.waitFor(async () => byName(await rows({ batch_id: batch1 }), 'Tabi Costa').status === 'delivered', { timeoutMs: 170_000, message: 'the row moves after the workflow is activated again' });
		await t.deactivate();
		const runs = (await t.waitExecutions({ since: mark, timeoutMs: 20_000 })).filter((e) => e.ran(TRIGGER));
		for (const run of runs) okRun(run);
		const handedOn = (list) => list.flatMap((e) => e.items(TRIGGER)).filter((e) => e.data?.id === tabi.message_id);
		assert.count(handedOn(runs), 1, 'the trigger handed the event on exactly once');
		const moved = byName(await rows({ batch_id: batch1 }), 'Tabi Costa');
		assert.subset(moved, { status: 'delivered', delivered_at: deliveredEvent.data.at }, 'the row moved with the time of the event');

		// Activated once more: the trigger remembers what it handed on, so the row is not touched again.
		const before = await snapshot();
		const mark2 = await t.executionMark();
		await t.activate();
		await t.sleep(8000);
		await t.deactivate();
		const again = (await t.waitExecutions({ since: mark2, timeoutMs: 8000 }).catch(() => [])).filter((e) => e.ran(TRIGGER));
		assert.count(handedOn(again), 0, 'the same event is not handed on a second time');
		assert.equal(await snapshot(), before, 'and the table did not change');
	});

	/* ------------------------------------------------- 8. summaries */
	await t.step('8 one summary per batch the moment every row is final, with counts, reasons and a snapshot note; never twice', async () => {
		const mark = await t.mock.mark();
		const run = await settleEverything();
		okRun(run);
		const reports = toOwner(await sendsSince(mark));

		const one = reportsOf(reports, batch1);
		assert.count(one, 1, 'batch 1 is reported exactly once');
		assert.match(one[0].content.text, /^Notices batch "Orders" \(.+\) is done: 13 people\./, 'header with label and count');
		assert.match(one[0].content.text, /delivered 9 \(read so far 3\), invalid number 3, duplicate 1\./, 'counts: read so far, not read');
		assert.match(one[0].content.text, /Messages left in this cycle: \d+ of 500\./, 'quota line');
		assert.excludes(one[0].content.text, 'BUSINESS', 'no plan name in capitals');
		assert.excludes(one[0].content.text, ' rows', 'the owner reads people, not rows');
		assert.match(one[0].content.text, /This is a snapshot: the notices table keeps updating as delivery and read news arrive\./, 'a snapshot, said plainly');
		assert.equal(one[0].idempotencyKey, `report-${batch1}`, 'report key');
		assert.excludes(one[0].content.text, 'paste them into the form', 'nothing failed in batch 1, so no resend hint');

		const fails = reportsOf(reports, failBatch);
		assert.count(fails, 1, 'the failure batch is reported once');
		assert.match(fails[0].content.text, /delivered 1 \(read so far 0\), failed 2, held 2, not sent, quota short 1\./, 'counts');
		assert.match(fails[0].content.text, /Failed: Gus \(\+5511977770032\): Turbo Notify rejected a value[^;]*; Dora \(\+5511977770035\): whatsapp_send_failed: The number is not on WhatsApp\./, 'names and reasons, one full stop at the end');
		assert.excludes(fails[0].content.text, '..', 'no double full stop');
		assert.match(fails[0].content.text, /Held, not sent: the same text went to more than 20 people in an hour \(duplicate_burst_blocked\), so it was not sent\. Personalise the text with \{name\} or wait, then send this line again \/ this number sends much more than it gets replies \(reply_ratio_too_low\)/, 'held rows are named with their reasons');
		assert.match(fails[0].content.text, /To send those lines again, paste them into the form again\. People who already got the text are skipped\./, 'how to send again: through the form');

		const quotaReport = reportsOf(reports, quotaBatch);
		assert.count(quotaReport, 1, 'the quota batch is reported once');
		assert.match(quotaReport[0].content.text, /delivered 2 \(read so far 0\), not sent, quota short 3\./, 'the quota shortfall is in the summary');
		assert.ok((await rows({ batch_id: batch1 })).every((r) => r.reported_at), 'every row of the batch is marked');
		assert.equal(new Set(reports.map((r) => r.idempotencyKey)).size, reports.length, 'one distinct key per summary');

		const mark2 = await t.mock.mark();
		okRun(await hourly());
		okRun(await hourly());
		okRun(await deliver(await news()));
		assert.count(toOwner(await sendsSince(mark2)), 0, 'later runs report nothing again');
	});

	/* ----------------------------------------- 9. no receipt */
	await t.step('9 a row that never gets news is closed as no_receipt by the hourly check, the batch is summarised once, and late news still upgrades the row', async () => {
		await t.mock.recipient({ number: '+5511977770061', stopAt: 'sent' });
		okRun(await exec('Stuck,+5511977770061\nFine,+5511977770062', 'Timeout test for {name}', 'Timeout'));
		const batch = await latestBatch();
		const fine = byName(await rows({ batch_id: batch }), 'Fine');
		await forceState(fine, 'delivered');
		okRun(await deliver(await news()));
		const mark = await t.mock.mark();
		okRun(await hourly());
		assert.equal(byName(await rows({ batch_id: batch }), 'Stuck').status, 'sent', 'with report_after_hours at 12 a fresh row is left alone');
		assert.count(reportsOf(await sendsSince(mark), batch), 0, 'and the batch is not summarised while a row still waits');

		await config({ report_after_hours: 0.0006 }); // about two seconds
		await t.sleep(3000);
		const mark2 = await t.mock.mark();
		const run = await hourly();
		okRun(run);
		const stuck = byName(await rows({ batch_id: batch }), 'Stuck');
		assert.equal(stuck.status, 'no_receipt', 'closed after report_after_hours');
		assert.match(stuck.error, /No delivery or read news from WhatsApp after 0\.0006 hours/, 'with its reason');
		const reports = reportsOf(await sendsSince(mark2), batch);
		assert.count(reports, 1, 'summarised once');
		assert.match(reports[0].content.text, /is done: 2 people\./, 'every row is final');
		assert.match(reports[0].content.text, /delivered 1 \(read so far 0\), no delivery news yet 1\./, 'the silent row is counted');
		await config({ report_after_hours: 12 });

		const mark3 = await t.mock.mark();
		await forceState(stuck, 'delivered');
		okRun(await deliver(await newsOf(stuck, 'message.delivered')));
		const after = byName(await rows({ batch_id: batch }), 'Stuck');
		assert.subset(after, { status: 'delivered', error: '' }, 'late news upgrades a no_receipt row and clears the note');
		assert.count(toOwner(await sendsSince(mark3)), 0, 'and does not summarise the batch again');
	});

	/* ------------------------------------ 10. stale queued, crash replay */
	await t.step('10 a queued line older than queued_max_age_hours is marked skipped_stale and reported, not sent days late; a row left queued by a crash is replayed with its key', async () => {
		const staleRow = { name: 'Old Line', phone: '+5511977770071', message: 'An old notice', status: 'queued', message_id: '', error: '', batch_id: 'stale-batch', label: 'Old', sent_at: '', delivered_at: '', read_at: '', reported_at: '' };
		await insert([staleRow]);
		const fabio = byName(await rows({ batch_id: batch1 }), 'Fábio');
		const target = byName(await rows({ batch_id: batch1 }), 'Gil');
		await update({ id: target.id }, { status: 'queued', message_id: '', sent_at: '', delivered_at: '', read_at: '' });
		await config({ queued_max_age_hours: 0.003 }); // about 11 seconds
		await t.sleep(13_000);
		okRun(await hourly());
		assert.equal(byName(await rows({ batch_id: 'stale-batch' }), 'Old Line').status, 'queued', 'a stale line is not marked by itself, not even by the hourly check: it happens when the next batch is submitted');
		const mark = await t.mock.mark();
		const run = await exec('Zed,+5511977770041', 'Crash test for {name}', 'Crash');
		await config({ queued_max_age_hours: 24 });
		okRun(run);
		const stale = byName(await rows({ batch_id: 'stale-batch' }), 'Old Line');
		assert.equal(stale.status, 'skipped_stale', 'the old line is not sent');
		assert.match(stale.error, /^Not sent: this line waited more than 0\.003 hours in the queue\. Paste it into the form again/, 'with its reason');
		const sends = await sendsSince(mark);
		assert.equal(sends.filter((s) => s.to.number === '+5511977770071').length, 0, 'nothing went to the old number');
		// Gil was queued 13 s ago too, so it is stale as well: the age rule applies to every queued row, replay included.
		assert.equal(byName(await rows({ batch_id: batch1 }), 'Gil').status, 'skipped_stale', 'a row queued for longer than the limit is not replayed either');
		assert.equal(sends.filter((s) => s.to.number !== OWNER).length, 1, 'only the new person was sent');
		assert.count(reportsOf(sends, 'stale-batch'), 1, 'the stale line is in a summary');
		assert.match(reportsOf(sends, 'stale-batch')[0].content.text, /not sent, waited too long 1/, 'counted as such');

		// Now the replay: a row queued by a crash, still young, goes out again with the same key and the API answers with the same message.
		const young = byName(await rows({ batch_id: batch1 }), 'Fábio');
		await update({ id: young.id }, { status: 'queued', message_id: '', sent_at: '', delivered_at: '', read_at: '' });
		const messagesBefore = (await t.mock.messages()).filter((m) => m.to?.number && m.to.number !== OWNER).length;
		const mark2 = await t.mock.mark();
		okRun(await exec('Zoe,+5511977770042', 'Crash test for {name}', 'Crash 2'));
		const sends2 = await sendsSince(mark2);
		const replay = sends2.find((s) => s.idempotencyKey === `${batch1}-${young.id}`);
		assert.ok(replay, 'the old row went out again with its old key');
		assert.equal(replay.messageId, fabio.message_id, 'the API gave back the first message');
		assert.equal((await t.mock.messages()).filter((m) => m.to?.number && m.to.number !== OWNER).length, messagesBefore + 1, 'only the new person made a new message');
		assert.subset(byName(await rows({ batch_id: batch1 }), 'Fábio'), { status: 'sent', message_id: fabio.message_id }, 'the row is whole again');
		void target;
	});

	/* ------------------------------------------------ 11. stop list */
	await t.step('11 the stop list is honoured in any phone format and the people on it are never sent a notice', async () => {
		await config({ stop_list: '+5511977770095, 11 97777-0096' });
		const mark = await t.mock.mark();
		const run = await exec('Stop One,11 97777-0095\nStop Two;+55 11 97777-0096\nGo On\t+5511977770097', 'Stop list test for {name}', 'Stop');
		await config({ stop_list: '' });
		okRun(run);
		const saved = await rows({ batch_id: await latestBatch() });
		assert.equal(saved.map((r) => r.status), ['opted_out', 'opted_out', 'sent'], 'two on the list, one sent');
		assert.match(saved[0].error, /stop list/, 'with the reason');
		assert.equal((await sendsSince(mark)).filter((s) => s.to.number !== OWNER).map((s) => s.to.number), ['+5511977770097'], 'only the person who is not on the list');
	});

	/* ------------------------------------- 12. number not connected */
	await t.step('12 a number that is not connected: the send reports it, the rows are failed with the reason and the summary waits until the number is back', async () => {
		okRun(await settleEverything());
		await t.mock.numberStatus({ number: 'main', status: 'disconnected' });
		const mark = await t.mock.mark();
		const submitted = await submit('Ana Nova,+5511977770051\nBeto Novo,+5511977770052', 'Outage test for {name}', 'Outage');
		assert.equal(submitted.status, 200, 'the form still confirms: the batch is saved');
		const batch = await latestBatch();
		const outage = await rows({ batch_id: batch });
		assert.equal(outage.map((r) => r.status), ['failed', 'failed'], 'the rows are failed, visibly');
		assert.match(outage[0].error, /number_not_connected/, 'with the reason from the send');
		assert.count((await sendsSince(mark)).filter((s) => s.status === 202), 0, 'nothing was sent');
		assert.equal(submitted.execution.status, 'error', 'the run stops at the summary: the same number cannot send it');
		assert.equal(submitted.execution.nodeError('Send the summary to the owner') !== undefined, true, 'the error is on the summary send');
		assert.ok(outage.every((r) => r.reported_at === ''), 'the batch is not marked as reported');
		await t.mock.numberStatus({ number: 'main', status: 'connected' });
		const mark2 = await t.mock.mark();
		okRun(await hourly());
		const reports = reportsOf(await sendsSince(mark2), batch);
		assert.count(reports, 1, 'after the number is back the hourly check sends the summary');
		assert.match(reports[0].content.text, /failed 2/, 'with the failures');
		assert.match(reports[0].content.text, /number_not_connected/, 'and their reason');
	});

	/* ------------------------------------------ 13. the form's password */
	await t.step('13 the form asks for its password: no header or a wrong password is refused with 401 and nothing happens; the page shows our answer for any status', async () => {
		assert.equal(t.workflow.node('New batch form').parameters.authentication, 'basicAuth', 'the exported trigger uses Basic Auth');
		await t.activate();
		const url = `${t.urls.n8n}/form/${formId()}`;
		const anonymous = await fetch(url);
		assert.equal(anonymous.status, 401, 'the form page itself needs the password');
		const page = await fetch(url, { headers: { authorization: AUTH } });
		assert.equal(page.status, 200, 'the page is served with it');
		const html = await page.text();
		for (const label of ['Recipients', 'Message', 'Batch label']) assert.includes(html, label, `field ${label}`);
		assert.includes(html, 'the same exact text to more than 20 people in an hour'.replace('the', 'The'), 'the form states the same-text rule');
		assert.includes(html, 'copy two columns from a sheet and paste', 'and the spreadsheet paste');
		// What a browser does with the refusal: the page script shows json.formSubmittedText whatever the status, because the form answers through a node.
		assert.match(html, /id=["']useResponseData["'][^>]*value=["']?true/, 'the page reads the answer body of this form');
		assert.includes(html, 'json?.formSubmittedText', 'and shows its formSubmittedText before it looks at the status');
		await t.deactivate();

		const before = (await rows()).length;
		const mark = await t.mock.mark();
		const none = await submit('Intruder,+5511977770091', 'Hello from an intruder', 'No auth', { auth: null });
		assert.equal(none.status, 401, 'no credentials');
		const wrong = await submit('Intruder,+5511977770091', 'Hello from an intruder', 'Wrong', { auth: 'Basic ' + Buffer.from('notices-team:wrong-password').toString('base64') });
		assert.equal(wrong.status, 401, 'wrong password');
		const stranger = await submit('Intruder,+5511977770091', 'Hello from an intruder', 'Wrong user', { auth: 'Basic ' + Buffer.from('someone:harness-form-password').toString('base64') });
		assert.equal(stranger.status, 401, 'wrong user');
		assert.equal(none.execution ?? wrong.execution ?? stranger.execution, null, 'no run started');
		assert.count(await rows(), before, 'no row was saved');
		assert.count(await sendsSince(mark), 0, 'no message was sent');
	});

	await t.step('14 only the typed lines and text are used: extra form fields cannot change the number or the owner, and the text is never evaluated', async () => {
		const mark = await t.mock.mark();
		const attempt = await accepted(
			'Xavi,+5511977770071',
			'Hi {name}, {{ 1 + 1 }} ={{ $env.PATH }} {{ $json.owner_phone }}',
			'Live',
			{ extra: { number: 'extra-number', owner_phone: '+5511977770099', batch_size: '1000', flow: 'retry', recipients: 'Evil,+5511977770098', message: 'evil text', daily_cap: '99999', max_recipients_per_submission: '99999', stop_list: 'x' } },
		);
		const sends = (await sendsSince(mark)).filter((s) => s.to.number !== OWNER);
		assert.count(sends, 1, 'one message');
		assert.equal(sends[0].path, '/v1/numbers/main/messages', 'always the number from Settings');
		assert.equal(sends[0].to, { number: '+5511977770071' }, 'only the typed recipient');
		assert.equal(sends[0].content, { text: 'Hi Xavi, {{ 1 + 1 }} ={{ $env.PATH }} {{ $json.owner_phone }}' }, 'only {name} is replaced, nothing else is evaluated');
		assert.equal(attempt.json.formSubmittedText, 'Batch received: 1 to send, 0 left out (invalid number, duplicate or stop list, see the table). You get one WhatsApp summary when the batch is done.', 'the form confirms');
		assert.subset(attempt.execution.first('Settings'), { owner_phone: OWNER, number: 'main', batch_size: 2, daily_cap: 500, max_recipients_per_submission: 200, stop_list: '' }, 'Settings win over anything a form field carries');
		assert.equal(attempt.execution.first('Settings')['Recipients'], 'Xavi,+5511977770071', 'only the three typed fields reach the workflow');
	});

	await t.step('15 the daily cap holds across batches: the first fits, the next is refused whole, the last one reaches the cap exactly', async () => {
		const dayAgo = Date.now() - 24 * 3600 * 1000;
		const counted = (await rows()).filter((r) => ['queued', 'sent', 'delivered', 'read', 'failed', 'no_receipt'].includes(r.status) && Date.parse(r.createdAt) >= dayAgo).length;
		await config({ daily_cap: counted + 3 });
		const mark = await t.mock.mark();
		await accepted('Cap One,+5511977770081\nCap Two,+5511977770082', 'Cap test for {name}', 'Cap 1');
		const afterFirst = (await rows()).length;

		const refused = await submit('Cap Three,+5511977770083\nCap Four,+5511977770084', 'Cap test for {name}', 'Cap 2');
		assert.equal(refused.status, 422, 'a second batch over the cap is refused');
		assert.match(refused.json.formSubmittedText, new RegExp(`adds 2 messages to the ${counted + 2} of the last 24 hours, and the daily cap is ${counted + 3}\\. Nothing was saved\\.`), 'the form says why');
		assert.count(await rows(), afterFirst, 'nothing was inserted');
		assert.equal((await sendsSince(mark)).filter((s) => s.to.number !== OWNER).map((s) => s.to.number), ['+5511977770081', '+5511977770082'], 'only the first batch went out');

		await accepted('Cap Five,+5511977770085', 'Cap test for {name}', 'Cap 3');
		assert.equal((await sendsSince(mark)).filter((s) => s.to.number !== OWNER).length, 3, 'one more fits exactly');
		const over = await submit('Cap Six,+5511977770086', 'Cap test for {name}', 'Cap 4');
		assert.equal(over.status, 422, 'the cap is full');
		assert.equal((await sendsSince(mark)).filter((s) => s.to.number !== OWNER).length, 3, 'and nothing else is sent');
		await config({ daily_cap: 500 });
	});

	/* --------------------------------------------------- final tallies */
	await t.step('16 the table, the API and the owner agree; the API was never polled for a status', async () => {
		const all = await rows();
		const sentOrBetter = all.filter((r) => ['sent', 'delivered', 'read', 'no_receipt'].includes(r.status));
		const ids = sentOrBetter.map((r) => r.message_id);
		assert.equal(new Set(ids).size, ids.length, 'no two rows share a message id');
		const outbound = (await t.mock.messages()).filter((m) => m.to?.number && m.to.number !== OWNER);
		const apiNumbers = new Set(outbound.map((m) => m.id));
		assert.ok(ids.every((id) => apiNumbers.has(id)), 'every message id in the table exists in the API');
		assert.ok(all.every((r) => /^\+\d+$/.test(r.phone) || r.status === 'invalid_phone'), 'every saved phone that was sent starts with +');
		assert.equal((await t.mock.requests({ path: '/status' })).length, 0, 'Get Status was never called in the whole run');
	});
}
