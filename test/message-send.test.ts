import type { IDataObject } from 'n8n-workflow';
import { TurboNotify } from '../nodes/TurboNotify/TurboNotify.node';
import { ACCEPTED, API, CT, GRP, PHONE, makeExecuteContext } from './helpers';

const node = new TurboNotify();
const SEND_URL = `${API}/numbers/main/messages`;

async function run(params: IDataObject, responses: unknown[] = [ACCEPTED]) {
	const { context, request } = makeExecuteContext({
		params: { resource: 'message', number: 'main', recipientType: 'phone', phoneNumber: PHONE, ...params },
		responses,
	});
	const result = await node.execute.call(context);
	return { result, request, call: request.mock.calls[0]?.[1] as IDataObject };
}

describe('Message sends', () => {
	const cases: Array<{ name: string; params: IDataObject; content: IDataObject }> = [
		{
			name: 'sendText',
			params: { operation: 'sendText', text: 'Your order is confirmed.' },
			content: { text: 'Your order is confirmed.' },
		},
		{
			name: 'sendMedia image with caption',
			params: {
				operation: 'sendMedia',
				mediaType: 'image',
				mediaUrl: 'https://cdn.example.com/photo.jpg',
				caption: 'Product photo',
				options: { mimeType: 'image/jpeg' },
			},
			content: {
				image_url: 'https://cdn.example.com/photo.jpg',
				caption: 'Product photo',
				mime_type: 'image/jpeg',
			},
		},
		{
			name: 'sendMedia document with file name',
			params: {
				operation: 'sendMedia',
				mediaType: 'document',
				mediaUrl: 'https://cdn.example.com/invoice.pdf',
				caption: '',
				fileName: 'Invoice-April.pdf',
			},
			content: {
				document_url: 'https://cdn.example.com/invoice.pdf',
				filename: 'Invoice-April.pdf',
			},
		},
		{
			name: 'sendMedia audio ignores caption',
			params: {
				operation: 'sendMedia',
				mediaType: 'audio',
				mediaUrl: 'https://cdn.example.com/a.ogg',
				caption: 'must not be sent',
			},
			content: { audio_url: 'https://cdn.example.com/a.ogg' },
		},
		{
			name: 'sendMedia sticker',
			params: { operation: 'sendMedia', mediaType: 'sticker', mediaUrl: 'https://cdn.example.com/s.webp' },
			content: { sticker_url: 'https://cdn.example.com/s.webp' },
		},
		{
			name: 'sendLocation',
			params: {
				operation: 'sendLocation',
				latitude: -23.5505,
				longitude: -46.6333,
				options: { name: 'Avenida Paulista', address: 'Sao Paulo, SP' },
			},
			content: {
				latitude: -23.5505,
				longitude: -46.6333,
				name: 'Avenida Paulista',
				address: 'Sao Paulo, SP',
			},
		},
		{
			name: 'sendContactCard',
			params: {
				operation: 'sendContactCard',
				displayName: 'Maria Souza',
				phones: { phoneValues: [{ label: 'Work', number: '+55 11 3333-4444' }, { number: '+5511977770002' }] },
				options: {
					emails: { emailValues: [{ label: 'Work', address: 'maria@example.com' }] },
					organization: 'Acme',
					title: 'CTO',
				},
			},
			content: {
				display_name: 'Maria Souza',
				phones: [{ label: 'Work', number: '+551133334444' }, { number: '+5511977770002' }],
				emails: [{ label: 'Work', address: 'maria@example.com' }],
				organization: 'Acme',
				title: 'CTO',
			},
		},
		{
			name: 'sendCalendarEvent',
			params: {
				operation: 'sendCalendarEvent',
				eventName: 'Sprint Planning',
				startAt: '2026-11-03T14:00:00Z',
				options: {
					endAt: '2026-11-03T15:00:00Z',
					description: 'Sprint 24',
					joinLink: 'https://meet.example.com/abc',
					hasReminder: true,
					reminderOffsetSeconds: 600,
				},
			},
			content: {
				name: 'Sprint Planning',
				start_at: '2026-11-03T14:00:00.000Z',
				end_at: '2026-11-03T15:00:00.000Z',
				description: 'Sprint 24',
				join_link: 'https://meet.example.com/abc',
				has_reminder: true,
				reminder_offset_sec: 600,
			},
		},
		{
			name: 'sendLinkButton',
			params: {
				operation: 'sendLinkButton',
				body: 'Your order has shipped.',
				buttonText: 'Track',
				buttonUrl: 'https://example.com/tracking/123',
				options: { footer: 'Example Store', headerText: 'Shipping' },
			},
			content: {
				interactive_type: 'cta_url',
				body: 'Your order has shipped.',
				url_button: { display_text: 'Track', url: 'https://example.com/tracking/123' },
				footer: 'Example Store',
				header: { type: 'text', text: 'Shipping' },
			},
		},
	];

	it.each(cases)('$name posts the documented body', async ({ params, content }) => {
		const { call, result } = await run(params);
		expect(call).toMatchObject({ method: 'POST', url: SEND_URL, json: true });
		expect(call.body).toEqual({ to: { number: PHONE }, content });
		expect(result[0]?.[0]?.json).toEqual(ACCEPTED);
	});

	it('uses the number from the Number parameter in the path', async () => {
		const { call } = await run({ operation: 'sendText', text: 'Hi', number: 'vendas-sp' });
		expect(call.url).toBe(`${API}/numbers/vendas-sp/messages`);
	});

	it('encodes the number reference', async () => {
		const { call } = await run({ operation: 'sendText', text: 'Hi', number: 'a b/c' });
		expect(call.url).toBe(`${API}/numbers/a%20b%2Fc/messages`);
	});

	it('cleans spaces and dashes from a phone number', async () => {
		const { call } = await run({ operation: 'sendText', text: 'Hi', phoneNumber: '+55 (11) 97777-0001' });
		expect((call.body as IDataObject).to).toEqual({ number: '+5511977770001' });
	});

	it('sends to a contact id', async () => {
		const { call } = await run({ operation: 'sendText', text: 'Hi', recipientType: 'contact', contactId: CT });
		expect((call.body as IDataObject).to).toEqual({ contact_id: CT });
	});

	it('sends to a group id', async () => {
		const { call } = await run({ operation: 'sendText', text: 'Hi', recipientType: 'group', groupId: GRP });
		expect((call.body as IDataObject).to).toEqual({ group_id: GRP });
	});

	it('sends the Idempotency-Key header only when set', async () => {
		const withKey = await run({ operation: 'sendText', text: 'Hi', options: { idempotencyKey: 'order-4711' } });
		expect((withKey.call.headers as IDataObject)['Idempotency-Key']).toBe('order-4711');
		const without = await run({ operation: 'sendText', text: 'Hi' });
		expect(JSON.stringify(without.call.headers ?? {})).not.toContain('Idempotency');
	});

	it('never sends the API key in the request body or url', async () => {
		const { call } = await run({ operation: 'sendText', text: 'Hi' });
		expect(JSON.stringify(call)).not.toContain('tn_live_test_key');
	});

	describe('validation names the field', () => {
		const bad: Array<[string, IDataObject, RegExp]> = [
			['phone without plus', { operation: 'sendText', text: 'Hi', phoneNumber: '5511977770001' }, /'Phone Number'/],
			['empty phone', { operation: 'sendText', text: 'Hi', phoneNumber: '' }, /'Phone Number'/],
			['bad contact id', { operation: 'sendText', text: 'Hi', recipientType: 'contact', contactId: 'abc' }, /'Contact ID'/],
			['bad group id', { operation: 'sendText', text: 'Hi', recipientType: 'group', groupId: 'grp_1' }, /'Group ID'/],
			['empty text', { operation: 'sendText', text: '   ' }, /'Text'/],
			['text too long', { operation: 'sendText', text: 'x'.repeat(4097) }, /'Text'.*4096/],
			['idempotency key too long', { operation: 'sendText', text: 'Hi', options: { idempotencyKey: 'k'.repeat(256) } }, /'Idempotency Key'/],
			['media url not http', { operation: 'sendMedia', mediaType: 'image', mediaUrl: 'ftp://x/y.jpg' }, /'URL'/],
			['media url empty', { operation: 'sendMedia', mediaType: 'image', mediaUrl: '' }, /'URL'/],
			['caption too long', { operation: 'sendMedia', mediaType: 'image', mediaUrl: 'https://x.example.com/a.jpg', caption: 'c'.repeat(1025) }, /'Caption'/],
			['latitude out of range', { operation: 'sendLocation', latitude: 91, longitude: 0 }, /'Latitude'/],
			['longitude out of range', { operation: 'sendLocation', latitude: 0, longitude: 181 }, /'Longitude'/],
			['contact card without phone', { operation: 'sendContactCard', displayName: 'Ana', phones: {} }, /'Phones'/],
			['contact card bad phone', { operation: 'sendContactCard', displayName: 'Ana', phones: { phoneValues: [{ number: 'abc' }] } }, /'Phones'/],
			['contact card bad email', { operation: 'sendContactCard', displayName: 'Ana', phones: { phoneValues: [{ number: PHONE }] }, options: { emails: { emailValues: [{ address: 'nope' }] } } }, /'Emails'/],
			['event end before start', { operation: 'sendCalendarEvent', eventName: 'E', startAt: '2026-11-03T15:00:00Z', options: { endAt: '2026-11-03T14:00:00Z' } }, /'End Time'/],
			['event without name', { operation: 'sendCalendarEvent', eventName: '', startAt: '2026-11-03T15:00:00Z' }, /'Event Name'/],
			['event bad start', { operation: 'sendCalendarEvent', eventName: 'E', startAt: 'tomorrow' }, /'Start Time'/],
			['button text too long', { operation: 'sendLinkButton', body: 'b', buttonText: 'x'.repeat(21), buttonUrl: 'https://example.com' }, /'Button Text'/],
			['button url not http', { operation: 'sendLinkButton', body: 'b', buttonText: 'Go', buttonUrl: 'javascript:alert(1)' }, /'Button URL'/],
		];
		it.each(bad)('%s', async (_name, params, pattern) => {
			const { context, request } = makeExecuteContext({
				params: { resource: 'message', number: 'main', recipientType: 'phone', phoneNumber: PHONE, ...params },
			});
			await expect(node.execute.call(context)).rejects.toThrow(pattern);
			expect(request).not.toHaveBeenCalled();
		});
	});

	it('includes the item index in the message when there are several items', async () => {
		const { context } = makeExecuteContext({
			items: [{ json: {} }, { json: {} }],
			params: [
				{ resource: 'message', operation: 'sendText', number: 'main', recipientType: 'phone', phoneNumber: PHONE, text: 'ok' },
				{ resource: 'message', operation: 'sendText', number: 'main', recipientType: 'phone', phoneNumber: 'bad', text: 'ok' },
			],
			responses: [ACCEPTED],
		});
		await expect(node.execute.call(context)).rejects.toThrow(/\[Item 1\]/);
	});
});
