/**
 * Real API scenario for T6 (post-purchase-nps-survey): the exported workflow against the REAL Turbo Notify API,
 * with real WhatsApp delivery between two numbers of the same owner.
 *
 *   The workflow runs on number A (the "number under test", the key passed with --api-key-file).
 *   The "customer" is number B, an owned number of ANOTHER organization. It is the customer of every order and
 *   also the owner phone of the settings (the only recipient the guard allows is B, so the owner alerts reach B too),
 *   and it answers with its own key (--customer-key-file). Both numbers count in the same budget (--max-sends 12).
 *
 *   export TN_REAL_OWNER_PHONE='+<number B: the customer, the only number the workflow may message>'
 *   export TN_REAL_PERSONAL_PHONE='+<number A: the number under test>'
 *   node templates/harness/run-template.mjs templates/post-purchase-nps-survey/workflow.json \
 *     --real-api --api-key-file <key of A> --customer-key-file <key of B> --max-sends 12 \
 *     --scenario templates/post-purchase-nps-survey/test/real.mjs --image n8nio/n8n:2.45.5 --tz America/Sao_Paulo \
 *     --run-id t6real --ports 5697,9251
 *
 * Patches (the workflow is imported as exported and only these are changed before the import):
 *   the values a person types in "Your settings" (owner phone, business name, review page https://example.org/reviews,
 *   the sending hours = the current hour and the next one), the poll of the Polling Trigger from 5 to 1 minute and the
 *   timer from 30 to 1 minute (the smallest intervals n8n allows). The clock of a survey is moved by writing an older
 *   `due_at` or `created_at` into the table, which a person could do too.
 *
 * Messages (12 allowed, 12 used), one phone number in different shapes:
 *   survey 1, a promoter: the question (timer); B answers "10"; the thank you with the review link button. 1 + 1 + 1.
 *   survey 2, a detractor with a sentence in the score message: the question (timer); B answers "4 <sentence>";
 *     the alert, the comment, the contact card and the last thanks (a link button). 1 + 1 + 4.
 *   B writes STOP: the confirmation. 1 + 1. The weekly report, by hand: 1.
 * Free of messages: the table, the webhook with and without the header, a status that starts nothing, E.164, the same
 * order twice, the cooldown, an order after STOP.
 *
 * What real mode cannot show: how WhatsApp draws the button and the card on a phone, a customer who is not the
 * owner (the guard allows one recipient), the weekly clock.
 */
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const HOOK = 'Receive an order';
const POLL = 'Poll WhatsApp replies';
const TIMER = 'Every 30 minutes: ask the surveys that are due';
const WEEK = 'Every week: send the NPS report';
const TOKEN = 'real-run-order-token-0001';
const REVIEW = 'https://example.org/reviews';
const ZONE = 'America/Sao_Paulo';

export const timeoutMs = 45 * 60_000;
export const credentials = [{ type: 'httpHeaderAuth', name: 'Order access (Header Auth)', data: { name: 'X-Order-Token', value: TOKEN } }];

function phones() {
	const customer = process.env.TN_REAL_OWNER_PHONE;
	const under = process.env.TN_REAL_PERSONAL_PHONE;
	for (const p of [customer, under]) if (!p || !/^\+[1-9]\d{7,14}$/.test(p)) throw new Error('set TN_REAL_OWNER_PHONE (the customer) and TN_REAL_PERSONAL_PHONE (the number under test), with + and the country code');
	return { customer, under };
}

/** The sending hours of the run: the current hour of the template's time zone and the next one. */
function currentHours() {
	const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
	const pad = (n) => String(n).padStart(2, '0');
	return { start: `${pad(hour)}:00`, end: hour >= 23 ? '23:59' : `${pad(hour + 1)}:59` };
}

/** A Brazilian mobile number as a shop would type it, from the E.164 number: "(DD) 9XXXX-XXXX". */
function localShape(e164) {
	const d = digits(e164);
	if (!/^55\d{2}9\d{8}$/.test(d)) return e164;
	return `(${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
}

export async function prepare(workflow) {
	const { customer } = phones();
	const hours = currentHours();
	const settings = workflow.nodes.find((n) => n.name === 'Your settings');
	const set = { owner_phone: customer, business_name: 'Sample Shop', window_start: hours.start, window_end: hours.end, review_url: REVIEW, review_button_text: 'Leave a review' };
	for (const a of settings.parameters.assignments.assignments) if (a.name in set) a.value = set[a.name];
	workflow.nodes.find((n) => n.name === POLL).parameters.pollTimes.item[0].value = 1;
	workflow.nodes.find((n) => n.name === TIMER).parameters.rule.interval[0].minutesInterval = 1;
	return workflow;
}

export default async function scenario(t) {
	const { assert, real } = t;
	const { customer: CUSTOMER } = phones();
	const person = real.customer;
	assert.ok(person, 'the customer sender is configured (--customer-key-file)');
	const allRows = async () => t.tables.rows('surveys');
	const rowOf = async (id) => (await t.tables.rows('surveys', { where: { order_id: id } }))[0];
	const patchRow = (id, patch) => t.tables.update('surveys', { order_id: id }, patch);
	const sendsSince = async (mark) => real.guard.sends({ since: mark });
	const call = (body, headers = { 'X-Order-Token': TOKEN }) => t.callWebhook(HOOK, { body, headers });
	const until = async (predicate, ms, label) => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			const value = await predicate();
			if (value) return value;
			await t.sleep(4000);
		}
		assert.fail(`timed out after ${Math.round(ms / 1000)} s waiting for: ${label}`);
	};
	const body = (id, extra = {}) => ({ order_id: id, customer_name: 'Sample Customer', phone: CUSTOMER, status: 'delivered', order_url: 'https://example.org/orders/sample', items: ['Sample item'], ...extra });
	const text = (s) => s.content?.text ?? s.content?.body ?? '';
	const latency = {};
	/** The answer of the customer, timed until the real poller has put it in the table. */
	const answerAndWait = async (label, message, ready, ms = 420_000) => {
		const t0 = Date.now();
		await person.send(message);
		const row = await until(ready, ms, `the real poller to read: ${label}`);
		latency[label] = Math.round((Date.now() - t0) / 1000);
		t.note('replyLatencySeconds', { ...latency });
		return row;
	};

	await t.step('0 pre-flight: the number under test is connected, the customer is the number the guard allows, the quota is readable', async () => {
		const single = await real.get('/v1/numbers/main');
		assert.equal(single.status, 'connected', 'the number under test is connected');
		const from = await person.verify();
		assert.ok(from, 'the customer sender is the number the guard allows');
		const quota = await real.quota();
		t.note('plan', { tier: quota.tier, messages_remaining: quota.remaining });
		assert.ok(quota.remaining >= 20, 'enough quota');
		assert.equal(real.guard.messagesAccepted + person.count, 0, 'nothing sent yet');
		assert.equal(t.workflow.node(POLL).parameters.pollTimes.item[0].value, 1, 'the poll runs every minute in this test');
		assert.equal(t.workflow.node(TIMER).parameters.rule.interval[0].minutesInterval, 1, 'the timer runs every minute in this test');
	});

	await t.step('1 the table is created by the workflow (twice), the real webhook refuses a call without the right header, and the workflow is switched on', async () => {
		const first = await t.run('Run once: create the table');
		assert.equal(first.status, 'success', first.describe());
		const again = await t.run('Run once: create the table');
		assert.equal(again.status, 'success', again.describe());
		await t.activate();
		const refused = await t.callWebhook(HOOK, { body: body('refused') });
		assert.equal(refused.status, 403, 'no header: refused');
		const wrong = await t.callWebhook(HOOK, { body: body('refused'), headers: { 'X-Order-Token': 'not-the-token' } });
		assert.equal(wrong.status, 403, 'a wrong value: refused');
		await t.sleep(5000);
		assert.equal(await rowOf('refused'), undefined, 'nothing stored');
		assert.equal(real.guard.messagesAccepted, 0, 'nothing sent');
	});

	await t.step('2 a status that starts nothing leaves a note row and no message', async () => {
		const mark = await real.guard.mark();
		assert.equal((await call(body('real-paid', { status: 'paid' }))).status, 200, 'the webhook answers');
		const note = await until(async () => (await allRows()).find((r) => /^status-\d\d$/.test(r.order_id)), 60_000, 'the status note row');
		assert.match(note.note, /order real-paid: status "paid" does not start a survey \(start_statuses: delivered\)/, 'the note says which status arrived');
		assert.equal(note.phone, '', 'the note carries no phone');
		assert.equal(await rowOf('real-paid'), undefined, 'no survey for it');
		assert.count(await sendsSince(mark), 0, 'nothing was sent');
	});

	await t.step('3 survey 1: the phone typed as a shop would is turned into E.164, the real timer asks the question once with the real idempotency key', async () => {
		const mark = await real.guard.mark();
		assert.equal((await call(body('real-1', { phone: localShape(CUSTOMER) }))).status, 200, 'the webhook answers');
		const queued = await until(async () => rowOf('real-1'), 60_000, 'the order to be stored');
		assert.equal(queued.status, 'queued', 'queued: nothing is sent at the moment of the order');
		assert.equal(digits(queued.phone), digits(CUSTOMER), 'the local shape became the E.164 number');
		assert.ok(queued.phone.startsWith('+'), 'with the plus sign');
		assert.equal((await call(body('real-1', { phone: localShape(CUSTOMER) }))).status, 200, 'the same order again is accepted by the webhook');
		await t.sleep(8000);
		assert.count((await allRows()).filter((r) => r.order_id === 'real-1'), 1, 'and stores nothing more');
		assert.count(await sendsSince(mark), 0, 'nothing was sent yet');
		await patchRow('real-1', { due_at: new Date(Date.now() - 3_600_000).toISOString() });
		// The row is saved as asked BEFORE the send and again with the message id after it: wait for the second save.
		const row = await until(async () => {
			const r = await rowOf('real-1');
			return r?.status === 'asked' && r.message_id ? r : null;
		}, 240_000, 'the real timer to ask the question');
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'one message');
		assert.equal(digits(sends[0].to?.number), digits(CUSTOMER), 'to the customer only');
		assert.match(text(sends[0]), /From 0 to 10/, 'the question');
		assert.equal(sends[0].idempotencyKey, 'nps-question-real-1', 'the idempotency key built from the order id');
		assert.ok(row.message_id, 'the message id is stored');
		const seen = await real.observe(row.message_id, ['delivered', 'read'], { timeoutMs: 90_000 });
		t.note('questionDelivery', { reached: seen.reached, state: seen.state, seen: seen.seen });
		assert.ok(['sent', 'delivered', 'read'].includes(seen.state), 'the question was sent');
	});

	await t.step('4 the cooldown: a second order of the same phone, a minute later, starts no second survey and sends nothing', async () => {
		const mark = await real.guard.mark();
		assert.equal((await call(body('real-cool'))).status, 200, 'the webhook answers');
		const row = await until(async () => rowOf('real-cool'), 60_000, 'the order to be stored');
		assert.equal(row.status, 'skipped', 'skipped');
		assert.match(row.note, /real-1/, 'the note names the order that was asked');
		assert.count(await sendsSince(mark), 0, 'nothing was sent');
	});

	await t.step('5 the customer answers 10 from a real number: the real poller reads it and the thank you arrives with the review link button', async () => {
		const mark = await real.guard.mark();
		const row = await answerAndWait('promoter', '10', async () => {
			const r = await rowOf('real-1');
			return r?.score === 10 ? r : null;
		});
		assert.equal([row.category, row.status], ['promoter', 'closed'], 'a promoter, the survey is finished');
		const sends = await until(async () => {
			const s = await sendsSince(mark);
			return s.length >= 1 ? s : null;
		}, 120_000, 'the thank you');
		assert.count(sends, 1, 'one message');
		assert.equal(sends[0].content?.interactive_type, 'cta_url', 'a link button message');
		assert.equal(sends[0].content?.url_button?.url, REVIEW, 'the button opens the review page');
		assert.equal(sends[0].status, 202, 'the API accepted the link button');
		assert.match(text(sends[0]), /^Thank you, Sample! We are glad/, 'the thanks above the button');
		const seen = await real.observe(sends[0].messageId, ['delivered', 'read'], { timeoutMs: 90_000 });
		t.note('linkButtonDelivery', { reached: seen.reached, state: seen.state });
	});

	await t.step('6 survey 2: a detractor writes the score and a sentence in ONE message: the alert, the comment, the contact card and the last thanks', async () => {
		await patchRow('real-1', { created_at: new Date(Date.now() - 40 * 86_400_000).toISOString() });
		const mark = await real.guard.mark();
		assert.equal((await call(body('real-2'))).status, 200, 'the webhook answers');
		const queued = await until(async () => rowOf('real-2'), 60_000, 'the order to be stored');
		assert.equal(queued.status, 'queued', 'queued: the 30 day cooldown of survey 1 was moved away');
		await patchRow('real-2', { due_at: new Date(Date.now() - 3_600_000).toISOString() });
		await until(async () => {
			const r = await rowOf('real-2');
			return r?.status === 'asked' && r.message_id;
		}, 240_000, 'the real timer to ask the question');
		const asked = await sendsSince(mark);
		assert.count(asked, 1, 'one question');
		assert.equal(asked[0].idempotencyKey, 'nps-question-real-2', 'its idempotency key');
		const mark2 = await real.guard.mark();
		const reply = '4 The box arrived crushed and nobody answered me when I wrote twice.';
		const row = await answerAndWait('detractor', reply, async () => {
			const r = await rowOf('real-2');
			return r?.score === 4 ? r : null;
		});
		assert.equal([row.category, row.status], ['detractor', 'commented'], 'a detractor whose comment came with the score');
		assert.equal(row.comment, reply, 'the whole message is the comment');
		const sends = await until(async () => {
			const s = await sendsSince(mark2);
			return s.length >= 4 ? s : null;
		}, 180_000, 'the alert, the comment, the card and the thanks');
		assert.count(sends, 4, 'four messages');
		for (const s of sends) assert.equal(digits(s.to?.number), digits(CUSTOMER), 'every one to the owner number (also the customer)');
		const alert = sends.find((s) => /^Unhappy customer: Sample Customer gave 4\/10 for order real-2/.test(text(s)));
		const comment = sends.find((s) => text(s).includes(reply));
		const card = sends.find((s) => s.content?.display_name === 'Sample Customer');
		const thanks = sends.find((s) => s.content?.interactive_type === 'cta_url');
		assert.ok(alert, 'the owner alert with the order, the score and the order link');
		assert.ok(comment, 'the comment forwarded to the owner');
		assert.ok(card, 'the contact card');
		assert.ok(thanks, 'the last thanks as a link button (review_for everyone)');
		assert.equal(thanks.content?.url_button?.url, REVIEW, 'to the review page');
		assert.equal([alert.status, comment.status, card.status, thanks.status], [202, 202, 202, 202], 'the API accepted all four');
		const cardSeen = await real.observe(card.messageId, ['delivered', 'read'], { timeoutMs: 90_000 });
		const thanksSeen = await real.observe(thanks.messageId, ['delivered', 'read'], { timeoutMs: 90_000 });
		t.note('contactCardDelivery', { reached: cardSeen.reached, state: cardSeen.state });
		t.note('detractorButtonDelivery', { reached: thanksSeen.reached, state: thanksSeen.state });
	});

	await t.step('7 STOP is confirmed once, and an order after it is skipped with nothing sent', async () => {
		const mark = await real.guard.mark();
		await answerAndWait('stop', 'STOP', async () => (await allRows()).find((r) => r.status === 'opted_out'));
		const sends = await until(async () => {
			const s = await sendsSince(mark);
			return s.length >= 1 ? s : null;
		}, 120_000, 'the confirmation');
		assert.count(sends, 1, 'one confirmation');
		assert.match(text(sends[0]), /^Done\. We will not ask you again\./, 'the confirmation');
		await t.sleep(90_000);
		assert.count(await sendsSince(mark), 1, 'and only one: nothing again on the next ticks');
		const after = await real.guard.mark();
		assert.equal((await call(body('real-after-stop'))).status, 200, 'the webhook answers');
		const row = await until(async () => rowOf('real-after-stop'), 60_000, 'the order to be stored');
		assert.equal(row.status, 'skipped', 'skipped');
		t.note('orderAfterStopReason', row.note);
		await t.sleep(70_000);
		assert.count(await sendsSince(after), 0, 'nothing was sent');
	});

	await t.step('8 the weekly report reaches the owner, run by hand', async () => {
		if (real.guard.messagesAccepted + person.count >= real.maxSends) {
			t.note('weeklyReport', 'not run: the budget of this run was used by the surveys');
			return;
		}
		const mark = await real.guard.mark();
		const report = await t.run(WEEK);
		assert.equal(report.status, 'success', report.describe());
		const reports = await sendsSince(mark);
		assert.count(reports, 1, 'one report');
		assert.match(text(reports[0]), /^NPS report, last 7 days/, 'the report');
		assert.ok(!text(reports[0]).includes(digits(CUSTOMER)), 'and no phone number in it');
	});

	await t.step('9 accounting and what the real API showed', async () => {
		const total = real.guard.messagesAccepted + person.count;
		t.note('messages', { byWorkflow: real.guard.messagesAccepted, byPerson: person.count, total });
		assert.ok(total <= real.maxSends, `inside the budget (${total} of ${real.maxSends})`);
		assert.equal(real.guard.blocked, 0, 'the guard blocked nothing: the workflow never tried another number');
		const all = await real.guard.requests();
		const byStatus = {};
		for (const r of all) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
		t.note('requestsByStatus', byStatus);
		t.note('answers429', all.filter((r) => r.status === 429).map((r) => ({ path: r.path.replace(/num_[0-9a-f]+/g, 'num_*'), error: r.response?.error })));
		const expired = all.filter((r) => JSON.stringify(r.response ?? '').includes('"content_expired":true'));
		t.note('contentExpiredSeen', expired.length);
		assert.count(expired, 0, 'content_expired was never seen');
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
		const table = tables.find((x) => x.name === 'surveys');
		if (table) await t.n8n.rest('DELETE', `/rest/projects/${t.n8n.projectId}/data-tables/${table.id}`);
		t.note('dataTablesDeleted', true);
	} catch (error) {
		t.note('dataTablesDeleted', `failed: ${error.message}`);
	}
}
