import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { apiRequest } from './GenericFunctions';
import { properties } from './descriptions';
import { handlers } from './operations';
import { requireText } from './validation';

interface NumberSummary {
	type?: string;
	alias?: string;
	number?: string;
	name?: string | null;
}

export class TurboNotify implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Turbo Notify',
		name: 'turboNotify',
		icon: { light: 'file:turboNotify.svg', dark: 'file:turboNotify.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Send WhatsApp messages and read contacts, groups and numbers with Turbo Notify',
		defaults: { name: 'Turbo Notify' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'turboNotifyApi', required: true }],
		properties,
	};

	methods = {
		listSearch: {
			async searchNumbers(this: ILoadOptionsFunctions): Promise<INodeListSearchResult> {
				const page = (await apiRequest(this, { method: 'GET', path: '/numbers' })) as { data?: NumberSummary[] };
				return {
					results: (page.data ?? []).map((n) => {
						const alias = n.alias ?? 'main';
						const label = `${alias} (+${n.number ?? ''})`;
						return { name: n.name ? `${n.name}: ${label}` : label, value: alias };
					}),
				};
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const handler = handlers[resource]?.[operation];
				if (!handler) {
					throw new NodeOperationError(this.getNode(), `'${operation}' is not available for '${resource}'`, { itemIndex: i });
				}
				const scope = { node: this.getNode(), itemIndex: i, items: items.length };
				const ref =
					resource === 'number'
						? 'main'
						: requireText(scope, this.getNodeParameter('number', i, 'main', { extractValue: true }), 'Number', 100);
				const output = await handler(this, i, ref, scope);
				for (const json of Array.isArray(output) ? output : [output]) {
					returnData.push({ json, pairedItem: { item: i } });
				}
			} catch (caught) {
				// Everything the node raises is already a NodeApiError or NodeOperationError
				// with the item index and a description. Anything else gets wrapped.
				const failure =
					caught instanceof NodeApiError || caught instanceof NodeOperationError
						? caught
						: new NodeOperationError(this.getNode(), caught as Error, { itemIndex: i });
				if (this.continueOnFail()) {
					returnData.push({ json: { error: failure.message }, pairedItem: { item: i } });
					continue;
				}
				throw failure;
			}
		}

		return [returnData];
	}
}
