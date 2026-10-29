const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { TurboNotify } = require('../nodes/TurboNotify/TurboNotify.node');
const { TurboNotifyTrigger } = require('../nodes/TurboNotifyTrigger/TurboNotifyTrigger.node');

const dir = join(__dirname, '..', 'examples');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

const action = new TurboNotify().description.properties;
const trigger = new TurboNotifyTrigger().description.properties;

const names = (props) => new Set(props.map((p) => p.name));

describe('example workflows use real parameters of the nodes', () => {
	it('finds the examples', () => expect(files.length).toBeGreaterThanOrEqual(2));

	it.each(files)('%s', (file) => {
		const workflow = JSON.parse(readFileSync(join(dir, file), 'utf8'));
		for (const node of workflow.nodes) {
			if (node.type === '@turbo-notify/n8n-nodes-turbo-notify.turboNotify') {
				const known = names(action);
				for (const key of Object.keys(node.parameters)) expect(known).toContain(key);
				const resource = action.find((p) => p.name === 'resource');
				expect(resource?.options?.map((o) => o.value)).toContain(node.parameters.resource);
				const operations = action
					.filter((p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes(node.parameters.resource))
					.flatMap((p) => (p.options ?? []).map((o) => o.value));
				expect(operations).toContain(node.parameters.operation);
			}
			if (node.type === '@turbo-notify/n8n-nodes-turbo-notify.turboNotifyTrigger') {
				const known = names(trigger);
				for (const key of Object.keys(node.parameters)) {
					if (key !== 'pollTimes') expect(known).toContain(key);
				}
			}
		}
		const nodeNames = workflow.nodes.map((n) => n.name);
		for (const [from, wires] of Object.entries(workflow.connections)) {
			expect(nodeNames).toContain(from);
			expect(JSON.stringify(wires)).toBeDefined();
		}
	});
});
