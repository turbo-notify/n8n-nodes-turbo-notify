# @turbo-notify/n8n-nodes-turbo-notify

Turbo Notify connects a WhatsApp number to your account and gives you an API for it. This package adds Turbo Notify to n8n:

- **Turbo Notify** node: send text, images, video, audio, documents, stickers, locations, contact cards, calendar events and link buttons; reply, react, edit and delete messages; show typing; check delivery status; read messages, contacts, groups, numbers and events. It also works as a tool for an AI Agent.
- **Turbo Notify Trigger** node: starts a workflow the moment something happens (a message arrives, a message is delivered or read, a number disconnects, a quota runs low). It is a webhook, so it is instant.
- **Turbo Notify Polling Trigger** node: the same events, checked at the interval you choose. It works on every plan and needs no public address.

Turbo Notify links your own WhatsApp number to your account as a linked device, the same way WhatsApp Web does. It is an independent service, not affiliated with Meta, and it does not use the WhatsApp Business Platform API. Messages follow your WhatsApp account's own rules, so read the [WhatsApp business policy](https://www.whatsapp.com/legal/business-policy/) and the [good practices](https://docs.turbonotify.com/en/general/abuse/) before you send in bulk.

- [Install](#install)
- [Credentials](#credentials)
- [Your first message](#your-first-message)
- [Turbo Notify node](#turbo-notify-node)
- [Triggers](#triggers)
- [Example workflows](#example-workflows)
- [Using Turbo Notify from n8n AI agents](#using-turbo-notify-from-n8n-ai-agents)
- [Errors](#errors)
- [Development](#development)

## Install

In n8n, open **Settings > Community Nodes**, choose **Install** and enter `@turbo-notify/n8n-nodes-turbo-notify`. On n8n Cloud the node is listed in the nodes panel once n8n has verified the package.

On a self-hosted n8n you can also install it from the command line, in the folder n8n uses for community nodes (`~/.n8n/nodes` by default):

```bash
npm i @turbo-notify/n8n-nodes-turbo-notify
```

Restart n8n afterwards. See n8n's guide to [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

Before you use the node you need a Turbo Notify account with your WhatsApp number connected, and an API key.

1. Sign in to the [dashboard](https://dashboard.turbonotify.com). Under **Numbers**, connect your main number if you have not yet. Without a connected number every send is refused with `number_not_connected`.
2. Under **API keys**, create a key. Use the template **AI agent (MCP)**. The name refers to the MCP server, but the scopes it selects are exactly the ones this package uses: `messages:send`, `messages:read`, `contacts:read`, `groups:read`, `numbers:read` and `events:read`. A workflow that only sends can use the **Transactional notifications** template instead. **Full access** also works, but gives the workflow more than it needs. The key value is shown once: copy it.
3. In n8n, create a **Turbo Notify API** credential and paste the key into **API Key**. Leave **Base URL** as it is. Select **Save**: n8n tests the key by calling `GET /v1/usage`, which works with any valid key.

**Webhook Signing Secret** is only for the instant trigger: see [Turbo Notify Trigger](#turbo-notify-trigger-instant).

| Operation | Scope the key needs |
|---|---|
| Message: Send (all kinds), Reply, React, Edit, Delete, Send Typing Indicator | `messages:send` |
| Message: Get, Get Status, Get Many, Get Quota | `messages:read` |
| Contact: Get, Get Many | `contacts:read` |
| Group: Get, Get Many | `groups:read` |
| Number: Get, Get Many, and the number list in the **Number** field | `numbers:read` |
| Event: Get Many, and the Polling Trigger | `events:read` |

The **Number**, **Contact** and **Group** lists in the editor need `numbers:read`, `contacts:read` and `groups:read`. Without them you can still type the value or map it from an earlier node.

Keys are not tied to one number: within its scopes, a key reaches your main number and all extra numbers. Treat it like a password. If it leaks, revoke it in the dashboard and create a new one.

## Your first message

1. Add a **Turbo Notify** node and choose the credential.
2. Keep **Resource** on Message and **Operation** on Send Text. **Number** is `main`.
3. Under **Phone Number** type your own number with the country code and a `+`, for example `+5511977770001`. Write something under **Text**.
4. Select **Test step**. The output looks like this:

```json
{
  "status": { "state": "pending", "at": "2026-10-28T10:00:00Z", "error": null },
  "id": "msg_0198d3c5a1b24d3e9f01a2b3c4d5e6f7",
  "number_alias": "main",
  "to": { "number": "+5511977770001" }
}
```

`pending` means Turbo Notify accepted the message. Whether it was delivered or read arrives later: see [Get Status](#message) and the [triggers](#triggers).

## Turbo Notify node

Every field takes a fixed value, a value mapped from an earlier node (`{{ $json.phone }}`) or any other n8n expression. The node runs once for each input item, so with 200 incoming rows it sends 200 messages, each with its own recipient and text. **Number** is the number to use: pick it from the list, or choose **By Alias or ID** and type its alias (`main` for the main number) or its `num_...` ID, or map it.

### Message

| Operation | What it does |
|---|---|
| Send Text | Sends a text of up to 4096 characters. `@5511977770001` (digits, no +) mentions that person. |
| Send Media | Sends an image, video, audio, document or sticker from a public web address. Caption for image, video and document, file name for document. |
| Send Location | Sends a map location. |
| Send Contact Card | Sends a contact card with 1 to 10 phone numbers and optional emails. Set **Phones Input** to JSON to give the phones as a list from an earlier node, such as `{{ $json.phones }}`. |
| Send Calendar Event | Sends an event invitation. WhatsApp shows the time only on WhatsApp Business accounts. Add **Remind Before (Minutes)** for a reminder. |
| Send Link Button | Sends a message with a button that opens a link. |
| Send Typing Indicator | Shows "typing" in a chat while your workflow (or an AI step) prepares the answer, and marks that chat's unread messages as read. Needs the Lone Wolf plan or higher. |
| Reply | Replies to an earlier message, quoting it. To answer a message from a trigger, map **Message ID** to `{{ $json.data.id }}`. |
| React | Reacts with an emoji. An empty emoji removes yours. Needs the Lone Wolf plan or higher. |
| Edit Text, Edit Caption | Changes a message you sent, within 15 minutes of sending. |
| Delete | Deletes a message you sent. The output has `deleted: true`, which means Turbo Notify accepted the request. WhatsApp finishes the deletion a moment later. |
| Get Status | Returns `pending`, `sent`, `delivered`, `read` or `failed`, with the reason when it failed. |
| Get Quota | How many messages the number can still send in this billing cycle. Use it before a big send. |
| Get, Get Many | Reads messages. Get Many filters by group, contact and direction. |

The recipient of a send is a **Phone Number** (with country code and a leading `+`, such as `+5511977770001`), a **Contact** or a **Group** (both picked from a list, or mapped by ID). Choose **Auto-Detect** when one value from an earlier node can be any of the three: the node tells a phone number, a `ct_` ID and a `grp_` ID apart. Digits without `+` are refused, never guessed: build the value with `{{ '+' + $json.phone }}`. Sending to a group needs the Business plan or higher. The content sends (everything except Send Text) can quote an earlier message with **Quoted Message ID** under **Additional Fields**.

**What the next node receives.** Every message step returns the API answer plus `id` (the message ID), the number that was used (`number_alias`, or `number_id` when you gave a `num_...` ID, the same names Get, Get Many and the triggers use) and, for sends and the typing indicator, the recipient as sent (`to`). `{{ $json.id }}` feeds Get Status, Reply, React, Edit or Delete after any message step, and `{{ $json.data.id }}` after a trigger. `status` is an object: use `{{ $json.status.state }}`. Values of the input row stay available with `{{ $('Name of the previous node').item.json.column }}`.

**Sending many messages.**

- **Spacing.** Each number has a minimum gap between sends that depends on the plan. When Turbo Notify answers that a message came too early, the node waits the time it asks for and tries again, up to 3 times. A quota that is used up is never retried.
- **No double sends.** **Retry On Fail** in the node settings re-runs the whole node, so on real runs (not when you click Test step) the node sets an Idempotency Key by itself. It is the same when n8n repeats an item and different for every item, so a repeat inside the same run never sends a message twice. When the node is a tool of an AI Agent, each call counts as a new run: give the agent a key of your own, for example the ID of the customer's order.
- **Your own key.** Under **Options**, **Idempotency Key** should differ for every item, such as the order number from an earlier node. One fixed value sends only the first message, and the node refuses a key that is repeated for a different message in the same run.
- **Checked first.** The node reads and checks every item before it sends the first one, so one invalid row stops the run with nothing sent. With **Continue On Fail** the other rows still go out and the invalid one reports what to fix.
- **Retry execution.** Retrying an execution from the editor creates a new execution and sends the items that already went out again.

### Contact, Group, Number, Event

- **Contact: Get, Get Many.** Get Many filters by name, phone, how the contact first appeared and whether you messaged them in the current billing cycle.
- **Group: Get, Get Many.** Get Many can include groups the number has left.
- **Number: Get, Get Many.** Get reads one number with its connection status, which is handy to check before a bulk send. Get Many lists the main and extra numbers and filters by status to find numbers that need attention.
- **Event: Get Many.** Reads the list of what happened on your numbers, newest first, filtered by type, number and time. Use it to catch up on events a workflow missed while it was off.

### Return All, Limit, Simplify

Get Many operations return one n8n item per result. **Return All** follows the API cursor until there is nothing left. Otherwise **Limit** (default 50) caps the result. **Simplify** is on by default and keeps the main fields (at most 10): turn it off for the full objects. It is on for **Get** too, and a simplified message keeps its `text`. Filters that are added must be filled in: an empty one is refused instead of returning everything.

## Triggers

Both triggers hand on the whole event: `id`, `type`, `organization_id`, `number_alias`, `number_id`, `created_at` and `data`. Choose one or more event types, or **Any Event** (message, number, contact, group, quota and storage events).

- For a received message, `data.from.number` is the sender (digits only, without `+`) and `data.id` the message ID. A message from a group has `data.to.group_id`.
- `data.preview` is the first 50 characters of the text. To read the whole message, add **Message > Get** with **Message ID** `{{ $json.data.id }}`: the text is in `text`.
- To message the sender with Send Text, set **Phone Number** to `{{ '+' + $json.data.from.number }}`, or use **Reply**.
- For several events, add a **Switch** on `{{ $json.type }}`.
- The event `id` is stable if you want your own deduplication.

### Turbo Notify Trigger (instant)

A webhook: Turbo Notify calls n8n the moment the event happens.

1. Add the trigger. Copy its **Production URL**. To try it first, copy the **Test URL**, select **Listen for test event** and send a message, then put the Production URL back and activate the workflow: the dashboard holds one address, and n8n answers 404 on a URL that is not listening.
2. In the [dashboard](https://dashboard.turbonotify.com), under **Webhooks**, paste the URL and type a secret: a long random value (Turbo Notify does not generate one). Select **Save settings**. Only an owner or an admin can save. The address must be public HTTPS: a local n8n needs a tunnel.
3. In the n8n credential, put the same value under **Webhook Signing Secret**. The trigger refuses to start without it.

Every delivery is checked against the secret (the signature header) and refused when the signature is wrong or the delivery is more than five minutes old. **Verify Signature** can be turned off to try things out. Under **Options**, **Ignore Duplicates** (on by default) skips an event that arrives twice, because Turbo Notify delivers each event at least once, and **Number** limits the trigger to one number.

A Turbo Notify organization has **one** webhook address. If you already receive webhooks somewhere else, use the Polling Trigger, or forward the events from there. Webhook delivery needs the Lone Wolf plan or higher. On Lone Wolf an event gets exactly one attempt, so one that finds n8n down is not delivered again: catch up with **Event > Get Many** (**Created After**), or use the Polling Trigger. Business and above retry up to six times.

A test run (**Listen for test event**) shows the first delivery whatever the filters say, because n8n stops listening after one.

### Turbo Notify Polling Trigger

Checks for new events at the interval you set under **Poll Times** and starts the workflow once per event, oldest first. It reads `GET /v1/events`, so it works on every plan, needs no public address and no webhook setup. Use it on the Free plan, behind a firewall, or when the organization's webhook address is taken.

- The first time the workflow is activated the trigger starts from now and does not run for past events. If you change the events or the number afterwards, it starts from now again.
- It reads the last two minutes again on every check and skips what it already handed on, so an event that becomes visible a moment late is not lost.
- Use **Test step** to see the most recent matching event as sample data.

Polling means a delay of up to the interval (one minute at the shortest).

## Example workflows

Import a file from [`examples/`](examples) with **Import from File** in the workflow menu, then choose your credential in each Turbo Notify node. The phone numbers in the examples are made up. Use your own.

- [`answer-private-messages.json`](examples/answer-private-messages.json): the Polling Trigger starts on every received message, skips groups, shows typing and answers with Reply. The typing step needs the Lone Wolf plan: on the Free plan it fails and the workflow goes on.
- [`answer-with-ai.json`](examples/answer-with-ai.json): the same, but it first reads the whole message with Get and passes it through a step where you plug in your AI model, then replies with its answer.
- [`notices-from-a-list.json`](examples/notices-from-a-list.json): sends a different text to every row of a list. Replace the Code node with your sheet or database.
- [`check-delivery.json`](examples/check-delivery.json): sends a message, waits, reads its status and branches when it failed (put your own steps on each branch).
- [`form-to-whatsapp.json`](examples/form-to-whatsapp.json): when someone submits an n8n form, send them a WhatsApp text.

## Patterns

- **Send a file from n8n.** The API takes a public HTTPS address, never the file itself, so there is no binary input. Upload the file with the n8n node of your storage (S3, R2, Google Drive, Dropbox), create a link that stays valid for a few minutes, and map it to **Media URL**. Turbo Notify downloads it before sending. Files can be up to 16 MB (image, audio) or 100 MB (video, document).
- **Ask a question and wait for the answer.** Send a message with **Send Link Button** whose button opens `{{ $execution.resumeUrl }}`, then add a **Wait** node set to resume on a webhook call. Or start a second workflow with the trigger on `message.received`, and match the sender.

## Using Turbo Notify from n8n AI agents

There are two ways to give an n8n AI Agent access to your WhatsApp.

**1. This node as a tool.** Connect the Turbo Notify node to the **Tools** input of an AI Agent node.

- Use one tool node per job and rename it (for example `send_whatsapp_text`). Set its description yourself, because every Turbo Notify tool otherwise shares the same text.
- Set **Recipient Type** to Auto-Detect and let the agent fill **To** and **Text** with `$fromAI('to', ...)` and `$fromAI('text', ...)`.
- Give the agent its own idempotency key if a retried call must not send twice.
- `pending` is not delivered: the agent should not tell a customer that a message arrived.

On a self-hosted n8n, community nodes work as tools only when `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` is set; managed plans may not allow it.

**2. The MCP server.** n8n's **MCP Client Tool** node can connect to the Turbo Notify MCP server, which exposes the same API as ready-made tools with descriptions written for agents. In the MCP Client Tool node:

- **Endpoint**: `https://mcp.turbonotify.com` (it speaks Streamable HTTP, so use an n8n version whose MCP Client Tool offers that transport)
- **Authentication**: Bearer Auth, with a credential whose token is a Turbo Notify API key (the **AI agent (MCP)** template fits)

The connection is described in the [MCP server guide](https://docs.turbonotify.com/en/general/mcp-server/). Use the node for steps you want fixed in the workflow, and the MCP server when the agent decides what to do.

## Errors

When Turbo Notify refuses a request, the node stops with the reason and what to change. Common ones:

| Code | Meaning |
|---|---|
| `not_authenticated` | The API key is wrong, revoked or expired. Create a new one. |
| `insufficient_scope` | The key lacks a scope. The message names it. |
| `number_not_connected` | The number is not connected to WhatsApp. Reconnect it in the dashboard. |
| `messages_quota_exceeded`, `contact_quota_exceeded` | The allowance for the billing cycle is used up. It resets when the cycle turns. |
| `feature_not_available` | The plan does not include it, for example sending to groups or the typing indicator. |
| `edit_window_expired` | A text or caption can be edited only within 15 minutes. |
| `send_rate_spacing`, `rate_limit_exceeded` | Too fast for the plan. The node waits and tries again up to 3 times before it stops. |

If Turbo Notify cannot be reached or does not answer in time, the message says so. For a send, check **Message > Get Many** with Direction **Sent** before you run it again, because the message may have gone out. All codes are listed in the [error reference](https://docs.turbonotify.com/en/reference/errors/).

Turn on **Continue On Fail** in the node settings to keep the workflow going: the failed item then carries the message in `error` and what to change in `hint`.

## Development

```bash
npm install
npm test        # Jest unit tests with mocked n8n helpers
npm run lint    # n8n community node lint
npm run build
```

The package has no runtime dependencies. It reads no files and no environment variables, and talks only to the address in the credential. The signature of a webhook delivery is checked with the Web Crypto API that Node.js provides.

Releases are published to npm from GitHub Actions with a provenance statement (`.github/workflows/publish.yml`). Run `npm run release` to tag a version.

## Resources

- [Turbo Notify documentation](https://docs.turbonotify.com)
- [API reference](https://docs.turbonotify.com/en/reference/api/)
- [Webhooks](https://docs.turbonotify.com/en/messages/webhook/)
- [Support](https://docs.turbonotify.com/en/help/support/)

## License

[MIT](LICENSE)
