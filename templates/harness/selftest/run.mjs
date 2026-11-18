#!/usr/bin/env node
/**
 * Selftest of the harness: node templates/harness/selftest/run.mjs
 *
 * Default: the contract check and the mock behaviour checks (no Docker), then the smallest scenario in
 * a real n8n (send a text, wait, read the status). Extra checks:
 *   --all        also the instant trigger + data table scenario and the AI agent scenario
 *   --polling    also the polling trigger scenario (waits for a one minute tick)
 * Other options are passed to the runner: --ports n8n,mock,llm  --run-id id  --image ref  --skip-build  --keep
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePorts, runTemplate } from '../lib/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};

// These two need no Docker: they fail fast when the mock drifts from the OpenAPI document or misbehaves.
for (const script of ['contract.mjs', 'mock-behaviour.mjs']) {
	const out = spawnSync(process.execPath, [path.join(here, script)], { encoding: 'utf8' });
	console.error(`\n=== ${script} ===\n${out.stdout.split('\n').slice(-3).join('\n')}`);
	if (out.status !== 0) {
		console.error(out.stdout, out.stderr);
		console.log(JSON.stringify({ ok: false, error: `${script} failed` }, null, 2));
		process.exit(1);
	}
}

const cases = [{ name: 'send and track', workflow: 'send-and-track.json', scenario: 'send-and-track.scenario.mjs' }];
if (flag('all')) {
	cases.push({ name: 'instant trigger and data table', workflow: 'instant-inbox.json', scenario: 'instant-inbox.scenario.mjs' });
	cases.push({ name: 'AI agent with the fake LLM', workflow: 'ai-agent.json', scenario: 'ai-agent.scenario.mjs' });
}
if (flag('all') || flag('polling')) {
	cases.push({ name: 'polling trigger', workflow: 'polling-inbox.json', scenario: 'polling-inbox.scenario.mjs' });
}

const results = [];
for (const c of cases) {
	console.error(`\n=== ${c.name} ===`);
	const report = await runTemplate({
		workflowPath: path.join(here, c.workflow),
		scenarioPath: path.join(here, c.scenario),
		runId: value('run-id') ? `${value('run-id')}-${results.length}` : undefined,
		ports: parsePorts(value('ports')),
		image: value('image'),
		skipBuild: flag('skip-build') || results.length > 0,
		keep: flag('keep'),
	});
	results.push({ case: c.name, report });
	console.error(report.ok ? `PASS ${c.name}` : `FAIL ${c.name}: ${report.error?.message}`);
	if (!report.ok && report.n8nLogTail) console.error(report.n8nLogTail.split('\n').slice(-25).join('\n'));
}

const summary = {
	ok: results.every((r) => r.report.ok),
	n8nVersion: results[0]?.report.n8n.version,
	packageVersion: results[0]?.report.package.version,
	cases: results.map((r) => ({ case: r.case, ok: r.report.ok, steps: r.report.steps.map((s) => `${s.ok ? 'ok  ' : 'FAIL'} ${s.name} (${s.ms} ms)`), assertions: r.report.assertions, error: r.report.error?.message })),
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
