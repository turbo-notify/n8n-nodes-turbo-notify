/**
 * A throwaway n8n in Docker: start, talk to its REST API, remove.
 *
 * Only the container this module starts (name tn-harness-<runId>, label tn-harness) is ever
 * touched. Nothing here looks at other containers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deepClone, flattedParse, log, run, sleep, uuid, waitFor } from './util.mjs';

export const PACKAGE_DIR = '@turbo-notify/n8n-nodes-turbo-notify';

/** Node types whose production URL needs a webhookId when the workflow is imported through REST. */
const NEEDS_WEBHOOK_ID = new Set([
	'@turbo-notify/n8n-nodes-turbo-notify.turboNotifyTrigger',
	'n8n-nodes-base.webhook',
	'n8n-nodes-base.wait',
	'n8n-nodes-base.formTrigger',
	'n8n-nodes-base.form',
	'@n8n/n8n-nodes-langchain.chatTrigger',
]);

const FINISHED = new Set(['success', 'error', 'crashed', 'canceled']);

export class N8nInstance {
	constructor({ runId, port, image, home, containerName, mockPort, timezone, packageRoot }) {
		this.runId = runId;
		this.port = port;
		this.image = image;
		this.home = home;
		this.containerName = containerName;
		this.mockPort = mockPort;
		this.timezone = timezone;
		this.packageRoot = packageRoot;
		this.url = `http://127.0.0.1:${port}`;
		this.cookie = null;
		this.browserId = `harness-${runId}`;
		this.version = null;
		this.imageId = null;
		this.projectId = null;
		this.started = false;
	}

	/* ----------------------------------------------------------- lifecycle */

	setPort(port) {
		this.port = port;
		this.url = `http://127.0.0.1:${port}`;
	}

	/** Copies the built package to <home>/nodes/node_modules/<package> as an installed community package. */
	prepareHome() {
		const pkg = JSON.parse(fs.readFileSync(path.join(this.packageRoot, 'package.json'), 'utf8'));
		const target = path.join(this.home, 'nodes', 'node_modules', PACKAGE_DIR);
		fs.mkdirSync(target, { recursive: true });
		fs.copyFileSync(path.join(this.packageRoot, 'package.json'), path.join(target, 'package.json'));
		fs.cpSync(path.join(this.packageRoot, 'dist'), path.join(target, 'dist'), { recursive: true });
		fs.writeFileSync(
			path.join(this.home, 'nodes', 'package.json'),
			JSON.stringify({ name: 'installed-nodes', private: true, dependencies: { [pkg.name]: pkg.version } }, null, 2),
		);
		// The container runs as uid 1000; let it write whatever the host user created.
		fs.chmodSync(this.home, 0o777);
		for (const entry of walk(this.home)) fs.chmodSync(entry, fs.statSync(entry).isDirectory() ? 0o777 : 0o666);
		return pkg;
	}

	async start() {
		const args = [
			'run', '-d',
			'--name', this.containerName,
			'--label', 'tn-harness=1',
			'--label', `tn-harness-run=${this.runId}`,
			'--add-host', 'host.docker.internal:host-gateway',
			'-p', `127.0.0.1:${this.port}:5678`,
			'-v', `${this.home}:/home/node/.n8n`,
			'-e', 'N8N_COMMUNITY_PACKAGES_ENABLED=true',
			'-e', 'N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true',
			'-e', 'N8N_DIAGNOSTICS_ENABLED=false',
			'-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false',
			'-e', 'N8N_PERSONALIZATION_ENABLED=false',
			'-e', 'N8N_HIRING_BANNER_ENABLED=false',
			'-e', 'N8N_TEMPLATES_ENABLED=false',
			'-e', 'N8N_SECURE_COOKIE=false',
			'-e', `GENERIC_TIMEZONE=${this.timezone}`,
			'-e', `TZ=${this.timezone}`,
			'-e', `WEBHOOK_URL=http://127.0.0.1:${this.port}/`,
			this.image,
		];
		const result = await run('docker', args);
		if (result.code !== 0) throw new Error(`docker run failed: ${result.stderr || result.stdout}`);
		this.started = true;
		const id = await run('docker', ['inspect', '--format', '{{.Image}}', this.containerName]);
		this.imageId = id.stdout.trim();
		await waitFor(
			async () => {
				try {
					const res = await fetch(`${this.url}/healthz/readiness`);
					return res.ok;
				} catch {
					return false;
				}
			},
			{ timeoutMs: 300_000, intervalMs: 1000, message: `n8n to be ready on ${this.url}/healthz/readiness` },
		);
	}

	async stop({ keep = false } = {}) {
		if (this.started && !keep) {
			await run('docker', ['rm', '-f', this.containerName]);
			this.started = false;
		}
		if (!keep) await removeDir(this.home, this.image);
	}

	async logs(tail = 60) {
		const out = await run('docker', ['logs', '--tail', String(tail), this.containerName]);
		return `${out.stdout}${out.stderr}`.trim();
	}

	/* ---------------------------------------------------------- REST client */

	async fetchRaw(pathname, init = {}) {
		const headers = { 'browser-id': this.browserId, ...(init.headers ?? {}) };
		if (this.cookie) headers.cookie = this.cookie;
		return fetch(`${this.url}${pathname}`, { ...init, headers });
	}

	async rest(method, pathname, body) {
		const request = () =>
			this.fetchRaw(pathname, {
				method,
				headers: body === undefined ? {} : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		let res = await request();
		// A busy host can answer a read with 502/503 ("Database is not ready!") for a moment: reads are safe to repeat.
		for (let attempt = 1; method === 'GET' && [502, 503].includes(res.status) && attempt <= 6; attempt += 1) {
			await sleep(1500 * attempt);
			res = await request();
		}
		const text = await res.text();
		let parsed;
		try {
			parsed = text ? JSON.parse(text) : null;
		} catch {
			parsed = text;
		}
		if (!res.ok) {
			const message = typeof parsed === 'object' && parsed ? (parsed.message ?? JSON.stringify(parsed)) : String(parsed);
			const error = new Error(`n8n ${method} ${pathname} -> ${res.status}: ${message}`);
			error.status = res.status;
			error.body = parsed;
			throw error;
		}
		return parsed && typeof parsed === 'object' && 'data' in parsed && Object.keys(parsed).length === 1 ? parsed.data : parsed;
	}

	/** Owner setup, login, version and personal project. */
	async bootstrap() {
		const email = `harness+${this.runId}@example.com`;
		const password = `Harness-${this.runId}-Pw1`;
		for (let attempt = 1; ; attempt += 1) {
			try {
				await this.rest('POST', '/rest/owner/setup', { email, firstName: 'Harness', lastName: 'Owner', password });
				break;
			} catch (error) {
				// A loaded machine can answer 503 "Database is not ready" a little after the readiness probe passes.
				if (error.status !== 503 || attempt >= 30) throw error;
				await sleep(2000);
			}
		}
		for (let attempt = 1; ; attempt += 1) {
			const res = await this.fetchRaw('/rest/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ emailOrLdapLoginId: email, password }),
			});
			if (res.ok) {
				const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('n8n-auth='));
				if (!cookie) throw new Error('login worked but n8n sent no n8n-auth cookie');
				this.cookie = cookie;
				break;
			}
			if (attempt >= 5) throw new Error(`n8n login failed: ${res.status} ${await res.text()}`);
			await sleep(1500);
		}
		const settings = await this.rest('GET', '/rest/settings');
		this.version = settings.versionCli ?? settings.n8nVersion ?? null;
		if (!this.version) {
			const out = await run('docker', ['exec', this.containerName, 'n8n', '--version']);
			this.version = out.stdout.trim().split('\n').pop() || 'unknown';
		}
		const project = await this.rest('GET', '/rest/projects/personal');
		this.projectId = project.id;
		return { email };
	}

	async nodeTypes() {
		const types = await this.rest('GET', '/types/nodes.json');
		return Array.isArray(types) ? types : Object.values(types);
	}

	/* ------------------------------------------------------------ credentials */

	async createCredential({ name, type, data }) {
		const created = await this.rest('POST', '/rest/credentials', { name, type, data, projectId: this.projectId });
		return { id: created.id, name: created.name, type };
	}

	/* -------------------------------------------------------------- workflows */

	/**
	 * Imports a workflow JSON. `rewrite(node)` may change a node in place (credential ids, data table
	 * ids). Nodes that need a webhookId get one. The JSON on disk is never touched.
	 */
	async importWorkflow(json, { name, rewrite } = {}) {
		const workflow = deepClone(json);
		for (const node of workflow.nodes ?? []) {
			if (rewrite) rewrite(node);
			if (NEEDS_WEBHOOK_ID.has(node.type) && !node.webhookId) node.webhookId = uuid();
		}
		const body = {
			name: name ?? workflow.name ?? 'harness workflow',
			nodes: workflow.nodes,
			connections: workflow.connections ?? {},
			settings: workflow.settings ?? { executionOrder: 'v1' },
			pinData: workflow.pinData ?? {},
			projectId: this.projectId,
		};
		if (workflow.meta) body.meta = workflow.meta;
		const created = await this.rest('POST', '/rest/workflows', body);
		return created;
	}

	async activate(workflowId, { settleMs = 1500 } = {}) {
		const current = await this.rest('GET', `/rest/workflows/${workflowId}`);
		const result = await this.rest('POST', `/rest/workflows/${workflowId}/activate`, { versionId: current.versionId });
		if (!result.active) throw new Error('n8n did not activate the workflow (see the n8n log in the report)');
		await sleep(settleMs); // webhooks and cron jobs register just after the call returns
		return result;
	}

	async deactivate(workflowId) {
		return this.rest('POST', `/rest/workflows/${workflowId}/deactivate`, {});
	}

	/** Starts a manual execution at `triggerName`. `pin` maps node names to item lists to pin. */
	async startManual(workflow, triggerName, { pin } = {}) {
		const pinData = {};
		for (const [node, items] of Object.entries(pin ?? {})) pinData[node] = items.map((item) => (item && item.json ? item : { json: item }));
		// n8n 2.45 runs the STORED workflow and ignores the pinData of the request, so the pin has to be stored first
		// (and stale pins of an earlier run removed).
		const current = await this.rest('GET', `/rest/workflows/${workflow.id}`);
		if (JSON.stringify(current.pinData ?? {}) !== JSON.stringify(pinData)) {
			const stored = await this.rest('PATCH', `/rest/workflows/${workflow.id}`, { pinData, versionId: current.versionId });
			workflow = { ...workflow, versionId: stored.versionId ?? current.versionId };
		}
		const response = await this.rest('POST', `/rest/workflows/${workflow.id}/run`, {
			workflowData: {
				id: workflow.id,
				name: workflow.name,
				nodes: workflow.nodes,
				connections: workflow.connections,
				settings: workflow.settings,
				pinData,
				versionId: workflow.versionId,
				active: false,
			},
			triggerToStartFrom: { name: triggerName },
		});
		if (response.executionId === undefined) {
			throw new Error(`n8n did not start an execution at "${triggerName}": ${JSON.stringify(response)} (a webhook or form trigger waits for a test call; pin its output instead)`);
		}
		return String(response.executionId);
	}

	/* ------------------------------------------------------------- executions */

	async listExecutions(workflowId, { limit = 100 } = {}) {
		const filter = encodeURIComponent(JSON.stringify({ workflowId }));
		const page = await this.rest('GET', `/rest/executions?filter=${filter}&limit=${limit}`);
		return (page.results ?? []).map((e) => ({ id: String(e.id), status: e.status, mode: e.mode, startedAt: e.startedAt, stoppedAt: e.stoppedAt }));
	}

	async getExecution(id) {
		const raw = await this.rest('GET', `/rest/executions/${id}`);
		const data = typeof raw.data === 'string' ? flattedParse(raw.data) : raw.data;
		return new Execution(raw, data);
	}

	async waitForExecution(id, { timeoutMs = 120_000 } = {}) {
		await waitFor(
			async () => {
				const head = await this.rest('GET', `/rest/executions/${id}`);
				return FINISHED.has(head.status);
			},
			{ timeoutMs, intervalMs: 400, message: `execution ${id} to finish` },
		);
		return this.getExecution(id);
	}

	/* ------------------------------------------------------------ data tables */

	async createDataTable(name, columns) {
		return this.rest('POST', `/rest/projects/${this.projectId}/data-tables`, { name, columns });
	}

	async dataTables() {
		const page = await this.rest('GET', `/rest/projects/${this.projectId}/data-tables`);
		return page.data ?? [];
	}

	async dataTableRows(tableId, { filter, take = 250 } = {}) {
		const rows = [];
		for (let skip = 0; ; skip += take) {
			let query = `take=${take}&skip=${skip}&sortBy=${encodeURIComponent('id:asc')}`;
			if (filter) query += `&filter=${encodeURIComponent(JSON.stringify(filter))}`;
			const page = await this.rest('GET', `/rest/projects/${this.projectId}/data-tables/${tableId}/rows?${query}`);
			rows.push(...(page.data ?? []));
			if ((page.data ?? []).length < take) return rows;
		}
	}

	async dataTableInsert(tableId, data) {
		return this.rest('POST', `/rest/projects/${this.projectId}/data-tables/${tableId}/insert`, { data, returnType: 'all' });
	}

	async dataTableUpdate(tableId, filter, data) {
		return this.rest('PATCH', `/rest/projects/${this.projectId}/data-tables/${tableId}/rows`, { filter, data, returnData: true });
	}

	async dataTableDelete(tableId, filter) {
		const query = `filter=${encodeURIComponent(JSON.stringify(filter))}&returnData=true`;
		return this.rest('DELETE', `/rest/projects/${this.projectId}/data-tables/${tableId}/rows?${query}`);
	}
}

/** One finished execution, with helpers to read what each node produced. */
export class Execution {
	constructor(raw, data) {
		this.raw = raw;
		this.id = String(raw.id);
		this.status = raw.status;
		this.mode = raw.mode;
		this.startedAt = raw.startedAt;
		this.stoppedAt = raw.stoppedAt;
		this.runData = data?.resultData?.runData ?? {};
		this.error = data?.resultData?.error ?? null;
		this.lastNodeExecuted = data?.resultData?.lastNodeExecuted ?? null;
	}

	/** Names of the nodes that ran, in start order. */
	get nodesRun() {
		return Object.entries(this.runData)
			.map(([name, runs]) => ({ name, start: runs[0]?.startTime ?? 0 }))
			.sort((a, b) => a.start - b.start)
			.map((n) => n.name);
	}

	ran(name) {
		return Array.isArray(this.runData[name]) && this.runData[name].length > 0;
	}

	/** Items (the json of each) a node put on output `output`, for one run or for all runs. */
	items(name, { run, output = 0 } = {}) {
		const runs = this.runData[name] ?? [];
		const pick = run === undefined ? runs : [runs[run]].filter(Boolean);
		return pick.flatMap((r) => (r.data?.main?.[output] ?? []).map((item) => item.json));
	}

	/** The first item json of a node, or undefined. */
	first(name, options) {
		return this.items(name, options)[0];
	}

	nodeError(name) {
		const run = (this.runData[name] ?? []).find((r) => r.error);
		return run?.error ?? null;
	}

	/** One line to put in a failure message. */
	describe() {
		const bits = [`execution ${this.id} ${this.status}`];
		if (this.error) bits.push(`error: ${this.error.message ?? JSON.stringify(this.error)}${this.error.node?.name ? ` (node "${this.error.node.name}")` : ''}`);
		bits.push(`nodes run: ${this.nodesRun.join(' > ') || 'none'}`);
		return bits.join('; ');
	}
}

function* walk(dir) {
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name);
		yield full;
		if (fs.statSync(full).isDirectory()) yield* walk(full);
	}
}

export async function removeDir(dir, image) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
		return;
	} catch {
		// Files created by the container's user can refuse deletion on Linux: let a container remove them.
	}
	const parent = path.dirname(dir);
	await run('docker', ['run', '--rm', '--entrypoint', 'rm', '-v', `${parent}:/p`, image, '-rf', `/p/${path.basename(dir)}`]);
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch (error) {
		log(`could not delete ${dir}: ${error.message}`);
	}
}

export function makeTempHome(runId) {
	const base = process.env.HARNESS_TMP ?? os.tmpdir();
	return fs.mkdtempSync(path.join(base, `tn-harness-${runId}-`));
}
