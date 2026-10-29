import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { optionalNumberProperty } from '../TurboNotify/descriptions/shared';
import { MAX_EVENT_TYPES, TRIGGER_EVENT_OPTIONS, chosenEventTypes } from '../TurboNotify/events';
import { searchNumbers } from '../TurboNotify/methods/listSearch';
import { CREDENTIAL } from '../TurboNotify/transport/context';
import { apiRequest } from '../TurboNotify/transport/request';
import { type PollState, advance, sinceOf, start } from './pollState';

interface EventList {
	data?: IDataObject[];
	has_more?: boolean;
}

const PAGE = 100;
const MAX_PAGES = 50;

export class TurboNotifyPollingTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Turbo Notify Polling Trigger',
		name: 'turboNotifyPollingTrigger',
		icon: {
			light: 'file:../TurboNotify/turboNotify.svg',
			dark: 'file:../TurboNotify/turboNotify.svg',
		},
		group: ['trigger'],
		version: 1,
		subtitle:
			'={{ Array.isArray($parameter["events"]) && !$parameter["events"].includes("*") ? $parameter["events"].join(", ") : "any event" }}',
		description:
			'Starts a workflow when Turbo Notify records a WhatsApp event, checking at the interval you set, on every plan',
		defaults: { name: 'Turbo Notify Polling Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: TRIGGER_EVENT_OPTIONS,
				default: ['message.received'],
				description:
					"Which events start the workflow. Set 'Poll Times' below to choose how often n8n checks.",
			},
			optionalNumberProperty('Only the events of this number. Leave empty for every number.'),
		],
	};

	methods = { listSearch: { searchNumbers } };

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const chosen = this.getNodeParameter('events', []) as unknown;
		// An expression can give the events as a list or as text separated by commas.
		const types = chosenEventTypes(chosen);
		if (types.length > MAX_EVENT_TYPES) {
			throw new NodeOperationError(this.getNode(), "'Events' accepts up to 20 event types", {
				description: 'Choose fewer events, or leave the field empty to listen to every event.',
			});
		}
		const picked = this.getNodeParameter('number', '', { extractValue: true });
		const number = typeof picked === 'string' ? picked.trim() : '';

		const filter: IDataObject = {};
		if (types.length > 0) filter.types = types;
		// The alias can be renamed; the num_ ID cannot. Either one narrows the events to a number.
		if (/^num_[0-9a-f]{32}$/.test(number)) filter.number_id = number;
		else if (number) filter.number_alias = number;
		const filterKey = `${[...types].sort().join(',')}|${number}`;

		const list = (qs: IDataObject): Promise<EventList> =>
			apiRequest<EventList>(this, {
				method: 'GET',
				path: '/events',
				qs: { ...filter, ...qs },
				arrayFormat: 'brackets',
			});

		/** Every event created since `since`, newest first. */
		const window = async (since: string): Promise<IDataObject[]> => {
			const rows: IDataObject[] = [];
			let page = await list({ limit: PAGE, 'created[gte]': since });
			for (let n = 0; n < MAX_PAGES; n++) {
				const batch = page.data ?? [];
				rows.push(...batch);
				const last = batch[batch.length - 1];
				if (batch.length < PAGE || !last || typeof last.id !== 'string') break;
				page = await list({ limit: PAGE, starting_after: last.id, 'created[gte]': since });
			}
			return rows;
		};

		if (this.getMode() === 'manual') {
			const latest = (await list({ limit: 1 })).data ?? [];
			if (latest.length === 0) {
				throw new NodeOperationError(this.getNode(), 'No matching event was found yet', {
					description: 'Send or receive a message on the number, then run the step again.',
				});
			}
			return [this.helpers.returnJsonArray(latest)];
		}

		const state = this.getWorkflowStaticData('node') as PollState;

		if (!state.initialized || state.filterKey !== filterKey) {
			const newest = (await list({ limit: 1 })).data?.[0];
			const seen =
				typeof newest?.created_at === 'string' ? await window(sinceOf(newest.created_at)) : [];
			start(state, filterKey, newest, seen, new Date());
			return null;
		}

		const fresh = advance(
			state,
			await window(sinceOf(state.lastCreatedAt ?? new Date().toISOString())),
		);
		if (fresh.length === 0) return null;
		return [this.helpers.returnJsonArray(fresh.reverse())];
	}
}
