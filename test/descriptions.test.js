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
