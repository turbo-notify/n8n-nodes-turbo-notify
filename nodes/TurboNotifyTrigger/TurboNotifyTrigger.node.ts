import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { apiRequest } from '../TurboNotify/GenericFunctions';

interface EventList {
	data?: IDataObject[];
	has_more?: boolean;
}

interface PollState {
	initialized?: boolean;
	filterKey?: string;
	lastEventId?: string;
	lastCreatedAt?: string;
}

const PAGE = 100;
const MAX_PAGES = 50;
const MAX_EVENT_TYPES = 20;

const createdGte = (state: PollState): IDataObject =>
	state.lastCreatedAt ? { 'created[gte]': state.lastCreatedAt } : {};

export class TurboNotifyTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Turbo Notify Trigger',
		name: 'turboNotifyTrigger',
		icon: { light: 'file:turboNotify.svg', dark: 'file:turboNotify.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts a workflow when Turbo Notify records a WhatsApp event, such as a received message',
		defaults: { name: 'Turbo Notify Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'turboNotifyApi', required: true }],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['message.received'],
				description: 'Which events start the workflow. Choose Poll Times to set how often n8n checks.',
				options: [
					{ name: 'Contact First Messaged', value: 'contact.first_messaged', description: 'A contact was messaged for the first time' },
					{ name: 'Message Calendar Response', value: 'message.calendar_responded', description: 'A guest answered a calendar event' },
					{ name: 'Message Deleted', value: 'message.deleted', description: 'A message was deleted' },
					{ name: 'Message Delivered', value: 'message.delivered', description: 'A message you sent reached the recipient' },
					{ name: 'Message Edited', value: 'message.edited', description: 'A message or caption was edited' },
					{ name: 'Message Reacted', value: 'message.reacted', description: 'A reaction was added or removed' },
					{ name: 'Message Read', value: 'message.read', description: 'The recipient read a message you sent' },
					{ name: 'Message Received', value: 'message.received', description: 'A message arrived from a contact' },
					{ name: 'Message Replied', value: 'message.replied', description: 'A reply was sent or received' },
					{ name: 'Message Send Failed', value: 'message.send.failed', description: 'A message could not be sent' },
					{ name: 'Message Sent', value: 'message.sent', description: 'A message was sent to WhatsApp' },
					{ name: 'Number Connected', value: 'number.connected', description: 'A number connected to WhatsApp' },
					{ name: 'Number Disconnected', value: 'number.disconnected', description: 'A number stayed disconnected beyond the reconnection window' },
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Number Alias',
						name: 'numberAlias',
						type: 'string',
						default: '',
						placeholder: 'e.g. main',
						description: 'Only events of this number. Leave empty for every number of the organization.',
					},
				],
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const events = (this.getNodeParameter('events', []) as string[]) ?? [];
		if (events.length < 1 || events.length > MAX_EVENT_TYPES) {
			throw new NodeOperationError(this.getNode(), "'Events' needs 1 to 20 event types", {
				description: 'Choose at least one event for the trigger to listen to.',
			});
		}
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const numberAlias = typeof options.numberAlias === 'string' ? options.numberAlias.trim() : '';

		const filter: IDataObject = { types: events };
		if (numberAlias) filter.number_alias = numberAlias;
		const filterKey = `${[...events].sort().join(',')}|${numberAlias}`;

		const list = (qs: IDataObject): Promise<EventList> =>
			apiRequest(this, { method: 'GET', path: '/events', qs: { ...filter, ...qs }, arrayFormat: 'brackets' }) as Promise<EventList>;

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
			const latest = (await list({ limit: 1 })).data?.[0];
			state.initialized = true;
			state.filterKey = filterKey;
			state.lastEventId = typeof latest?.id === 'string' ? latest.id : undefined;
			state.lastCreatedAt = typeof latest?.created_at === 'string' ? latest.created_at : undefined;
			return null;
		}

		const fresh: IDataObject[] = [];
		let page = await list({
			limit: PAGE,
			...(state.lastEventId ? { ending_before: state.lastEventId } : {}),
			...createdGte(state),
		});
		for (let n = 0; n < MAX_PAGES; n++) {
			const rows = page.data ?? [];
			const reached = state.lastEventId ? rows.findIndex((e) => e.id === state.lastEventId) : -1;
			fresh.push(...(reached >= 0 ? rows.slice(0, reached) : rows));
			const last = rows[rows.length - 1];
			if (reached >= 0 || rows.length < PAGE || !last || typeof last.id !== 'string') break;
			page = await list({ limit: PAGE, starting_after: last.id, ...createdGte(state) });
		}

		if (fresh.length === 0) return null;

		const newest = fresh[0] as IDataObject;
		state.lastEventId = String(newest.id);
		state.lastCreatedAt = String(newest.created_at ?? state.lastCreatedAt ?? '');
		return [this.helpers.returnJsonArray(fresh.reverse())];
	}
}
