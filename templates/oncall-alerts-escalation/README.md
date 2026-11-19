# On-call alerts that escalate on WhatsApp until someone answers (Turbo Notify)

For a small ops or dev team, an agency, or a shop owner who wants a WhatsApp page next to the normal alerting. Your monitoring tool (or a cron job, or a form) posts an alert. The workflow pages the first person on call on WhatsApp, waits for "OK" and, when nobody answers in time, pages the next person, then the next. The people who were paged are told who took it. When the alert is resolved they are told that too. If nobody answers after the last level, everybody gets one final message and the workflow stops.

## Read this first

- **WhatsApp is an extra channel, not a replacement for a paging service.** Delivery depends on the person's phone, on their connection and on WhatsApp itself. A phone on silent, in airplane mode or with notifications off will not wake anyone, and nothing in this workflow can change that. Use this next to your normal alerting, and decide for yourself whether it is enough for your case. This is not legal or contractual advice.
- **The on-call phones must NOT be the phone linked to Turbo Notify, and neither may `owner_phone`.** That phone cannot page itself: a message to your own chat makes no push notification, and what you type on that phone arrives as a sent message (`message.sent`), not as a received one, so no "OK" from it can ever take an alert. Use the numbers of other people, on their own phones. The workflow cannot check this for you: nothing it calls before sending returns the linked number, and reading it would cost an extra step, so it is documented here, in the sticky note, in the Settings notes and in the red note.
- **The one-minute timer costs n8n executions.** It runs 1,440 times a day, about 43,200 a month. n8n Cloud counts executions per month: on n8n.io/pricing (read on 2026-11-17) the Starter plan lists 2,500, Pro 10,000 and Business 40,000, so check your plan before you activate it there. Self-hosted n8n has no such count. The lever: open `Every minute: look for unanswered alerts`, set the interval to 2 or 5 minutes (about 21,600 or 8,640 runs a month) and set `ack_minutes` to a multiple of it. Escalation then comes up to that interval later. A poll that finds nothing does not start an execution, but every alert, every reply and every other message that reaches your number does.
- **n8n must run all day and all night, and be reachable by your monitoring tool over HTTPS.** The webhook only works while the workflow is active and n8n is up. While n8n is off nothing is paged and nothing escalates. A local n8n needs a tunnel or a public address.
- **A disconnected WhatsApp number cannot page anybody.** Every send is refused while the number is not connected. The workflow records each refusal in the row and fails the run, naming the alert, the phone and the reason (setup step 9 explains how to be told). If the number is down you will not be paged by WhatsApp about it: watch the number in the Turbo Notify dashboard too.
- **It does not run on sample numbers.** The run stops with a plain message while a phone in `Your settings` is the placeholder `+55XXXXXXXXXXX`. Nobody is paged and the poll has already taken the replies of that minute, so activate only after step 6.
- **A reply written while n8n was off is read at the first poll after n8n starts, and escalation may have fired meanwhile.** When n8n starts again, the timer and the poll start at about the same time, so the timer can page the next level before the poll has read the "OK" that was written during the outage. The reply still takes the alert when it is read, but only while its text exists: the text of a message expires after 1 hour on the Free plan and up to 7 hours on Lone Wolf (see [Message retention](https://docs.turbonotify.com/en/messages/retention/)). After that the poll sees a content-removed marker instead of the text and the reply is ignored.
- **Privacy and the token.** The poll reads the events of the whole organization, so the n8n execution list shows the first 50 characters of every message that arrives on your numbers, whoever wrote it. The table holds the phones of the people on call and the text of your alerts. The webhook's header, with your token, is part of every saved execution of the webhook. Set the workflow setting "Save successful production executions" to "Do not save" (failed runs are still saved) or restrict who can open executions, and delete old rows from time to time. A leaked token can page your on-call people and use your message quota: share it only with your monitoring tool and replace the credential value if it leaks. Do not put secrets or customer data in the alert message: it goes to WhatsApp and into the table.

## Make a phone hard to ignore

A silent phone cannot be woken by a workflow, but you can make it much harder to miss:

- Each on-call person saves the number of your WhatsApp as a contact and **sends it one message first**, so a chat exists and the first page is not a message from an unknown number.
- On the phone, **mark that chat as a favourite** and allow it through **Do Not Disturb** (a Focus mode on iPhone, the priority conversations or notification settings on Android).
- **Send a weekly test alert** (a firing alert with a test id, answered with OK, then resolved), so a broken number, a revoked key or a phone that stopped notifying shows up on a quiet day.
- **A number used only to page sends far more than it receives.** Turbo Notify refuses sends with `429 reply_ratio_too_low` when a number sends far more than it gets back, a sign of unsolicited sending (see [Rate limits](https://docs.turbonotify.com/en/messages/rate-limits/) and [Protect your number](https://docs.turbonotify.com/en/general/abuse/)). Every "OK" and every test answer is a reply that helps. If you page many people about many alerts and almost nobody writes back, the sends can be refused, and the workflow then fails the run with that reason. It cannot get around the limit and is not meant to. This refusal exists in the documentation and could not be provoked in the tests.

## Before you use it

The note on the canvas is short on purpose. What did not fit in it is here.

- **Install.** Settings > Community Nodes, see [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/). It works on n8n Cloud (verified node) and self-hosted, tested on n8n 2.45.5.
- **Free plan.** Use at most two different phones in all: `owner_phone` equal to `oncall_phone_2`, or `oncall_phone_2` empty. See "Plans, quota and pace".
- **Polling.** Replies are read by polling, so a confirmation can take up to a minute.
- **Executions.** The one-minute timer runs 1,440 times a day. Check your plan, or set the Schedule Trigger to every 2 or 5 minutes.
- **Error workflow.** Set one, so that you hear about a failed page.
- **The alert body.** See "What your monitoring tool posts".

## What it does

- **Entry (A).** A Webhook receives a JSON alert. It requires a Header Auth credential: a request without the right header is answered `403` by n8n (the same answer for a missing and for a wrong value) and never starts a run. Fields are mapped from names you set (`field_alert_id`, `field_service`, `field_severity`, `field_status`, `field_message`, `field_runbook_url`), so any tool that can post a flat JSON body works. Text is cut (message at `max_text_length`, 300 by default; service at 80), control and direction characters are removed, and a runbook link that is not `http://` or `https://` (or is longer than 500 characters) is dropped. An alert below `min_severity` is ignored. A severity the list does not know, or none, is never ignored.
- **It fails open.** An alert is never refused for its looks. An id may hold any characters (accents, spaces, parentheses: `Servidor Sao Paulo`, `Website (prod)`). An alert without an id gets one built from its service and text, so the same service and text again is the same alert (such an alert cannot be closed by a resolved request, which has no id either). Any status other than `resolved` (an unknown word, `ok`, nothing) counts as firing. Only a body that is not a JSON object, or an id longer than 100 characters, is rejected: the run fails with a plain message and nothing is stored or sent.
- **Repeated firing.** The id of the alert is the key of one row in the Data Table `oncall_alerts`. While the row is open or acknowledged, the same alert firing again does nothing at all. A row that was resolved opens a new incident when it fires again more than `reopen_minutes` after it was resolved (default 2, never less than one minute, so a monitor that flaps does not page again and again). A row that was acknowledged, or that nobody took, opens a new incident when it fires again more than `rearm_hours` later (default 12). A new incident has a new code. More than `max_new_alerts_per_hour` new alerts in the last 60 minutes (default 10) are not paged and the run fails, naming the alert, so a flood is seen. The highest entry of `severity_order` is never held back by this limit.
- **Level 1 (B).** The first person gets one message with the service, the severity, the text, a 4 character code (letters and digits, never 0, O, 1, I or L) and "Reply OK CODE to take it". When the alert has a runbook link, the link is the last line of the text and that same message is a WhatsApp link button message whose button opens the runbook (so the button is a convenience, never the only copy of the link). One message, not a text plus a button, so a page costs one message of your quota. The row stores the level, the phone, the message id and the time. The idempotency key is built from the alert id (and a hash of it), the minute the incident opened and the level, so a repeated run cannot send the same page twice. The code comes from the alert id and the minute, never from chance.
- **Acknowledgement (C).** The Polling Trigger reads `message.received` and `message.replied` (people often swipe and answer the page, which arrives as `message.replied`). A text from a phone that was paged for an open alert, that starts with one of the `ack_words` (default `ok, ack, got it, visto, ciente`) and has nothing, or only the code, after it, takes the alert. With the code it takes that alert. Without the code it takes the **newest** open alert of that person, once per poll. The row gets who and when. The person gets "Acknowledged, you own ...", and every other level that was already paged gets ONE short note "NAME took SERVICE". Levels not yet paged hear nothing. Anything else is ignored without a reply: other sentences from a paged phone ("ok thanks, I will look at it later"), a wrong code, an image captioned OK, a message in a group, and every message of a phone that is not on the list or was not paged for that alert. A thumbs-up reaction is not a message and does not count.
- **Escalation (D).** A Schedule Trigger runs every minute. An open alert whose current level was paged more than `ack_minutes` plus one minute ago (default 5, so 6) with no acknowledgement pages the next level: "ESCALATED, nobody answered level N". The extra minute is a grace tick: a reply written just before the deadline is read by the poll before the timer can escalate. Escalation therefore happens between `ack_minutes` + 1 and `ack_minutes` + 2 minutes after the page (between 6 and 7 minutes with the defaults; a slower Schedule Trigger adds its interval). After the last level ONE final message goes to every level and to the owner (once each, even when the owner is also a level), the row becomes `unacknowledged` and the workflow stops for that alert. Nobody is paged twice for the same incident, and the sends respect the pace of your plan (the node waits when Turbo Notify asks it to).
- **Resolution (E).** A payload with the resolved state closes an open, an acknowledged or an unacknowledged alert and sends ONE "Resolved" message to each person who was paged. The row becomes `resolved`, so the next outage with the same id is a new incident once `reopen_minutes` have passed (and not ignored for `rearm_hours`). A resolved payload for an alert that is already resolved, or that never existed, does nothing.
- **Failures.** A refused send never stops the other messages of the run and is never silent. The row records it (`last_error`). A refused page counts as that level tried: the next minute tick pages the next level without waiting for `ack_minutes`, with the runbook link in the text (it is there anyway) and no button, in case the button was the reason. Every refused message, including a page to a level that has a next one, ends the run in an error that names the alert, the phone and the reason; when no level could be reached at all the error says NOBODY could be paged. Setup step 9 turns that error into a message for you. Both send nodes are set to try three times, 2 seconds apart, when the first message of a batch fails. n8n repeats the whole batch then, which is safe because every message has an idempotency key (a message that already went out is returned, not sent again).
- **No stale save.** The poll, the timer and the webhook may work on the same row at once. Each save writes only the columns its own run owns: a page writes the level, the phone, the time and the message id, an acknowledgement writes who took the alert, a resolved request writes its own status. A slow timer run therefore cannot put back an `open` status over an acknowledgement or a resolution written meanwhile. The one status a late save can still write is `unacknowledged` (after the final message).
- **Setup branch (F).** "Run once: create the table" creates `oncall_alerts` when it is missing and does nothing when it exists.

### What it does not do

No quiet hours, no on-call rotation calendar (the levels are fixed numbers) and no groups. It does not follow delivery after a send is accepted: a message that WhatsApp could not deliver is covered only by the escalation timer. Acknowledging by a link, a reaction or a voice note is not supported.

## Nodes

Live flow (21 working nodes, plus 9 notes):

1. `Receive an alert` (Webhook, Header Auth)
2. `Poll WhatsApp replies` (WhatsApp by Turbo Notify Polling Trigger)
3. `Every minute: look for unanswered alerts` (Schedule Trigger)
4. `Your settings` (Edit Fields: every value you change, each explained in the node's Notes)
5. `Check the settings` (Code: stops the run on a placeholder, then names the entry point)
6. `Webhook alert, or replies and timer?` (If)
7. `Find the alert in the table` (Data Table)
8. `Decide what to do with the alert` (Code: checks, caps, severity, repeated firing, resolve, flood limit)
9. `Save the alert` (Data Table upsert, before anybody is paged)
10. `Read the open alerts` (Data Table)
11. `Decide what each open alert needs` (Code: which reply takes which alert, which alert needs the next level)
12. `Write the messages` (Code: who gets which text, with which key)
13. `Does the page carry a runbook button?` (If)
14. `Send the page with the runbook button` (Turbo Notify: Send Link Button, Continue On Fail, three tries)
15. `Send the text message` (Turbo Notify: Send Text, Continue On Fail, three tries)
16. `Gather the answers of Turbo Notify` (Merge)
17. `Update the alert rows` (Code: matches each answer with its message, keeps only the columns this run owns)
18. `Save the alert after sending` (Data Table upsert of those columns)
19. `Report what failed` (Code: fails the run when any message was refused)

Setup branch (2 nodes): `Run once: create the table`, `Create the oncall_alerts table`. The 9 notes are the yellow overview, the red warning and seven white section notes (one of them is the heading of `Your settings`).

## Setup

Works on n8n Cloud (community nodes enabled, Verified Community Nodes turned on: the package is a verified node) and on self-hosted n8n. Tested on n8n 2.45.5.

1. Install the community node package `@turbo-notify/n8n-nodes-turbo-notify` (tested with 1.5.15): Settings > Community Nodes > Install, or see [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/). Package page: https://www.npmjs.com/package/@turbo-notify/n8n-nodes-turbo-notify.
2. In Turbo Notify, connect your WhatsApp number and create an API key with the scopes `messages:send` and `events:read`. In n8n create a **Turbo Notify API** credential with that key.
3. Create the credential for the webhook: **Header Auth**, named exactly **Alert access (Header Auth)**. Choose a header name (for example `X-Alert-Token`) and a long random value (30 or more characters, from a password generator). That value is the key to your phones: share it only with your monitoring tool. **Your tool must send exactly that header name with that value.**
4. Import `workflow.json`. Select your credentials on the Webhook node and on **every** Turbo Notify node (the Polling Trigger, `Send the page with the runbook button`, `Send the text message`). An import does not always pick them for you.
5. Click **Execute workflow** on `Run once: create the table`.
6. Open `Your settings` and replace `oncall_phone_1`, `oncall_phone_2` and `owner_phone` with real numbers, with `+` and the country code. **None of them may be the phone linked to Turbo Notify.** **On the Free plan use at most two different phones in all** (see "Plans"): set `owner_phone` equal to `oncall_phone_2`, or leave `oncall_phone_2` empty (an empty level 2 or 3 is allowed and makes the ladder shorter). Fill `oncall_phone_3` for a third level on a plan with more contacts. Translate the texts if you like (pt-BR texts below).
7. Point your monitoring tool at the **Production URL** of `Receive an alert` (shown when you open the node: n8n normally assigns a new address to an imported copy, so do not reuse the one in the file), method POST, over HTTPS, with the header of step 3 and a JSON body (examples below). n8n must be reachable from the internet at that address.
8. Test with a number you own: post a firing alert, answer `OK` and the code from that phone, post it resolved. Then try an alert with nobody answering and watch the next level get paged after `ack_minutes` plus the minute of grace.
9. Set an **Error workflow**, so you are told when a message is refused. First create a second workflow whose first node is an **Error Trigger**, followed by a Send Email (or Slack) node that writes the workflow name and the error message. Then open this workflow, **Settings** (the `...` menu), choose it under **Error workflow** and save. Without it the run still ends in an error, but only the Executions list shows it. (The Error workflow is not part of this template and was not run in the tests.) A WhatsApp message cannot be the channel for this one: it is the channel that failed. **Put a throttle in the Error workflow, or fix the cause quickly:** a persistent fault (a disconnected number, for example) fails a run every minute, and each failed run starts your Error workflow, so you would get a message a minute. A flood that is held back by `max_new_alerts_per_hour` fails one run for every repeat of every blocked alert.
10. Activate the workflow. Do it only after steps 4 to 7: while `Check the settings` stops the run, the poll has already taken the replies of that minute.

### What your monitoring tool posts

A flat JSON body. The names of the fields are settings, these are the defaults:

```json
{
  "alert_id": "db-primary-down",
  "service": "Database primary",
  "severity": "critical",
  "status": "firing",
  "message": "Connections refused",
  "runbook_url": "https://example.com/runbooks/db-down"
}
```

Only `alert_id` matters (without one the alert gets an id built from its service and text). Without `status` the alert is firing. To close it, post the same `alert_id` with `"status": "resolved"` (the other fields are not needed). Use a stable id: an id that changes on every post is a new alert every time.

```bash
curl -X POST 'https://YOUR-N8N-ADDRESS/webhook/THE-ADDRESS-SHOWN-IN-THE-NODE' \
  -H 'X-Alert-Token: YOUR-LONG-RANDOM-VALUE' -H 'Content-Type: application/json' \
  -d '{"alert_id":"db-primary-down","service":"Database primary","severity":"critical","message":"Connections refused"}'
```

The tool gets `200` as soon as n8n accepts the request, before the alert is checked. A rejected alert (a body that is not a JSON object, an id over 100 characters) shows only as a failed run. No monitoring tool was used in the tests; they were simulated with HTTP requests.

### Your tool

None of these was connected in the tests. Each line says what the tool has to do: **check your tool's documentation, it is not tested here.**

| Tool | What to set up | Note |
|---|---|---|
| Uptime Kuma | A Webhook notification with a custom body (JSON) that holds the fields above, and an additional header with the name and value of your Header Auth credential | Map its up and down states to `firing` and `resolved` in the body, otherwise a recovery counts as firing |
| Grafana | A Webhook contact point with a custom payload (a template) that produces the flat body, and the header of your credential | The settings and the template syntax depend on your version: check it |
| Prometheus Alertmanager | It sends a nested `alerts` list, which this workflow does not read | Put a small relay or step in front that turns each alert into the flat body |

The header name is whatever you put in the Header Auth credential. Using the name `Authorization` was not tested (only `X-Alert-Token`).

### The Data Table `oncall_alerts` (created by the setup branch)

The name must stay exactly `oncall_alerts` (lower case). To create it by hand: Data tables > Create, with these columns (dates are text in ISO 8601, UTC).

| Column | Type | Meaning |
|---|---|---|
| `alert_id` | String | The id from your tool. One row per id |
| `service`, `severity`, `message` | String | As received, cut to the limits |
| `status` | String | `open`, `acknowledged`, `resolved` or `unacknowledged` |
| `level` | Number | The last level paged (0 before the first page), also when that page was refused |
| `notified_phone` | String | The phone of that level |
| `message_id` | String | The Turbo Notify id of that page. Empty when the page was refused |
| `notified_at` | String | When that level was paged. `ack_minutes` counts from here |
| `acknowledged_by`, `acknowledged_at` | String | Who took it (phone) and when |
| `resolved_at` | String | When the tool reported it resolved |
| `runbook_url` | String | The runbook link, empty when there is none or it was not valid |
| `short_code` | String | The 4 character code people answer with |
| `opened_at` | String | When this incident opened (the minute of it is part of the idempotency key) |
| `pages` | Number | Pages sent for this incident, also refused ones (the same number as `level`) |
| `paged_phones` | String | Phones that really received a page, comma separated. Only they can take the alert and hear about it afterwards |
| `last_error` | String | Why a message of the last step was refused. Empty when all went out |

You can edit rows by hand (set `status` to `resolved` to stop an alert). Rows are never deleted by the workflow.

## Settings (the `Your settings` node)

Every value is explained in the node's **Notes** (open the node and look at the Notes tab). The canvas shows only the first line of a note.

| Field | Default | Meaning |
|---|---|---|
| `oncall_phone_1`, `oncall_phone_2` | `+55XXXXXXXXXXX` (placeholders, the run stops until you replace them) | Level 1 and level 2. Never the phone linked to Turbo Notify. Empty `oncall_phone_2` for one level, or to stay within two phones on Free |
| `oncall_phone_3` | empty | Level 3, optional. An empty level 2 or 3 makes the ladder shorter |
| `owner_phone` | `+55XXXXXXXXXXX` (placeholder) | Gets the final message. May be the same as a level (it then gets one message). Not the linked phone |
| `ack_minutes` | `5` | Minutes a level has to answer. The timer adds one minute of grace and checks once a minute: the next level comes `ack_minutes` + 1 to + 2 minutes after the page |
| `ack_words` | `ok, ack, got it, visto, ciente` | A reply that starts with one of these, then nothing or the code, takes the alert |
| `min_severity`, `severity_order` | `warning`, `info, warning, critical` | Lower severities are ignored. An unknown severity is never ignored. The last entry of `severity_order` is never held back by the flood limit |
| `max_new_alerts_per_hour` | `10` | More new alerts than this in the last 60 minutes are not paged and the run fails |
| `reopen_minutes`, `rearm_hours` | `2`, `12` | When an alert that fires again is a new incident (see "Repeated firing"). `reopen_minutes` is at least one minute: with `0` or `1` a second outage right after a resolved one is paged. If your tool only reports changes (it never repeats a firing alert), a second outage within `reopen_minutes` of the resolution is not paged: set it to 0 or 1 for such a tool |
| `max_text_length` | `300` | Longest alert message kept |
| `field_alert_id`, `field_service`, `field_severity`, `field_status`, `field_message`, `field_runbook_url` | the names in the example above | Which field of your JSON holds what |
| `runbook_button_text` | `Open runbook` | Text on the button, at most 20 characters |
| `msg_page`, `msg_escalated`, `msg_ack_confirm`, `msg_ack_note`, `msg_final`, `msg_resolved` | English texts | Every message a person receives. Placeholders: `{service}` `{severity}` `{message}` `{code}` `{alert_id}` `{minutes}` and, in `msg_escalated`, `{level}` and `{previous_level}`, in the note, `{name}`. `\n` is a line break |

## Plans, quota and pace

- The Polling Trigger works on every plan and needs no public address on the Turbo Notify side. The Webhook of this template is n8n's own, and it needs one.
- **Free: 300 messages and 2 distinct contacts per billing cycle.** Each phone you page counts as a contact, once per cycle. **Use at most two different phones in all**: set `owner_phone` equal to `oncall_phone_2`, or leave `oncall_phone_2` empty. The defaults of this template name three different people (two levels and the owner): on Free the third one is refused at the worst moment, when nobody answered and the final message goes out. The send pace is one message every 6 seconds, so the final message to four people takes about 20 seconds.
- **Lone Wolf: 1,800 messages and 100 distinct contacts per cycle**, one message every 1.2 seconds. Sources: [Quota and usage](https://docs.turbonotify.com/en/usage/quota/) and [Rate limits](https://docs.turbonotify.com/en/messages/rate-limits/).
- Messages per alert: one page per level paged (at most 3), then either the confirmation plus one note per other paged level (at most 3 in all), or the final message to up to four phones, and one "resolved" message per paged phone. A new number also has a daily warm-up limit (50 messages on the first day, see [Rate limits](https://docs.turbonotify.com/en/messages/rate-limits/#warm-up-of-new-numbers)).
- A refused page does not use quota. Send an alert to yourself first and see the numbers in the dashboard before you rely on the ceilings.
- The pages are sent from the number called `main`. With several numbers in the organization, change the number on the three Turbo Notify nodes, and set **Options > Number** on the Polling Trigger (that option exists in the node and was not run in the tests).

## Things to know before you rely on it

- **The confirmation can take up to a minute.** Replies are read by polling, once a minute. After you answer OK, wait for "Acknowledged": do not send OK twice (a second OK for an alert that is already taken is ignored, and a second OK in the same poll takes only one alert).
- **One incident per alert id.** The row is reused. A new incident overwrites the row (the table is the current state, not a history). Executions keep the history while n8n keeps them.
- **A plain "OK" takes the newest open alert of that person.** If you were paged for two alerts and mean the older one, answer with its code.
- **The reply must be text.** A voice note, a sticker, a reaction or an image captioned OK does not take the alert.
- **Two identical alerts at the same instant.** The check "does this alert exist" and the save are two steps. Both requests read the table before either has saved. The code and the idempotency key come from the alert id and the minute, so both runs write the same text with the same key and Turbo Notify sends ONE message: in the test that is what happened. The real worst case: the two requests fall on both sides of a minute change. The keys then differ and the first person gets two pages (the row stays one). A repeat of the same alert after the row is saved is ignored.
- **If your tool only reports changes.** An alert whose second outage comes within `reopen_minutes` of its resolution is ignored as a flap. Set `reopen_minutes` to 0 or 1 for such a tool.
- **A flood is blocked for a rolling hour.** `max_new_alerts_per_hour` counts the alerts opened in the last 60 minutes. A blocked alert is not stored, so each time your tool repeats it while the hour is full, the run fails again and your Error workflow fires again. The block lifts as older alerts pass the hour. The highest severity is never blocked.
- **Timer precision.** Escalation happens between `ack_minutes` + 1 and `ack_minutes` + 2 minutes after the page (one minute of grace, then the first minute tick).
- **An acknowledged alert that is never resolved** stays acknowledged. It pages again only if it fires again after `rearm_hours`. Resolve it in your tool, or set its `status` to `resolved` in the table.
- **An acknowledgement and a resolved request in the same few seconds:** the later save decides the final status (it can be either one), and both sets of messages go out.
- **A run is not atomic.** The row is written before the first page and after each send. If n8n stops between a send and the save, the next tick tries the same page again, and the idempotency key makes Turbo Notify return the first message instead of sending a second one (tested by putting the row back to its earlier state, not by killing n8n).
- **The executions list fills up** (one run a minute from the timer). n8n prunes it by itself (see its settings for "Prune data").
- **The webhook accepts any size n8n accepts.** The text that is kept is cut as described above, but an oversized request is still received by n8n first. Keep the address private.

## Customization

- **Other channels in the same shape.** Everything that leaves the workflow goes through `Write the messages`, which returns one item per message (`to`, `text`, `key`, `runbook_url`, ...). To add Telegram, Slack or e-mail next to WhatsApp, put your node after that Code node, in parallel with the two Turbo Notify send nodes, and map `to` and `text`. To read answers from another channel, build the acknowledgement items of `Decide what each open alert needs` from your own trigger (an item with `action: "ack"`, `responder` and a `row`). This is a hint: it was not built or tested.
- **More than three levels, or a second contact per level.** The list of levels lives in four Code nodes (`Check the settings`, `Decide what each open alert needs`, `Write the messages`, `Report what failed`): add a setting and a name in each. Not tested.
- **Wording.** All the texts are in `Your settings`. Brazilian Portuguese:
  - `msg_page`: `ALERTA [{severity}] {service}: {message}\nResponda OK {code} para assumir.`
  - `msg_escalated`: `ESCALADO, ninguém respondeu o nível {previous_level}. [{severity}] {service}: {message}\nResponda OK {code} para assumir.`
  - `msg_ack_confirm`: `Recebido, o alerta {service} ({code}) é seu.`
  - `msg_ack_note`: `{name} assumiu {service} ({code}). Você não precisa agir.`
  - `msg_final`: `Ninguém assumiu {service} ({code}): {message}\nNão haverá mais mensagens sobre este alerta. Verifique agora.`
  - `msg_resolved`: `Resolvido: {service} ({code}).`
  - `runbook_button_text`: `Abrir runbook`
  - `ack_words`: the default already holds `visto` and `ciente`; add words such as `recebido`.
- **Severities.** Change `severity_order` and `min_severity` to your tool's names (for example `low, medium, high`).

## Test record

Tested end to end from the exact `workflow.json` (SHA-256 below), in a fresh throwaway n8n, against a simulated Turbo Notify API (nothing reached WhatsApp in that part), then once against the real API (see "Real API run"). See "What is not proven".

| | |
|---|---|
| Date | 2026-11-18 |
| `workflow.json` | SHA-256 `2721ed80410d3dc7c534e76b32e1ecd904e72d3235c7365401612e91363e1257` (`shasum -a 256 workflow.json`) |
| Notes reformatted | Notes reformatted 2026-11-18 after n8n review feedback on T1; node logic unchanged; mock scenario rerun: 616 assertions, 0 failed (n8n 2.45.5, package build 1.5.16). The file before the reformat had the SHA-256 `4bfede4d9ea01a6149f31b1e335ca9fb83385a3cb3c292562bd03d14634fb27b`, and the real API runs below were made on it. `workflow.png` was retaken on 2026-11-18 in the n8n 2.45.5 editor and shows the reformatted notes. The overview note height was trimmed afterwards, after a look at the canvas in n8n 2.45.5 (only the size of that note changed, so the mock scenario was not run again). |
| Canvas relaid out | Canvas relaid out 2026-11-19 after n8n returned the first template (appointment reminders) a second time over the sticky notes: only node positions and the size of the notes changed (a left to right layout in sections, every node inside exactly one section, no overlapping sections, the warning inside its section over the node it concerns, the overview at the top left), and node logic, names, connections and note texts are unchanged (verified by comparing this file with the previous one without positions and sizes). Mock scenario rerun on this file: 616 assertions, 0 failed (52 steps, 469 s, n8n 2.45.5, package build 1.5.16), and `test/placeholder.mjs` 11 assertions, 0 failed (3 steps), the same totals as the run of 2026-11-18. The previous SHA-256 was `b54e0fc2f68c92b3d23e2cddb77e955cdc771a3bb99c7934fefa3141ee9783c4`; this row supersedes what the row above says about the overview height. `workflow.png` was retaken from this layout in the n8n 2.45.5 editor. |
| n8n | 2.45.5 (image `n8nio/n8n:2.45.5`, id `sha256:9f6d0a5987ab5a297c4b0b38fbf1a22285dd1364551478e93f03d506908fa74c`) |
| Package | `@turbo-notify/n8n-nodes-turbo-notify` 1.5.15 (built from this repository) |
| Mock API | `templates/harness/mock-api.mjs`, same routes, answers, events and errors as `public-docs-web/public/openapi.json` |
| Patches applied to `workflow.json` by the scenario | none in the file. The workflow is imported as exported and the scenario proves it refuses to page with the placeholder numbers. Then it types the values a person must type, through the stored workflow: the three on-call numbers and the owner. For single steps it also changes one setting and puts it back (the field names, `ack_words`, `min_severity`, `max_text_length`, `max_new_alerts_per_hour`, `reopen_minutes`, the six texts, one level fewer, an empty level 2, the owner as level 1). `ack_minutes` stays at its exported 5: the clock is moved by writing older timestamps into the table (`notified_at`, `opened_at`, `resolved_at`, `acknowledged_at`), which a person could do too, and by waiting for the next minute where a new incident needs a new idempotency key. The mock's send spacing is switched on for one step, and its answer delay (`latencyMs`) for the three race steps |
| Scenario | `test/scenario.mjs`, 52 steps, 616 assertions, 0 failed, 748 s. A second scenario, `test/placeholder.mjs`, runs the file with nothing patched (11 assertions, 0 failed) |
| Other checks | the module's own jest suites (including the 16 template tests that run on this folder: valid JSON, no placeholder credentials, no em or en dash, no invisible or bidirectional control characters, every node connected, overview note and section notes) and `npm run lint`: `npx jest` 17 suites, 410 tests, all green; `npm run lint` exits 0 |

Rerun:

```bash
cd n8n-nodes-turbo-notify
node templates/harness/run-template.mjs templates/oncall-alerts-escalation/workflow.json \
  --scenario templates/oncall-alerts-escalation/test/scenario.mjs --image n8nio/n8n:2.45.5
node templates/harness/run-template.mjs templates/oncall-alerts-escalation/workflow.json \
  --scenario templates/oncall-alerts-escalation/test/placeholder.mjs --image n8nio/n8n:2.45.5
```

How each entry point was reached: the alert branches run from the Webhook node with a pinned request (a webhook cannot be started by hand), the real HTTP behavior is in the live block at the end; the reply branches run from the Polling Trigger with events taken from the mock's own event feed (the mock turns an incoming message into the same event the API serves); the escalation branches run from the Schedule Trigger by hand. The last block activates the workflow and uses real HTTP requests, the real poller and the real minute timer.

Branches run (each step asserts the requests the mock received and the rows in the table):

| Branch | Proved |
|---|---|
| Exported file | The webhook needs Header Auth, accepts POST only and is addressed by its random id. The placeholders are in `Your settings`, each value is explained in the node's Notes, the redundant page limit is gone, both send nodes try three times, no text has an em or en dash |
| Setup branch, three times | The table is created by the workflow, running it again creates nothing and keeps the rows |
| Guard: placeholders | As exported, an alert, the timer and a reply each end the run in an error that names `oncall_phone_1`, `oncall_phone_2` and `owner_phone`; nothing was looked up, sent or stored. Each setting is then checked on its own: a short number, an empty level 2 (allowed), the same number twice, a wait of zero, an unknown `min_severity`, a button text over 20 characters, empty `ack_words`, a negative `reopen_minutes` (refused) and a `reopen_minutes` of 0 (allowed) |
| Level 1 | One message to level 1 only: the text with the code and "Reply OK CODE to take it" and the runbook link as its last line, the link button with the same runbook, an idempotency key from the alert, a hash of its id, the minute and the level, a row with level, phone, message id, pages, paged phones. The code is the one derived from the id and the minute. Without a runbook link a plain text; a `javascript:` link and a link over 500 characters are dropped |
| Severity | `info` below `warning` is ignored (no row, nothing sent), `WARNING` pages, an unknown severity and a missing severity page, `min_severity` set to `critical` ignores a warning |
| Field limits | Service cut at 80, message at 300 (and at 20 when set so), direction and zero-width characters and a control character removed, no page longer than a button allows |
| Rejected requests | An id over 100 characters, an array and a text body: the run fails with a plain message, nothing is stored or sent |
| Fail open | An id with accents, spaces, parentheses and a hash sign pages. `Website (prod)` and `Website [prod]` get different keys and both pages are accepted by the API. An alert without an id gets an `auto-` id built from service and text: the same alert again sends nothing, another text is another alert. An unknown status (`ok`) pages as firing. An empty JSON object pages |
| Field names | Another tool's field names read from settings; a resolved request needs only the id and the state |
| Repeated firing | The same alert three times while open: nothing sent, the row untouched. A flap right after resolve is ignored, then a new incident (new code, new key, still one row). An acknowledged or unacknowledged alert fires again: ignored before `rearm_hours`, a new page after it. A flood past `max_new_alerts_per_hour`: the run fails naming the alert, nothing stored or sent, a repeat of the blocked alert fails again while the hour is full, an unknown severity is held back too, a `critical` alert still pages, and the limit is a setting |
| Acknowledgement | With the code (small letters work), from level 2: marked, confirmation to that person, ONE note to level 1 with the name, level 3 and the owner hear nothing, the timer then leaves it alone. Without the code: the newest open alert only, once per poll. With a code of an older alert while a newer is open. Every default word with capitals, accents and punctuation, and a custom word list |
| Ignored | Chatter, "okay", a wrong code, a code plus more words, an image captioned OK, a group message, an unlisted phone, level 3 that was never paged, the owner, an outgoing message, an answer to an alert already taken or resolved, and the same event twice |
| Escalation | Not due at 0, 4 and 5.5 minutes (the minute of grace), due at 7: level 2 gets "ESCALATED, nobody answered level 1" with the link in the text and the button, key per level, row follows. Level 3 next. After the last level: one final message to the three levels and the owner, row `unacknowledged`, and nothing more in three more ticks; a reply after it is ignored |
| Shorter ladders | Two levels and the owner as level 1: two final messages. One level only (empty levels 2 and 3, owner is level 1): one final message. An empty level 2 with level 3 filled: level 3 stands in for level 2, then the final message goes to both levels and the owner |
| Several alerts due in one run | Three alerts, two with a runbook link: each page has its own text, code, button and its own message id in its own row |
| Alert opened but never paged | Not touched in its first minute and a half, paged as a first page three minutes later |
| Repeated page | The row put back to its state before the save: the page is requested again and Turbo Notify answers with the first message, no second message exists |
| Resolution | Closes the alert and sends ONE message to level 1 and level 2 only; an acknowledged alert's resolver is told too, also with a severity below the minimum; never escalated afterwards; a second resolved, and a resolved alert that never existed, do nothing. An alert that nobody took (`unacknowledged`) is closed too, the three people paged are told, a flap is ignored, and the next outage with the same id pages level 1 again |
| Races | A reply written inside the minute of grace is read while the timer runs: the alert stays acknowledged and level 2 is not paged. A timer run kept busy for 6 seconds by a slow API cannot undo an acknowledgement or a resolved request written meanwhile (the row ends acknowledged, or resolved, with the page to level 2 recorded). Two identical requests at the same moment (real HTTP): one row, two requests to Turbo Notify with the same key and the same text, ONE message |
| Pace | With a 1.5 second spacing the four final messages all arrive, spread over time, after the API asked the node to wait |
| Refused page | The row records the reason and level 1 as not reached, the run fails naming the alert, phone and reason (not the "nobody" alarm), the page was tried three times, the next tick pages level 2 at once (no wait), as a plain page with the runbook in the text; only the person who was reached can take the alert and hears about it |
| A send that fails once | Tried again by n8n: one message goes out, no error in the row, no failed run (button node and text node) |
| Every level refused | Level 1, level 2: each run fails naming the alert and the phone. Level 3: the run ends in the "NOBODY could be paged" error. The next tick sends the final messages (refused too: the error says so), the row is `unacknowledged`, and nothing is tried again |
| Contact quota | Level 2 refused (`402`): recorded and reported, level 3 paged next, that run passes |
| Refused confirmation, note, resolved | The run fails and names the alert, the phone and the reason; the row is still acknowledged or resolved and records what failed |
| Some refused, some not, in one run | The button node's message is refused on all three tries and the text node's goes out: each row gets its own result (the answers are matched to the right message after the buttons and texts are sent in two branches) |
| Wording | The six texts and the button text come from `Your settings`, the runbook link ends every page |
| Live webhook | No header: `403`; a wrong value: `403`, the same answer; the token in the `Authorization` header: `403`; GET: refused; none of them starts a run or stores a row. A correct request: `200`, level 1 paged, the same request again sends nothing, a 200 KB message is cut to 300 characters |
| Live poller | A reply written to the number was read by the real Polling Trigger (the real tick, up to a minute) and took the alert; the workflow does not react to anything else |
| Live timer | An alert whose `notified_at` was moved back 7 minutes was escalated by the real minute timer |
| Inactive, then active again | A reply written while the workflow was switched off was read by the first poll after switching on and took the alert. It is not lost |

### Real API run

Run from the exact `workflow.json` (SHA-256 `4bfede4d9ea01a6149f31b1e335ca9fb83385a3cb3c292562bd03d14634fb27b`) (the file before the notes were reformatted on 2026-11-18; only sticky notes differ from the current file) on 2026-11-18 (UTC), in a throwaway n8n 2.45.5 with package `@turbo-notify/n8n-nodes-turbo-notify` 1.5.15, against the real Turbo Notify API with real WhatsApp delivery (`test/real.mjs`, harness real mode with the guard on and a budget). Two numbers owned by the same person, on two organizations: the number under test sent the pages, and the on-call person (level 1 and owner at once, levels 2 and 3 empty) was the other number, which answered with its own key. Only the values typed in `Your settings` were patched. The final run passed: 7 steps, 30 assertions, 0 failed, 230 s.

| Step | Result on the real API |
|---|---|
| Table | `Run once: create the table` created `oncall_alerts` in the real n8n; the webhook, activated, answered `403` to a call without the Header Auth header and stored nothing |
| Alert 1, the page | One message accepted (`202`), to the on-call number only, a link button message (`interactive_type: cta_url`) whose text ends with the runbook link; the row holds the message id and the paged phone; the API reported it `delivered` 3 seconds after acceptance |
| Same alert again | Answered `200`, nothing sent (the guard counted one message) |
| Acknowledgement | The on-call number wrote `OK <code>` (a real inbound message), the real Polling Trigger read it on its next tick and took the alert: `acknowledged_by` is the sender, and the confirmation "Acknowledged, you own ..." was accepted 57 s after the person wrote. This is the `from.number` equality: it held on the real events feed, with the phone as the API writes it |
| Alert 2, nobody answers | The page was accepted; the row's `notified_at` was moved 10 minutes back (as a person editing the table could); the real minute timer closed it with ONE final message ("Nobody acknowledged ...") and the row became `unacknowledged`; a minute later nothing more was sent |
| Alert 3, resolved | The page, then a resolved request: the row became `resolved` and ONE "Resolved: ..." message was accepted |
| Cleanup | The 6 messages of the workflow and the person's message were deleted for everyone at the end; the table was deleted; the guard blocked nothing |

Messages: 7 accepted in the final run (6 by the workflow, 1 by the person), 8 in all for the day: a first attempt stopped after the first page because of a mistake in the scenario (it read the row as the message id, a bug of `test/real.mjs`, fixed; the workflow was not involved) and the final budget was lowered to 7 so the day total stayed at 8.

Differences from the mock, and what the real API showed:

- **The number resource names its phone `number`**, not `phone_number`. The scenario had the wrong field name, which made its "the on-call phone is not the linked phone" check pass without checking anything. It now reads `number` and also asserts that it is the number under test. The workflow does not read that field.
- **Phone formats.** The phone of the sender in the real `message.received` event, compared by digits, equalled the phone typed in `Your settings` (with `+` and the country code) and the acknowledgement was taken. Whether a number with and without the ninth digit would differ was not tried: only one pair of numbers was used.
- **Pace.** The real API accepted sends that came one second apart (the confirmation of alert 1 and the page of alert 2) and refused none for pace or reply ratio in these 7 messages. The plan of the key was a custom plan with a very large quota, so no Free plan limit was met.
- **Delivery.** The page moved to `delivered` by itself within seconds; the mock needs a delay setting for that.
- **Events request.** The poller asked `GET /v1/events` with a `created[gte]` window and every call answered `200` (the harness request log keeps one value per query key, so it shows only one of the two event types).
- **Nothing else differed** in the steps above: every assertion on the real answers (status codes, the `cta_url` content, message ids, the sender of the reply) held as written for the mock.

Not proven by this run: how the link button looks on a phone and on a Business account, a human reply time (the reply was sent by a script right after the page, and the 57 s is the poll tick), levels 2 and 3 (the guard allows one recipient), the 6 second pace and the 2 contact limit of the Free plan, `reply_ratio_too_low`, and any real monitoring tool.

### What is not proven

- **Real WhatsApp delivery to a human.** The real API run (above) delivered the page, the confirmation, the final and the resolved message between two owned numbers, but nobody looked at a phone: how the link button looks on a personal and on a Business account, and whether a person is woken by it, was not seen.
- **That the on-call phone is not the linked phone.** It is documented in five places. The real run used a different number for the person, and its answer was read as an incoming message; the opposite case (the linked phone answering itself) was not run. The workflow itself does not check it: no call it already makes returns the linked number. That a message to your own chat makes no push and that your own replies arrive as sent messages comes from the Turbo Notify contract (`message.sent` with origin `native`), not from a test here.
- **Any real monitoring tool.** Uptime Kuma, Grafana, Prometheus Alertmanager, cron jobs and forms were not connected. Their payloads were simulated with flat JSON. Nested payloads are not read. The "Your tool" table is a pointer to check, not a tested setup. Whether your tool can send a custom header was not checked here.
- **Real reply latency.** A real reply was read within one poll tick (57 s from the send to the confirmation, up to a minute by design). How long a human takes, and how long WhatsApp takes to carry a reply on a busy day, was not measured.
- **The retry of a failed send beyond the first message.** n8n repeats a send node only when the FIRST message of its batch fails (and then repeats the whole batch, which the idempotency key makes free). A refusal of a later message in a batch is not retried. This was shown with a 503 and with the 409 refusals of the tests, not with a real network fault.
- **n8n Cloud execution counts.** The plan limits in "Read this first" were read from n8n.io/pricing on 2026-11-17, not from an account, and the claim that a poll without messages starts no execution rests on how n8n polling triggers work, not on a count made here.
- **The real Free plan.** The `402` for a third contact and the 6 second pace come from the mock and the documentation. No Free plan was used.
- **An Error workflow.** It is described in Setup step 9, not built, and was not run. Neither was a throttle in it.
- **An n8n restart in the middle of a run, several n8n workers or queue mode.** A repeated page was tested by putting the row back, not by killing n8n. The races were made with a slow API on one n8n, not with two workers.
- **An acknowledgement and a resolved request that overlap.** Each of them was proved against the timer, not against the other: the later save decides the status.
- **A minute change between two identical requests.** The two requests of the live race fell in the same minute. When they straddle a minute change the keys differ and level 1 can get two pages. This follows from the key design and was not provoked.
- **The Header Auth credential with a header name other than `X-Alert-Token`, including `Authorization`.** Only `X-Alert-Token` was used.
- **A very long outage.** Reactivation was tested after a few seconds off, not after hours.
- **A reply read after its text expired.** The mock does not expire message content; the claim rests on the documented retention.
- **`reply_ratio_too_low`.** It exists in the documentation and could not be provoked.
- **The canvas look.** Where the sticky notes sit was computed from node and note rectangles (a node 100 wide with a label up to 50 beside it and 80 below), not seen in a browser. How the notes under `Your settings` render in the flow was not seen.
- **n8n Cloud itself.** The claim that the package works there rests on its verification by n8n, noted in the module README.

