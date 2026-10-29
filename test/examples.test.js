// Plain JavaScript on purpose: these contract tests read the package files, which the community node
// lint rules (strict mode) do not allow in TypeScript sources.
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { TurboNotify } = require('../nodes/TurboNotify/TurboNotify.node');
const { TurboNotifyTrigger } = require('../nodes/TurboNotifyTrigger/TurboNotifyTrigger.node');
const {
	TurboNotifyPollingTrigger,
} = require('../nodes/TurboNotifyPollingTrigger/TurboNotifyPollingTrigger.node');

const dir = join(__dirname, '..', 'examples');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

const action = new TurboNotify().description.properties;
const instantTrigger = new TurboNotifyTrigger().description.properties;
const pollingTrigger = new TurboNotifyPollingTrigger().description.properties;

const names = (props) => new Set(props.map((p) => p.name));
const TYPE = '@turbo-notify/n8n-nodes-turbo-notify';

describe('example workflows use real parameters of the nodes', () => {
	it('finds the examples', () => expect(files.length).toBeGreaterThanOrEqual(4));

	it.each(files)('%s', (file) => {
		const workflow = JSON.parse(readFileSync(join(dir, file), 'utf8'));
		for (const node of workflow.nodes) {
			if (node.type === `${TYPE}.turboNotify`) {
				for (const key of Object.keys(node.parameters)) expect(names(action)).toContain(key);
				const operations = action
					.filter(
						(p) =>
							p.name === 'operation' &&
							p.displayOptions.show.resource.includes(node.parameters.resource),
					)
					.flatMap((p) => (p.options ?? []).map((o) => o.value));
				expect(operations).toContain(node.parameters.operation);
			}
			if (node.type === `${TYPE}.turboNotifyTrigger`) {
				for (const key of Object.keys(node.parameters))
					expect(names(instantTrigger)).toContain(key);
			}
			if (node.type === `${TYPE}.turboNotifyPollingTrigger`) {
				for (const key of Object.keys(node.parameters))
					if (key !== 'pollTimes') expect(names(pollingTrigger)).toContain(key);
			}
		}
		const nodeNames = workflow.nodes.map((n) => n.name);
		for (const from of Object.keys(workflow.connections)) expect(nodeNames).toContain(from);
	});
});
