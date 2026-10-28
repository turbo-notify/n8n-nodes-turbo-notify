# Changelog

## 0.1.1

- Message Delete now reports `deleted: true` next to what the API returned, so the next step of a workflow can check it. The package publishes through the npm Trusted Publisher (no token) from this release on.

## 0.1.0

First release.

- Credential Turbo Notify API (API key, tested with GET /v1/usage).
- Node Turbo Notify: Message (send text, media, location, contact card, calendar event and link button; reply, react, edit text, edit caption, delete, get status, get, get many), Contact, Group and Number.
- Node Turbo Notify Trigger: polling over GET /v1/events.
