import { TurboNotifyApi } from '../credentials/TurboNotifyApi.credentials';

describe('TurboNotifyApi credential', () => {
	const credential = new TurboNotifyApi();

	it('has the name the nodes reference', () => {
		expect(credential.name).toBe('turboNotifyApi');
		expect(credential.displayName).toBe('Turbo Notify API');
	});

	it('stores the API key as a password field and a default Base URL', () => {
		const apiKey = credential.properties.find((p) => p.name === 'apiKey');
		expect(apiKey?.typeOptions?.password).toBe(true);
		expect(apiKey?.required).toBe(true);
		const baseUrl = credential.properties.find((p) => p.name === 'baseUrl');
		expect(baseUrl?.default).toBe('https://api.turbonotify.com');
	});

	it('sends the key as a Bearer token and nowhere else', () => {
		expect(credential.authenticate).toEqual({
			type: 'generic',
			properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
		});
	});

	it('tests the key with GET /v1/usage (no scope needed)', () => {
		expect(credential.test.request).toMatchObject({
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "").replace(/\\/v1$/, "")}}',
			url: '/v1/usage',
			method: 'GET',
		});
	});

	it('also keeps the webhook signing secret, as a password the Trigger reads', () => {
		const secret = credential.properties.find((p) => p.name === 'webhookSecret');
		expect(secret?.typeOptions?.password).toBe(true);
		expect(secret?.required).toBeFalsy();
	});

	it('links to the API key documentation', () => {
		expect(credential.documentationUrl).toMatch(/^https:\/\/docs\.turbonotify\.com\//);
	});
});
