// Plain JavaScript on purpose, see examples.test.js.
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { handlers } = require('../nodes/TurboNotify/actions');
const { EVENT_OPTIONS } = require('../nodes/TurboNotify/events');
const { properties } = require('../nodes/TurboNotify/descriptions');

const operationsOf = (resource) =>
	properties
		.filter((p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes(resource))
		.flatMap((p) => (p.options ?? []).map((o) => o.value));

describe('the editor and the code describe the same node', () => {
	const resources = properties.find((p) => p.name === 'resource').options.map((o) => o.value);

	it.each(resources)(
		'%s: every operation has a handler and every handler an operation',
		(resource) => {
			expect(Object.keys(handlers[resource] ?? {}).sort()).toEqual(operationsOf(resource).sort());
		},
	);

	it('every parameter a handler reads is a property of the node', () => {
		const dir = join(__dirname, '..', 'nodes', 'TurboNotify', 'actions');
		const known = new Set(properties.map((p) => p.name));
		for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
			const text = readFileSync(join(dir, file), 'utf8');
			for (const match of text.matchAll(/(?:param|locator)(?:<[^>]*>)?\(context, '([A-Za-z]+)'/g)) {
				expect({ file, parameter: match[1], known: known.has(match[1]) }).toEqual({
					file,
					parameter: match[1],
					known: true,
				});
			}
		}
	});

	it('lists each event type once, in alphabetical order of its name', () => {
		const values = EVENT_OPTIONS.map((o) => o.value);
		expect(new Set(values).size).toBe(values.length);
		const labels = EVENT_OPTIONS.map((o) => o.name);
		expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
	});

	it('every property name is camelCase', () => {
		for (const p of properties) expect(p.name).toMatch(/^[a-z][A-Za-z]*$/);
	});
});

describe('optional fields are not at the top level of a node (n8n review, 2026-11-12)', () => {
	const { TurboNotifyTrigger } = require('../nodes/TurboNotifyTrigger/TurboNotifyTrigger.node');
	const {
		TurboNotifyPollingTrigger,
	} = require('../nodes/TurboNotifyPollingTrigger/TurboNotifyPollingTrigger.node');
	const names = (props) => props.map((p) => p.name);
	const inOptions = (props) => props.find((p) => p.name === 'options').options.map((o) => o.name);

	it('Send Media: Caption and File Name sit in Additional Fields', () => {
		const forMedia = (p) => p.displayOptions?.show?.operation?.includes('sendMedia');
		const topLevel = properties.filter(
			(p) => forMedia(p) && p.type !== 'collection' && ['caption', 'fileName'].includes(p.name),
		);
		expect(topLevel).toEqual([]);
		const fields = properties.find((p) => p.name === 'additionalFields' && forMedia(p));
		expect(fields.options.map((o) => o.name)).toEqual(['caption', 'fileName', 'quotedMessageId']);
	});

	it('the webhook trigger: Number and Verify Signature sit in Options', () => {
		const props = new TurboNotifyTrigger().description.properties;
		expect(names(props)).toEqual(['events', 'options']);
		expect(inOptions(props)).toEqual(['ignoreDuplicates', 'number', 'verifySignature']);
	});

	it('the polling trigger: Number sits in Options', () => {
		const props = new TurboNotifyPollingTrigger().description.properties;
		expect(names(props)).toEqual(['events', 'options']);
		expect(inOptions(props)).toEqual(['number']);
	});
});

describe('the setup text left the trigger form and lives in the README (n8n review, 2026-11-12)', () => {
	it('holds the steps, the Webhook URLs hint and the plan requirement', () => {
		const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
		for (const text of [
			'Production URL',
			'Test URL',
			'Webhook URLs',
			'Lone Wolf plan or higher',
			'Free plan',
		]) {
			expect(readme).toContain(text);
		}
	});
});

describe('no form text states a plan requirement (n8n review, 2026-11-12)', () => {
	const { TurboNotifyTrigger } = require('../nodes/TurboNotifyTrigger/TurboNotifyTrigger.node');
	const {
		TurboNotifyPollingTrigger,
	} = require('../nodes/TurboNotifyPollingTrigger/TurboNotifyPollingTrigger.node');
	const { TurboNotifyApi } = require('../credentials/TurboNotifyApi.credentials');

	const texts = (props) =>
		props.flatMap((p) => [p.displayName, p.description, p.hint, ...texts(p.options ?? [])]);

	it('the Turbo Notify node, both triggers and the credential never say "Lone Wolf" or "Free plan"', () => {
		const all = [
			...texts(properties),
			...texts(new TurboNotifyTrigger().description.properties),
			...texts(new TurboNotifyPollingTrigger().description.properties),
			...texts(new TurboNotifyApi().properties),
		].filter((t) => typeof t === 'string');
		for (const text of all) expect(text).not.toMatch(/Lone Wolf|Free plan/);
	});

	it('the README keeps the typing indicator requirement', () => {
		const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
		expect(readme).toMatch(/Send Typing Indicator \|[^|]*Needs the Lone Wolf plan or higher/);
	});
});

describe('the nodes are found by searching for WhatsApp', () => {
	const { TurboNotify } = require('../nodes/TurboNotify/TurboNotify.node');
	const { TurboNotifyTrigger } = require('../nodes/TurboNotifyTrigger/TurboNotifyTrigger.node');
	const {
		TurboNotifyPollingTrigger,
	} = require('../nodes/TurboNotifyPollingTrigger/TurboNotifyPollingTrigger.node');

	const nodes = [
		[new TurboNotify().description, 'WhatsApp by Turbo Notify'],
		[new TurboNotifyTrigger().description, 'WhatsApp by Turbo Notify Trigger'],
		[new TurboNotifyPollingTrigger().description, 'WhatsApp by Turbo Notify Polling Trigger'],
	];

	it.each(nodes)('%# says WhatsApp in its name, the catalog label n8n.io searches', (d, name) => {
		expect(d.displayName).toBe(name);
		expect(d.defaults.name).toBe(name);
	});

	it('keeps the node types, so a workflow that already uses them keeps working', () => {
		expect(nodes.map(([d]) => d.name)).toEqual([
			'turboNotify',
			'turboNotifyTrigger',
			'turboNotifyPollingTrigger',
		]);
	});

	it('keeps the instant trigger grouped with the action node (same label without "Trigger")', () => {
		expect(nodes[1][0].displayName.replace(/ Trigger$/, '')).toBe(nodes[0][0].displayName);
	});

	it.each(nodes)('%# starts its name with WhatsApp, the first word the editor ranks', (d) => {
		expect(d.displayName.startsWith('WhatsApp')).toBe(true);
	});

	it('names the polling trigger like the action plus "Polling Trigger"', () => {
		expect(nodes[2][0].displayName).toBe(`${nodes[0][0].displayName} Polling Trigger`);
	});

	// The editor searches only displayName and each string of the codex alias list, and a query has to be
	// an in-order subsequence of ONE field, so a two-word query needs an alias that holds both words.
	const ALIASES = {
		TurboNotify: [
			'whatsapp',
			'whatsapp send',
			'whatsapp message',
			'send whatsapp message',
			'whatsapp calendar',
			'whatsapp automation',
			'whatsapp notifications',
			'whatsapp by turbo notify',
			'turbo notify whatsapp',
		],
		TurboNotifyTrigger: [
			'whatsapp',
			'whatsapp incoming message',
			'whatsapp message received',
			'whatsapp webhook',
			'whatsapp events',
			'whatsapp by turbo notify',
			'turbo notify whatsapp',
		],
		TurboNotifyPollingTrigger: [
			'whatsapp',
			'whatsapp incoming message',
			'whatsapp message received',
			'whatsapp events',
			'whatsapp polling',
			'whatsapp by turbo notify',
			'turbo notify whatsapp',
		],
	};
	const OTHER_BRANDS = ['meta', 'twilio', 'facebook', 'zapier', 'make', 'vonage', 'messagebird'];

	describe.each(Object.entries(ALIASES))('%s codex aliases', (dir, required) => {
		const codex = JSON.parse(
			readFileSync(join(__dirname, '..', 'nodes', dir, `${dir}.node.json`), 'utf8'),
		);

		it('keep whatsapp and the multi-word phrases people type', () => {
			for (const alias of required) expect(codex.alias).toContain(alias);
		});

		it('are single lowercase strings, never another brand, never the Business Platform API', () => {
			for (const alias of codex.alias) {
				expect(typeof alias).toBe('string');
				expect(alias).toBe(alias.toLowerCase());
				const words = alias.split(/\s+/);
				for (const brand of OTHER_BRANDS) expect(words).not.toContain(brand);
				expect(alias).not.toMatch(/business (platform|api)|cloud api/);
			}
			expect(new Set(codex.alias).size).toBe(codex.alias.length);
		});
	});
});
