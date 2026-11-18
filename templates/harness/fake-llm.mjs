#!/usr/bin/env node
/**
 * A tiny OpenAI compatible server, so templates with an AI Agent run deterministically.
 *
 *   node templates/harness/fake-llm.mjs --port 9100
 *
 * It answers:
 *   GET  /v1/models              a short list (used by the credential test of n8n)
 *   POST /v1/chat/completions    plain answers and tool calls, streaming or not
 *   POST /v1/responses           the same through the Responses API (non streaming and streaming)
 *   POST /v1/embeddings          a fixed size vector derived from the text
 *
 * In n8n, create an "OpenAI" credential whose Base URL is http://host.docker.internal:9100/v1
 * (the runner does this for you, see the README) and use the OpenAI Chat Model node.
 *
 * HOW A SCENARIO SCRIPTS REPLIES
 * ------------------------------
 * A script is an ordered list of rules. For every request the first rule whose conditions all
 * hold (and that still has uses left) answers. A rule with no condition always matches, so end
 * the list with one as the fallback.
 *
 *   llm.script([
 *     // 1. Choose by regex over the LAST USER message
 *     { user: /refund|chargeback/i, reply: 'I am handing you to a colleague.' },
 *
 *     // 2. Ask the agent to call a tool. The tool must be wired to the agent in the workflow.
 *     //    n8n names a tool after its node, so the name is matched without regard to case or separators.
 *     //    "arguments" is an object; it is sent as the JSON string OpenAI uses.
 *     { user: /where is my order/i, toolCalls: [{ name: 'find_order', arguments: { id: 'A-100' } }] },
 *
 *     // 3. After the tool ran, n8n sends its result back as the last message (role tool).
 *     //    Match it with "afterTool" (regex over that result) and answer with the final text.
 *     { afterTool: /A-100/, reply: (ctx) => `Your order is ready. (${ctx.lastTool})` },
 *
 *     // 4. Other conditions: "system" (regex over the system prompt), "when" (any function of ctx),
 *     //    "times" (the rule is used at most that many times, then skipped).
 *     { system: /billing desk/i, user: /invoice/i, reply: 'Invoices are sent on the 5th.', times: 1 },
 *
 *     // 5. Fallback
 *     { reply: 'OK.' },
 *   ]);
 *
 *   A rule with only a "user" condition does not answer once a tool result is the last message (the
 *   agent would call the tool again and again): answer the tool result with "afterTool" or the fallback.
 *
 *   ctx = { lastUser, lastTool, lastRole, system, messages, tools (names offered), model, request }
 *   "reply" may be a string or a function(ctx) returning a string (for example JSON for a
 *   structured output parser: reply: JSON.stringify({ intent: 'billing' })).
 *   "toolCalls" may be an array or a function(ctx) returning an array.
 *
 * Every request received is kept in llm.requests (the raw body plus the derived ctx), so a
 * scenario can assert what the agent sent: the system prompt, the history, the tools offered.
 *
 * Over HTTP (when the fake runs as its own process): POST /__llm/script with
 *   { "rules": [ { "user": "refund", "flags": "i", "reply": "..." } ] }
 * (regex fields are strings), GET /__llm/requests, POST /__llm/reset.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const hex = (n = 12) => crypto.randomBytes(n).toString('hex');

function textOf(content) {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === 'string' ? part : (part?.text ?? part?.content ?? '')))
			.filter(Boolean)
			.join('\n');
	}
	return content == null ? '' : String(content);
}

/** Messages of a Responses API request (input items) in the chat shape. */
function messagesFromResponses(body) {
	const out = [];
	if (body.instructions) out.push({ role: 'system', content: String(body.instructions) });
	const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : (body.input ?? []);
	for (const item of input) {
		if (item.type === 'function_call_output') out.push({ role: 'tool', content: textOf(item.output), tool_call_id: item.call_id });
		else if (item.type === 'function_call') out.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, function: { name: item.name, arguments: item.arguments } }] });
		else if (item.role) out.push({ role: item.role === 'developer' ? 'system' : item.role, content: textOf(item.content) });
	}
	return out;
}

function toolNames(body) {
	return (body.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean);
}

function contextOf(body, messages) {
	const last = messages[messages.length - 1] ?? {};
	const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
	const lastToolMsg = last.role === 'tool' ? last : null;
	return {
		lastUser: textOf(lastUserMsg?.content),
		lastTool: lastToolMsg ? textOf(lastToolMsg.content) : '',
		lastRole: last.role ?? '',
		system: messages
			.filter((m) => m.role === 'system' || m.role === 'developer')
			.map((m) => textOf(m.content))
			.join('\n'),
		messages,
		tools: toolNames(body),
		model: body.model ?? 'fake-model',
		request: body,
	};
}

const asRegex = (v, flags) => (v instanceof RegExp ? v : v == null ? null : new RegExp(String(v), flags ?? ''));

export function createFakeLlm() {
	let rules = [{ reply: 'OK.' }];
	let requests = [];
	let server = null;

	function pick(ctx) {
		for (const rule of rules) {
			if (rule.times !== undefined && (rule.used ?? 0) >= rule.times) continue;
			const user = asRegex(rule.user, rule.flags);
			const system = asRegex(rule.system, rule.flags);
			const afterTool = asRegex(rule.afterTool, rule.flags);
			if (user && !user.test(ctx.lastUser)) continue;
			if (system && !system.test(ctx.system)) continue;
			if (afterTool && !(ctx.lastRole === 'tool' && afterTool.test(ctx.lastTool))) continue;
			// A rule that is not about a tool result must not answer a tool result with a user rule,
			// otherwise the agent would loop calling the same tool again.
			if (!afterTool && user && ctx.lastRole === 'tool' && !rule.allowAfterTool) continue;
			if (rule.when && !rule.when(ctx)) continue;
			rule.used = (rule.used ?? 0) + 1;
			return rule;
		}
		return { reply: 'OK.' };
	}

	function decide(ctx) {
		const rule = pick(ctx);
		const calls = typeof rule.toolCalls === 'function' ? rule.toolCalls(ctx) : rule.toolCalls;
		if (calls?.length) {
			const offered = ctx.tools;
			const norm = (n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, '');
			const resolved = [];
			for (const call of calls) {
				// n8n names a tool after its node ("Calculator", "Find_order"), so match without regard to case or separators.
				const name = offered.length ? offered.find((o) => o === call.name) ?? offered.find((o) => norm(o) === norm(call.name)) : call.name;
				if (!name) {
					return { text: `[fake-llm] tool "${call.name}" is not offered by the agent (offered: ${offered.join(', ') || 'none'})`, calls: [] };
				}
				resolved.push({ ...call, name });
			}
			return {
				text: null,
				calls: resolved.map((c) => ({
					id: `call_${hex(8)}`,
					name: c.name,
					arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
				})),
			};
		}
		const text = typeof rule.reply === 'function' ? rule.reply(ctx) : (rule.reply ?? 'OK.');
		return { text: String(text), calls: [] };
	}

	const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };

	function chatBody(model, d) {
		const message = d.calls.length
			? { role: 'assistant', content: null, tool_calls: d.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
			: { role: 'assistant', content: d.text };
		return {
			id: `chatcmpl-${hex()}`,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [{ index: 0, message, finish_reason: d.calls.length ? 'tool_calls' : 'stop' }],
			usage,
		};
	}

	function chatStream(res, model, d) {
		const id = `chatcmpl-${hex()}`;
		const created = Math.floor(Date.now() / 1000);
		const send = (delta, finish = null) =>
			res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
		send({ role: 'assistant', content: d.calls.length ? null : '' });
		if (d.calls.length) {
			d.calls.forEach((c, index) => {
				send({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] });
				send({ tool_calls: [{ index, function: { arguments: c.arguments } }] });
			});
			send({}, 'tool_calls');
		} else {
			const words = d.text.split(/(\s+)/).filter(Boolean);
			for (const w of words) send({ content: w });
			send({}, 'stop');
		}
		res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
		res.write('data: [DONE]\n\n');
		res.end();
	}

	function responsesBody(model, d) {
		const output = d.calls.length
			? d.calls.map((c) => ({ type: 'function_call', id: `fc_${hex(8)}`, call_id: c.id, name: c.name, arguments: c.arguments, status: 'completed' }))
			: [{ type: 'message', id: `msg_${hex(8)}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: d.text, annotations: [] }] }];
		return {
			id: `resp_${hex()}`,
			object: 'response',
			created_at: Math.floor(Date.now() / 1000),
			status: 'completed',
			model,
			output,
			output_text: d.text ?? '',
			parallel_tool_calls: true,
			usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
		};
	}

	function responsesStream(res, model, d) {
		const full = responsesBody(model, d);
		let n = 0;
		const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: (n += 1), ...data })}\n\n`);
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
		send('response.created', { response: { ...full, status: 'in_progress', output: [] } });
		full.output.forEach((item, index) => {
			send('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', ...(item.content ? { content: [] } : {}) } });
			if (item.type === 'message') {
				const part = item.content[0];
				send('response.content_part.added', { output_index: index, item_id: item.id, content_index: 0, part: { ...part, text: '' } });
				for (const w of part.text.split(/(\s+)/).filter(Boolean)) send('response.output_text.delta', { output_index: index, item_id: item.id, content_index: 0, delta: w });
				send('response.output_text.done', { output_index: index, item_id: item.id, content_index: 0, text: part.text });
				send('response.content_part.done', { output_index: index, item_id: item.id, content_index: 0, part });
			} else {
				send('response.function_call_arguments.delta', { output_index: index, item_id: item.id, delta: item.arguments });
				send('response.function_call_arguments.done', { output_index: index, item_id: item.id, arguments: item.arguments });
			}
			send('response.output_item.done', { output_index: index, item });
		});
		send('response.completed', { response: full });
		res.end();
	}

	async function readJson(req) {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const raw = Buffer.concat(chunks).toString('utf8');
		return raw ? JSON.parse(raw) : {};
	}

	async function handle(req, res) {
		const url = new URL(req.url, 'http://fake');
		const json = (status, body) => {
			const payload = JSON.stringify(body);
			res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
			res.end(payload);
		};
		try {
			const path = url.pathname.replace(/^\/v1(?=\/)/, '');
			if (req.method === 'GET' && path === '/models') {
				return json(200, { object: 'list', data: ['fake-model', 'gpt-4o-mini', 'gpt-4.1-mini'].map((id) => ({ id, object: 'model', created: 1_700_000_000, owned_by: 'fake-llm' })) });
			}
			if (req.method === 'POST' && path === '/chat/completions') {
				const body = await readJson(req);
				const ctx = contextOf(body, body.messages ?? []);
				requests.push({ endpoint: 'chat', at: new Date().toISOString(), ctx: { ...ctx, request: undefined, messages: ctx.messages }, body });
				const d = decide(ctx);
				if (body.stream) return chatStream(res, ctx.model, d);
				return json(200, chatBody(ctx.model, d));
			}
			if (req.method === 'POST' && path === '/responses') {
				const body = await readJson(req);
				const ctx = contextOf(body, messagesFromResponses(body));
				requests.push({ endpoint: 'responses', at: new Date().toISOString(), ctx: { ...ctx, request: undefined }, body });
				const d = decide(ctx);
				if (body.stream) return responsesStream(res, ctx.model, d);
				return json(200, responsesBody(ctx.model, d));
			}
			if (req.method === 'POST' && path === '/embeddings') {
				const body = await readJson(req);
				const inputs = Array.isArray(body.input) ? body.input : [body.input];
				const vec = (text) => Array.from({ length: 8 }, (_, i) => (crypto.createHash('sha256').update(`${i}:${text}`).digest()[0] / 255) * 2 - 1);
				return json(200, { object: 'list', model: body.model ?? 'fake-embed', data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: vec(String(t)) })), usage: { prompt_tokens: 1, total_tokens: 1 } });
			}
			if (path === '/__llm/script' && req.method === 'POST') {
				const body = await readJson(req);
				rules = (body.rules ?? []).map((r) => ({ ...r }));
				return json(200, { ok: true, rules: rules.length });
			}
			if (path === '/__llm/requests' && req.method === 'GET') return json(200, { count: requests.length, requests });
			if (path === '/__llm/reset' && req.method === 'POST') {
				rules = [{ reply: 'OK.' }];
				requests = [];
				return json(200, { ok: true });
			}
			if (path === '/healthz') return json(200, { status: 'ok' });
			return json(404, { error: { message: `fake-llm: no route for ${req.method} ${url.pathname}`, type: 'invalid_request_error' } });
		} catch (error) {
			return json(500, { error: { message: `fake-llm: ${error.message}`, type: 'server_error' } });
		}
	}

	return {
		/** Replace the script. Rules may carry real RegExp objects and functions. */
		script(list) {
			rules = list.map((r) => ({ ...r }));
		},
		get requests() {
			return requests;
		},
		reset() {
			rules = [{ reply: 'OK.' }];
			requests = [];
		},
		async start(port = Number(process.env.LLM_PORT ?? 9100), host = process.env.LLM_HOST ?? '127.0.0.1') {
			server = http.createServer((req, res) => void handle(req, res));
			await new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, host, resolve);
			});
			return { port: server.address().port, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}` };
		},
		async stop() {
			if (server) await new Promise((resolve) => server.close(resolve));
			server = null;
		},
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const args = process.argv.slice(2);
	const get = (name, fallback) => {
		const i = args.indexOf(`--${name}`);
		return i >= 0 ? args[i + 1] : fallback;
	};
	const llm = createFakeLlm();
	const info = await llm.start(Number(get('port', process.env.LLM_PORT ?? 9100)), get('host', process.env.LLM_HOST ?? '127.0.0.1'));
	console.log(`[fake-llm] OpenAI compatible server on ${info.url}/v1 (script it with POST /__llm/script)`);
	for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => (await llm.stop(), process.exit(0)));
}
