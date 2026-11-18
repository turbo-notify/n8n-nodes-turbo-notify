# Send WhatsApp notices to a list and track delivery with Turbo Notify

An n8n workflow template for the moment you must tell many people the same thing (a class change, a delivery update, a payment due date, an event change) and want to know what happened to each message. Tested on n8n 2.45.5.

Someone allowed to send opens a password protected form, pastes `name` and `phone` (two columns copied from a sheet work, so do commas and semicolons) and writes the text once. The workflow cleans the numbers, drops duplicates and the people on your stop list, checks your WhatsApp quota, sends in paced batches from **your own** number, writes delivered, read and failed back into an n8n Data Table as the news arrives, and sends **you** one WhatsApp summary per batch. The summary is a snapshot: when everyone has a receipt, or at the latest after `report_after_hours` (12 by default). The table keeps updating after it (a read receipt can arrive a day later).

**Be clear about the plan before you build on it.** The title says bulk, but the Free plan allows 2 different contacts per billing cycle and your own number counts as one, so Free reaches **one customer at most**. Lone Wolf reaches 100 contacts and 1,800 messages a cycle (see "Plan and limits").

Not affiliated with Meta or WhatsApp. It uses the [Turbo Notify](https://turbonotify.com) community node, which links your own WhatsApp number as a linked device. Read the [WhatsApp business policy](https://www.whatsapp.com/legal/business-policy/) and the [good practices](https://docs.turbonotify.com/en/general/abuse/) before you send in bulk, and send only to people who expect your messages.

## Words used on this page

* A **row** is one line of the `notices` table: one person of your list, in one submission of the form.
* A **batch** is one submission of the form. Its **batch id** (for example `20261117-1030-ab3`) is shown in the summary and written on every row of the batch, so you can find the rows of a summary in the table.
* **`no_receipt`** is the status of a message WhatsApp has told nothing about (no delivered, no read, no failure) for `report_after_hours`. It is not a failure: the phone may simply have been off. If the news arrives later, the row moves to `delivered` or `read`.
* A **receipt** is the news that a message was delivered to the phone or read.

## Before you use it

The note on the canvas is short on purpose. What did not fit in it is here.

- **Plan limits.** The Free plan reaches 2 contacts per billing cycle (yours counts, so one customer in practice) and Lone Wolf reaches 100. See "Plan and limits".
- **API key scopes.** Choose `messages:send`, `messages:read` and `events:read` when you create the key: the scopes of a key cannot be changed afterwards.
- **n8n must be reachable and active.** The people who use the form need a public HTTPS address of your n8n, and the workflow must stay active. After a pause the Polling Trigger catches up.
- **People who ask to stop.** End your text with "Reply STOP if you do not want these notices", add anyone who asks to stop to `stop_list`, tell people why they get these messages and delete old rows from the table. See "People who ask to stop".
- **Tested on** n8n 2.45.5, on n8n Cloud and self-hosted.

## What it does

| Flow | Starts with | What happens |
|---|---|---|
| New batch | the form **New batch form** (Basic Auth) | Each line is split on a TAB (a spreadsheet paste), otherwise on `;`, otherwise on `,`. The phone is normalised to `+` and digits only where that is certain. Invalid lines, duplicates and stop list lines are kept in the table with a status and a reason. A batch is refused before anything is saved when it goes over a cap or has no message. The form answers as soon as the lines are checked. |
| Send | the end of the new batch flow | Reads the quota once, marks every row as "to send" or "skipped" with its reason, then sends only what fits (one message stays free for your summary), in batches of `batch_size`, one batch at a time, with the key `<batch id>-<row id>` so a repeat can never send twice. Rows that do not fit are marked `skipped_quota`, rows queued for too long `skipped_stale`, rows the API holds back `held`. |
| Track | the **WhatsApp by Turbo Notify Polling Trigger** on `message.delivered`, `message.read` and `message.send.failed` | Every minute at the shortest. A receipt for one of your messages carries your message id in `data.id` (its `direction` says `inbound` and its `origin` `native`: the recipient's phone sent it). The matching row moves forward to `delivered`, `read` or `failed` with the reason. A row never goes backwards (read stays read) and news about messages that are not in the table is ignored. |
| Close | the **Every hour** schedule | A row that is still `sent` with no news for `report_after_hours` becomes `no_receipt`, so the batch can close. A late receipt still upgrades such a row. |
| Summary | the end of any of the flows above | When every row of a batch is settled (or `report_after_hours` have passed since the batch was saved, checked at the next hourly run) you get ONE WhatsApp message: counts (delivered, "read so far", failed, held, not sent), the names and reasons of the failures, the quota left. The batch is then marked, so it is never summarised twice. A batch whose rows were all skipped for quota is settled at once and summarised in the same run. |
| Setup | the manual trigger **Create the notices table (run once)** | Creates the data table with its 12 columns. Does nothing if it already exists. |

27 working nodes, one Edit Fields node (**Settings**) with every value a person may change, and nine sticky notes.

### Phone numbers and the list

* Paste `name`, a TAB, `phone` (copy two columns from your sheet and paste), or `name;phone`, or `name,phone`, one person per line. A first line `name,phone` is skipped. A line with only a phone is accepted. A name with a comma needs quotes (`"Silva, Ana",+5511977770008`) or a tab.
* The default country code is `55` (Brazil), changeable in Settings (`default_country_code`). A number is accepted only when it is certain:

| Typed | Result |
|---|---|
| `+5511977770001`, `+55 11 97777-0001`, `005511977770001` | accepted as typed |
| `5511977770001` (13 digits) | accepted |
| `11977770001`, `(11) 97777-0001`, `011 97777-0001` (area code and the 9 digit mobile) | `+55` is added |
| `1177770001` (10 digits, no ninth digit) | `invalid_phone`: it could be a landline or an old mobile, so it is not guessed |
| `12345`, `abc` | `invalid_phone` with the reason |

With another default country code, only numbers that start with that code or with `+` are accepted. Every phone the workflow sends starts with `+` (the node refuses a phone without it).

### The message

The **Message** field of the form is required. Write the text once and put `{name}` where the name goes, for example:

> Hello {name}, the class on Friday moved to 7 pm. Reply here if you cannot come. Reply STOP if you do not want these notices.

The Settings value `default_message` ships **empty** on purpose, so a forgotten message can never reach your list. A submission with no message (or only spaces) is refused and nothing is saved or sent. Leave `default_message` empty unless you replace the form with another source that may send an empty text.

### Duplicates, held lines, stale lines

* **Duplicates**: inside a batch the second line with the same number is `duplicate`. Against earlier rows, a number that already got, or is about to get, **the same final text** in the last `dedupe_days` days is `duplicate`. The same person with another text is a new notice. `dedupe_days` = `0` switches the second check off.
* **Held**: WhatsApp side protection refuses the same text to more than 20 recipients in the last hour from one number (`429 duplicate_burst_blocked`, see [Rate limits](https://docs.turbonotify.com/en/messages/rate-limits/#related-errors)), and a number that sends far more than it gets replies (`429 reply_ratio_too_low`). Those rows become `held` (not failed) with a plain reason, and the summary says "held: the same text went to more than 20 people in an hour, personalise the text with {name} or wait". Put `{name}` in the text (the text then differs per person) or wait, then paste the held lines into the form again: held rows are not treated as duplicates. The workflow never changes a text to get around a limit: that is against the [usage rules](https://docs.turbonotify.com/en/general/abuse/#turbo-notify-usage-rules). These two refusals are documented but could not be provoked on purpose (see "What this test does not prove").
* **Stale**: a line still `queued` after `queued_max_age_hours` (24 by default) is marked `skipped_stale` and appears in the summary, instead of going out days later with an unrelated batch. This is decided **when the next batch is submitted**: nothing marks a queued line by itself in between, not even the hourly check.

### Lines that failed or were not sent

Paste them into the form again. Dedupe is by phone and final text, so people who already got the text are skipped and only the missing ones are sent. There is no retry button: that keeps the workflow small and the rule easy to say.

If Turbo Notify cannot read your quota (the call fails), nothing is sent. The form had already answered "Batch received", the n8n execution shows the error "Could not read your quota", and the lines stay `queued`. The next batch you submit sends them first, unless they are older than `queued_max_age_hours` by then (they are marked `skipped_stale` instead).

If the number is disconnected the sends fail one by one and the rows become `failed` with `number_not_connected` and the hint of the API. The summary needs the same number, so it waits until you reconnect and is sent by the next event or the next hourly run (the n8n execution shows the error meanwhile). Set an n8n error workflow if you want to be told.

## Setup

You need a Turbo Notify account with your WhatsApp number connected and about ten minutes. It works on **n8n Cloud** (n8n verified this community node on 2026-11-16, enable *Verified Community Nodes* in the Cloud admin panel) and on **self-hosted n8n** (2.45.5 tested).

1. **Install the community node** `@turbo-notify/n8n-nodes-turbo-notify` (tested with version 1.5.15): Settings, Community Nodes, Install. See [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/).
2. **Create the Turbo Notify API key and credential.** In the [Turbo Notify dashboard](https://dashboard.turbonotify.com), connect your number under Numbers and create an API key under API keys with the scopes `messages:send`, `messages:read` and `events:read` (the key template **AI agent (MCP)** includes all three). The scopes are chosen when the key is created: to change them later, create a new key. In n8n create a credential **Turbo Notify API** and paste the key. n8n does not fill the credential in on import: select it in **each** of the four Turbo Notify nodes (**Get message quota**, **Send the notice**, **Send the summary to the owner** and **New delivery and failure events**).
3. **Import** `workflow.json`. n8n gives the form its own random address on import: do not replace it with a short name, anybody could guess it.
4. **Create the form password.** Create a **Basic Auth** credential named `Form access (Basic Auth)` with a user and a strong password and select it in **New batch form**. The form address and the password stay only with the people allowed to send: anyone who has both can message your list.
5. **Create the table.** Run **Create the notices table (run once)** (Execute workflow from that trigger). It makes a data table named `notices` with 12 text columns: `name`, `phone`, `message`, `status`, `message_id`, `error`, `batch_id`, `label`, `sent_at`, `delivered_at`, `read_at`, `reported_at`. Every Data Table node finds it **by name**, so there is nothing to select.
6. **Fill in Settings** (the **Settings** node, every value is explained in its note): at least `owner_phone`, your own number with the country code and `+`. It **must be a different phone from the number linked to Turbo Notify**: the summary is sent from the linked number to this phone, and it must be a phone you read. Until you set it, the form refuses every batch with a message that says so.
7. **Choose the number (only if you have several).** The number that sends is `number` in Settings (it is read by **Get message quota** and both Send nodes). To send from another number, set `number` in Settings **and** pick the same number in the Polling Trigger options (**New delivery and failure events**, Options, Number): that option only filters the events the trigger reads. With one number, leave both alone.
8. **Activate** the workflow. Open the production address of **New batch form** (the node shows it), sign in and send a first batch **with your own phone on two lines** (`Ana,+55...` and `Bruno,+55...`, the same number twice): you receive one notice, the second line is marked `duplicate`, and the summary reaches you once the delivery is confirmed.

n8n must be reachable over **HTTPS** by the people who use the form (not `localhost`, not a tunnel that sleeps) and must stay **active**: the form, the Polling Trigger and the hourly check only work while the workflow is active.

**If n8n is off or the workflow is deactivated for a while**, the trigger catches up when it is active again. It remembers the last event it read and looks back from there with two minutes of overlap (Turbo Notify keeps events for 90 days), so the news that arrived meanwhile is applied once. Only the very first activation, or a change of the events or of the number in the trigger options, starts from "now". News is applied to rows younger than `track_days`. The hourly check that closes silent messages does not run while the workflow is inactive.

### Settings

| Field | Default | Meaning |
|---|---|---|
| `owner_phone` | `+55XXXXXXXXXXX` | Your own number: summaries go here. Must be changed, and must be a different phone from the number linked to Turbo Notify. |
| `number` | `main` | Alias of the Turbo Notify number that sends. Read by Get message quota and both Send nodes, never taken from the form. To send from another number, also pick it in the Polling Trigger options (that option only filters the events). |
| `batch_size` | `10` | Messages sent before each pause. |
| `pause_between_batches_seconds` | `150` | Pause after each batch, so the number's own queue can empty. A number sends about one message every 15 seconds in a burst (seen in a real API run) and a message that waits more than 5 minutes in that queue fails with `message_timeout`: use at least `batch_size` x 15 seconds. |
| `dedupe_days` | `3` | Window for the duplicate check. `0` switches it off. |
| `report_after_hours` | `12` | A sent row with no news for this long becomes `no_receipt`, and an unfinished batch older than this is summarised anyway (at the next hourly run), with the rows still waiting counted. Why 12: a phone that is off sends no receipt, and the summary of its batch would wait for it. Twelve hours gets you the summary the same day. A late receipt still updates the table. |
| `track_days` | `3` | News is applied to rows younger than this. |
| `queued_max_age_hours` | `24` | A queued line older than this is marked `skipped_stale` when the next batch is submitted. |
| `max_recipients_per_submission` | `200` | A longer list is refused. |
| `max_message_length` | `1000` | A longer text is refused (WhatsApp stops at 4096). |
| `daily_cap` | `500` | Messages the workflow accepts in 24 hours, across batches. A batch that would pass it is refused whole. |
| `default_message` | empty | Leave it empty: the form requires a message (see "The message"). Used only when a message arrives empty from another source. `{name}` is replaced by the name. |
| `default_country_code` | `55` | Added to numbers typed without `+`. Change it for another country. |
| `stop_list` | empty | Phones that must never get a notice, separated by commas, with `+` and the country code (any format the form accepts works). See "People who ask to stop". |

## Plan and limits

Sending needs no special plan, and the Polling Trigger works on every plan. What the plan changes is how many people and messages you can reach (per number, per billing cycle, [Quota and usage](https://docs.turbonotify.com/en/usage/quota/)):

| Plan | Messages | Different contacts | Pace |
|---|---|---|---|
| Free | 300 | **2** | one send every 6 seconds |
| Lone Wolf | 1,800 | **100** | faster |

* **On Free this template reaches one customer at most**, because the summary goes to you and you count as the second contact. Use Free to try it with your own number.
* **A number connected this week** is limited by WhatsApp warm up: 50 messages on its first day, then 200, 500, 1,000 and 2,000 until the seventh day. A send the API refuses for that reason is marked `skipped_quota` with the reason.
* The workflow reads **Get Quota** once per run and sends only what fits, keeping one message for your summary. It cannot see the contact allowance in advance: a send the API refuses for it is marked `skipped_quota` with the reason (`402 contact_quota_exceeded`), and the people already counted in this cycle still work.
* The same text to more than 20 people in an hour is held (see above): use `{name}`.

## People who ask to stop

* Send only to people who expect your messages, and end every text with a line such as **Reply STOP if you do not want these notices**.
* **Read the replies in the WhatsApp app** on the phone of the sending number: this workflow does not read them, and a reply that says "stop" is easy to miss. A text that invites a reply also keeps a number healthy.
* When someone asks to stop, act **at once**: open the **Settings** node, find the field `stop_list` and type the person's phone with `+` and the country code, separated by commas, for example `+5511977770001, +5511977770002`. Save the workflow. The next batch marks those phones `opted_out` and never sends them anything. Also remove the person from your own list or sheet.
* Repeated unwanted messages get numbers restricted by WhatsApp. See [Protect your number](https://docs.turbonotify.com/en/general/abuse/).

## Data

* The `notices` table holds names, phones and message texts of your recipients, for as long as you keep the rows. **Delete old rows** you do not need (an n8n Data Table can be emptied from its page, or add a step that deletes rows older than a few months), and tell the people you message why they receive messages from this number.
* Turbo Notify keeps message content for a limited time (see [Quota and usage](https://docs.turbonotify.com/en/usage/quota/)); the table is your own copy.

## Security

* The form asks for a user and a password (Basic Auth). Without them the page and the submission answer `401` and nothing starts.
* The number that sends, the owner and every limit come from **Settings**. A form submission carries only three things: the list of recipients, the text and an optional label. Extra fields posted to the form are ignored.
* The text is only searched for `{name}`. Anything else in it (for example `{{ ... }}`) is sent as plain text, never evaluated.
* Caps: lines per submission, text length and a daily cap across batches. An over-cap submission is refused with a clear answer on the form and nothing is saved.
* A refusal is answered with status `422` and a JSON body that carries the text. n8n's own form page shows that text whatever the status (read from the form page source of n8n 2.45.5: when a node answers, the page prints `formSubmittedText` before it looks at the status). The heading of that page is n8n's own "Form Submitted" in both cases.

## Things to know

* A row marked `failed` with `message_timeout` may still arrive: look before you paste it again.
* Changing `number` while messages are in flight stops the tracking from finding them: leave it alone until a batch is summarised.
* Overlapping runs are safe: a row sent twice reuses its idempotency key, so the API answers with the same message.
* A batch with nothing to send (every line invalid or duplicate) is summarised by the next run that reaches the summary step: the next batch, the next delivery news or the hourly check.
* The form answers before the rows are saved (a few milliseconds earlier, inside n8n). If the save fails, the run shows an error in the executions list.
* Where a step has two outputs that can both run (**Is this row to be sent?**), every row was saved before the split, so the order between the two branches, which n8n takes from their position on the canvas, does not change what is sent or reported.

## Customization ideas

* Replace the form with your own source (a Google Sheet, a CRM, a webhook): produce the same three fields and keep **Settings** in front. A swap is a suggestion, it is not tested here.
* Send the summary to a group or to more than one person.
* Add a second text after delivery (for example a satisfaction question) by reading rows with status `delivered`.
* Link the table to your own system with the `message_id`, which also appears in the Turbo Notify events.

## Test record

Tested on 2026-11-17, **n8n 2.45.5** (image `n8nio/n8n:2.45.5`, digest `sha256:9f6d0a5987ab5a297c4b0b38fbf1a22285dd1364551478e93f03d506908fa74c`, pinned: not `latest`), fresh instance, SQLite, one run per container, with the package `@turbo-notify/n8n-nodes-turbo-notify` **1.5.15** (built from this repository, installed as a community node).

| | |
|---|---|
| `workflow.json` | SHA-256 `222861f7e4707b72a7b4b38a1ac213b83922a69a772920da710657ecc9ebddce` (the exact file the mock run below imported) |
| Notes reformatted | Notes reformatted 2026-11-18 after n8n review feedback on T1; node logic unchanged; mock scenario rerun: 635 assertions, 0 failed (n8n 2.45.5, package build 1.5.16). The file before the reformat had the SHA-256 `eb7a9c6f44929948b095c7aeea20dbf9b99d4ef666cbf4c7a9ccc4cffb3442fd`, and the real API runs below were made on it. `workflow.png` was not regenerated and still shows the previous notes. |
| Method | a stateful simulation of the Turbo Notify public API (`templates/harness`, built from `openapi.json`), driven over HTTP, plus live round trips of the Polling Trigger |
| Result | passed on the final file: 24 steps, 635 assertions, 0 failed, 188 s (run again on 2026-11-17 after the last change of the canvas layout; `workflow.png` is a screenshot of this file in the n8n 2.45.5 editor) |

Tested end to end in n8n 2.45.5 against a simulated Turbo Notify API (same routes, answers, events and errors as the public contract). This exact file was also run against the real API with real WhatsApp delivery to a test number (see "Real API runs").

Run it again (from the module folder, Docker running, `npm install` done once):

```bash
node templates/harness/run-template.mjs templates/bulk-notices-with-delivery-tracking/workflow.json \
  --scenario templates/bulk-notices-with-delivery-tracking/test/scenario.mjs --run-id t2 --ports 5692,9211,9212 \
  --image n8nio/n8n:2.45.5
```

The workflow was imported exactly as exported. Nothing else was edited. The only differences from what you import are:

* **Settings values**, set before the import: `owner_phone` = `+5511977770009`, `batch_size` = 2 and `pause_between_batches_seconds` = 1 (so nine rows make five passes through the loop; the Wait node itself is not shortened). During the run the scenario changes other Settings values the way a person would (and puts them back): the placeholder `owner_phone`, `max_recipients_per_submission` = 3, `max_message_length` = 20, `report_after_hours` = 0.0006 (about 2 seconds), `queued_max_age_hours` = 0.003 (about 11 seconds), `stop_list` and `daily_cap`.
* **The Data Table nodes**: the harness points them at the table it creates by id. The scenario points them back to the exported value (**By Name** `notices`) before anything runs, then deletes the table and creates it with the **Create the notices table** branch, so the documented setup is what is tested.
* **The credentials**: `Turbo Notify API` points at the simulation and `Form access (Basic Auth)` is a Basic Auth credential the scenario creates (user and password known to the scenario only).
* **The simulated API**: quota 500, a message becomes `sent` after 0.3 s and stays there until the scenario moves it, plan spacing of 4 seconds in the spacing step. Faults are injected on purpose (a 429 body for `duplicate_burst_blocked` and `reply_ratio_too_low`, a 402, a 422, a 403 on the quota read).
* **Delivery news**: the events the simulation produced (same envelope and `data` as the real receipts: `data.id` is our message id, `direction` inbound, `origin` native) are fed to the Polling Trigger as pinned items, and the workflow behind it runs from there. Two steps (7c and 7d) also activate the workflow and let the real Polling Trigger poll the simulation.
* The form is called over real HTTP on its production address with the `Authorization` header, with the workflow active only for the length of one submission.

### Branches and what each one proved

| Step | Branch | Proved |
|---|---|---|
| 0a | Setup | Every Data Table node refers to `notices` by name. The form address is the node's own random id (`path` equals `webhookId`, a uuid), not a guessable name. `default_message` ships empty, `report_after_hours` ships as 12, the form's Message field is required and the form says so, the Settings note says where the sending number is chosen. No note sits inside or touches another note and no node is half inside a note, no note carries a `Section:` prefix. There is no Retry branch and no connected-number check. |
| 0b | Setup | With no table the run stops with n8n's "not found". **Create the notices table** makes it with the 12 text columns and a second run does not create a second one. |
| 1 | New batch, refusals | The placeholder `owner_phone`, an empty list, an empty message, a message of only spaces, more lines than `max_recipients_per_submission` and a text over `max_message_length` are each refused with `422` and a clear answer on the form, the run ends before **Save the rows as queued**: nothing is saved, nothing is sent. |
| 2 | New batch and send | 14 pasted lines (header, `,`, `;` and **TAB**, spaces, parentheses, `0` prefix, 13 digit numbers, a line with only a number, a quoted name with a comma): 9 valid, 3 `invalid_phone` with their own reason (ten digits without the ninth digit is not guessed), 1 `duplicate` inside the batch. `{name}` merged (and removed cleanly when there is no name). Get Quota runs once for the whole run and there is no `GET /v1/numbers/main`. Nine sends in row order, every phone with `+`, key `<batch id>-<row id>`, five loop passes with the Wait. The form was answered while the batch was still being sent. No summary yet (rows wait for news). |
| 3 | Duplicates | The same list again: 10 `duplicate` rows, 3 `invalid_phone`, nothing sent, the loop is not entered. The same numbers with another text are a new notice and go out. The batch with nothing to send is summarised by the next run that reaches the summary step. |
| 4 | Send, spacing | With the plan spacing enforced the API answers `429 send_rate_spacing` and the node waits and retries: all three rows `sent`, none failed. |
| 5 | Send, quota short | 3 messages left: 2 sent, one kept for the summary, 3 rows `skipped_quota` with the reason and the reset date. There is no separate alert. |
| 5b | Send, nothing fits | One message left: both rows `skipped_quota`, the loop is not entered, and the batch is summarised in the same run ("not sent, quota short 2"). |
| 5c | Quota read fails | The quota call is refused: the form had already answered `200`, the run ends with "Could not read your quota, so nothing was sent" on the planning step, the line stays `queued` and nothing is sent, not even a summary. The next submission sends the waiting line first, with the key of its own batch. |
| 6 | Send, failures | A refused send (`422`) is `failed`; a contact quota refusal (`402`) is `skipped_quota`; `duplicate_burst_blocked` and `reply_ratio_too_low` (`429`) are `held` with their own reason, not retried by the node, and the next rows still go out; a recipient that fails later stays `sent` until the failure event arrives. |
| 6b | Held | The same lines through the form again are sent: held rows are not duplicates. |
| 7a, 7b | Track (pinned news) | `sent` to `delivered` to `read` with the times of the events, a failure event gives `failed` with `code: message`, Get Status is never called (0 requests in the whole run). Events of messages that are not in the table change nothing, a replay of the same news changes nothing, a delivered event after a read one does not bring the row back, read then delivered in the wrong order inside one poll still ends `read` with both times, a failure event for a delivered row is ignored. |
| 7c | Track (live trigger) | The activated Polling Trigger polled the simulation with the three type filters, ran by itself for a delivery made after activation, handed on one event (no history), and the row moved to `delivered`. |
| 7d | Track after a pause | With the workflow inactive a message was delivered. Nothing read the news meanwhile. When the workflow was activated again the trigger handed the event on exactly once, the row moved to `delivered` with the time of the event, and a further activation did not hand it on again. |
| 8 | Summary | One summary per batch the moment every row is final: counts with "read so far", the number of people (never "rows"), failures with names and reasons and one full stop, the held reasons, the quota shortfall, the quota left without a plan name, "This is a snapshot: the notices table keeps updating", how to send the lines again, key `report-<batch>`; later runs report nothing again; every row marked. |
| 9 | Hourly check | With `report_after_hours` 12 a fresh `sent` row is left alone. After the age passes it becomes `no_receipt` with its reason, the batch is summarised once ("no delivery news yet 1"), and a late delivered event upgrades the row, clears the note and sends no second summary. |
| 10 | Stale and replay | A queued line older than `queued_max_age_hours` stays `queued` through the hourly check and is marked `skipped_stale` when the next batch is submitted; it appears in a summary, nothing goes to its number, a row queued for too long is not replayed either. A young row left queued by a crash is sent again with the same key and the API answers with the same message: no second message. |
| 11 | Stop list | Two numbers on `stop_list` (typed in two formats) become `opted_out`, the third line is sent. |
| 12 | Number down | A disconnected number: the sends fail, the rows are `failed` with `number_not_connected`, the form still confirmed, the run ends with an error on the summary send and the batch is not marked reported; after reconnecting, the hourly check sends the summary once. |
| 13 | Password and page | Page and submission with no credentials, a wrong password and a wrong user answer `401`: no run starts, no row, no message. The form page states the same-text rule and the spreadsheet paste, and its script prints `formSubmittedText` of the answer before it looks at the status (`useResponseData` is true). |
| 14 | Safety | Extra fields posted to the form (`number`, `owner_phone`, `batch_size`, `flow`, `recipients`, `message`, `daily_cap`, `stop_list`) change nothing. A text with `{{ 1 + 1 }}` and `={{ $env.PATH }}` is sent as typed. |
| 15 | Daily cap | A batch that fits goes out, the next is refused whole with the numbers in the answer and nothing inserted, one more row reaches the cap exactly, the next is refused. |
| 16 | All | No two rows share a message id, every id exists in the API, every sent phone starts with `+`, and Get Status was never called. |

### Contract facts used (and where they come from)

* Receipts: `message.delivered` and `message.read` are inbound and native events whose `data.id` is the message you sent; `message.send.failed` carries `data.error` with `code`, `message` and `hint` and `id` is null only when no record was created: [Webhooks and events](https://docs.turbonotify.com/en/messages/webhook/) (field table and "Failure events"). Matching by `data.id` and never by direction was also seen on the real API.
* Quota and plan table (Free 2 contacts and 300 messages, Lone Wolf 100 contacts and 1,800 messages), what counts toward the quota, `tier` in capitals: [Quota and usage](https://docs.turbonotify.com/en/usage/quota/). The summary does not print the tier.
* `duplicate_burst_blocked` (the same text to more than 20 recipients in the last hour) and `reply_ratio_too_low`, warm up 50, 200, 500, 1,000, 2,000, Free spacing: [Rate limits](https://docs.turbonotify.com/en/messages/rate-limits/) and [Protect your number](https://docs.turbonotify.com/en/general/abuse/) (no circumventing limits).
* The node answers a refused send with `error` holding the message and the code in brackets and `hint`, retries only `send_rate_spacing`, `rate_limit_exceeded` and `messages_per_minute_limit_exceeded`: read in the source of package 1.5.15 and shown by steps 4 and 6.
* The Polling Trigger keeps its position between activations, looks back two minutes and hands each event on once; the API keeps events 90 days: the source of package 1.5.15 (`pollState.ts`) and [Polling](https://docs.turbonotify.com/en/messages/polling/).
* Form Trigger 2.1: the form page prints the answer text of a node whatever the status, a new import gets a new random address: read in the sources of n8n 2.45.5 (the form page template and the editor), not seen in a browser.

### What this test does not prove

* **The simulated run sent no message to WhatsApp.** Delivery, read and failure are whatever the simulation was told to produce. A separate run of this exact file against the real API (see "Real API runs") proved the form with its password, the quota read, one real send, the live Polling Trigger on a real delivery and a real read, the owner summary, the resubmit and the failure path of an over long text; the held, stale, stop list and cap handling stay simulation only.
* **`duplicate_burst_blocked` and `reply_ratio_too_low`.** Existence and wording come from the docs only; they were never triggered on the real API, so their real response body, and whether a `Retry-After` comes with them, are not proven. The simulation answers a 429 with the documented code.
* **The `message.send.failed` payload.** None exists on the account that was used, so the real shape (and which failures send an event) is the documented one, not an observed one. A failure after the send is also only caught while the workflow is active.
* **The Polling Trigger on a real busy account**: pagination of hundreds of events, the two minute look-back under load, and a minute of delay on every state. Only live round trips against the simulation, and one against the real API.
* **The form in a browser.** The form is exercised over HTTP. That its page prompts for the Basic Auth password, blocks an empty required Message field, shows the refusal text with status `422` and that an imported copy gets a new address are read from the n8n 2.45.5 sources, not seen in a browser.
* **The Data Table drop down.** Table references are by name and are never picked in the UI here.
* **n8n Cloud.** Not run on Cloud: it is the same node and the same core nodes, and n8n verified the community node, but this template was tested on the self-hosted image only.
* **Free plan limits** (the real Free refusals), **real scale** (hundreds of rows, a pause of 150 seconds, the 5 minute queue limit of a real number), **the billing cycle turning**, **number warm up** (the template only reacts to `warmup_limit_exceeded`) and **replies from the people who get the notice**.
* **Overlapping runs at the same time** are reasoned about, not run: every send carries its row key and a row only moves forward, guarded by the status it was read with.
* **A very busy machine:** on a loaded host n8n sometimes answers a `500` or `503` for a moment (seen once on a refusal while two other containers ran). That run was repeated.

### Real API runs

Two groups of runs, both against `https://api.turbonotify.com` with a production key of an account whose plan is **CUSTOM**, not Free, n8n 2.45.5 (image digest `sha256:9f6d0a5987ab5a297c4b0b38fbf1a22285dd1364551478e93f03d506908fa74c`), package `@turbo-notify/n8n-nodes-turbo-notify` 1.5.15. Every message went to one test number of the account owner, from a different number of the same owner, and every message was deleted for everyone at the end. The guard of the harness was on (recipient check, budget, request log).

**Final run, 2026-11-18, on the file before the notes were reformatted (it differs from the current file only in sticky notes)** (`eb7a9c6f44929948b095c7aeea20dbf9b99d4ef666cbf4c7a9ccc4cffb3442fd`).

| Part | Result on the real API |
|---|---|
| Table | **Create the notices table** made the table with its 12 columns. Passed |
| Password | The form page, a submission with no credentials and a submission with a wrong password all answered `401`: no run started, nothing was sent. Passed |
| Form | One batch over HTTP with Basic Auth and the workflow active: a TAB separated line, a comma separated duplicate of the same number and a malformed line (`abc`) became `sent`, `duplicate`, `invalid_phone`. Exactly one real send went out, with the text merged (`{name}`), the phone with `+` and the key `<batch id>-<row id>`; the row stored the real message id. Passed |
| Quota | One **Get Quota** read in the run (`GET .../messages/quota`, `200`, keys `cycle_end, cycle_start, number_alias, quota, remaining, resets_at, tier, used`, `tier` in capitals). Requests of the run: two event reads by the trigger, the quota read and the send. Get Status was never called. Passed |
| Polling Trigger | The live trigger received the real `message.delivered` (inbound, native, `data.id` is our message id): the row stayed `sent` for about 30 seconds and showed `delivered` with `delivered_at` at the next minute tick (about 40 seconds after the send). Passed |
| Read | The owner's phone read the message about 45 seconds after the delivery and the live trigger moved the row to `read` with `read_at` set (a row stays `read`). Passed |
| Summary | The owner received **one** summary for the batch ("3 people, delivered 1 (read so far 0), invalid number 1, duplicate 1", the quota left without a plan name, the snapshot sentence). It was sent at the delivery, before the read, as designed: the table moved on after it. Passed |
| Resubmit | The same list again: `duplicate`, `duplicate`, `invalid_phone` and **nothing** sent. The hourly check then sent the one summary of that all-duplicate batch, and a second hourly run sent nothing. Passed |
| Failure path (`real-failure.mjs`, 15 assertions) | A text of 4097 characters: the node refused it before any request (no send reached the API), the row was `failed` with `'Text' is too long (4097 characters, the limit is 4096)...`, and the owner summary listed it with one full stop. Probes through the guard: a phone with a letter gets `400 {"error":"invalid_phone_number"}`; the owner number **without** `+` is accepted (`202`), so only the node's own check keeps a phone without `+` from going out. Passed |

What did not go to plan, and what was done:

* **First attempt**, same day: n8n answered `500 Expression timed out` (5000 ms limit of its expression runtime) when the workflow was activated, while the host was heavily loaded by other containers. It happened before any request to the API: 0 messages. The run was repeated once on a quieter host and did not recur.
* **One assertion of the scenario was wrong, not the workflow.** The last step compared the number of messages the real API lists in the time window with the number the harness counted, and another run using the same key had sent a message to the same number in that window (the listing showed 4, the harness had counted 3, none of them from this workflow). The step now checks by message id (every message the harness counted is listed and went to the test number) and records how many messages of other runs were in the window. Steps 0 to 3c passed in that run (60 assertions); the corrected last step was **not run again**, because a second run would exceed the budget of real messages.

Real messages: 3 in the final run (the notice, its summary and the summary of the resubmitted batch) and 2 in the failure run (the summary of the failed batch and the accepted probe without `+`), 5 in all, inside the budgets of 4 and 3. All were deleted for everyone.

Differences from the simulation: the receipt takes the polling interval (about 40 seconds here, the simulation's trigger runs are pinned or polled at once); a `read` receipt really arrives only when a person opens the chat; the real API rejects a letter in the phone and accepts a phone without `+`; the real quota is a plan of 10 million messages (the simulation uses 500, so the quota shortfall branches stay simulation only); sends are paced by the real number (the simulation answers at once).

Not proven by the real runs: a `message.send.failed` event (none was produced, the failure row of the failure run came from the node's own refusal), the two `429` holds, the Free plan limits, a batch of many rows paced at about 15 seconds per message (only one notice was sent), the stale handling, the stop list, the daily cap and the other Settings caps, and the corrected last step of the scenario.

Earlier real runs (2026-11-17, earlier revisions of this workflow: revision 1 with Get Status every 15 minutes, revision 2 with the Polling Trigger, SHA-256 `b4b1dc94474ceb55e35f33ea36ed511f73375302e3e697ffe56bcd77fa6a2d32`) showed the same contract: `message.delivered` as an inbound native event with `data.id` equal to our message id, a pending message that cannot be deleted (`400`), sends paced per number (about 15 seconds apart in a burst) and the node refusing a phone without `+` itself.

Rerun (it sends about 3 real messages, then 2; the number comes from the environment, the key from a file, neither is in the repository):

```bash
export TN_REAL_OWNER_PHONE='+<your test number>'
node templates/harness/run-template.mjs templates/bulk-notices-with-delivery-tracking/workflow.json \
  --real-api --api-key-file <file with the line "- Value: tn_live_..."> --max-sends 4 \
  --scenario templates/bulk-notices-with-delivery-tracking/test/real.mjs --image n8nio/n8n:2.45.5 \
  --run-id t2real --ports 5692,9211
node templates/harness/run-template.mjs templates/bulk-notices-with-delivery-tracking/workflow.json \
  --real-api --api-key-file <same file> --max-sends 3 \
  --scenario templates/bulk-notices-with-delivery-tracking/test/real-failure.mjs --image n8nio/n8n:2.45.5
```
