/**
 * Second scenario: the workflow exactly as exported, with NOTHING patched, so "Your settings" still holds the sample
 * group and the placeholder owner number. It proves the safe default on the live entry points too: the tables can
 * be created, but the real poller, a manual digest and the hourly run all stop with a clear message, nothing is
 * stored, nothing is read in full and nothing is sent. The real poller runs every 10 minutes, so the last step waits
 * for a real tick (up to 10 minutes).
 *
 *   node templates/harness/run-template.mjs templates/whatsapp-group-daily-digest/workflow.json \
 *     --scenario templates/whatsapp-group-daily-digest/test/placeholder.mjs --run-id t5 --ports 5696,9241,9242 \
 *     --image n8nio/n8n:2.45.5 --tz America/Sao_Paulo
 */
export const timeoutMs = 25 * 60_000;

const POLL = 'Poll WhatsApp group messages';
const HOURLY = 'Every hour: look for digests that are due';

export default async function scenario(t) {
	const { assert } = t;
	const mark = await t.mock.mark();
	const refused = /^Not ready to digest anything: .*watch_groups is still the sample.*owner_phone is not a real number/;

	await t.step('the tables can be created with the sample settings (they need none)', async () => {
		const execution = await t.run('Run once: create the tables');
		assert.equal(execution.status, 'success', execution.describe());
		assert.count(await t.tables.rows('group_messages'), 0, 'group_messages is empty');
		assert.count(await t.tables.rows('digests'), 0, 'digests is empty');
	});

	await t.step('a manual run of each entry point stops with a message that names every setting to change', async () => {
		const injected = await t.mock.injectMessage({ from: { number: '+5511977770051', name: 'Ana Silva' }, text: 'A message in the group the sample settings do not name', group: { name: 'Neighbours' } });
		const event = (await t.mock.events()).find((e) => e.id === injected.event_id);
		const polled = await t.run(POLL, { pin: { [POLL]: [event] } });
		assert.equal(polled.status, 'error', 'the poll fails loudly');
		assert.match(polled.error?.message ?? '', refused, 'and says what to set');
		assert.ok(!polled.ran('Keep the group messages to store'), 'the message was not even looked at');
		const hourly = await t.run(HOURLY);
		assert.equal(hourly.status, 'error', 'the hourly run fails loudly');
		assert.match(hourly.error?.message ?? '', refused, 'with the same message');
		const now = await t.run('Run now for one group');
		assert.equal(now.status, 'error', 'the manual run fails loudly');
		assert.match(now.error?.message ?? '', /run_now_group is empty/, 'and says what to type');
	});

	await t.step('the real poller is started by a group message, fails inside the run and stores nothing, reads nothing in full, sends nothing', async () => {
		await t.activate();
		const since = await t.executionMark();
		await t.mock.injectMessage({ from: { number: '+5511977770052', name: 'Bruno Costa' }, text: 'Another message while the workflow still holds its sample settings', group: { name: 'Neighbours' } });
		await t.waitFor(async () => (await t.n8n.listExecutions(t.workflow.id)).some((e) => Number(e.id) > since && e.mode !== 'manual' && e.status === 'error'), { timeoutMs: 12 * 60_000, message: 'the run of the poller to fail (it polls every 10 minutes)' });
		const runs = (await t.n8n.listExecutions(t.workflow.id)).filter((e) => Number(e.id) > since && e.mode !== 'manual');
		const failed = await t.execution(runs.find((e) => e.status === 'error').id);
		assert.match(failed.error?.message ?? '', refused, 'with the plain message');
		await t.deactivate();
		assert.count(await t.tables.rows('group_messages'), 0, 'nothing is stored');
		assert.count(await t.tables.rows('digests'), 0, 'nothing is recorded');
		assert.count(await t.mock.sends({ since: mark }), 0, 'nothing is sent');
		const reads = (await t.mock.requests({ since: mark, method: 'GET' })).filter((r) => /\/messages\/msg_/.test(r.path));
		assert.count(reads, 0, 'no message was read in full');
	});
}
