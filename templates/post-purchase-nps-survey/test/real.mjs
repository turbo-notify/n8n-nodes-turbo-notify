/**
 * Real API scenario for T6 (post-purchase-nps-survey): the exported workflow against the REAL Turbo Notify API,
 * with real WhatsApp delivery between two numbers of the same owner. NOT RUN YET: written for a later gate 2 run.
 *
 *   The workflow runs on number A (the "number under test", the key passed with --api-key-file).
 *   The "customer" is number B, an owned number of ANOTHER organization. It is the customer of every order and
 *   also the owner phone of the settings (the only recipient the guard allows is B), and it answers with its own key
 *   (--customer-key-file). Both numbers count in the same budget (--max-sends).
 *
 *   export TN_REAL_OWNER_PHONE='+<number B: the customer, the only number the workflow may message>'
 *   export TN_REAL_PERSONAL_PHONE='+<number A: the number under test>'
 *   node templates/harness/run-template.mjs templates/post-purchase-nps-survey/workflow.json \
 *     --real-api --api-key-file <key of A> --customer-key-file <key of B> --max-sends 16 \
 *     --scenario templates/post-purchase-nps-survey/test/real.mjs --image n8nio/n8n:2.45.5 --tz America/Sao_Paulo \
 *     --run-id t6real --ports 5697,9251
 *
 * Messages (16 allowed, 14 used):
 *   order 1, a detractor: the question; B answers "3"; the alert, the apology and the contact card (all to B, who is
 *     also the owner); B writes a long comment; the comment forwarded and the thanks. 6 by the workflow, 2 by B.
 *   order 2, a promoter: the question; B answers "10"; the thank you with the review link button. 2 + 1.
 *   With review_url set and review_for left at everyone, the short thanks after the detractor's comment is a link button too.
 *   B writes STOP: the confirmation. 1 + 1. The weekly report: 1.
 *
 * What real mode cannot show: how WhatsApp draws the button and the card on a phone, a customer who is not the
 * owner (the guard allows one recipient), the 30 minute clock (the timer is run by hand here), the 5 minute poll rhythm of a busy number, the weekly clock.
 * The values typed in "Your settings" are the only patch.
 */
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const HOOK = 'Receive an order';
const TIMER = 'Every 30 minutes: ask the surveys that are due';
const WEEK = 'Every week: send the NPS report';
const TOKEN = 'real-run-order-token-0001';

export const timeoutMs = 40 * 60_000;
export const credentials = [{ type: 'httpHeaderAuth', name: 'Order access (Header Auth)', data: { name: 'X-Order-Token', value: TOKEN } }];

function phones() {
	const customer = process.env.TN_REAL_OWNER_PHONE;
	const under = process.env.TN_REAL_PERSONAL_PHONE;
	for (const p of [customer, under]) if (!p || !/^\+[1-9]\d{7,14}$/.test(p)) throw new Error('set TN_REAL_OWNER_PHONE (the customer) and TN_REAL_PERSONAL_PHONE (the number under test), with + and the country code');
	return { customer, under };
}

/** The values a person types in "Your settings": the owner is number B too, the whole day is the sending window, a review page. */
export async function prepare(workflow) {
	const { customer } = phones();
	const settings = workflow.nodes.find((n) => n.name === 'Your settings');
	const set = { owner_phone: customer, business_name: 'Sample Shop', window_start: '00:00', window_end: '23:59', review_url: 'https://example.com/review', review_button_text: 'Leave a review' };
	for (const a of settings.parameters.assignments.assignments) if (a.name in set) a.value = set[a.name];
	return workflow;
}

export default async function scenario(t) {
	const { assert, real } = t;
	const { customer: CUSTOMER } = phones();
	const person = real.customer;
	assert.ok(person, 'the customer sender is configured (--customer-key-file)');
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
	const body = (id, extra = {}) => ({ order_id: id, customer_name: 'Sample Customer', phone: CUSTOMER, status: 'delivered', order_url: 'https://example.com/orders/sample', items: ['Sample item'], ...extra });
	const text = (s) => s.content?.text ?? s.content?.body ?? '';

	await t.step('0 pre-flight: the number under test is connected, the customer is the number the guard allows, the quota is readable', async () => {
		const single = await real.get('/v1/numbers/main');
		assert.equal(single.status, 'connected', 'the number under test is connected');
		const from = await person.verify();
		assert.ok(from, 'the customer sender is the number the guard allows');
		const quota = await real.quota();
		t.note('plan', { tier: quota.tier, messages_remaining: quota.remaining });
		assert.ok(quota.remaining >= 30, 'enough quota');
		assert.equal(real.guard.messagesAccepted + person.count, 0, 'nothing sent yet');
	});

	await t.step('1 the table is created by the workflow, the real webhook refuses a call without the header, and the workflow is switched on', async () => {
		const execution = await t.run('Run once: create the table');
		assert.equal(execution.status, 'success', execution.describe());
		await t.activate();
		const refused = await t.callWebhook(HOOK, { body: body('refused') });
		assert.equal(refused.status, 403, 'no header: refused');
		assert.equal(await rowOf('refused'), undefined, 'nothing stored');
		assert.equal(real.guard.messagesAccepted, 0, 'nothing sent');
	});

	await t.step('2 order 1: queued by the real webhook, asked by the timer (run by hand), the question reaches WhatsApp', async () => {
		const mark = await real.guard.mark();
		assert.equal((await call(body('real-1'))).status, 200, 'the webhook answers');
		await until(async () => rowOf('real-1'), 60_000, 'the order to be stored');
		assert.equal((await rowOf('real-1')).status, 'queued', 'queued: nothing is sent at the moment of the order');
		assert.count(await sendsSince(mark), 0, 'and nothing was sent');
		await patchRow('real-1', { due_at: new Date(Date.now() - 3_600_000).toISOString() });
		const timer = await t.run(TIMER);
		assert.equal(timer.status, 'success', timer.describe());
		const row = await rowOf('real-1');
		assert.equal(row.status, 'asked', 'asked');
		const sends = await sendsSince(mark);
		assert.count(sends, 1, 'one message');
		assert.equal(digits(sends[0].to?.number), digits(CUSTOMER), 'to the customer only');
		assert.match(text(sends[0]), /From 0 to 10/, 'the question');
		const seen = await real.observe(row.message_id, ['delivered', 'read'], { timeoutMs: 90_000 });
		t.note('questionDelivery', { reached: seen.reached, state: seen.state, seen: seen.seen });
		assert.ok(['sent', 'delivered', 'read'].includes(seen.state), 'the question was sent');
	});

	await t.step('3 the customer answers 3 from a real number: the real poller reads it, the alert, the apology and the contact card go out', async () => {
		const mark = await real.guard.mark();
		await person.send('3');
		const row = await until(async () => {
			const r = await rowOf('real-1');
			return r?.score === 3 ? r : null;
		}, 420_000, 'the real poller to read the answer');
		assert.equal([row.category, row.status], ['detractor', 'answered'], 'a detractor, waiting for the comment');
		const sends = await until(async () => {
			const s = await sendsSince(mark);
			return s.length >= 3 ? s : null;
		}, 90_000, 'the alert, the apology and the card');
		assert.count(sends, 3, 'three messages');
		assert.ok(sends.some((s) => /^Unhappy customer: Sample Customer gave 3\/10 for order real-1/.test(text(s))), 'the alert');
		assert.ok(sends.some((s) => /^I am sorry, Sample\. What went wrong\?/.test(text(s))), 'the apology');
		assert.ok(sends.some((s) => s.content?.display_name === 'Sample Customer'), 'the contact card');
	});

	await t.step('4 the customer writes a long comment: it is stored complete, forwarded to the owner, and thanked once', async () => {
		const mark = await real.guard.mark();
		const comment = 'The box arrived crushed and the card was wrong. I wrote twice and nobody answered me, so I am not happy.';
		await person.send(comment);
		const row = await until(async () => {
			const r = await rowOf('real-1');
			return r?.status === 'commented' ? r : null;
		}, 420_000, 'the real poller to read the comment');
		assert.equal(row.comment, comment, 'the whole comment, not the first 50 characters');
		const sends = await until(async () => {
			const s = await sendsSince(mark);
			return s.length >= 2 ? s : null;
		}, 90_000, 'the forward and the thanks');
		assert.ok(sends.some((s) => text(s).includes(comment)), 'the comment reached the owner');
		assert.ok(sends.some((s) => /^Thank you, Sample\. Your answer reached us\./.test(text(s))), 'the customer was thanked');
	});

	await t.step('5 order 2: a 10 is thanked with a link button to the review page', async () => {
		await patchRow('real-1', { created_at: new Date(Date.now() - 40 * 86_400_000).toISOString() });
		const mark = await real.guard.mark();
		await call(body('real-2'));
		await until(async () => rowOf('real-2'), 60_000, 'the order to be stored');
		assert.equal((await rowOf('real-2')).status, 'queued', 'queued: the 30 day cooldown of order 1 was moved away');
		await patchRow('real-2', { due_at: new Date(Date.now() - 3_600_000).toISOString() });
		const timer = await t.run(TIMER);
		assert.equal(timer.status, 'success', timer.describe());
		await person.send('10');
		await until(async () => (await rowOf('real-2'))?.status === 'closed', 420_000, 'the real poller to read the 10');
		const sends = await until(async () => {
			const s = await sendsSince(mark);
			return s.length >= 2 ? s : null;
		}, 90_000, 'the thank you');
		const thanks = sends.find((s) => s.content?.interactive_type === 'cta_url');
		assert.ok(thanks, 'a link button message');
		assert.equal(thanks.content?.url_button?.url, 'https://example.com/review', 'the button opens the review page');
	});

	await t.step('6 STOP is confirmed once, and the weekly report reaches the owner', async () => {
		let mark = await real.guard.mark();
		await person.send('STOP');
		await until(async () => (await t.tables.rows('surveys', { where: { status: 'opted_out' } })).length >= 1, 420_000, 'the real poller to read STOP');
		const sends = await until(async () => {
			const s = await sendsSince(mark);
			return s.length >= 1 ? s : null;
		}, 60_000, 'the confirmation');
		assert.match(text(sends[0]), /^Done\. We will not ask you again\./, 'the confirmation');
		mark = await real.guard.mark();
		const report = await t.run(WEEK);
		assert.equal(report.status, 'success', report.describe());
		const reports = await sendsSince(mark);
		assert.count(reports, 1, 'one report');
		assert.match(text(reports[0]), /^NPS report, last 7 days/, 'the report');
		assert.ok(!text(reports[0]).includes(digits(CUSTOMER)), 'and no phone number in it');
	});

	await t.step('7 accounting', async () => {
		const total = real.guard.messagesAccepted + person.count;
		t.note('messages', { byWorkflow: real.guard.messagesAccepted, byPerson: person.count, total });
		assert.ok(total <= real.maxSends, `inside the budget (${total} of ${real.maxSends})`);
		assert.equal(real.guard.blocked, 0, 'the guard blocked nothing: the workflow never tried another number');
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
