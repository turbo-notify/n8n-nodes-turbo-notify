// Plain JavaScript on purpose: these contract tests read the template files, which the community node lint
// rules (strict mode) do not allow in TypeScript sources.
//
// They apply the rules of the n8n template library (docs.n8n.io/contribute/create-templates) to every folder
// of templates/ that holds a workflow.json, so a template cannot be committed in a shape n8n would refuse.
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..', 'templates');
const folders = existsSync(root)
	? readdirSync(root).filter(
			(name) =>
				name !== 'harness' &&
				statSync(join(root, name)).isDirectory() &&
				existsSync(join(root, name, 'workflow.json')),
		)
	: [];

const TYPE = '@turbo-notify/n8n-nodes-turbo-notify';
const DEFAULT_NAMES = new Set([
	'Turbo Notify WhatsApp',
	'Turbo Notify WhatsApp Trigger',
	'Turbo Notify WhatsApp Polling Trigger',
	'Edit Fields',
	'If',
	'Switch',
	'Code',
	'HTTP Request',
	'Loop Over Items',
	'Schedule Trigger',
	'Wait',
	'Merge',
	'Filter',
	'Set',
	'No Operation, do nothing',
	'AI Agent',
	'Data table',
	'Data Table',
	'When clicking Test workflow',
	"When clicking 'Execute workflow'",
	'On form submission',
]);
const words = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

describe('workflow templates follow the n8n library rules', () => {
	it('finds at least the folders that are ready', () => {
		expect(Array.isArray(folders)).toBe(true);
	});

	describe.each(folders)('%s', (slug) => {
		const dir = join(root, slug);
		const raw = readFileSync(join(dir, 'workflow.json'), 'utf8');
		const workflow = JSON.parse(raw);
		const nodes = workflow.nodes;
		const stickies = nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote');
		const working = nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
		const overviews = stickies.filter((n) => /###\s+How it works/.test(n.parameters?.content ?? ''));

		it('is a workflow with a name that says WhatsApp and Turbo Notify', () => {
			expect(workflow.name).toMatch(/WhatsApp/);
			expect(workflow.name).toMatch(/Turbo Notify/);
		});

		it('uses the Turbo Notify nodes and names the package with the tested version', () => {
			expect(working.some((n) => String(n.type).startsWith(`${TYPE}.`))).toBe(true);
			const note = overviews[0]?.parameters.content ?? '';
			expect(note).toContain(TYPE);
			expect(note).toMatch(/\b1\.\d+\.\d+\b/);
		});

		it('has exactly one yellow overview note of 100 to 300 words with the required headings', () => {
			expect(overviews).toHaveLength(1);
			const [overview] = overviews;
			const content = overview.parameters.content;
			expect(words(content)).toBeGreaterThanOrEqual(100);
			expect(words(content)).toBeLessThanOrEqual(300);
			expect(content).toMatch(/###\s+How it works/);
			expect(content).toMatch(/###\s+Setup/);
			// n8n stores yellow as colour 1 and as no value at all.
			expect([undefined, 1]).toContain(overview.parameters.color);
		});

		it('puts the overview note in the top-left corner of the canvas', () => {
			const [overview] = overviews;
			const minX = Math.min(...nodes.map((n) => n.position[0]));
			const minY = Math.min(...nodes.map((n) => n.position[1]));
			expect(overview.position[0]).toBeLessThanOrEqual(minX + 40);
			expect(overview.position[1]).toBeLessThanOrEqual(minY + 40);
		});

		it('has white section notes of under 50 words when it has four or more nodes', () => {
			if (working.length < 4) return;
			const sections = stickies.filter((n) => !overviews.includes(n) && /^##\s/m.test(n.parameters?.content ?? ''));
			expect(sections.length).toBeGreaterThanOrEqual(2);
			for (const note of sections) expect(words(note.parameters.content)).toBeLessThan(50);
		});

		it('gives every node a descriptive name, not the default one', () => {
			const defaults = working.filter((n) => DEFAULT_NAMES.has(n.name)).map((n) => n.name);
			expect(defaults).toEqual([]);
			expect(new Set(nodes.map((n) => n.name)).size).toBe(nodes.length);
		});

		it('groups what a person must change in an Edit Fields (Set) node', () => {
			expect(working.some((n) => n.type === 'n8n-nodes-base.set')).toBe(true);
		});

		it('has no pinned data, no secrets and no private identifiers', () => {
			expect(workflow.pinData ?? {}).toEqual({});
			expect(raw).not.toMatch(/tn_(live|test)_/i);
			expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
			expect(raw).not.toMatch(/https?:\/\/[^"\s]*(ngrok|localhost|127\.0\.0\.1)/i);
			expect(raw).not.toMatch(/[\w.+-]+@(?!example\.(com|org)|turbonotify\.com)[\w-]+\.[a-z]{2,}/i);
		});

		it('uses only the fictitious phone numbers of the project', () => {
			const phones = raw.match(/\+?\d{12,13}/g) ?? [];
			for (const phone of phones) expect(phone.replace('+', '')).toMatch(/^55119777700\d\d$/);
		});

		it('keeps the credential as a placeholder', () => {
			for (const node of working) {
				for (const credential of Object.values(node.credentials ?? {})) {
					expect(String(credential.id ?? '')).not.toMatch(/^[A-Za-z0-9]{16}$/);
				}
			}
		});

		it('never leaves a public form that sends WhatsApp messages without authentication', () => {
			for (const node of nodes.filter((n) => n.type === 'n8n-nodes-base.formTrigger')) {
				expect({ name: node.name, authentication: node.parameters.authentication }).toEqual({
					name: node.name,
					authentication: 'basicAuth',
				});
			}
		});

		it('has no em or en dash', () => {
			for (const file of ['workflow.json', 'README.md']) {
				expect(readFileSync(join(dir, file), 'utf8')).not.toMatch(new RegExp('[\\u2013\\u2014]'));
			}
		});

		it('has no invisible or bidirectional control characters', () => {
			// Zero-width, bidirectional and invisible formatting characters hide text from a reviewer. The class is
			// built from code points so that this source file holds none of them either.
			const ranges = [
				[0x200b, 0x200f],
				[0x202a, 0x202e],
				[0x2060, 0x206f],
				[0xfeff, 0xfeff],
			];
			const invisible = new RegExp(
				'[' + ranges.map(([from, to]) => String.fromCharCode(from) + '-' + String.fromCharCode(to)).join('') + ']',
				'g',
			);
			const hex = (match) => 'U+' + match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
			const texts = {
				'workflow.json': raw,
				'workflow.json (parsed)': JSON.stringify(workflow),
				'README.md': readFileSync(join(dir, 'README.md'), 'utf8'),
			};
			for (const [file, text] of Object.entries(texts)) {
				expect({ file, found: [...text.matchAll(invisible)].map(hex) }).toEqual({ file, found: [] });
			}
		});

		it('ships its README with the test record and its scenario', () => {
			const readme = readFileSync(join(dir, 'README.md'), 'utf8');
			expect(readme).toMatch(/Test record/i);
			expect(readme).toMatch(/2\.\d+\.\d+/);
			expect(existsSync(join(dir, 'test', 'scenario.mjs'))).toBe(true);
		});

		it('is connected: every working node is reachable from a trigger or a connection', () => {
			const connected = new Set(Object.keys(workflow.connections));
			for (const targets of Object.values(workflow.connections)) {
				for (const group of Object.values(targets)) {
					for (const list of group) for (const link of list ?? []) connected.add(link.node);
				}
			}
			for (const node of working) {
				if (node.disabled) continue;
				expect({ name: node.name, connected: connected.has(node.name) }).toEqual({
					name: node.name,
					connected: true,
				});
			}
		});
	});
});
