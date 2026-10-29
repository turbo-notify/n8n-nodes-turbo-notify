import type { IDataObject, JsonObject } from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';
import { MESSAGE, NODE, apiError, makeExecuteContext, node } from './helpers';

const TEXT: IDataObject = { ...MESSAGE, operation: 'sendText', text: 'Hi' };

async function failing(failWith: unknown) {
	const { context, request } = makeExecuteContext({ params: TEXT, failWith });
	const error = (await node.execute.call(context).catch((e: unknown) => e)) as NodeApiError;
	return { error, request };
}
const withStatus = (status: number, body: IDataObject, headers: IDataObject = {}) =>
	failing(apiError(status, body, headers));

describe('a send that came too early waits and tries again', () => {
	it('repeats after send_rate_spacing for as long as the API asked, then succeeds', async () => {
		const { context, request } = makeExecuteContext({ params: TEXT });
		request.mockReset();
		request
			.mockRejectedValueOnce(apiError(429, { error: 'send_rate_spacing' }, { 'retry-after': '2' }))
			.mockResolvedValueOnce({ message_id: 'msg_a' });
		const result = await node.execute.call(context);
		expect(request).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenLastCalledWith(2000);
		expect(result[0]?.[0]?.json).toMatchObject({ id: 'msg_a' });
	});

	it('gives up after three repeats and says why', async () => {
		const { error, request } = await withStatus(
			429,
			{ error: 'send_rate_spacing' },
			{ 'retry-after': '1' },
		);
		expect(request).toHaveBeenCalledTimes(4);
		expect(error.message).toContain('send_rate_spacing');
		expect(error.failure).toEqual({ cause: 'rate-limited', retryAfterMs: 1000 });
	});

	it('never waits for a quota, which only resets with the cycle', async () => {
		const { error, request } = await withStatus(
			429,
			{ error: 'messages_quota_exceeded' },
			{ 'retry-after': '1296000' },
		);
		expect(request).toHaveBeenCalledTimes(1);
		expect(error.failure).toMatchObject({ cause: 'quota-exhausted' });
		expect((error.failure as { resetsAtEpochMs: number }).resetsAtEpochMs).toBeGreaterThan(
			Date.now(),
		);
		expect(error.description).toMatch(/billing cycle/);
	});

	it('does not repeat a wait longer than 30 seconds', async () => {
		const { request } = await withStatus(
			429,
			{ error: 'rate_limit_exceeded' },
			{ 'retry-after': '90' },
		);
		expect(request).toHaveBeenCalledTimes(1);
	});
});

describe('what n8n is told about a failure', () => {
	it.each([
		[401, { error: 'not_authenticated' }, 'credential-invalid'],
		[404, { error: 'number_not_found' }, 'configuration-invalid'],
		[503, { error: 'service_unavailable' }, 'temporarily-unavailable'],
	])('%s %j is %s', async (status, body, cause) => {
		expect((await withStatus(status, body as IDataObject)).error.failure).toEqual({ cause });
	});

	it('says nothing about a 502, because a send may have gone out', async () => {
		expect((await withStatus(502, { error: 'bad_gateway' })).error.failure).toBeUndefined();
	});
});

describe('the text a person reads', () => {
	it('keeps the code and tells how to fix it', async () => {
		const { error } = await withStatus(409, { error: 'number_not_connected' });
		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toContain('number_not_connected');
		expect(error.description).toMatch(/Reconnect the number/);
	});

	it('names the missing scope', async () => {
		const { error } = await withStatus(403, {
			error: 'insufficient_scope',
			required_scope: 'messages:send',
		});
		expect(error.message).toContain('insufficient_scope');
		expect(error.description).toContain("'messages:send'");
	});

	it('lists the fields the API rejected, without the word error', async () => {
		const { error } = await withStatus(422, {
			error: 'validation_error',
			details: {
				errors: [
					{ loc: ['body', 'content', 'text'], msg: 'String should have at most 4096 characters' },
				],
			},
		});
		expect(error.description).toContain('content.text: String should have at most 4096 characters');
		expect(error.message).not.toMatch(/error/i);
	});

	it('puts the plan message of feature_not_available first', async () => {
		const { error } = await withStatus(402, {
			error: 'feature_not_available',
			message: 'Groups need the Business plan.',
		});
		expect(error.description).toMatch(/^Groups need the Business plan\./);
		expect(error.description).toMatch(/Billing/);
	});

	it.each([
		'reply_ratio_too_low',
		'duplicate_burst_blocked',
		'warmup_limit_exceeded',
		'recipients_per_day_limit_exceeded',
	])('explains %s', async (code) => {
		const { error, request } = await withStatus(429, { error: code });
		expect(request).toHaveBeenCalledTimes(1);
		expect(error.message).toContain(code);
		expect(error.description).not.toBe('');
	});

	it('says a server answer may mean the message went out', async () => {
		const { error } = await withStatus(500, {});
		expect(error.message).toBe('Turbo Notify could not complete the request (500)');
		expect(error.description).toMatch(/may have gone out/);
	});

	it.each([
		[
			'timeout',
			{ code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' },
			'Turbo Notify did not answer in time',
		],
		[
			'unreachable',
			{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' },
			'Could not reach Turbo Notify',
		],
	])('says plainly when it is a %s', async (_name, props, message) => {
		const { error } = await failing(Object.assign(new Error(props.message), { code: props.code }));
		expect(error.message).toBe(message);
		expect(error.description).not.toBe('');
	});

	it('does not use the words error, problem, failure or mistake in any text it writes', async () => {
		for (const [status, body] of [
			[401, { error: 'not_authenticated' }],
			[404, { error: 'not_found' }],
			[402, { error: 'contact_quota_exceeded' }],
			[500, {}],
		] as Array<[number, IDataObject]>) {
			const { error } = await withStatus(status, body);
			expect(`${error.message} ${error.description}`).not.toMatch(
				/\b(error|problem|failure|mistake)\b/i,
			);
		}
	});

	it('keeps our text when n8n has already wrapped the answer in a NodeApiError', async () => {
		const axiosLike = Object.assign(new Error('Request failed with status code 429'), {
			response: {
				status: 429,
				data: { error: 'messages_quota_exceeded', message: 'quota' },
				headers: { 'retry-after': '600' },
			},
		});
		const wrapped = new NodeApiError(NODE, axiosLike as unknown as JsonObject, {
			message: 'The service is receiving too many requests from you',
			httpCode: '429',
		});
		const { error } = await failing(wrapped);
		expect(error.message).toContain('messages_quota_exceeded');
		expect(error.message).not.toMatch(/receiving too many requests/);
		expect(error.description).toMatch(/billing cycle/);
	});
});
