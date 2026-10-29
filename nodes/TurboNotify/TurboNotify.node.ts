import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { handlers, type Run } from './actions';
import { properties } from './descriptions';
import { searchContacts, searchGroups, searchNumbers } from './methods/listSearch';
import { CREDENTIAL } from './transport/context';
import { requireText, type Scope } from './validation';

export class TurboNotify implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Turbo Notify',
		name: 'turboNotify',
		icon: { light: 'file:turboNotify.svg', dark: 'file:turboNotify.svg' },
		group: ['output'],
		version: 1,
		subtitle:
			'={{ $parameter["operation"].replace(/([A-Z])/g, " $1").toLowerCase() + ": " + $parameter["resource"] }}',
		description:
			'Send WhatsApp messages and read contacts, groups, numbers and events with Turbo Notify',
		defaults: { name: 'Turbo Notify' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		properties,
	};

	methods = { listSearch: { searchNumbers, searchContacts, searchGroups } };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		// Keys typed in this run, shared by every item, so one key cannot stand for two messages.
		const keys = new Map<string, string>();

		// What went wrong is already a NodeApiError or NodeOperationError with the item index and a hint.
		// Anything else gets wrapped.
		const asNodeError = (caught: unknown, i: number) =>
			caught instanceof NodeApiError || caught instanceof NodeOperationError
				? caught
				: new NodeOperationError(this.getNode(), caught as Error, { itemIndex: i });

		const prepare = (i: number): Run => {
			const resource = this.getNodeParameter('resource', i) as string;
			const operation = this.getNodeParameter('operation', i) as string;
			const handler = handlers[resource]?.[operation];
			if (!handler) {
				throw new NodeOperationError(
					this.getNode(),
					`'${operation}' is not available for '${resource}'`,
					{ itemIndex: i },
				);
			}
			const scope: Scope = { node: this.getNode(), itemIndex: i, items: items.length, keys };
			const needsNumber =
				resource !== 'event' && !(resource === 'number' && operation === 'getMany');
			const ref = needsNumber
				? requireText(
						scope,
						this.getNodeParameter('number', i, 'main', { extractValue: true }),
						'Number',
						100,
					)
				: 'main';
			return handler(this, i, ref, scope);
		};

		const collect = async (run: Run, i: number) => {
			const output = await run();
			for (const json of Array.isArray(output) ? output : [output]) {
				returnData.push({ json, pairedItem: { item: i } });
			}
		};

		if (this.continueOnFail()) {
			for (let i = 0; i < items.length; i++) {
				try {
					await collect(prepare(i), i);
				} catch (caught) {
					const failure = asNodeError(caught, i);
					const json = failure.description
						? { error: failure.message, hint: failure.description }
						: { error: failure.message };
					returnData.push({ json, pairedItem: { item: i } });
				}
			}
			return [returnData];
		}

		// Every item is read and checked before the first request leaves, so one bad row
		// stops the run before any message is sent.
		const runs: Run[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				runs.push(prepare(i));
			} catch (caught) {
				throw asNodeError(caught, i);
			}
		}
		for (let i = 0; i < runs.length; i++) {
			try {
				await collect(runs[i] as Run, i);
			} catch (caught) {
				throw asNodeError(caught, i);
			}
		}
		return [returnData];
	}
}
