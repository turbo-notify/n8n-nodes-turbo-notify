import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';
import { USER_AGENT } from '../nodes/TurboNotify/transport/version';

export class TurboNotifyApi implements ICredentialType {
	name = 'turboNotifyApi';

	displayName = 'Turbo Notify API';

	icon: Icon = {
		light: 'file:../nodes/TurboNotify/turboNotify.svg',
		dark: 'file:../nodes/TurboNotify/turboNotify.svg',
	};

	documentationUrl = 'https://docs.turbonotify.com/en/guides/n8n/';

	properties: INodeProperties[] = [
		{
			// n8n draws a link inside a notice in the text colour with no underline, so it reads as plain text.
			// The step by step is reached through the underlined docs link n8n shows above the form (documentationUrl).
			displayName:
				'You need a Turbo Notify account, your WhatsApp number connected under Numbers, and an API key from API keys. The step by step is in the docs linked above.',
			name: 'notice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Create it in the Turbo Notify dashboard, under API keys (https://dashboard.turbonotify.com/api-keys). The value is shown only once.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.turbonotify.com',
			description:
				'Address of the Turbo Notify API. Change it only if support gave you another one.',
		},
		{
			displayName: 'Webhook Signing Secret',
			name: 'webhookSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Only for the WhatsApp by Turbo Notify Trigger. The secret you type next to the webhook address in the Turbo Notify dashboard: Turbo Notify does not generate one, so pick a long random value and enter it on both sides.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "").replace(/\\/v1$/, "")}}',
			url: '/v1/usage',
			method: 'GET',
			headers: { 'User-Agent': USER_AGENT },
		},
	};
}
