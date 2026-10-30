# Changelog

## Unreleased

- The credential notice no longer ends with a link that n8n draws like plain text ("Open the setup guide"). It now points at the underlined **docs** link n8n shows above the form, which opens the same page. README: the button is **Execute step**, as n8n names it.

## 0.3.1

What a person meets on the first day, found by using the node against the production API.

- **The credential says what you need.** A notice at the top lists the account, the connected number and the API key, with the page that goes through it step by step, the volume a new number can send in its first week and the Free plan allowance. The credential and all three nodes now open the same documentation page.
- **Errors that stop a new user say what to do next.** `warmup_limit_exceeded` gives the day-by-day volume (50, 200, 500, 1,000 and 2,000) and how long until the count starts again at midnight UTC. `messages_quota_exceeded` and `contact_quota_exceeded` link to the plan page and give the reset date when the answer has one. `number_not_connected` and `not_authenticated` link to Numbers and API keys.
- **The node panel reads as the node.** n8n shows the description of the instant trigger above the list of actions of the grouped Turbo Notify node, so that description now describes the whole node.
- **`User-Agent: turbo-notify-n8n/<version>`** on every request, including the credential test, so Turbo Notify can tell n8n traffic apart.
- **A first workflow to import** (`send-first-message.json`) and notes about the Free plan in the other examples.
- README opens with what to do before the first message and the limits of the first day.

## 0.3.0

A breaking release: nobody had built on 0.2.x, so the nodes were redesigned instead of kept compatible. Re-add the nodes in workflows that used 0.2.x.

**Two triggers.** *Turbo Notify Trigger* is now a webhook (instant, signature checked, duplicates skipped). The polling trigger is now *Turbo Notify Polling Trigger* and listens to every event type the server emits (43, up from 13), or to all of them when none is chosen. Its Number option is a picker.

**Every value from an earlier node.**
- **Auto-Detect** recipient: one value that can be a phone number, a contact ID or a group ID.
- Contact and Group are pickers (list or ID) everywhere, including the Get Many filters. The plain ID fields are gone.
- Contact card phones as a list from an earlier node (**Phones Input**: JSON), emails as JSON.
- Numbers, dates (ISO text, epoch milliseconds, Luxon), booleans such as "false" and the text of an expression are understood. Dates in another format are refused with a hint instead of read as another date.

**Outputs for the next node.** Message steps return `id` (the message ID, replacing `message_id`), `number_alias` or `number_id` (the number used) and, for sends and the typing indicator, `to`. **Simplify** is on by default for Get too, and a simplified message keeps its `text`.

**New.** The API credential has a **Webhook Signing Secret** for the instant trigger, which refuses to start without it. Triggers have an **Any Event** option, and a test run shows the first delivery whatever the filters say. Operations: Send Typing Indicator, Message > Get Quota, Number > Get, Event > Get Many. A **Quoted Message ID** on the content sends. **Remind Before (Minutes)** replaces the two reminder fields. The `operation` value of the typing indicator is `sendTypingIndicator`.

**Removed.** The MIME Type option (it did nothing). The idempotency key moved from Additional Fields to its own **Options**.

**Safer bulk sends.** A send that came too early waits for the time the API asks and tries again (up to 3 times). Real runs set an Idempotency Key so Retry On Fail inside the same run never sends twice. Every item is checked before the first request. A repeated typed key for a different message is refused. Failures tell n8n why (rate limit, quota, credential, configuration, service unavailable), and the text a person reads survives n8n's own wrapping.

**Polling trigger.** Reads a two-minute look-back window and skips what it already handed on, so same-second and late-visible events are no longer lost.

**Smaller.** Requests time out after 30 seconds (reads) or 60 seconds (writes). A Base URL ending in `/v1` works. An empty Get Many filter and an unknown media type are refused. Clear messages for an empty value, an event ID where a message ID belongs, a server answer, a timeout and an unreachable server. Continue On Fail adds a `hint`.

## 0.2.1

- The package now publishes through the npm Trusted Publisher under the `@turbo-notify` scope (no token). No change to the nodes.

## 0.2.0

- The package moves to the Turbo Notify npm organization: it is now `@turbo-notify/n8n-nodes-turbo-notify`. Install it under the new name; the old name `n8n-nodes-turbo-notify` is deprecated and points here. Workflows that use the nodes need the new package installed (the node type is now `@turbo-notify/n8n-nodes-turbo-notify.turboNotify`).
- Clearer package description, more search keywords, and search aliases on both nodes (whatsapp, wa, notify).

## 0.1.1

- Message Delete now reports `deleted: true` next to what the API returned, so the next step of a workflow can check it. The package publishes through the npm Trusted Publisher (no token) from this release on.

## 0.1.0

First release.

- Credential Turbo Notify API (API key, tested with GET /v1/usage).
- Node Turbo Notify: Message (send text, media, location, contact card, calendar event and link button; reply, react, edit text, edit caption, delete, get status, get, get many), Contact, Group and Number.
- Node Turbo Notify Trigger: polling over GET /v1/events.
