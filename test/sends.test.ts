import type { IDataObject } from 'n8n-workflow';
import {
	ACCEPTED,
	API,
	CT,
	GRP,
	MESSAGE,
	MSG,
	PHONE,
	body,
	makeExecuteContext,
	node,
	run,
} from './helpers';

const SEND_URL = `${API}/numbers/main/messages`;

describe('every send posts the documented body', () => {
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
			},
			content: { image_url: 'https://cdn.example.com/photo.jpg', caption: 'Product photo' },
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
			name: 'sendMedia audio ignores the caption',
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
			params: {
				operation: 'sendMedia',
				mediaType: 'sticker',
				mediaUrl: 'https://cdn.example.com/s.webp',
			},
			content: { sticker_url: 'https://cdn.example.com/s.webp' },
		},
		{
			name: 'sendLocation',
			params: {
				operation: 'sendLocation',
				latitude: -23.5505,
				longitude: -46.6333,
				additionalFields: { name: 'Avenida Paulista', address: 'Sao Paulo, SP' },
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
				phones: {
					phoneValues: [
						{ label: 'Work', number: '+55 11 3333-4444' },
						{ number: '+5511977770002' },
					],
				},
				additionalFields: {
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
			name: 'sendCalendarEvent with a reminder in minutes',
			params: {
				operation: 'sendCalendarEvent',
				eventName: 'Sprint Planning',
				startAt: '2026-11-03T14:00:00Z',
				additionalFields: {
					endAt: '2026-11-03T15:00:00Z',
					description: 'Sprint 24',
					joinLink: 'https://meet.example.com/abc',
					remindBeforeMinutes: 10,
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
				additionalFields: { footer: 'Example Store', headerText: 'Shipping' },
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

	it.each(cases)('$name', async ({ params, content }) => {
		const { call, json } = await run({ ...MESSAGE, ...params });
		expect(call).toMatchObject({ method: 'POST', url: SEND_URL, json: true });
		expect(call.body).toEqual({ to: { number: PHONE }, content });
		expect(json).toMatchObject({ id: MSG, status: ACCEPTED.status });
	});
});

describe('recipient and number', () => {
	it('uses the number from the Number field in the path, encoded', async () => {
		expect(
			(await run({ ...MESSAGE, operation: 'sendText', text: 'Hi', number: 'vendas-sp' })).call.url,
		).toBe(`${API}/numbers/vendas-sp/messages`);
		expect(
			(await run({ ...MESSAGE, operation: 'sendText', text: 'Hi', number: 'a b/c' })).call.url,
		).toBe(`${API}/numbers/a%20b%2Fc/messages`);
	});

	it('cleans spaces, dashes and brackets from a phone number', async () => {
		const { call } = await run({
			...MESSAGE,
			operation: 'sendText',
			text: 'Hi',
			phoneNumber: '+55 (11) 97777-0001',
		});
		expect(body(call).to).toEqual({ number: '+5511977770001' });
	});

	it.each([
		['contact', { recipientType: 'contact', contactId: CT }, { contact_id: CT }],
		['group', { recipientType: 'group', groupId: GRP }, { group_id: GRP }],
		['auto with a phone', { recipientType: 'auto', recipient: PHONE }, { number: PHONE }],
		['auto with a contact', { recipientType: 'auto', recipient: CT }, { contact_id: CT }],
		['auto with a group', { recipientType: 'auto', recipient: GRP }, { group_id: GRP }],
	])('sends to a %s', async (_name, params, to) => {
		const { call } = await run({ ...MESSAGE, operation: 'sendText', text: 'Hi', ...params });
		expect(body(call).to).toEqual(to);
	});

	it('quotes an earlier message from a content send', async () => {
		const { call } = await run({
			...MESSAGE,
			operation: 'sendMedia',
			mediaType: 'image',
			mediaUrl: 'https://x.example.com/a.png',
			additionalFields: { quotedMessageId: MSG },
		});
		expect(body(call).quoted_message_id).toBe(MSG);
	});

	it('never puts the API key in the request', async () => {
		const { call } = await run({ ...MESSAGE, operation: 'sendText', text: 'Hi' });
		expect(JSON.stringify(call)).not.toContain('tn_live_test_key');
	});
});

describe('typing indicator', () => {
	it('shows and clears for a recipient', async () => {
		const { call, json } = await run(
			{ ...MESSAGE, operation: 'sendTypingIndicator', isTyping: false },
			{ responses: [{ operation_id: 'op_1', status: { state: 'cleared', at: 't' } }] },
		);
		expect(call).toMatchObject({
			method: 'POST',
			url: `${API}/numbers/main/typing-indicator`,
			body: { to: { number: PHONE }, is_typing: false },
		});
		expect(json).toMatchObject({
			operation_id: 'op_1',
			number_alias: 'main',
			is_typing: false,
			to: { number: PHONE },
		});
	});
});

describe('a send refuses what it cannot send, naming the field', () => {
	const bad: Array<[string, IDataObject, RegExp]> = [
		[
			'phone without plus',
			{ operation: 'sendText', text: 'Hi', phoneNumber: '5511977770001' },
			/'Phone Number' is not a valid/,
		],
		[
			'empty phone',
			{ operation: 'sendText', text: 'Hi', phoneNumber: '' },
			/'Phone Number' is empty/,
		],
		[
			'bad contact id',
			{ operation: 'sendText', text: 'Hi', recipientType: 'contact', contactId: 'abc' },
			/'Contact' is not a valid ID/,
		],
		[
			'empty contact',
			{ operation: 'sendText', text: 'Hi', recipientType: 'contact', contactId: '' },
			/'Contact' is empty/,
		],
		[
			'bad group id',
			{ operation: 'sendText', text: 'Hi', recipientType: 'group', groupId: 'grp_1' },
			/'Group' is not a valid ID/,
		],
		['empty text', { operation: 'sendText', text: '   ' }, /'Text' is empty/],
		['text too long', { operation: 'sendText', text: 'x'.repeat(4097) }, /'Text'.*4096/],
		[
			'key too long',
			{ operation: 'sendText', text: 'Hi', options: { idempotencyKey: 'k'.repeat(256) } },
			/'Idempotency Key'/,
		],
		[
			'media url not http',
			{ operation: 'sendMedia', mediaType: 'image', mediaUrl: 'ftp://x/y.jpg' },
			/'Media URL'/,
		],
		[
			'media url empty',
			{ operation: 'sendMedia', mediaType: 'image', mediaUrl: '' },
			/'Media URL' is empty/,
		],
		[
			'media type unknown',
			{ operation: 'sendMedia', mediaType: 'toString', mediaUrl: 'https://x.example.com/a.jpg' },
			/'Media Type'/,
		],
		[
			'caption too long',
			{
				operation: 'sendMedia',
				mediaType: 'image',
				mediaUrl: 'https://x.example.com/a.jpg',
				caption: 'c'.repeat(1025),
			},
			/'Caption'/,
		],
		[
			'quoted id malformed',
			{
				operation: 'sendMedia',
				mediaType: 'image',
				mediaUrl: 'https://x.example.com/a.jpg',
				additionalFields: { quotedMessageId: 'x' },
			},
			/'Quoted Message ID'/,
		],
		[
			'latitude out of range',
			{ operation: 'sendLocation', latitude: 91, longitude: 0 },
			/'Latitude'/,
		],
		[
			'longitude out of range',
			{ operation: 'sendLocation', latitude: 0, longitude: 181 },
			/'Longitude'/,
		],
		[
			'card without phone',
			{ operation: 'sendContactCard', displayName: 'Ana', phones: {} },
			/'Phones' is empty/,
		],
		[
			'card bad phone',
			{
				operation: 'sendContactCard',
				displayName: 'Ana',
				phones: { phoneValues: [{ number: 'abc' }] },
			},
			/'Phones'/,
		],
		[
			'card with 11 phones',
			{
				operation: 'sendContactCard',
				displayName: 'Ana',
				phones: { phoneValues: Array.from({ length: 11 }, () => ({ number: PHONE })) },
			},
			/up to 10 numbers/,
		],
		[
			'card bad email',
			{
				operation: 'sendContactCard',
				displayName: 'Ana',
				phones: { phoneValues: [{ number: PHONE }] },
				additionalFields: { emails: { emailValues: [{ address: 'nope' }] } },
			},
			/'Emails'/,
		],
		[
			'card with 11 emails',
			{
				operation: 'sendContactCard',
				displayName: 'Ana',
				phones: { phoneValues: [{ number: PHONE }] },
				additionalFields: {
					emails: { emailValues: Array.from({ length: 11 }, () => ({ address: 'a@b.co' })) },
				},
			},
			/up to 10 addresses/,
		],
		[
			'event end before start',
			{
				operation: 'sendCalendarEvent',
				eventName: 'E',
				startAt: '2026-11-03T15:00:00Z',
				additionalFields: { endAt: '2026-11-03T14:00:00Z' },
			},
			/'End Time'/,
		],
		[
			'event without a name',
			{ operation: 'sendCalendarEvent', eventName: '', startAt: '2026-11-03T15:00:00Z' },
			/'Event Name'/,
		],
		[
			'event with a bad start',
			{ operation: 'sendCalendarEvent', eventName: 'E', startAt: 'tomorrow' },
			/'Start Time'/,
		],
		[
			'button text too long',
			{
				operation: 'sendLinkButton',
				body: 'b',
				buttonText: 'x'.repeat(21),
				buttonUrl: 'https://example.com',
			},
			/'Button Text'/,
		],
		[
			'button url not http',
			{
				operation: 'sendLinkButton',
				body: 'b',
				buttonText: 'Go',
				buttonUrl: 'javascript:alert(1)',
			},
			/'Button URL'/,
		],
	];

	it.each(bad)('%s', async (_name, params, pattern) => {
		const { context, request } = makeExecuteContext({ params: { ...MESSAGE, ...params } });
		await expect(node.execute.call(context)).rejects.toThrow(pattern);
		expect(request).not.toHaveBeenCalled();
	});
});
