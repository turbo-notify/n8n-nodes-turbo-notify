import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	IPollFunctions,
} from 'n8n-workflow';

export const BASE = 'https://api.turbonotify.com';
export const API = `${BASE}/v1`;

export const NODE: INode = {
	id: 'node-1',
	name: 'Turbo Notify',
	type: 'n8n-nodes-turbo-notify.turboNotify',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

type Params = IDataObject | IDataObject[];

export interface MockOptions {
	params: Params;
	items?: INodeExecutionData[];
	responses?: unknown[];
	failWith?: unknown;
	continueOnFail?: boolean;
	baseUrl?: string;
	staticData?: IDataObject;
	mode?: 'manual' | 'trigger';
}

function paramLookup(params: Params, name: string, index: number, fallback: unknown): unknown {
	const source = Array.isArray(params) ? (params[index] ?? {}) : params;
	const value = source[name];
	return value === undefined ? fallback : value;
}

export function makeExecuteContext(options: MockOptions) {
	const request = jest.fn();
	for (const response of options.responses ?? []) {
		request.mockResolvedValueOnce(response);
	}
	if (options.failWith !== undefined) {
		request.mockRejectedValue(options.failWith);
	} else {
		request.mockResolvedValue({});
	}
	const items = options.items ?? [{ json: {} }];
	const context = {
		getInputData: () => items,
		getNode: () => NODE,
		getNodeParameter: (name: string, index: number, fallback?: unknown) =>
			paramLookup(options.params, name, index, fallback),
		getCredentials: async () => ({
			apiKey: 'tn_live_test_key',
			baseUrl: options.baseUrl ?? BASE,
		}),
		continueOnFail: () => options.continueOnFail ?? false,
		helpers: { httpRequestWithAuthentication: request },
	};
	return { context: context as unknown as IExecuteFunctions, request };
}

export function makePollContext(options: MockOptions) {
	const request = jest.fn();
	for (const response of options.responses ?? []) {
		request.mockResolvedValueOnce(response);
	}
	request.mockResolvedValue({ object: 'list', data: [], has_more: false });
	const staticData = options.staticData ?? {};
	const context = {
		getNode: () => NODE,
		getMode: () => options.mode ?? 'trigger',
		getNodeParameter: (name: string, fallback?: unknown) =>
			paramLookup(options.params, name, 0, fallback),
		getCredentials: async () => ({
			apiKey: 'tn_live_test_key',
			baseUrl: options.baseUrl ?? BASE,
		}),
		getWorkflowStaticData: () => staticData,
		helpers: {
			httpRequestWithAuthentication: request,
			returnJsonArray: (data: IDataObject | IDataObject[]) =>
				(Array.isArray(data) ? data : [data]).map((json) => ({ json })),
		},
	};
	return { context: context as unknown as IPollFunctions, request, staticData };
}

export function apiError(status: number, body: IDataObject, headers: IDataObject = {}) {
	return Object.assign(new Error(`Request failed with status code ${status}`), {
		httpCode: String(status),
		response: { status, data: body, headers },
	});
}

export const MSG = 'msg_0198d3c5a1b24d3e9f01a2b3c4d5e6f7';
export const CT = 'ct_0198d3c5a1b24d3e9f01a2b3c4d5e6f7';
export const GRP = 'grp_e442553a56b14e2695f6acfd7d651b1a';
export const PHONE = '+5511977770001';

export const ACCEPTED = {
	message_id: MSG,
	status: { state: 'pending', at: '2026-10-28T10:00:00Z', error: null },
};
