import type { IDataObject } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { MESSAGE, run } from './helpers';

const TEXT: IDataObject = { ...MESSAGE, operation: 'sendText', text: 'Hi' };

describe('Base URL', () => {
	it.each([
		['https://api.turbonotify.com/v1', 'https://api.turbonotify.com/v1/numbers/main/messages'],
		['https://api.turbonotify.com/', 'https://api.turbonotify.com/v1/numbers/main/messages'],
		['http://localhost:12000', 'http://localhost:12000/v1/numbers/main/messages'],
	])('accepts %s', async (baseUrl, url) => {
		expect((await run(TEXT, { baseUrl })).call.url).toBe(url);
	});

	it.each([
		'https://user:pass@api.turbonotify.com',
		'https://api.turbonotify.com?x=1',
		'ftp://api.turbonotify.com',
		'not a url',
		'',
	])('refuses %j', async (baseUrl) => {
		await expect(run(TEXT, { baseUrl })).rejects.toBeInstanceOf(NodeOperationError);
	});
});

describe('timeouts', () => {
	it('allows 30 seconds for a read and 60 for a write', async () => {
		expect((await run(TEXT)).call.timeout).toBe(60_000);
		expect(
			(await run({ resource: 'number', operation: 'getMany' }, { responses: [{ data: [] }] })).call
				.timeout,
		).toBe(30_000);
	});
});
