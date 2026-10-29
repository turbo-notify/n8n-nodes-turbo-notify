const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

describe('package contract for verified community nodes', () => {
	it('is named n8n-nodes-*', () =>
		expect(pkg.name).toMatch(/^(@[a-z0-9-]+\/)?n8n-nodes-[a-z0-9-]+$/));
	it('has the community package keyword', () =>
		expect(pkg.keywords).toContain('n8n-community-node-package'));
	it('is MIT licensed', () => {
		expect(pkg.license).toBe('MIT');
		expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toMatch(/MIT License/);
	});
	it('has a repository and no runtime dependencies', () => {
		expect(pkg.repository.url).toMatch(/github\.com\/.+\/n8n-nodes-turbo-notify/);
		expect(pkg.dependencies).toBeUndefined();
		expect(pkg.optionalDependencies).toBeUndefined();
		expect(pkg.bundledDependencies).toBeUndefined();
	});
	it('has no install-time scripts', () => {
		for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
			expect(pkg.scripts?.[hook]).toBeUndefined();
		}
	});
	it('publishes only dist and uses strict mode', () => {
		expect(pkg.files).toEqual(['dist']);
		expect(pkg.n8n.strict).toBe(true);
	});
	it('lists every node and credential source file', () => {
		const entries = [...pkg.n8n.nodes, ...pkg.n8n.credentials];
		expect(entries).toHaveLength(4);
		for (const entry of entries) {
			const source = entry.replace(/^dist\//, '').replace(/\.js$/, '.ts');
			expect(existsSync(join(root, source))).toBe(true);
		}
	});
	it('has the publish workflow with provenance permissions', () => {
		const workflow = readFileSync(join(root, '.github/workflows/publish.yml'), 'utf8');
		expect(workflow).toContain('id-token: write');
		expect(workflow).toContain('npm run release');
	});
});

describe('source rules from the verification guidelines', () => {
	const sources = [...walk(join(root, 'nodes')), ...walk(join(root, 'credentials'))].filter((f) =>
		f.endsWith('.ts'),
	);

	it('finds the sources', () => expect(sources.length).toBeGreaterThan(5));

	it.each(sources.map((f) => [f.replace(root + '/', ''), f]))(
		'%s has no env, file system or raw network access',
		(_n, file) => {
			const text = readFileSync(file, 'utf8');
			expect(text).not.toMatch(
				/process\.env|\bfrom\s+['"](node:)?(fs|http|https|net|child_process|os|path)['"]|require\(/,
			);
			expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest|axios/);
		},
	);

	it('only mentions turbonotify.com hosts as URLs', () => {
		for (const file of sources) {
			const urls = readFileSync(file, 'utf8').match(/https?:\/\/[^\s'"`)<>]+/g) ?? [];
			for (const url of urls) {
				expect(url).toMatch(
					/^https?:\/\/([a-z.]*turbonotify\.com|([a-z]+\.)?example\.com|api\.example\.test)/,
				);
			}
		}
	});

	it('every file of the package avoids em and en dashes', () => {
		const files = walk(root).filter(
			(f) => !f.endsWith('package-lock.json') && !/\.(png|ico)$/.test(f),
		);
		for (const file of files) {
			const text = readFileSync(file, 'utf8');
			expect({ file, bad: /[\u2013\u2014]/.test(text) }).toEqual({ file, bad: false });
		}
	});

	it('has the one icon every node and the credential point at', () => {
		expect(existsSync(join(root, 'nodes/TurboNotify/turboNotify.svg'))).toBe(true);
	});

	it('has a codex file next to each node', () => {
		for (const entry of pkg.n8n.nodes) {
			expect(existsSync(join(root, entry.replace(/^dist\//, '').replace(/\.js$/, '.json')))).toBe(
				true,
			);
		}
	});
});
