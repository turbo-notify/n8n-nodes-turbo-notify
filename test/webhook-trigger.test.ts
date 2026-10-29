import { createHmac } from 'crypto';
import type { IDataObject, IHookFunctions, IWebhookFunctions } from 'n8n-workflow';
import { TurboNotifyTrigger } from '../nodes/TurboNotifyTrigger/TurboNotifyTrigger.node';
import { isGenuine } from '../nodes/TurboNotifyTrigger/signature';
import { NODE } from './helpers';

const trigger = new TurboNotifyTrigger();
const SECRET = 'a-long-random-secret';

const event = (id: string, type = 'message.received', extra: IDataObject = {}): IDataObject => ({
	id,
	type,
	organization_id: 'org_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
	number_alias: 'main',
	number_id: 'num_0a1b2c3d4e5f60718293a4b5c6d7e8f9',
	created_at: '2026-10-28T10:00:00Z',
	data: { id: 'msg_1', preview: 'Hi' },
	...extra,
});

const sign = (raw: string, timestamp: number, secret = SECRET) =>
	`sha256=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}`;

function delivery(input: {
	noRawBody?: boolean;
	body: IDataObject;
	params?: IDataObject;
	secret?: string;
	signedWith?: string;
	timestamp?: number;
	headers?: IDataObject;
	mode?: string;
	staticData?: IDataObject;
}) {
	const raw = JSON.stringify(input.body);
	const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
	const json = jest.fn();
	const status = jest.fn().mockReturnValue({ json });
	const staticData = input.staticData ?? {};
	const params: IDataObject = {
		verifySignature: true,
		events: ['message.received'],
		options: {},
		...input.params,
	};
	const context = {
		getNode: () => NODE,
		getMode: () => input.mode ?? 'trigger',
		getRequestObject: () => (input.noRawBody ? {} : { rawBody: Buffer.from(raw) }),
		getResponseObject: () => ({ status }),
		getBodyData: () => input.body,
		getHeaderData: () =>
			input.headers ?? {
				'x-webhook-timestamp': String(timestamp),
				'x-webhook-signature': sign(raw, timestamp, input.signedWith ?? SECRET),
			},
		getNodeParameter: (name: string, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		getCredentials: async () => ({
			apiKey: 'k',
			baseUrl: 'https://api.turbonotify.com',
			webhookSecret: input.secret ?? SECRET,
		}),
		getWorkflowStaticData: () => staticData,
		helpers: { returnJsonArray: (data: IDataObject) => [{ json: data }] },
	};
	return { context: context as unknown as IWebhookFunctions, status, json, staticData };
}

describe('Turbo Notify Trigger (webhook)', () => {
	it('is a webhook trigger without polling, listening for POST', () => {
		expect(trigger.description.webhooks?.[0]).toMatchObject({
			httpMethod: 'POST',
			responseMode: 'onReceived',
		});
		expect(trigger.description.polling).toBeUndefined();
		expect(trigger.description.inputs).toEqual([]);
	});

	it('starts the workflow with the whole event', async () => {
		const body = event('evt_1');
		const result = await trigger.webhook.call(delivery({ body }).context);
		expect(result.workflowData?.[0]?.[0]?.json).toEqual(body);
	});

	describe('the signature', () => {
		it.each([
			['a wrong secret', { signedWith: 'another-secret' }],
			['no signature headers', { headers: {} }],
			['a delivery older than five minutes', { timestamp: Math.floor(Date.now() / 1000) - 3600 }],
		])('answers 401 and starts nothing for %s', async (_name, extra) => {
			const { context, status, json } = delivery({ body: event('evt_1'), ...extra });
			const result = await trigger.webhook.call(context);
			expect(status).toHaveBeenCalledWith(401);
			expect(json).toHaveBeenCalled();
			expect(result).toEqual({ noWebhookResponse: true });
		});

		it('says what to fill in when the credential has no signing secret', async () => {
			await expect(
				trigger.webhook.call(delivery({ body: event('evt_1'), secret: '' }).context),
			).rejects.toThrow(/'Webhook Signing Secret'.*empty/);
		});

		it('refuses to guess the signed bytes when n8n kept no raw body', async () => {
			const { context } = delivery({ body: event('evt_1'), noRawBody: true });
			await expect(trigger.webhook.call(context)).rejects.toThrow(/did not keep the raw body/);
		});

		it('is checked when the workflow is activated, not only when a delivery arrives', async () => {
			const activation = (secret: string, verify = true) =>
				({
					getNode: () => NODE,
					getNodeParameter: () => verify,
					getCredentials: async () => ({ webhookSecret: secret }),
				}) as unknown as IHookFunctions;
			await expect(trigger.webhookMethods.default.checkExists.call(activation(''))).rejects.toThrow(
				/'Webhook Signing Secret'.*empty/,
			);
			await expect(
				trigger.webhookMethods.default.checkExists.call(activation(SECRET)),
			).resolves.toBe(true);
			await expect(
				trigger.webhookMethods.default.checkExists.call(activation('', false)),
			).resolves.toBe(true);
		});

		it('can be turned off to try things out', async () => {
			const { context } = delivery({
				body: event('evt_1'),
				params: { verifySignature: false },
				headers: {},
			});
			expect((await trigger.webhook.call(context)).workflowData).toBeDefined();
		});
	});

	describe('which events start the workflow', () => {
		it('ignores a type that was not chosen, still answering 200', async () => {
			const result = await trigger.webhook.call(
				delivery({ body: event('evt_1', 'message.sent') }).context,
			);
			expect(result).toEqual({ webhookResponse: 'Event ignored' });
		});

		it('every event when the list is empty', async () => {
			const result = await trigger.webhook.call(
				delivery({ body: event('evt_1', 'group.joined'), params: { events: [] } }).context,
			);
			expect(result.workflowData).toBeDefined();
		});

		it('only the number asked for, picked from a list or typed, by alias or by ID', async () => {
			const delivered = async (extra: IDataObject, number: IDataObject[string]) =>
				(
					await trigger.webhook.call(
						delivery({ body: event('evt_1', 'message.received', extra), params: { number } })
							.context,
					)
				).workflowData;
			expect(await delivered({}, 'sales-sp')).toBeUndefined();
			expect(await delivered({ number_alias: 'sales-sp' }, 'sales-sp')).toBeDefined();
			expect(
				await delivered(
					{},
					{ __rl: true, mode: 'list', value: 'num_0a1b2c3d4e5f60718293a4b5c6d7e8f9' },
				),
			).toBeDefined();
			expect(await delivered({}, { __rl: true, mode: 'list', value: '' })).toBeDefined();
		});

		it('Any Event lets every type through', async () => {
			const result = await trigger.webhook.call(
				delivery({ body: event('evt_1', 'group.joined'), params: { events: ['*'] } }).context,
			);
			expect(result.workflowData).toBeDefined();
		});

		it('a test run shows the first delivery whatever the filters say', async () => {
			const { context } = delivery({
				body: event('evt_1', 'message.sent'),
				mode: 'manual',
				params: { number: 'sales-sp' },
			});
			expect((await trigger.webhook.call(context)).workflowData).toBeDefined();
		});
	});

	describe('an event that arrives twice', () => {
		it('starts the workflow once', async () => {
			const staticData: IDataObject = {};
			const first = await trigger.webhook.call(
				delivery({ body: event('evt_1'), staticData }).context,
			);
			const again = await trigger.webhook.call(
				delivery({ body: event('evt_1'), staticData }).context,
			);
			expect(first.workflowData).toBeDefined();
			expect(again).toEqual({ webhookResponse: 'Event already received' });
		});

		it('starts it again when Ignore Duplicates is off, and in a test run', async () => {
			const staticData: IDataObject = {};
			await trigger.webhook.call(delivery({ body: event('evt_1'), staticData }).context);
			const off = await trigger.webhook.call(
				delivery({
					body: event('evt_1'),
					staticData,
					params: { options: { ignoreDuplicates: false } },
				}).context,
			);
			const test = await trigger.webhook.call(
				delivery({ body: event('evt_1'), staticData, mode: 'manual' }).context,
			);
			expect(off.workflowData).toBeDefined();
			expect(test.workflowData).toBeDefined();
		});

		it('remembers only the latest 500 IDs', async () => {
			const staticData: IDataObject = {
				received: Array.from({ length: 500 }, (_, i) => `evt_old_${i}`),
			};
			await trigger.webhook.call(delivery({ body: event('evt_new'), staticData }).context);
			expect((staticData.received as string[]).length).toBe(500);
			expect((staticData.received as string[])[0]).toBe('evt_new');
		});
	});
});

describe('signature check', () => {
	const raw = '{"id":"evt_1"}';
	const now = 1_800_000_000;
	const check = (over: Partial<Parameters<typeof isGenuine>[0]> = {}) =>
		isGenuine({
			secret: SECRET,
			timestamp: String(now),
			signature: sign(raw, now),
			rawBody: raw,
			now: now * 1000,
			...over,
		});

	it('accepts what Turbo Notify signs', async () => {
		expect(await check()).toBe(true);
		expect(
			await check({ signature: sign(raw, now).toUpperCase().replace('SHA256=', 'sha256=') }),
		).toBe(true);
	});

	it('accepts a delivery signed by the server itself, with escaped non-ASCII text', async () => {
		// Produced with the HmacSigner of the webhook worker: secret s3cret, timestamp 1800000000.
		const serverBody =
			'{"id":"evt_1","type":"message.received","data":{"preview":"ol\\u00e1 \\ud83d\\ude00"}}';
		const signature = 'sha256=8c3a0c98c6e5f931e652dbb8be921afdfc936ad4bbf23fea584bae7410fe01bf';
		expect(
			await isGenuine({
				secret: 's3cret',
				timestamp: '1800000000',
				signature,
				rawBody: serverBody,
				now: 1_800_000_000_000,
			}),
		).toBe(true);
		expect(
			await isGenuine({
				secret: 's3cret',
				timestamp: '1800000000',
				signature,
				rawBody: JSON.stringify(JSON.parse(serverBody)),
				now: 1_800_000_000_000,
			}),
		).toBe(false);
	});

	it('refuses a changed body, a wrong secret, a missing part and a stale timestamp', async () => {
		expect(await check({ rawBody: '{"id":"evt_2"}' })).toBe(false);
		expect(await check({ secret: 'other' })).toBe(false);
		expect(await check({ signature: undefined })).toBe(false);
		expect(await check({ secret: '' })).toBe(false);
		expect(await check({ timestamp: String(now - 301), signature: sign(raw, now - 301) })).toBe(
			false,
		);
		expect(await check({ timestamp: 'abc' })).toBe(false);
		expect(await check({ signature: 'sha256=' })).toBe(false);
	});
});
