# Template test harness

Dev tooling for the workflow templates in `templates/`. It runs a workflow JSON, exactly as exported, in a
throwaway n8n against a stateful mock of the Turbo Notify public API, then lets a scenario script assert what
the workflow did.

```
templates/harness/
  mock-api.mjs        stateful mock of the public API (Node 20+, no dependencies)
  fake-llm.mjs        OpenAI compatible server with scripted replies, for AI Agent templates
  run-template.mjs    the runner: <workflow.json> --scenario <scenario.mjs>
  lib/                n8n in Docker, REST client, scenario context, assertions
  selftest/           the harness tested against itself (and the smallest example scenario)
```

Nothing here ships in the npm package (`files` is `dist` only). The mock mode needs no secret; the optional real mode reads a key from a file you pass (see below) and never writes it anywhere.

## Requirements

- Node 20 or newer (tested on 22), Docker, and `npm install` done once in the module (the runner builds the
  package with `npm run build`).
- The image `n8nio/n8n:latest` (pulled by Docker on first use). Pin another version with `--image n8nio/n8n:2.45.5`
  or the environment variable `HARNESS_N8N_IMAGE`.

## Run a template

```bash
node templates/harness/run-template.mjs templates/<slug>/workflow.json --scenario templates/<slug>/test/scenario.mjs
```

stdout is a JSON report, stderr is progress. Exit code: `0` passed, `1` failed, `2` could not start.

| Option | Meaning |
|---|---|
| `--scenario <file>` | the scenario module (required) |
| `--run-id <id>` | names the container `tn-harness-<id>` and the temp home; default random. Use a different id per parallel run |
| `--ports <n8n,mock,llm>` | for example `--ports 5691,9199,9198` (or `--n8n-port`, `--mock-port`, `--llm-port`) |
| `--image <ref>` | n8n image, default `n8nio/n8n:latest` |
| `--skip-build` | do not run `npm run build` first (a build lock protects parallel runs when you do build) |
| `--keep` | leave the container and the temp home for debugging (remove with `docker rm -f tn-harness-<id>`) |
| `--timeout <ms>` | limit for the scenario, default 300000 |
| `--tz <zone>` | time zone of n8n, default `UTC` |
| `--report <file>` | also write the JSON report to a file |
| `--llm` | start the fake LLM even if the workflow does not look like it needs one |

Ports: n8n uses 5690 to 5699 (first free one), the mock API 9099 and the fake LLM 9100. When those are busy the
runner takes the next free port (9201 to 9299 and 9301 to 9399), so several agents can run side by side. Give each
run its own `--run-id` and, to be safe, its own `--ports`.

What a run does, in order: build the package, start the mock (and the fake LLM when needed), copy the built package
to `<temp home>/nodes/node_modules/@turbo-notify/n8n-nodes-turbo-notify` with a `nodes/package.json`, start
`docker run` with `--add-host host.docker.internal:host-gateway`, set the owner, log in, create the
`turboNotifyApi` credential (the mock's address through `host.docker.internal`), create the credentials and data
tables the scenario declares, let the scenario `prepare` the JSON, rewrite credential references to the real ids,
import the workflow, run the scenario. At the end, success or not, it runs `docker rm -f` on its own container and
deletes its temp home. It never touches another container.

The report records `n8n.version` (and the image digest), the package version, the nodes the scenario patched, every
step with its time, the assertion counts and the executions seen. Copy those into the template README as the test record.

## Write a scenario

A scenario is an ES module. Only the default export is required.

```js
export default async function scenario(t) { /* ... */ }

// Optional exports
export const timeoutMs = 120_000;
export const mock = { delays: '300,600,1200', quota: 50, plan: 'business' }; // mock settings at start (delays in ms after the send)
export const llm = true;                                  // start the fake LLM (also automatic for lmChat nodes)
export const credentials = [{ type: 'someApi', name: 'Some API', data: { token: 'x', url: '{{mockDockerUrl}}' } }];
export const tables = [{ name: 'contacts', columns: [{ name: 'phone', type: 'string' }], nodes: ['Read contacts'] }];
export async function prepare(workflow, ctx) { /* edit the "Edit Fields" values the user would type */ return workflow; }
```

- `credentials`: the harness already creates `turboNotifyApi`, and `openAiApi` and `openRouterApi` pointing at the
  fake LLM. Any other credential type a workflow uses must be declared here, otherwise the run stops with a clear message.
  String values accept `{{mockUrl}}`, `{{mockDockerUrl}}`, `{{llmUrl}}`, `{{llmDockerUrl}}`, `{{apiKey}}`, `{{webhookSecret}}`.
- `tables`: Data Tables are created before the import, and every Data Table node whose `cachedResultName` equals
  the table name (or that is listed in `nodes`, or whose name matches `match`) is pointed at the real table.
- `prepare`: templates keep their user settings in one Edit Fields (Set) node. Patch those values here (a test
  phone number, a short delay). The report lists the patched nodes, so the template README can say what was changed.
  Everything else is tested as exported.

### The test context `t`

| Call | What it does |
|---|---|
| `t.run('Trigger node name', { pin })` | manual execution from that node, waits, returns an Execution. `pin` is `{ 'Node name': [item, ...] }` and feeds a trigger with chosen items, the way to test the branches behind a Polling or Instant trigger without waiting |
| `t.activate()` / `t.deactivate()` | activates the workflow (Schedule, Polling and Webhook triggers go live) |
| `t.executionMark()` | highest execution id now, to pass as `since` |
| `t.waitExecutions({ count, since, timeoutMs })` | waits for finished non manual executions, returns them (default timeout 150 s) |
| `t.expectNoExecutions({ since, ms })` | passes when nothing started for `ms` |
| `t.execution(id)` | one execution |
| `t.callWebhook('Webhook node', { body, headers, query })` | calls an activated webhook node |
| `t.webhookTargetFor('Turbo Notify Trigger node', { events })` | makes the mock deliver signed webhooks to the instant trigger |
| `t.tables.create/insert/rows/update/remove/clear(name, ...)` | Data Tables over REST (`rows(name, { where: { col: value } })`) |
| `t.mock.*` | the mock: see below |
| `t.llm.script([...])`, `t.llm.requests` | the fake LLM |
| `t.step(name, fn)` | named step with timing in the report; a failing step stops the scenario |
| `t.assert.equal/ok/match/includes/excludes/subset/count/fail` | assertions with readable failures |
| `t.workflow.node(name)`, `.webhookUrl(name)`, `t.n8n.rest(method, path, body)` | escape hatches |
| `t.waitFor(fn, { timeoutMs })`, `t.sleep(ms)`, `t.logs()` | helpers (`logs` returns the n8n container log tail) |

An Execution has `status`, `nodesRun` (names in order), `ran(name)`, `items(name, { run, output })` (the `json` of
every item a node put out), `first(name)`, `nodeError(name)`, `error` and `describe()`.

### One complete example

`selftest/send-and-track.json` is a manual trigger, Send Text, Wait 3 seconds and Get Status. Its scenario
`selftest/send-and-track.scenario.mjs`:

```js
export default async function scenario(t) {
	const { assert } = t;
	const mark = await t.mock.mark(); // only look at the requests made from here on

	const execution = await t.step('run the workflow from its manual trigger', () => t.run('When clicking Test workflow'));
	assert.equal(execution.status, 'success', execution.describe());

	const sends = await t.mock.sends({ since: mark });
	assert.count(sends, 1, 'one message was sent');
	assert.equal(sends[0].to, { number: '+5511977770001' }, 'recipient');
	assert.equal(sends[0].idempotencyKey, 'selftest-order-1', 'Idempotency-Key header');

	const status = execution.first('Get the status');
	assert.equal(status.status.state, 'delivered', 'state after 3 seconds'); // mock delays: sent 0.5 s, delivered 1 s, read 30 s

	await t.mock.messageState({ message_id: execution.first('Send the text').id, state: 'read' }); // force it, do not wait
	const types = (await t.mock.events()).map((e) => e.type);
	assert.includes(types, 'message.read', 'read event');
}
```

Run it: `node templates/harness/run-template.mjs templates/harness/selftest/send-and-track.json --scenario templates/harness/selftest/send-and-track.scenario.mjs`

The other selftest scenarios show an instant trigger with a data table and a forged delivery
(`instant-inbox.*`), an AI Agent with a scripted tool call (`ai-agent.*`) and a polling trigger (`polling-inbox.*`).

### Things that behave differently in a test

- Test the workflow as exported: do not shorten Wait nodes. If a template waits a day, give the scenario a way in
  that the template itself offers (a Set value in its config node patched in `prepare`, or `pin` plus a manual run
  from the node after the wait). Say so in the template README.
- n8n refuses a polling interval under one minute, so `t.waitExecutions` for a Polling Trigger takes up to a minute
  per tick. For the branches behind the trigger, pin the trigger output instead and run manually.
- Schedule Triggers: run them manually (`t.run('Schedule Trigger')`) instead of waiting for the clock.
- Webhook and Form triggers cannot be started manually through the API (they wait for a test call). Activate and use
  `t.callWebhook`, or pin the trigger output.
- The first poll of a Polling Trigger runs at activation and only records what exists. Create the history before
  `t.activate()` and the new events after it.

## Real API mode (`--real-api`): gate 2, real WhatsApp delivery

The mock proves a workflow against the documented contract. Gate 2 proves it against the real one. With `--real-api`
no mock is started: the workflow runs in the throwaway n8n against `https://api.turbonotify.com` with a real API key,
and **every send reaches WhatsApp**.

```bash
export TN_REAL_OWNER_PHONE='+<the one number that may receive messages>'
node templates/harness/run-template.mjs templates/<slug>/workflow.json \
  --real-api --api-key-file <file with the line "- Value: tn_live_..."> --max-sends 8 \
  --scenario templates/<slug>/test/real.mjs --image n8nio/n8n:2.45.5 --run-id <id> --ports 5691,9201
```

| Option | Meaning |
|---|---|
| `--real-api` | real mode (no mock, no fake LLM unless asked) |
| `--api-key-file <file>` | a file with a line `- Value: tn_live_...`. The key is read at run time, never taken from the command line |
| `--max-sends <n>` | hard budget of accepted sends (default 8). A replay of an idempotent send returns the same message id and does not count |
| `--keep-messages` | by default every message the run created is deleted for everyone when it ends, also after a failure |
| `--customer-key-file <file>` | two-number scenarios (T3): the key of ANOTHER organization whose main number plays the customer who writes to the number under test. Needs env `TN_REAL_PERSONAL_PHONE` (the number under test, with `+`) and `TN_REAL_OWNER_PHONE` set to the customer number. The key file may use `- Value:` or `- Key:` |
| `--no-guard` | n8n talks to the API directly: no recipient check, no budget, no request log. Not recommended |
| env `TN_REAL_OWNER_PHONE` | the only number that may receive a message, with `+`. Never write it into a file of the repository |

What it needs: Docker, the key of an organization whose number is connected, and a second number you own to receive
the messages. What it costs: real messages (count them: the report says `realApi.messagesAccepted`), real quota and
real contacts of that organization. Tell the people who own the receiving phone: invitations and texts will arrive.

**The guard.** n8n's `turboNotifyApi` credential points at a small proxy the harness runs on the host, which forwards
every call to the real API unchanged and answers with what the API answered. The proxy

- refuses (403, never forwarded) a send to any number but `TN_REAL_OWNER_PHONE`, compared by digits,
- refuses every write that is not a send, a reply, a typing indicator, an edit, a delete or a mark as read (no number, pairing or billing calls),
- lets a Reply through only when the message it quotes belongs to a conversation with that number (the proxy looks the message up with the same key), and a typing indicator only towards that number,
- stops at `--max-sends` accepted messages (429 `harness_budget_exhausted`),
- records every request and response (without the `Authorization` header), the equivalent of the mock request log:
  `t.real.guard.requests()`, `.sends()`, `.mark()`, `.messagesAccepted`, `.blocked`.

**Masking.** The key and the owner number are registered as secrets: every line the harness prints, the JSON report and
the `--report` file replace them with `tn_live_***MASKED***` and `<owner test number>` (the number under test of a
two-number run shows as `<number under test>`; Groq `gsk_` and OpenRouter `sk-or-v1-` keys are masked too). A scenario must not echo them
into a place the harness does not control.

**Scenarios** live in `<slug>/test/real.mjs`, the same module shape as a mock scenario, and use `t.real` instead of
`t.mock` (`t.mock` throws in real mode). `export async function cleanup(t)` runs at the end, also after a failure,
before the harness deletes the messages.

| `t.real.` | What it does |
|---|---|
| `ownerPhone` | the receiving number (from the environment) |
| `guard` | the request log and counters of the proxy (see above) |
| `get(path)`, `post(path, body)`, `call(method, path, body)` | direct calls with the key (reads and cleanup deletes) |
| `numbers()`, `quota()`, `contactQuota()`, `message(id)`, `status(id)`, `receipts(id)`, `responses(id)`, `events(query)`, `listSent(limit)` | the reads scenarios need |
| `observe(id, states, { timeoutMs })` | watches a message state until it reaches one of `states`; returns every state seen with its time |
| `deleteMessage(id)` | delete for everyone (never throws) |
| `t.note(name, value)` | records a finding in the report under `notes` |

**Two-number scenarios.** With `--customer-key-file`, `t.real.customer` plays the customer: `verify()` (the key's main number is
the allowed customer number), `send(text)` (plain text, to the number under test only, counted in the same `--max-sends`
budget as the guard's sends), `list(query)`, `status(id)`, `deleteAll()` (run by the harness at the end, also after a
failure). A scenario that uses a real chat model exports `llm = false` so that the fake LLM is not started and declares its
own `openAiApi` credential (for example pointing at an OpenAI compatible provider; read the key from a file at load time and
call `registerSecret` so it is masked). `templates/ai-support-assistant-with-human-handoff/test/real.mjs` is the example.

Do not send anything through `t.real.post` that the guard would refuse: direct calls bypass it, and sending is the
workflow's job. Scenarios assert before every run that can send that no setting, row or form line targets another number.

What real mode cannot do: a guest tapping Going, Maybe or Not going, a person replying, WhatsApp rendering on a phone, and
plan limits other than the plan of the key's organization.

## The mock API (`mock-api.mjs`)

```bash
node templates/harness/mock-api.mjs --port 9099 --key tn_test_harness_key
```

Options (environment variable in brackets): `--port` [MOCK_PORT], `--host` [MOCK_HOST], `--key` [MOCK_API_KEY],
`--delays sent,delivered,read` in ms after acceptance, default `1000,2000,4000` [MOCK_DELAYS], `--quota` [MOCK_QUOTA],
`--contact-quota`, `--plan free|lone_wolf|business|custom` (default business), `--enforce-spacing` and `--spacing-ms`
(plan intervals 6 s, 1.2 s, 0.6 s, 0.4 s).

**Mocked, following `public-docs-web/public/openapi.json` and the docs:** bearer key check (`401 not_authenticated`),
every route the node and its two triggers call (`/v1/numbers/{ref}/...` for send of text, media, location, contact card,
calendar event, link button, reply, react, edit, delete, typing indicator, mark as read, get, list with `group_id`,
`contact_id`, `direction` and cursor, status, receipts, reactions, responses, quota; contacts and groups get and list;
numbers get and list; `/v1/events` with `types[]`, `type`, `number_id`, `number_alias`, `request_id`, `created[gte]`,
`created[lte]`, `starting_after`, `ending_before`, `limit`; `/v1/usage`), the shortcut routes of the main number, id formats
(`num_`, `ct_`, `grp_`, `msg_`, `evt_`, `req_` plus 32 hex), error bodies (`{ "error": "<code>", ... }`, 422 with
`details.errors`), the message lifecycle `pending, sent, delivered, read` with the matching events, failures with a reason and
`message.send.failed`, `Idempotency-Key` (same key and body returns the original, other body is `409
idempotency_key_conflict`, a replay costs no quota), message quota (`429 messages_quota_exceeded` with `Retry-After`), contact quota
(`402 contact_quota_exceeded`), spacing (`429 send_rate_spacing` with `Retry-After`, only with `--enforce-spacing`), plan gating
(`402 feature_not_available` for typing, reactions, group sends, mark as read), `409 number_not_connected`, mentions, previews,
`contact.created` and `contact.first_messaged` events, webhook signing with the documented scheme.

`node templates/harness/selftest/contract.mjs` checks the answers against the response schemas of the OpenAPI document.

**NOT mocked: real WhatsApp delivery.** Nothing reaches a phone. Delivery, read, failure and incoming messages are
whatever the mock is told to produce. A template README should say: "tested end to end in n8n <version> against a
simulated Turbo Notify API (same routes, answers, events and errors as the public contract); no message was sent to
WhatsApp". Also not simulated: message content retention and event expiry, warm-up and the other send protection limits
(use `fault` to inject their 429 answers), API key scopes, the personal account calendar quirk, number pairing and
management routes, media downloads (`media_fetch_failed` and similar come only from `recipient.fail`), edit and delete failure events.

### Control API (`/__test/*`, no auth)

| Call | Purpose |
|---|---|
| `POST /__test/reset` `{ keepConfig }` | back to the state at start (config too, unless `keepConfig`) |
| `POST /__test/config` | `delays`, `plan`, `quota`, `contactQuota`, `enforceSpacing`, `spacingMs`, `subscriptionActive`, `latencyMs`, `apiKey`, `webhookAttempts`, `webhookRetryMs` |
| `POST /__test/inject-message` | an incoming message: `{ from: '+5511977770001', name, text \| audio: { transcript, language } \| image \| location \| document, group, reply_to, number }` becomes a `message.received` (or `message.replied`) event and a readable message |
| `POST /__test/inject-calendar-response` | `{ message_id, from, response: going \| not_going \| maybe (accepted, declined, tentative work too), extra_guests }` |
| `POST /__test/inject-reaction` | a contact reacts to a message |
| `POST /__test/recipient` | `{ number, fail: { code, message, hint }, delays: { sent, delivered, read }, stopAt: sent \| delivered, name }` |
| `POST /__test/message-state` / `message-age` | force a state at once / make a message older (for the 15 minute edit window) |
| `POST /__test/quota` | `{ number, limit, used, remaining }` |
| `POST /__test/group`, `contact`, `number`, `number-status` | create groups, contacts, extra numbers, change a number's status |
| `POST /__test/fault` | `{ method, path (regex), status, body, headers, times, delayMs }`: the next matching requests fail that way |
| `POST /__test/webhook-target` | `{ url, secret, events }`: every new event is delivered signed (retried up to 3 times on non 2xx) |
| `POST /__test/webhook-deliver` | deliver one event again, optionally `tamper: signature \| body \| old-timestamp \| no-signature` |
| `GET /__test/log` | every request received (method, path, query, headers subset, parsed body, response status and body); `?since=<seq>&method=&path=` |
| `GET /__test/messages`, `/events`, `/deliveries`, `/state` | what the mock holds |

In scenarios use `t.mock` (`mark`, `sends`, `requests`, `injectMessage`, `injectCalendarResponse`, `recipient`, `fault`,
`config`, `quota`, `messageState`, `waitForMessageState`, `waitForEvent`, `deliveries`, `redeliver`, ...).
Webhooks reach the instant trigger of the workflow at `http://127.0.0.1:<n8n port>/webhook/<webhookId>/turbo-notify`,
signed with the secret of the credential (`whsec_harness_secret`).

Phone numbers: use only the fictitious `+55119777700xx` range. The mock's own number is `+5511977770000`.

## The fake LLM (`fake-llm.mjs`)

An OpenAI compatible server (`/v1/chat/completions` streaming or not, `/v1/responses`, `/v1/models`,
`/v1/embeddings`). The harness starts it when the workflow has an OpenAI or OpenRouter chat model node and creates the
credentials pointing at it (current n8n uses the Responses API by default; both work). The header of the file explains
how to script replies and tool calls. Example:

```js
t.llm.script([
	{ user: /refund|chargeback/i, reply: 'I am handing you to a colleague.' },
	{ user: /where is my order/i, toolCalls: [{ name: 'find_order', arguments: { id: 'A-100' } }] },
	{ afterTool: /A-100/, reply: (ctx) => `Your order is ready. ${ctx.lastTool}` },
	{ reply: 'OK.' },
]);
// later: t.llm.requests[0].ctx.system, .tools, .lastUser
```

The model never decides anything real: a template that uses an AI step is tested for its wiring, prompts, tool calls
and what it does with the answer, not for the quality of a real model. Say so in the template README.

## Selftest

```bash
node templates/harness/selftest/run.mjs                # contract check, mock behaviour, then the smallest scenario in a real n8n
node templates/harness/selftest/run.mjs --all          # also instant trigger + data table, AI agent, polling (about two minutes)
node templates/harness/selftest/contract.mjs           # mock against openapi.json, no Docker
node templates/harness/selftest/mock-behaviour.mjs     # lifecycle, quota, spacing, idempotency, webhooks, no Docker
```

## Troubleshooting

- `docker run failed ... port is already allocated`: another run uses that port. Pass `--ports` or let the runner pick.
- `n8n did not activate the workflow`: read `n8nLogTail` in the report. A Polling Trigger in a workflow needs a poll
  interval of at least one minute.
- A node shows `The node ... is not installed`: the build is stale. Drop `--skip-build`.
- After `--keep`: `docker logs tn-harness-<id>`, then `docker rm -f tn-harness-<id>` and delete the temp folder named in the report.
