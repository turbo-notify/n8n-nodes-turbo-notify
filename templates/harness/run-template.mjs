#!/usr/bin/env node
/**
 * Runs an n8n workflow JSON end to end against the Turbo Notify mock API in a throwaway n8n.
 *
 *   node templates/harness/run-template.mjs <path/to/workflow.json> --scenario <path/to/scenario.mjs>
 *
 * Options
 *   --scenario <file>    the scenario module (required)
 *   --run-id <id>        names the container (tn-harness-<id>) and the temp home; default random
 *   --ports <n,m,l>      n8n, mock API and fake LLM ports, for example 5691,9199,9198
 *   --n8n-port <n>       (default: first free of 5690..5699)
 *   --mock-port <n>      (default: 9099, else the first free of 9201..9299)
 *   --llm-port <n>       (default: 9100, else the first free of 9301..9399)
 *   --image <ref>        n8n image, default n8nio/n8n:latest (env HARNESS_N8N_IMAGE)
 *   --skip-build         do not run `npm run build` first
 *   --keep               leave the container and the temp home in place (for debugging)
 *   --timeout <ms>       limit for the scenario, default 300000
 *   --tz <zone>          time zone of n8n, default UTC
 *   --report <file>      also write the JSON report to this file
 *   --llm                start the fake LLM even if the workflow does not look like it needs one
 *
 * Real API mode (sends REAL WhatsApp messages, see the harness README):
 *   --customer-key-file <f>  two-number scenarios: the key of the organization whose number plays the customer (needs env TN_REAL_PERSONAL_PHONE: the number under test)
 *   --real-api           no mock: the workflow runs against https://api.turbonotify.com through a guard proxy
 *   --api-key-file <f>   file with the line `- Value: tn_live_...` (required with --real-api; the key is never printed)
 *   --max-sends <n>      hard budget of accepted sends, default 8
 *   --keep-messages      do not delete the messages this run sent when it ends (by default every one is deleted for everyone)
 *   --allow-group <grp_id|name>  the ONE group (of the number under test) that plain text may be written into, by the workflow and by the customer sender; its id and name are masked
 *   --no-guard           n8n talks to the API directly (no recipient check, no budget, no request log): not recommended
 *   env TN_REAL_OWNER_PHONE  the ONE number that may receive messages (with +); required with --real-api
 *
 * stdout: the JSON report. stderr: progress. Exit code 0 passed, 1 failed, 2 could not start.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runTemplate, parsePorts } from './lib/harness.mjs';
import { redact } from './lib/util.mjs';

function parse(argv) {
	const out = { positional: [] };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (!a.startsWith('--')) {
			out.positional.push(a);
			continue;
		}
		const key = a.slice(2);
		if (['skip-build', 'keep', 'llm', 'real-api', 'no-guard', 'keep-messages'].includes(key)) out[key] = true;
		else out[key] = argv[(i += 1)];
	}
	return out;
}

const args = parse(process.argv.slice(2));
const workflowPath = args.positional[0];
if (!workflowPath || !args.scenario || args.help) {
	console.error('usage: node templates/harness/run-template.mjs <workflow.json> --scenario <scenario.mjs> [options]\nsee the header of this file for the options');
	process.exit(2);
}
if (args['real-api'] && !args['api-key-file']) {
	console.error('--real-api needs --api-key-file <file with the line "- Value: tn_live_...">');
	process.exit(2);
}
for (const file of [workflowPath, args.scenario]) {
	if (!fs.existsSync(file)) {
		console.error(`not found: ${file}`);
		process.exit(2);
	}
}

const ports = { ...parsePorts(args.ports) };
if (args['n8n-port']) ports.n8n = Number(args['n8n-port']);
if (args['mock-port']) ports.mock = Number(args['mock-port']);
if (args['llm-port']) ports.llm = Number(args['llm-port']);

const report = await runTemplate({
	workflowPath,
	scenarioPath: args.scenario,
	runId: args['run-id'],
	ports,
	image: args.image,
	skipBuild: Boolean(args['skip-build']),
	keep: Boolean(args.keep),
	timeoutMs: args.timeout ? Number(args.timeout) : undefined,
	timezone: args.tz,
	llm: Boolean(args.llm),
	realApi: args['real-api']
		? { allowGroup: args['allow-group'], keyFile: path.resolve(args['api-key-file'] ?? ''), customerKeyFile: args['customer-key-file'] ? path.resolve(args['customer-key-file']) : undefined, maxSends: args['max-sends'] ? Number(args['max-sends']) : 8, guard: !args['no-guard'], keepMessages: Boolean(args['keep-messages']) }
		: undefined,
});

const json = redact(JSON.stringify(report, null, 2));
if (args.report) fs.writeFileSync(path.resolve(args.report), `${json}\n`);
console.log(json);
if (!report.ok) {
	console.error(redact(`\n[harness] FAILED: ${report.error?.message ?? 'a step failed'}`));
	process.exit(report.n8n.version ? 1 : 2);
}
console.error(`\n[harness] passed on n8n ${report.n8n.version} (package ${report.package.version}) in ${(report.durationMs / 1000).toFixed(1)} s`);
