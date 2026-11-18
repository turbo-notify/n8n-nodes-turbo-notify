/**
 * Second scenario: the workflow exactly as exported, with NOTHING patched, so "Your settings" still holds the
 * placeholder owner phone. It proves the safe default: the table can be created, but the hourly run and the answer
 * flow stop with a clear message and nothing is sent to anybody. (The form needs no owner phone, so it still works.)
 *
 *   node templates/harness/run-template.mjs templates/appointment-reminders-with-rsvp/workflow.json \
 *     --scenario templates/appointment-reminders-with-rsvp/test/placeholder.mjs --run-id t1 --ports 5691,9201,9202 \
 *     --image n8nio/n8n:2.45.5 --tz America/Sao_Paulo
 */
export const timeoutMs = 10 * 60_000;
export const credentials = [{ type: 'httpBasicAuth', name: 'Form access (Basic Auth)', data: { user: 'staff', password: 'harness-form-password' } }];

export default async function scenario(t) {
	const { assert } = t;
	const mark = await t.mock.mark();
	await t.step('the table can be created with the placeholder phone (it needs no phone)', async () => {
		const execution = await t.run('Run once: create the table');
		assert.equal(execution.status, 'success', execution.describe());
		assert.count(await t.tables.rows('appointments'), 0, 'the table is empty');
	});
	await t.step('the hourly run refuses to run with the placeholder phone, says what to set, and sends nothing', async () => {
		await t.tables.insert('appointments', [{
			customer_name: 'Placeholder Customer', phone: '+5511977770011', title: 'Check-up', location: '', start_at: new Date(Date.now() + 5 * 3_600_000).toISOString(),
			duration_min: 30, status: 'scheduled', reminder_message_id: '', reminded_at: '', rsvp_at: '', extra_guests: 0, last_error: '', notes: '',
		}]);
		const execution = await t.run('Every hour: remind and report');
		assert.equal(execution.status, 'error', 'the run fails loudly');
		assert.match(execution.nodeError('Write the invitations')?.message ?? '', /Your settings: set owner_phone to your own WhatsApp number/, 'with a message that says what to do');
		assert.count(await t.mock.sends({ since: mark }), 0, 'nothing is sent');
		assert.equal((await t.tables.rows('appointments'))[0].status, 'scheduled', 'the row is untouched');
	});
}
