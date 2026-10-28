# n8n-nodes-turbo-notify

Turbo Notify connects a WhatsApp number to your account and gives you an API for it. This package adds Turbo Notify to n8n:

- **Turbo Notify** node: send text, images, video, audio, documents, stickers, locations, contact cards, calendar events and link buttons; reply, react, edit and delete messages; check delivery status; read messages, contacts, groups and numbers.
- **Turbo Notify Trigger** node: start a workflow when a message arrives, or when a message you sent is delivered or read.

Turbo Notify links your own WhatsApp number to your account as a linked device, the same way WhatsApp Web does. It is an independent service, not affiliated with Meta, and it does not use the WhatsApp Business Platform API. Messages follow your WhatsApp account's own rules, so read the [WhatsApp business policy](https://www.whatsapp.com/legal/business-policy/) and the [good practices](https://docs.turbonotify.com/en/general/abuse/) before you send in bulk.

- [Install](#install)
- [Credentials](#credentials)
- [Turbo Notify node](#turbo-notify-node)
- [Trigger](#trigger)
- [Example workflows](#example-workflows)
- [Using Turbo Notify from n8n AI agents](#using-turbo-notify-from-n8n-ai-agents)
- [Errors](#errors)
- [Development](#development)

## Install

In n8n, open **Settings > Community Nodes**, choose **Install** and enter `n8n-nodes-turbo-notify`. On n8n Cloud the node is listed in the nodes panel once n8n has verified the package.

On a self-hosted n8n you can also install it from the command line, in the folder n8n uses for community nodes (`~/.n8n/nodes` by default):

```bash
npm i n8n-nodes-turbo-notify
```

Restart n8n afterwards. See n8n's guide to [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

Before you use the node you need a Turbo Notify account with your WhatsApp number connected, and an API key.

1. Sign in to the [dashboard](https://dashboard.turbonotify.com). Under **Numbers**, connect your main number if you have not yet. Without a connected number every send is refused with `number_not_connected`.
2. Under **API keys**, create a key. Use the template **AI agent (MCP)**. The name refers to the MCP server, but the scopes it selects are exactly the ones this package uses: `messages:send`, `messages:read`, `contacts:read`, `groups:read`, `numbers:read` and `events:read`. A workflow that only sends can use the **Transactional notifications** template instead. **Full access** also works, but gives the workflow more than it needs. The key value is shown once: copy it.
3. In n8n, create a **Turbo Notify API** credential and paste the key into **API Key**. Leave **Base URL** as it is. Select **Save**: n8n tests the key by calling `GET /v1/usage`, which works with any valid key.

| Operation | Scope the key needs |
|---|---|
| Message: Send (all kinds), Reply, React, Edit, Delete | `messages:send` |
| Message: Get, Get Status, Get Many | `messages:read` |
| Contact: Get, Get Many | `contacts:read` |
| Group: Get, Get Many | `groups:read` |
| Number: Get Many, and the number list in the **Number** field | `numbers:read` |
| Turbo Notify Trigger | `events:read` |

Keys are not tied to one number: within its scopes, a key reaches your main number and all extra numbers. Treat it like a password. If it leaks, revoke it in the dashboard and create a new one.

## Turbo Notify node

Every operation has a **Number** field. Pick the number from the list, or type its alias (`main` for the main number) or its `num_...` id.

### Message

| Operation | What it does |
|---|---|
| Send Text | Sends a text of up to 4096 characters. `@5511977770001` (digits, no +) mentions that person. |
| Send Media | Sends an image, video, audio, document or sticker from a public web address. Caption for image, video and document, file name for document. |
| Send Location | Sends a map location. |
| Send Contact Card | Sends a contact card with 1 to 10 phone numbers and optional emails. |
| Send Calendar Event | Sends an event invitation. WhatsApp shows the time only on WhatsApp Business accounts. |
| Send Link Button | Sends a message with a button that opens a link. |
| Reply | Replies to an earlier message, quoting it. To answer the message that just arrived, use Send Text. |
| React | Reacts with an emoji. An empty reaction removes yours. |
| Edit Text, Edit Caption | Changes a message you sent, within 15 minutes of sending. |
| Delete | Deletes a message you sent. |
| Get Status | Returns `pending`, `sent`, `delivered`, `read` or `failed`, with the reason when it failed. |
| Get, Get Many | Reads messages. Get Many filters by group, contact and direction. |

The recipient of a send is a **Phone Number** (with country code and a leading `+`, such as `+5511977770001`), a **Contact** (`ct_...` id) or a **Group** (`grp_...` id). Sending to a group needs the Business plan or higher.

A send is accepted asynchronously. The node returns `message_id` and a `pending` status right away. The final outcome arrives later: use **Get Status**, or the Trigger with `message.sent`, `message.delivered`, `message.read` or `message.send.failed`.

**Idempotency Key** (under **Options** of Send and Reply) prevents a duplicate when a step is retried. If the node runs again with the same key on the same number, the message is not sent twice. Use something stable, such as an order id.

### Contact, Group, Number

- **Contact: Get, Get Many.** Get Many filters by name, phone, how the contact first appeared and whether you messaged them in the current billing cycle.
- **Group: Get, Get Many.** Get Many can include groups the number has left.
- **Number: Get Many.** Lists the main and extra numbers with their status. Filter by status to find numbers that need attention.

### Return All, Limit, Simplify

Get Many operations return one n8n item per result. **Return All** follows the API cursor until there is nothing left. Otherwise **Limit** (default 50) caps the result. **Simplify** is on by default and keeps the main fields (at most 10). Turn it off for the full objects.

## Trigger

**Turbo Notify Trigger** checks for new events at the interval you set under **Poll Times** and starts the workflow once per event. It reads `GET /v1/events`, so it works on every plan, needs no public address and no webhook setup.

- **Events**: choose one or more of Message Received, Message Sent, Message Replied, Message Delivered, Message Read, Message Send Failed, Message Reacted, Message Edited, Message Deleted, Message Calendar Response, Number Connected, Number Disconnected and Contact First Messaged.
- **Options > Number Alias**: only events of one number. Empty means every number.
- The first time the workflow is activated the trigger starts from now and does not run for past events. If you change the events afterwards, it starts from now again.
- Each output item is the full event: `id`, `type`, `organization_id`, `number_alias`, `number_id`, `created_at` and `data`. For a received message, `data.from.number` is the sender (digits only, without `+`) and `data.preview` the start of the text. A message from a group has `data.to.group_id`.
- Each event runs the workflow once, oldest first. The event `id` is stable if you want your own deduplication.
- Use **Test step** to see the most recent matching event as sample data.

Polling means a delay of up to the poll interval (one minute at the shortest). If you need events within seconds, register a webhook in the dashboard under **Webhooks** and receive it with n8n's Webhook node. The [webhook guide](https://docs.turbonotify.com/en/messages/webhook/) shows how to check the `X-Webhook-Signature` header. A Turbo Notify organization has one webhook address, so this package does not register one for you.

## Example workflows

Import a file from [`examples/`](examples) with **Import from File** in the workflow menu, then choose your credential in each Turbo Notify node.

- [`form-to-whatsapp.json`](examples/form-to-whatsapp.json): when someone submits an n8n form, send them a WhatsApp text. The Idempotency Key is built from the execution id, so a retry of the same run does not message them twice.
- [`reply-to-received-message.json`](examples/reply-to-received-message.json): the Trigger starts on every received message and the node answers the sender from the same number. To skip group messages, add an **If** node that checks that `{{ $json.data.to.group_id }}` is empty.

The phone numbers in the examples are made up. Use your own.

## Using Turbo Notify from n8n AI agents

There are two ways to give an n8n AI Agent access to your WhatsApp.

**1. This node as a tool.** The Turbo Notify node can be connected to the **Tools** input of an AI Agent node, and the agent picks the operation and fills the fields. Community nodes as tools depend on your n8n version and settings, so check the n8n documentation for your installation.

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
| `feature_not_available` | The plan does not include it, for example sending to groups. |
| `edit_window_expired` | A text or caption can be edited only within 15 minutes. |

All codes are listed in the [error reference](https://docs.turbonotify.com/en/reference/errors/). Turn on **Continue On Fail** in the node settings to keep the workflow going: the failed item then carries the message in an `error` field.

## Development

```bash
npm install
npm test        # Jest unit tests with mocked n8n helpers
npm run lint    # n8n community node lint
npm run build
```

The package has no runtime dependencies. It reads no files and no environment variables, and talks only to the address in the credential.

Releases are published to npm from GitHub Actions with a provenance statement (`.github/workflows/publish.yml`). Run `npm run release` to tag a version.

## Resources

- [Turbo Notify documentation](https://docs.turbonotify.com)
- [API reference](https://docs.turbonotify.com/en/reference/api/)
- [Support](https://docs.turbonotify.com/en/help/support/)

## License

[MIT](LICENSE)
