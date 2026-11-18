/**
 * Orchestration: mock API, optional fake LLM, a throwaway n8n, the workflow import and the scenario.
 * The CLI (run-template.mjs) and the selftest are thin callers of runTemplate().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeLlm } from '../fake-llm.mjs';
import { createMockApi } from '../mock-api.mjs';
import { AssertionFailure, createAssert } from './assert.mjs';
import { mockClient } from './mock-client.mjs';
import { REAL_API_URL, createCustomerSender, createGuardProxy, guardClient, readApiKey, realClient } from './real.mjs';
import { N8nInstance, PACKAGE_DIR, makeTempHome } from './n8n.mjs';
import { deepClone, fillTokens, firstFreePort, log, randomHex, range, redact, registerGroup, registerPhone, run, sleep, waitFor } from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '../../..');

const DEFAULT_IMAGE = process.env.HARNESS_N8N_IMAGE ?? 'n8nio/n8n:latest';
export const API_KEY = 'tn_test_harness_key';
export const WEBHOOK_SECRET = 'whsec_harness_secret';

/** Credential types the harness can create for a fake OpenAI compatible model. */
const LLM_CREDENTIAL_TYPES = {
	openAiApi: (url) => ({ apiKey: 'sk-fake-harness-key', organizationId: '', url, header: false, headerName: '', headerValue: '', allowedHttpRequestDomains: 'all', allowedDomains: '' }),
	openRouterApi: (url) => ({ apiKey: 'sk-fake-harness-key', url }),
};

/* --------------------------------------------------------------- the build */

async function withBuildLock(fn) {
	const lock = path.join(os.tmpdir(), 'tn-harness-build.lock');
	const deadline = Date.now() + 5 * 60_000;
	for (;;) {
		try {
			fs.mkdirSync(lock);
			break;
		} catch {
			try {
				if (Date.now() - fs.statSync(lock).mtimeMs > 5 * 60_000) fs.rmSync(lock, { recursive: true, force: true });
			} catch {
				// the other build just finished
			}
			if (Date.now() > deadline) throw new Error(`another build holds ${lock} for too long`);
			await sleep(1000);
		}
	}
	try {
		return await fn();
	} finally {
		fs.rmSync(lock, { recursive: true, force: true });
	}
}

async function buildModule() {
	await withBuildLock(async () => {
		log('npm run build');
		const out = await run('npm', ['run', 'build'], { cwd: PACKAGE_ROOT });
		if (out.code !== 0) throw new Error(`npm run build failed:\n${out.stdout}\n${out.stderr}`);
	});
}

/* ------------------------------------------------------------- port choice */

async function choosePorts(requested = {}) {
	const n8n = requested.n8n ?? (await firstFreePort(range(5690, 5699)));
	const mock = requested.mock ?? (await firstFreePort([9099, ...range(9201, 9299)]));
	const llm = requested.llm ?? (await firstFreePort([9100, ...range(9301, 9399)]));
	return { n8n, mock, llm };
}

/** Two runs that pick the same free port at the same moment: the loser takes the next one. */
async function listenWithRetry(start, ports, key, candidates, requested) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await start(ports[key]);
		} catch (error) {
			if (error.code !== 'EADDRINUSE' || requested || attempt >= 8) throw error;
			ports[key] = await firstFreePort(candidates.filter((p) => p !== ports[key]));
		}
	}
}

/** "--ports 5691,9199,9198" is n8n,mock,llm. */
export function parsePorts(text) {
	if (!text) return {};
	const [n8n, mock, llm] = String(text).split(',').map((n) => (n ? Number(n) : undefined));
	return { n8n, mock, llm };
}

/* ------------------------------------------------------------ the pipeline */

/**
 * Runs one workflow against one scenario. Always removes its container and temp home.
 * Resolves to the report object (never throws for a failing scenario).
 */
export async function runTemplate(options) {
	const started = Date.now();
	const runId = options.runId ?? randomHex(3);
	const assertApi = createAssert();
	const steps = [];
	const report = {
		ok: false,
		runId,
		workflow: options.workflowPath,
		scenario: options.scenarioPath,
		n8n: { image: options.image ?? DEFAULT_IMAGE, version: null, imageId: null, port: null, container: null },
		package: { name: null, version: null },
		ports: {},
		patchedNodes: [],
		steps,
		assertions: assertApi.counter,
		executions: [],
		notes: {},
		error: null,
		n8nLogTail: undefined,
		durationMs: 0,
	};

	let mock = null;
	let guard = null;
	let customer = null;
	let llm = null;
	let n8n = null;
	let cleaned = false;
	const cleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		try {
			if (n8n) await n8n.stop({ keep: options.keep });
		} catch (error) {
			log(`cleanup of n8n failed: ${error.message}`);
		}
		try {
			await mock?.stop();
			await guard?.stop();
			await llm?.stop();
		} catch {
			// nothing left to do
		}
	};
	const onSignal = async (signal) => {
		log(`${signal} received, cleaning up`);
		await cleanup();
		process.exit(130);
	};
	process.once('SIGINT', onSignal);
	process.once('SIGTERM', onSignal);

	try {
		const workflowJson = JSON.parse(fs.readFileSync(path.resolve(options.workflowPath), 'utf8'));
		const scenarioModule = options.scenarioModule ?? (await import(pathToFileURL(path.resolve(options.scenarioPath)).href));
		const scenario = typeof scenarioModule.default === 'function' ? scenarioModule.default : scenarioModule.run;
		if (typeof scenario !== 'function') throw new Error('the scenario must `export default async function (t) { ... }`');

		const wantsLlm =
			options.llm === true ||
			scenarioModule.llm === true ||
			(scenarioModule.llm !== false && (workflowJson.nodes ?? []).some((n) => /lmChat|lmOpenAi|embeddingsOpenAi/.test(n.type) || Object.keys(n.credentials ?? {}).some((c) => c in LLM_CREDENTIAL_TYPES)));

		if (!options.skipBuild) await buildModule();
		if (!fs.existsSync(path.join(PACKAGE_ROOT, 'dist'))) throw new Error('dist/ is missing: run `npm run build` first or drop --skip-build');

		const ports = await choosePorts(options.ports);
		report.ports = ports;
		const host = process.platform === 'darwin' ? '127.0.0.1' : '0.0.0.0';

		// Real mode: no mock. A guard proxy (recipient, budget and call allowlist, request log) stands in front of the
		// real API, and the scenario reads the real API with the key through t.real.
		const realMode = Boolean(options.realApi);
		let realKey = null;
		let real = null;
		let mockInfo;
		let mockUrl;
		let mockDockerUrl;
		let api;
		if (realMode) {
			const ro = options.realApi;
			realKey = readApiKey(ro.keyFile);
			const ownerPhone = ro.ownerPhone ?? process.env.TN_REAL_OWNER_PHONE;
			if (!ownerPhone) throw new Error('a real run needs TN_REAL_OWNER_PHONE (the owner test number, with +): it is the only number that may receive messages');
			registerPhone(ownerPhone);
			const upstream = ro.baseUrl ?? REAL_API_URL;
			guard = createGuardProxy({ upstream, allowedNumber: ownerPhone, maxSends: ro.maxSends ?? 8 });
			if (ro.guard === false) {
				mockInfo = { port: 0, url: upstream };
				mockDockerUrl = upstream;
			} else {
				mockInfo = await listenWithRetry((port) => guard.start(port, host), ports, 'mock', range(9201, 9299), options.ports?.mock);
				mockUrl = mockInfo.url;
				mockDockerUrl = `http://host.docker.internal:${mockInfo.port}`;
			}
			const direct = realClient({ baseUrl: upstream, apiKey: realKey });
			// A call that goes through the guard (recipient, call and budget rules apply): for probes of the real API's answers.
			const throughGuard = async (method, path, body) => {
				const base = ro.guard === false ? upstream : mockUrl;
				const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${realKey}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
				const text = await res.text();
				let json = text;
				try {
					json = JSON.parse(text);
				} catch {
					// keep the text
				}
				return { status: res.status, ok: res.ok, body: json };
			};
			real = { ...direct, throughGuard, guard: guardClient(guard), ownerPhone, upstream, maxSends: guard.maxSends, startedAt: new Date().toISOString(), guarded: ro.guard !== false };
			// --allow-group: the ONE group a plain text may be written into (besides the owner number). Resolved with the key
			// of the number under test; its id and name are masked in all output.
			if (ro.allowGroup) {
				if (ro.guard === false) throw new Error('--allow-group needs the guard (it cannot be combined with --no-guard)');
				const wanted = String(ro.allowGroup);
				let found;
				if (/^grp_[0-9a-f]{32}$/.test(wanted)) {
					found = await direct.get(`/v1/numbers/main/groups/${wanted}`);
				} else {
					const list = (await direct.get(`/v1/numbers/main/groups?name=${encodeURIComponent(wanted)}`)).data ?? [];
					const exact = list.filter((g) => g.name === wanted && g.is_active);
					if (exact.length !== 1) throw new Error(`--allow-group: ${exact.length} active groups carry that name on the number under test, expected exactly one`);
					found = exact[0];
				}
				if (!found?.is_active) throw new Error('--allow-group: the group is not active on the number under test');
				registerGroup({ id: found.id, name: found.name });
				guard.allowGroup(found.id);
				real.testGroup = { id: found.id, name: found.name, participantsCount: found.participants_count };
			}
			api = new Proxy({}, {
				get() {
					throw new Error('t.mock is not available in a --real-api run: use t.real');
				},
			});
			report.realApi = { upstream, guard: ro.guard !== false, maxSends: guard.maxSends, ownerNumber: '<owner test number, masked>', testGroup: real.testGroup ? '<test group>' : undefined };
			// Two-number scenarios: a second organization's key plays the customer who writes to the number under test.
			if (ro.customerKeyFile) {
				const personal = process.env.TN_REAL_PERSONAL_PHONE;
				if (!personal) throw new Error('--customer-key-file needs TN_REAL_PERSONAL_PHONE (the number under test, with +)');
				registerPhone(personal, 'number under test');
				customer = createCustomerSender({ apiKey: readApiKey(ro.customerKeyFile), to: personal, expectedFrom: ownerPhone, maxSends: guard.maxSends, guard, baseUrl: upstream, groupName: real.testGroup?.name });
				guard.extraCount = () => customer.count;
				real.customer = customer;
				report.realApi.customerSender = true;
			}
		} else {
			mock = createMockApi({ apiKey: API_KEY, ...(scenarioModule.mock ?? {}), ...(options.mock ?? {}) });
			mockInfo = await listenWithRetry((port) => mock.start(port, host), ports, 'mock', range(9201, 9299), options.ports?.mock);
			mockUrl = mockInfo.url;
			mockDockerUrl = `http://host.docker.internal:${mockInfo.port}`;
			api = mockClient(mockUrl, API_KEY);
		}

		let llmInfo = null;
		let llmDockerUrl = null;
		if (wantsLlm) {
			llm = createFakeLlm();
			llmInfo = await listenWithRetry((port) => llm.start(port, host), ports, 'llm', range(9301, 9399), options.ports?.llm);
			llmDockerUrl = `http://host.docker.internal:${llmInfo.port}/v1`;
		}
		const tokens = { mockUrl: mockUrl ?? '', mockDockerUrl, llmUrl: llmInfo?.url ?? '', llmDockerUrl: llmDockerUrl ?? '', apiKey: realKey ?? API_KEY, webhookSecret: WEBHOOK_SECRET };

		const home = makeTempHome(runId);
		n8n = new N8nInstance({
			runId,
			port: ports.n8n,
			image: report.n8n.image,
			home,
			containerName: `tn-harness-${runId}`,
			mockPort: mockInfo.port || undefined,
			timezone: options.timezone ?? 'UTC',
			packageRoot: PACKAGE_ROOT,
		});
		const pkg = n8n.prepareHome();
		report.package = { name: pkg.name, version: pkg.version };
		report.n8n.container = n8n.containerName;
		for (let attempt = 1; ; attempt += 1) {
			log(`starting ${report.n8n.image} as ${n8n.containerName} on ${n8n.url}`);
			try {
				await n8n.start();
				break;
			} catch (error) {
				// Two runs choosing the same free port at the same moment: take another one.
				const clash = /port is already allocated|address already in use|bind for/i.test(error.message);
				if (!clash || options.ports?.n8n || attempt >= 5) throw error;
				await run('docker', ['rm', '-f', n8n.containerName]);
				const next = await firstFreePort(range(5690, 5699).filter((p) => p !== n8n.port));
				n8n.setPort(next);
				ports.n8n = next;
			}
		}
		report.n8n.port = n8n.port;
		await n8n.bootstrap();
		report.n8n.version = n8n.version;
		report.n8n.imageId = n8n.imageId;
		log(`n8n ${n8n.version} is up`);

		/* ---- credentials */
		const credentialByType = new Map();
		const turbo = await n8n.createCredential({
			name: 'Turbo Notify API',
			type: 'turboNotifyApi',
			data: { apiKey: realKey ?? API_KEY, baseUrl: mockDockerUrl, webhookSecret: WEBHOOK_SECRET },
		});
		credentialByType.set('turboNotifyApi', turbo);
		if (llmDockerUrl) {
			for (const [type, build] of Object.entries(LLM_CREDENTIAL_TYPES)) {
				credentialByType.set(type, await n8n.createCredential({ name: `Fake LLM (${type})`, type, data: build(llmDockerUrl) }));
			}
		}
		for (const spec of scenarioModule.credentials ?? []) {
			credentialByType.set(spec.type, await n8n.createCredential({ name: spec.name ?? spec.type, type: spec.type, data: fillTokens(spec.data, tokens) }));
		}

		/* ---- data tables declared by the scenario */
		const tableByName = new Map();
		const tableMatchers = [];
		for (const spec of scenarioModule.tables ?? []) {
			const created = await n8n.createDataTable(spec.name, spec.columns);
			tableByName.set(spec.name, created);
			tableMatchers.push({ spec, id: created.id });
		}

		/* ---- the scenario may fill in the values the user would type */
		let prepared = deepClone(workflowJson);
		const context0 = { urls: tokens, credentials: Object.fromEntries([...credentialByType].map(([k, v]) => [k, v])), tables: Object.fromEntries([...tableByName].map(([k, v]) => [k, v.id])), workflow: prepared, realGroup: real?.testGroup ? { id: real.testGroup.id } : undefined };
		if (typeof scenarioModule.prepare === 'function') {
			const result = await scenarioModule.prepare(prepared, context0);
			if (result) prepared = result;
			const before = new Map((workflowJson.nodes ?? []).map((n) => [n.name, JSON.stringify(n)]));
			report.patchedNodes = (prepared.nodes ?? []).filter((n) => before.get(n.name) !== JSON.stringify(n)).map((n) => n.name);
		}

		/* ---- import */
		const missingCredentials = new Set();
		const unmatchedTables = new Set();
		const rewrite = (node) => {
			for (const type of Object.keys(node.credentials ?? {})) {
				const cred = credentialByType.get(type);
				if (cred) node.credentials[type] = { id: cred.id, name: cred.name };
				else missingCredentials.add(`${type} (node "${node.name}")`);
			}
			if (node.type === 'n8n-nodes-base.dataTable' && node.parameters?.dataTableId !== undefined) {
				const ref = node.parameters.dataTableId;
				const label = typeof ref === 'string' ? ref : (ref.cachedResultName || ref.value || '');
				const hit = tableMatchers.find(
					({ spec }) =>
						spec.name === label ||
						(spec.nodes ?? []).includes(node.name) ||
						(spec.match instanceof RegExp && spec.match.test(node.name)),
				);
				if (hit) node.parameters.dataTableId = { __rl: true, mode: 'list', value: hit.id, cachedResultName: hit.spec.name };
				else if (ref && typeof ref === 'object' && ref.mode === 'name') {
					// "By Name" references are resolved by n8n itself at run time: leave them exactly as exported.
				} else unmatchedTables.add(`${JSON.stringify(label)} (node "${node.name}")`);
			}
		};
		const imported = await n8n.importWorkflow(prepared, { name: `h-${runId}-${path.basename(path.dirname(path.resolve(options.workflowPath)))}`, rewrite });
		if (missingCredentials.size) {
			throw new Error(`the workflow uses credentials the harness cannot provide: ${[...missingCredentials].join(', ')}. Declare them in the scenario: export const credentials = [{ type, name, data }]`);
		}
		if (unmatchedTables.size) {
			throw new Error(`the workflow uses data tables the scenario did not declare: ${[...unmatchedTables].join(', ')}. Declare them: export const tables = [{ name, columns, nodes: ['Node name'] }]`);
		}

		/* ---- the scenario context */
		const t = buildContext({ real, n8n, api, llm, tokens, imported, assertApi, steps, report, tableByName, ports, mockInfo, llmInfo, runId });
		const timeoutMs = options.timeoutMs ?? scenarioModule.timeoutMs ?? 5 * 60_000;
		let timer;
		const timeLimit = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`scenario timed out after ${timeoutMs} ms`)), timeoutMs);
		});
		try {
			await Promise.race([scenario(t), timeLimit]);
		} finally {
			clearTimeout(timer);
			// Always, also after a failure: the scenario's own cleanup, then (real mode) every message this run sent is deleted for everyone.
			if (typeof scenarioModule.cleanup === 'function') {
				try {
					await scenarioModule.cleanup(t);
				} catch (error) {
					log(`scenario cleanup failed: ${error.message}`);
				}
			}
			if (real && customer && !options.realApi.keepMessages) {
				report.realApi = { ...report.realApi, customerCleanup: await customer.deleteAll().catch((error) => ({ failed: error.message })) };
			}
			if (real && guard && !options.realApi.keepMessages) {
				const outcome = { deleted: 0, alreadyGone: 0, failed: [] };
				for (const id of guard.acceptedMessageIds()) {
					const result = await real.deleteWhenSent(id).catch((error) => ({ deleted: false, status: 0, error: error.message }));
					if (result.deleted) outcome.deleted += 1;
					else if (result.status === 404 || result.status === 400) outcome.alreadyGone += 1; // already deleted by the scenario
					else outcome.failed.push({ id, status: result.status, error: result.error ?? result.note });
				}
				report.realApi = { ...report.realApi, cleanup: outcome };
			}
		}
		report.ok = assertApi.counter.failed === 0 && steps.every((s) => s.ok);
	} catch (error) {
		report.ok = false;
		report.error = error instanceof AssertionFailure ? { type: 'assertion', message: error.message } : { type: 'error', message: error.message, stack: error.stack?.split('\n').slice(0, 6).join('\n') };
		if (n8n?.started) {
			try {
				report.n8nLogTail = await n8n.logs(60);
			} catch {
				// the container may be gone
			}
		}
	} finally {
		await cleanup();
		process.removeListener('SIGINT', onSignal);
		process.removeListener('SIGTERM', onSignal);
	}
	if (guard) {
		report.realApi = {
			...report.realApi,
			messagesAccepted: guard.messagesAccepted,
			customerMessagesSent: customer ? customer.count : undefined,
			messageIds: guard.acceptedMessageIds(),
			callsBlocked: guard.blocked,
			requests: guard.entries.length,
			// what n8n really sent and what the API answered, without bodies of 2xx answers (error bodies are kept)
			requestLog: guard.entries.map((e) => ({
				seq: e.seq,
				method: e.method,
				path: e.path,
				query: Object.keys(e.query).length ? e.query : undefined,
				status: e.status,
				idempotencyKey: e.headers['idempotency-key'] ? 'set' : undefined,
				error: e.status >= 400 ? e.response : undefined,
				response: e.method === 'POST' && e.status < 400 ? e.response : undefined, // a send answers {message_id, status}
				retryAfter: e.responseHeaders?.['retry-after'],
				blocked: e.blocked,
			})),
			byStatus: guard.entries.reduce((acc, e) => ({ ...acc, [e.status]: (acc[e.status] ?? 0) + 1 }), {}),
		};
	}
	report.durationMs = Date.now() - started;
	return report;
}

/* -------------------------------------------------------------- scenario t */

function buildContext({ real, n8n, api, llm, tokens, imported, assertApi, steps, report, tableByName, ports, mockInfo, llmInfo, runId }) {
	let workflow = imported;
	const nodeByName = (name) => {
		const node = workflow.nodes.find((n) => n.name === name);
		if (!node) throw new Error(`the workflow has no node named "${name}". Nodes: ${workflow.nodes.map((n) => n.name).join(', ')}`);
		return node;
	};
	const refresh = async () => {
		workflow = await n8n.rest('GET', `/rest/workflows/${imported.id}`);
		return workflow;
	};
	const tableId = async (name) => {
		const hit = tableByName.get(name);
		if (hit) return hit.id;
		const found = (await n8n.dataTables()).find((tb) => tb.name === name);
		if (!found) throw new Error(`no data table named "${name}"`);
		return found.id;
	};
	const filterOf = (where) =>
		where && Object.keys(where).length
			? { type: 'and', filters: Object.entries(where).map(([columnName, value]) => ({ columnName, condition: 'eq', value })) }
			: undefined;
	const recorded = (execution) => {
		if (!report.executions.some((e) => e.id === execution.id)) {
			report.executions.push({ id: execution.id, status: execution.status, mode: execution.mode, nodesRun: execution.nodesRun });
		}
		return execution;
	};

	const t = {
		runId,
		assert: assertApi,
		n8n,
		mock: api,
		real,
		llm,
		urls: { n8n: n8n.url, mock: mockInfo.url, mockForN8n: tokens.mockDockerUrl, llm: llmInfo?.url, llmForN8n: tokens.llmDockerUrl },
		ports,
		sleep,
		waitFor,
		log: (...args) => log('scenario:', ...args),
		/** Records a finding (a real response shape, a state reached) in the report under `notes`. */
		note(name, value) {
			report.notes[name] = value;
		},

		workflow: {
			get id() {
				return workflow.id;
			},
			get name() {
				return workflow.name;
			},
			get nodes() {
				return workflow.nodes;
			},
			node: nodeByName,
			refresh,
			/** Production (or test) URL of a webhook based node, reachable from this machine. */
			webhookUrl(nodeName, { test = false } = {}) {
				const node = nodeByName(nodeName);
				const base = `${n8n.url}/${test ? 'webhook-test' : 'webhook'}`;
				if (node.type === '@turbo-notify/n8n-nodes-turbo-notify.turboNotifyTrigger') return `${base}/${node.webhookId}/turbo-notify`;
				if (node.type === 'n8n-nodes-base.webhook') return `${base}/${node.parameters?.path || node.webhookId}`;
				throw new Error(`do not know the webhook URL of node type ${node.type}`);
			},
		},

		/** Named step with a timing in the report. A failing step aborts the scenario. */
		async step(name, fn) {
			const at = Date.now();
			log(`step: ${name}`);
			try {
				const result = await fn();
				steps.push({ name, ok: true, ms: Date.now() - at });
				return result;
			} catch (error) {
				steps.push({ name, ok: false, ms: Date.now() - at, error: error.message });
				throw error;
			}
		},

		/** Runs the workflow once from a trigger node and waits for the execution. `pin` feeds that node. */
		async run(triggerName, { pin, timeoutMs = 120_000 } = {}) {
			await refresh();
			nodeByName(triggerName);
			const id = await n8n.startManual(workflow, triggerName, { pin });
			return recorded(await n8n.waitForExecution(id, { timeoutMs }));
		},

		async activate(options) {
			await n8n.activate(imported.id, options);
			await refresh();
		},
		async deactivate() {
			await n8n.deactivate(imported.id);
		},

		/** Highest execution id so far, as a mark for waitExecutions. */
		async executionMark() {
			const all = await n8n.listExecutions(imported.id);
			return all.reduce((max, e) => Math.max(max, Number(e.id)), 0);
		},

		/**
		 * Waits for `count` finished executions that are not manual runs and are newer than `since`.
		 * Polling workflows tick once a minute at most (n8n refuses shorter intervals), so the
		 * default timeout is generous.
		 */
		async waitExecutions({ count = 1, since = 0, timeoutMs = 150_000, includeManual = false } = {}) {
			const found = await waitFor(
				async () => {
					const all = (await n8n.listExecutions(imported.id))
						.filter((e) => Number(e.id) > since && (includeManual || e.mode !== 'manual'))
						.filter((e) => ['success', 'error', 'crashed', 'canceled'].includes(e.status));
					return all.length >= count ? all : null;
				},
				{ timeoutMs, intervalMs: 1000, message: `${count} finished execution(s) after #${since}` },
			);
			const full = [];
			for (const e of found.sort((a, b) => Number(a.id) - Number(b.id))) full.push(recorded(await n8n.getExecution(e.id)));
			return full;
		},

		/** Passes when no execution starts for `ms` milliseconds. */
		async expectNoExecutions({ since = 0, ms = 8000, includeManual = false } = {}) {
			await sleep(ms);
			const all = (await n8n.listExecutions(imported.id)).filter((e) => Number(e.id) > since && (includeManual || e.mode !== 'manual'));
			assertApi.count(all, 0, `expected no execution after #${since}, found ${all.map((e) => `#${e.id} ${e.status}`).join(', ')}`);
		},

		async execution(id) {
			return recorded(await n8n.getExecution(id));
		},

		/** Calls a webhook based node of the activated workflow. */
		async callWebhook(nodeName, { method = 'POST', body, headers = {}, query, test = false } = {}) {
			const url = new URL(t.workflow.webhookUrl(nodeName, { test }));
			for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
			const res = await fetch(url, {
				method,
				headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
				body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
			});
			const text = await res.text();
			let parsed = text;
			try {
				parsed = JSON.parse(text);
			} catch {
				// plain text answer
			}
			return { status: res.status, body: parsed };
		},

		/** Registers the instant trigger of the workflow as the webhook target of the mock. */
		async webhookTargetFor(nodeName, { events, secret = tokens.webhookSecret } = {}) {
			return api.webhookTarget({ url: t.workflow.webhookUrl(nodeName), secret, events });
		},

		tables: {
			async create(name, columns) {
				const created = await n8n.createDataTable(name, columns);
				tableByName.set(name, created);
				return created;
			},
			id: tableId,
			async rows(name, { where } = {}) {
				return n8n.dataTableRows(await tableId(name), { filter: filterOf(where) });
			},
			async insert(name, rows) {
				return n8n.dataTableInsert(await tableId(name), Array.isArray(rows) ? rows : [rows]);
			},
			async update(name, where, data) {
				return n8n.dataTableUpdate(await tableId(name), filterOf(where), data);
			},
			async remove(name, where) {
				return n8n.dataTableDelete(await tableId(name), filterOf(where));
			},
			async clear(name) {
				return n8n.dataTableDelete(await tableId(name), { type: 'and', filters: [{ columnName: 'id', condition: 'gte', value: 0 }] });
			},
		},

		logs: (tail) => n8n.logs(tail),
	};
	return t;
}
