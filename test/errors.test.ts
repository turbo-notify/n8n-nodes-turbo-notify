import type { IDataObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { TurboNotify } from '../nodes/TurboNotify/TurboNotify.node';
import { PHONE, apiError, makeExecuteContext } from './helpers';

const node = new TurboNotify();
const params: IDataObject = { resource: 'message', operation: 'sendText', number: 'main', recipientType: 'phone', phoneNumber: PHONE, text: 'Hi' };

async function failing(status: number, body: IDataObject, headers: IDataObject = {}) {
	const { context } = makeExecuteContext({ params, failWith: apiError(status, body, headers) });
	return node.execute.call(context).then(
		() => {
			throw new Error('expected the call to throw');
		},
		(e: unknown) => e as NodeApiError,
	);
}

describe('API error mapping', () => {
	it('wraps the answer in a NodeApiError that keeps the API code', async () => {
		const error = await failing(409, { error: 'number_not_connected' });
		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toContain('number_not_connected');
		expect(error.description).toMatch(/Reconnect the number/);
	});

	it('403 insufficient_scope names the missing scope', async () => {
		const error = await failing(403, { error: 'insufficient_scope', required_scope: 'messages:send' });
		expect(error.message).toContain('insufficient_scope');
		expect(error.description).toContain("'messages:send'");
	});

	it('401 tells the user to check the credential', async () => {
		const error = await failing(401, { error: 'not_authenticated' });
		expect(error.description).toMatch(/API Key/);
	});

	it('429 keeps the Retry-After value', async () => {
		const error = await failing(429, { error: 'rate_limit_exceeded' }, { 'retry-after': '7' });
		expect(error.description).toContain('7');
	});

	it('quota answers say the allowance resets with the billing cycle', async () => {
		const error = await failing(429, { error: 'messages_quota_exceeded' });
		expect(error.description).toMatch(/billing cycle/);
	});

	it('422 validation_error lists the rejected fields', async () => {
		const error = await failing(422, {
			error: 'validation_error',
			details: { errors: [{ loc: ['body', 'content', 'text'], msg: 'String should have at most 4096 characters' }] },
		});
		expect(error.description).toContain('content.text');
	});

	it('an unknown code is passed through as it is', async () => {
		const error = await failing(500, { error: 'internal_error' });
		expect(error.message).toContain('internal_error');
	});

	it('a network failure without a response still becomes a NodeApiError', async () => {
		const { context } = makeExecuteContext({ params, failWith: new Error('getaddrinfo ENOTFOUND') });
		await expect(node.execute.call(context)).rejects.toBeInstanceOf(NodeApiError);
	});

	it('local validation uses NodeOperationError', async () => {
		const { context } = makeExecuteContext({ params: { ...params, phoneNumber: 'x' } });
		await expect(node.execute.call(context)).rejects.toBeInstanceOf(NodeOperationError);
	});

	it('does not use the words error, problem, failure or mistake in local messages', async () => {
		const { context } = makeExecuteContext({ params: { ...params, phoneNumber: 'x' } });
		const e = (await node.execute.call(context).catch((x: unknown) => x)) as NodeOperationError;
		expect(`${e.message} ${e.description ?? ''}`).not.toMatch(/\b(error|problem|failure|mistake)/i);
	});

	it('continueOnFail returns the message for the failed item and keeps going', async () => {
		const { context } = makeExecuteContext({
			items: [{ json: {} }, { json: {} }],
			params: [params, { ...params, phoneNumber: 'x' }],
			responses: [{ message_id: 'msg_a' }],
			continueOnFail: true,
		});
		const result = await node.execute.call(context);
		expect(result[0]).toHaveLength(2);
		expect(result[0]?.[0]?.json).toEqual({ message_id: 'msg_a' });
		expect(result[0]?.[1]?.json.error).toMatch(/'Phone Number'/);
		expect(result[0]?.[1]?.pairedItem).toEqual({ item: 1 });
	});

	it('rejects a Base URL that is not http or https', async () => {
		const { context } = makeExecuteContext({ params, baseUrl: 'file:///etc/passwd' });
		await expect(node.execute.call(context)).rejects.toThrow(/Base URL/);
	});

	it('removes a trailing slash from the Base URL', async () => {
		const { context, request } = makeExecuteContext({ params, baseUrl: 'https://api.example.test/', responses: [{}] });
		await node.execute.call(context);
		expect(request.mock.calls[0]?.[1].url).toBe('https://api.example.test/v1/numbers/main/messages');
	});
});
