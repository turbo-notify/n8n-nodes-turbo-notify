import type {
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { optionalNumberProperty } from '../TurboNotify/descriptions/shared';
import { TRIGGER_EVENT_OPTIONS, chosenEventTypes } from '../TurboNotify/events';
import { searchNumbers } from '../TurboNotify/methods/listSearch';
import { CREDENTIAL } from '../TurboNotify/transport/context';
import { isGenuine } from './signature';

/** Event IDs kept to recognise a delivery that arrives twice (the API delivers at least once). */
const MAX_REMEMBERED = 500;

/** The secret is typed in the credential and in the dashboard; without it no delivery can be trusted. */
async function requireSecret(context: IHookFunctions | IWebhookFunctions): Promise<string> {
	const { webhookSecret } = await context.getCredentials(CREDENTIAL);
	const secret = String(webhookSecret ?? '').trim();
	if (secret === '') {
		throw new NodeOperationError(
			context.getNode(),
			"'Webhook Signing Secret' in the Turbo Notify API credential is empty",
			{
				description:
					'Type the secret you entered next to the webhook address in the Turbo Notify dashboard, or turn off Verify Signature to try things out.',
			},
		);
	}
	return secret;
}

export class TurboNotifyTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Turbo Notify Trigger',
		name: 'turboNotifyTrigger',
		icon: {
			light: 'file:../TurboNotify/turboNotify.svg',
			dark: 'file:../TurboNotify/turboNotify.svg',
		},
		group: ['trigger'],
		version: 1,
		subtitle:
			'={{ Array.isArray($parameter["events"]) && !$parameter["events"].includes("*") ? $parameter["events"].join(", ") : "any event" }}',
		// n8n groups this trigger with the Turbo Notify node (the name without "Trigger" is the same) and
		// gives the group the trigger's description: the node panel for "Turbo Notify" shows this text above
		// the list of actions. So it describes the whole app, and a test keeps it that way.
		description: 'Send, track and receive WhatsApp messages from your workflows',
		defaults: { name: 'Turbo Notify Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		webhooks: [
			{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'turbo-notify' },
		],
		properties: [
			{
				displayName:
					'Paste the Production URL under Webhooks in the Turbo Notify dashboard, with the secret from the credential. To try it first, paste the Test URL, select Listen for test event and send a message, then put the Production URL back and activate the workflow. The dashboard holds one address, so the other URL stops receiving while you test. Needs the Lone Wolf plan or higher. On the Free plan, use the Turbo Notify Polling Trigger.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: TRIGGER_EVENT_OPTIONS,
				default: ['message.received'],
				description: 'Which events start the workflow',
			},
			optionalNumberProperty('Only the events of this number. Leave empty for every number.'),
			{
				displayName: 'Verify Signature',
				name: 'verifySignature',
				type: 'boolean',
				default: true,
				description:
					'Whether to accept only deliveries signed with your secret. Turn it off only to try things out.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Ignore Duplicates',
						name: 'ignoreDuplicates',
						type: 'boolean',
						default: true,
						description:
							'Whether to skip an event that was already received. Turbo Notify delivers each event at least once, so one can arrive twice.',
					},
				],
			},
		],
	};

	methods = { listSearch: { searchNumbers } };

	// Turbo Notify has one webhook address per organization and no endpoint to register it: the person
	// pastes the URL under Webhooks in the dashboard. n8n registers its own URL, so there is nothing to
	// create or delete at Turbo Notify. What can be checked when the workflow is activated, or when
	// n8n starts listening for a test event, is that the secret is there.
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				if (this.getNodeParameter('verifySignature', true) as boolean) await requireSecret(this);
				return true;
			},
			async create(): Promise<boolean> {
				return true;
			},
			async delete(): Promise<boolean> {
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject();
		const response = this.getResponseObject();
		const body = this.getBodyData();

		if (this.getNodeParameter('verifySignature', true) as boolean) {
			const secret = await requireSecret(this);
			const headers = this.getHeaderData();
			const raw = (request as { rawBody?: Buffer | string }).rawBody;
			// The signature covers the exact bytes Turbo Notify sent (it escapes non-ASCII text), so a
			// body written again from the parsed JSON would not match. n8n always keeps the raw body.
			if (raw === undefined) {
				throw new NodeOperationError(
					this.getNode(),
					'n8n did not keep the raw body of the delivery',
					{
						description:
							'The signature cannot be checked without it. Turn off Verify Signature to try things out.',
					},
				);
			}
			const genuine = await isGenuine({
				secret,
				timestamp: headers['x-webhook-timestamp'] as string | undefined,
				signature: headers['x-webhook-signature'] as string | undefined,
				rawBody: raw.toString(),
			});
			if (!genuine) {
				response
					.status(401)
					.json({ message: 'The signature does not match the secret, or the delivery is too old' });
				return { noWebhookResponse: true };
			}
		}

		// A test run waits for one delivery and then stops listening: whatever arrives first is shown, so
		// the filters apply only to the live workflow.
		if (this.getMode() !== 'manual') {
			const chosen = chosenEventTypes(this.getNodeParameter('events', []));
			if (chosen.length > 0 && !chosen.includes(String(body.type))) {
				return { webhookResponse: 'Event ignored' };
			}
			const picked = this.getNodeParameter('number', '', { extractValue: true });
			const number = typeof picked === 'string' ? picked.trim() : '';
			if (number !== '' && body.number_alias !== number && body.number_id !== number) {
				return { webhookResponse: 'Event ignored' };
			}

			const options = this.getNodeParameter('options', {}) as { ignoreDuplicates?: boolean };
			if (options.ignoreDuplicates !== false && typeof body.id === 'string') {
				const memory = this.getWorkflowStaticData('node') as { received?: string[] };
				const received = memory.received ?? [];
				if (received.includes(body.id)) return { webhookResponse: 'Event already received' };
				memory.received = [body.id, ...received].slice(0, MAX_REMEMBERED);
			}
		}

		return { workflowData: [this.helpers.returnJsonArray(body)] };
	}
}
