import type { IDataObject } from 'n8n-workflow';
import { ACCEPTED, CT, MESSAGE, MSG, PHONE, body, makeExecuteContext, node, run } from './helpers';

const TEXT: IDataObject = { ...MESSAGE, operation: 'sendText', text: 'Hi' };

describe('values an expression can produce', () => {
	it('sends a number as text, and refuses digits without + instead of guessing a country', async () => {
		expect(body((await run({ ...TEXT, text: 4711 as unknown as string })).call).content).toEqual({
			text: '4711',
		});
		await expect(run({ ...TEXT, phoneNumber: 5511977770001 as unknown as string })).rejects.toThrow(
			/'Phone Number' is not a valid international number/,
		);
	});

	it('refuses an object in a text field and says how to fix it', async () => {
		await expect(run({ ...TEXT, text: { reply: 'Hi' } as unknown as string })).rejects.toThrow(
			/object or a list/,
		);
	});

	it.each([
		['off', false],
		['no', false],
		['yes', true],
		['TRUE', true],
		['false', false],
	])('reads the flag %j as %s', async (value, expected) => {
		const { call } = await run({ ...MESSAGE, operation: 'sendTypingIndicator', isTyping: value });
		expect(body(call).is_typing).toBe(expected);
	});

	it('refuses a flag it cannot read, naming the field', async () => {
		await expect(
			run({ ...MESSAGE, operation: 'sendTypingIndicator', isTyping: 'maybe' }),
		).rejects.toThrow(/'Typing' must be true or false/);
	});

	it.each([' ', true, []])('does not turn %j into a latitude of 0', async (latitude) => {
		await expect(
			run({
				...MESSAGE,
				operation: 'sendLocation',
				latitude: latitude as unknown as number,
				longitude: 10,
			}),
		).rejects.toThrow(/Latitude/);
	});

	it('names Recipient Type when it is none of the four', async () => {
		await expect(run({ ...TEXT, recipientType: 'Auto' })).rejects.toThrow(/'Recipient Type'/);
	});

	it('reads the filter flags of Get Many from text', async () => {
		const { call } = await run(
			{
				resource: 'contact',
				operation: 'getMany',
				number: 'main',
				returnAll: 'false',
				limit: 1,
				simplify: 'false',
				filters: { contactedInCycle: 'false' },
			},
			{ responses: [{ data: [{ id: CT, extra: 1 }], has_more: false }] },
		);
		expect(call.qs).toMatchObject({ contacted_in_cycle: false });
	});
});

describe('dates', () => {
	const event = (startAt: unknown): IDataObject => ({
		...MESSAGE,
		operation: 'sendCalendarEvent',
		eventName: 'Sync',
		startAt: startAt as IDataObject[string],
	});
	const start = async (startAt: unknown) =>
		(body((await run(event(startAt))).call).content as IDataObject).start_at;

	it.each([
		['an ISO date with an offset', '2026-11-03T14:00:00-03:00', '2026-11-03T17:00:00.000Z'],
		['milliseconds and Z', '2026-11-03T14:00:00.000Z', '2026-11-03T14:00:00.000Z'],
		['epoch milliseconds', Date.parse('2026-11-03T14:00:00Z'), '2026-11-03T14:00:00.000Z'],
		['a Luxon value', { toISO: () => '2026-11-03T14:00:00.000Z' }, '2026-11-03T14:00:00.000Z'],
		['a Date', new Date('2026-11-03T14:00:00Z'), '2026-11-03T14:00:00.000Z'],
	])('accepts %s', async (_name, value, expected) => {
		expect(await start(value)).toBe(expected);
	});

	it.each(['03/11/2026 14:00', '1', 1798765432, 'tomorrow', ''])(
		'refuses %j instead of reading another date',
		async (value) => {
			await expect(run(event(value))).rejects.toThrow(/'Start Time' is not a valid date and time/);
		},
	);

	it('sets the reminder from minutes, and none when it is left out', async () => {
		const withReminder = await run({
			...event('2026-11-03T14:00:00Z'),
			additionalFields: { remindBeforeMinutes: 30 },
		});
		const without = await run(event('2026-11-03T14:00:00Z'));
		expect(body(withReminder.call).content).toMatchObject({
			has_reminder: true,
			reminder_offset_sec: 1800,
		});
		expect(body(without.call).content).not.toHaveProperty('has_reminder');
	});
});

describe('lists from an earlier node', () => {
	const card = (extra: IDataObject) => ({
		...MESSAGE,
		operation: 'sendContactCard',
		displayName: 'Maria',
		...extra,
	});

	it('takes phones from JSON mode: an array, JSON text, one value or a cell with several', async () => {
		const phones = async (phonesJson: unknown) =>
			(
				(
					body(
						(
							await run(
								card({ phonesInput: 'json', phonesJson: phonesJson as IDataObject[string] }),
							)
						).call,
					).content as IDataObject
				).phones as IDataObject[]
			).map((p) => p.number);
		expect(await phones(['+5511977770002', { number: '+5511977770003', label: 'Work' }])).toEqual([
			'+5511977770002',
			'+5511977770003',
		]);
		expect(await phones('["+5511977770002"]')).toEqual(['+5511977770002']);
		expect(await phones('+5511977770002')).toEqual(['+5511977770002']);
		expect(await phones('+5511977770002; +5511977770003')).toEqual([
			'+5511977770002',
			'+5511977770003',
		]);
	});

	it('refuses JSON mode with nothing in it', async () => {
		await expect(run(card({ phonesInput: 'json', phonesJson: '' }))).rejects.toThrow(
			/'Phones' is empty/,
		);
	});

	it('takes emails from an array or JSON text', async () => {
		const { call } = await run(
			card({
				phones: { phoneValues: [{ number: PHONE }] },
				additionalFields: { emailsJson: '["maria@example.com"]' },
			}),
		);
		expect(body(call).content).toMatchObject({ emails: [{ address: 'maria@example.com' }] });
	});
});

describe('pickers hand over their plain value', () => {
	it('a contact or group picked from a list, or typed, reaches the request the same way', async () => {
		const picked = await run({
			...TEXT,
			recipientType: 'contact',
			contactId: { __rl: true, mode: 'list', value: CT },
		});
		const typed = await run({ ...TEXT, recipientType: 'contact', contactId: CT });
		expect(body(picked.call).to).toEqual({ contact_id: CT });
		expect(body(typed.call).to).toEqual({ contact_id: CT });
	});
});

describe('every item uses its own values', () => {
	it('sends each row to its own recipient with its own text', async () => {
		const { calls } = await run(
			[
				{ ...TEXT, phoneNumber: '+5511977770001', text: 'one' },
				{ ...TEXT, phoneNumber: '+5511977770002', text: 'two' },
			],
			{ items: [{ json: {} }, { json: {} }], responses: [ACCEPTED, ACCEPTED] },
		);
		expect(calls.map((c) => body(c))).toEqual([
			{ to: { number: '+5511977770001' }, content: { text: 'one' } },
			{ to: { number: '+5511977770002' }, content: { text: 'two' } },
		]);
	});
});

describe('what the next node receives', () => {
	it('a send returns the API answer with id, the number used and the recipient', async () => {
		const { json } = await run(TEXT);
		expect(json).toEqual({
			id: MSG,
			status: ACCEPTED.status,
			number_alias: 'main',
			to: { number: PHONE },
		});
	});

	it('names a number given as a num_ ID number_id', async () => {
		const id = 'num_0a1b2c3d4e5f60718293a4b5c6d7e8f9';
		const { json } = await run({ ...TEXT, number: id });
		expect(json).toMatchObject({ number_id: id });
		expect(json).not.toHaveProperty('number_alias');
	});

	it('every output item points at the input item it came from', async () => {
		const { result } = await run([TEXT, TEXT], {
			items: [{ json: {} }, { json: {} }],
			responses: [ACCEPTED, ACCEPTED],
		});
		expect(result[0]?.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
	});

	it('refuses a request that names no existing operation', async () => {
		const { context } = makeExecuteContext({
			params: { resource: 'message', operation: 'nope', number: 'main' },
		});
		await expect(node.execute.call(context)).rejects.toThrow(
			/'nope' is not available for 'message'/,
		);
	});
});
