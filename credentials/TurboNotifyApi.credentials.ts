import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class TurboNotifyApi implements ICredentialType {
	name = 'turboNotifyApi';

	displayName = 'Turbo Notify API';

	icon: Icon = {
		light: 'file:../nodes/TurboNotify/turboNotify.svg',
		dark: 'file:../nodes/TurboNotify/turboNotify.svg',
	};

	documentationUrl = 'https://docs.turbonotify.com/en/general/access-key/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Create it in the Turbo Notify dashboard, under API keys. The value is shown only once.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.turbonotify.com',
			description: 'Address of the Turbo Notify API. Change it only if support gave you another one.',
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
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/usage',
			method: 'GET',
		},
	};
}
