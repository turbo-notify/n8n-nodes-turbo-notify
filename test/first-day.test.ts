import type { IDataObject } from 'n8n-workflow';
import { TurboNotifyApi } from '../credentials/TurboNotifyApi.credentials';
import { TurboNotifyTrigger } from '../nodes/TurboNotifyTrigger/TurboNotifyTrigger.node';
import { TurboNotifyPollingTrigger } from '../nodes/TurboNotifyPollingTrigger/TurboNotifyPollingTrigger.node';
import { untilText } from '../nodes/TurboNotify/transport/errors';
import { USER_AGENT } from '../nodes/TurboNotify/transport/version';
import { ACCEPTED, MESSAGE, apiError, makeExecuteContext, makePollContext, node, run } from './helpers';

const TEXT: IDataObject = { ...MESSAGE, operation: 'sendText', text: 'Hi' };

async function refused(status: number, body: IDataObject, headers: IDataObject = {}) {
	const { context } = makeExecuteContext({ params: TEXT, failWith: apiError(status, body, headers) });
	return (await node.execute.call(context).catch((e: unknown) => e)) as {
		message: string;
		description: string;
	};
}

describe('what a new user needs to know before the first send', () => {
	const credential = new TurboNotifyApi();

	it('opens the credential with a notice that says what is needed and where', () => {
		const first = credential.properties[0];
		expect(first?.type).toBe('notice');
		const text = String(first?.displayName);
		expect(text).toMatch(/account/);
		expect(text).toMatch(/connected under Numbers/);
		expect(text).toMatch(/API key from API keys/);
		// a link in a notice is drawn like plain text, so the notice points at the underlined docs link instead
		expect(text).toMatch(/step by step is in the docs linked above/);
		expect(text).not.toMatch(/<a /);
		expect(text).not.toMatch(/<b>/);
	});

	it('gives the first-week volume of a new number and sends the plan allowance to Billing', () => {
		const text = String(credential.properties[0]?.displayName);
		for (const volume of ['50 messages', '200', '500', '1,000', '2,000']) expect(text).toContain(volume);
		// the allowance belongs to the plan of the reader: the notice never quotes one plan as if it were everyone's
		expect(text).toMatch(/your plan/i);
		expect(text).toMatch(/Billing/);
		expect(text).not.toMatch(/Free plan/);
		expect(text).not.toMatch(/\b300\b/);
	});

	it('points the credential and every node at the same page', () => {
		expect(credential.documentationUrl).toBe('https://docs.turbonotify.com/en/guides/n8n/');
	});

	it('names where the API key is created', () => {
		const apiKey = credential.properties.find((p) => p.name === 'apiKey');
		expect(apiKey?.description).toContain('https://dashboard.turbonotify.com/api-keys');
	});
});

describe('the instant trigger tells where n8n keeps its address', () => {
	it('says that Webhook URLs is closed at the top of the step and opens it', () => {
		const notice = new TurboNotifyTrigger().description.properties[0];
		expect(notice?.type).toBe('notice');
		expect(String(notice?.displayName)).toMatch(/Open Webhook URLs at the top of this step/);
	});
});

describe('the answers that stop a new user say what to do next', () => {
	it('says how a new number ramps up and when the count starts again', async () => {
		const error = await refused(429, { error: 'warmup_limit_exceeded' }, { 'retry-after': '9749' });
		for (const volume of ['50 messages', '200', '500', '1,000', '2,000']) {
			expect(error.description).toContain(volume);
		}
		expect(error.description).toContain('midnight UTC, in about 2 hours 42 minutes.');
		expect(error.description).toContain('/messages/rate-limits/');
		expect(error.description).not.toMatch(/a few days/);
	});

	it('does not invent a wait when the answer carries none', async () => {
		const error = await refused(429, { error: 'warmup_limit_exceeded' });
		expect(error.description).toMatch(/midnight UTC\.$/);
	});

	it.each(['messages_quota_exceeded', 'contact_quota_exceeded'])(
		'sends %s to the plan page and says when it resets',
		async (code) => {
			const error = await refused(402, { error: code, details: { resets_at: '2026-11-29T10:52:10Z' } });
			expect(error.description).toContain('https://dashboard.turbonotify.com/billing');
			expect(error.description).toMatch(/billing cycle/);
			expect(error.description).toContain('It resets on 2026-11-29 (UTC).');
		},
	);

	it('leaves the reset date out when the answer has none', async () => {
		const error = await refused(402, { error: 'messages_quota_exceeded' });
		expect(error.description).not.toMatch(/It resets on/);
	});

	it('explains that a contact already messaged in the cycle still works', async () => {
		const error = await refused(402, { error: 'contact_quota_exceeded' });
		expect(error.description).toMatch(/already messaged in this cycle can still receive messages/);
	});

	it('sends a disconnected number to the Numbers page', async () => {
		const error = await refused(409, { error: 'number_not_connected' });
		expect(error.description).toContain('https://dashboard.turbonotify.com/numbers');
	});

	it('sends a rejected key to the API keys page', async () => {
		const error = await refused(401, { error: 'not_authenticated' });
		expect(error.description).toContain('https://dashboard.turbonotify.com/api-keys');
	});

	it.each([
		[9749, '2 hours 42 minutes'],
		[7200, '2 hours'],
		[3600, '1 hour'],
		[2100, '35 minutes'],
		[60, '1 minute'],
		[20, 'less than a minute'],
	])('says %s seconds as %s', (seconds, text) => expect(untilText(seconds)).toBe(text));
});

describe('traffic from n8n can be told apart', () => {
	it('sends the package as the User-Agent with every request, next to the other headers', async () => {
		const manual = await run(TEXT, { mode: 'manual', executionId: '9' });
		expect(manual.call?.headers).toMatchObject({ 'User-Agent': USER_AGENT });
		const real = await run(TEXT, { mode: 'trigger', executionId: '9', responses: [ACCEPTED] });
		expect(real.call?.headers).toMatchObject({
			'User-Agent': USER_AGENT,
			'Idempotency-Key': expect.any(String),
		});
	});

	it('uses the package version in the name', () => {
		expect(USER_AGENT).toMatch(/^turbo-notify-n8n\/\d+\.\d+\.\d+$/);
	});

	it('also names itself when n8n tests the credential', () => {
		expect(new TurboNotifyApi().test.request.headers).toEqual({ 'User-Agent': USER_AGENT });
	});

	it('sends it from the polling trigger as well', async () => {
		const { context, request } = makePollContext({
			params: { events: ['message.received'] },
			responses: [{ object: 'list', data: [], has_more: false }, { object: 'list', data: [], has_more: false }],
		});
		await new TurboNotifyPollingTrigger().poll.call(context);
		expect(request.mock.calls[0]?.[1].headers).toMatchObject({ 'User-Agent': USER_AGENT });
	});
});

describe('the node panel', () => {
	it('shows the app description, not a sentence about the trigger', () => {
		// n8n gives the grouped Turbo Notify node the description of the trigger whose name matches it.
		const { description } = new TurboNotifyTrigger().description;
		expect(description).toBe('Send, track and receive WhatsApp messages from your workflows');
		expect(description).not.toMatch(/^Starts/);
	});

	it('keeps the polling trigger as its own entry with its own description', () => {
		const { description, name } = new TurboNotifyPollingTrigger().description;
		expect(name).toBe('turboNotifyPollingTrigger');
		expect(description).toMatch(/^Starts a workflow/);
	});
});
