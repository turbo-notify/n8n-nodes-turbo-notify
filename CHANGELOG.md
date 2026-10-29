# Changelog

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
