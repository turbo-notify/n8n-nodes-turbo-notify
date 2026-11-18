# Send WhatsApp appointment reminders and track RSVP answers with Turbo Notify

An n8n workflow for a clinic, salon, tutor or studio. Appointments live in an n8n Data Table. Staff add them with a
form. Every hour the workflow sends each customer whose appointment is coming up a **native WhatsApp calendar
invitation** from your own number. The customer taps Going, Maybe or Not going inside WhatsApp, and the workflow
updates the booking. A decline alerts you with a text and the customer's contact card, so you can call. Each hourly run
sends you **one message that lists only what needs you**: reminders that could not go out (with the reason),
customers who have not tapped yet, and the message quota left when it was the cause. Nothing to report, no message.

It uses the community node [`@turbo-notify/n8n-nodes-turbo-notify`](https://www.npmjs.com/package/@turbo-notify/n8n-nodes-turbo-notify)
(tested with 1.5.15) and core n8n nodes only. No other account is needed. It works on **n8n Cloud** (the package is
verified by n8n and listed in its catalog: an admin enables Verified Community Nodes in the Cloud admin panel) and on
**self-hosted n8n**. Tested on n8n 2.45.5.

## Read this first

- **Customers on a personal WhatsApp account see the invitation without the time card.** WhatsApp removes the start
  and end time of an event when the *recipient* has a personal account (the event is a WhatsApp Business feature; see
  [Send a calendar event](https://docs.turbonotify.com/en/messages/send/#send-a-calendar-event)). The API has no field
  that tells which kind of account a recipient has, so the workflow cannot choose. It does the safe thing for everybody:
  the message text repeats the date and the time. For the same reason the invitation text says "If you see the buttons
  below, tap one, or just reply here": a typed reply reaches your phone, and the workflow does not read it.
- **Answers are read from the documented `message.calendar_responded` event.** What the test record proves, and what it
  does not (a real tap on a phone), is stated there in plain words.
- **n8n must be running for reminders to go out.** Reminders are sent by the hourly run: while n8n is off or the
  workflow is inactive nothing is sent, and a booking whose reminder time passed meanwhile is listed as not reminded.
  Answers are more forgiving. The Polling Trigger keeps the time of the last event it handled and, when the workflow
  is active again, reads everything newer (Turbo Notify keeps events for 90 days, and every poll also looks back 2
  minutes). An answer given while n8n was off is therefore handled at the next poll, once, and its thank-you may
  arrive late. Only the very first activation, or a change of the events or of the number, starts from now. Run n8n
  continuously (a small always-on server or n8n Cloud) so that reminders are on time.
- **The form needs an address staff can open.** On self-hosted n8n, set the public webhook URL (`WEBHOOK_URL`) so the
  form's Production URL is not `localhost`. Staff open that URL, sign in with the Basic Auth user and password, and add
  appointments from a phone or a computer. The address ends in the form node's own random id: n8n gives an imported
  copy a new one, so do not replace it with a short name that anybody could guess.
- **Time zone.** The times staff type, and the times in every message, use the time zone of the workflow. Set
  `expected_timezone` in **Your settings** to the zone you mean (for example `America/Sao_Paulo`) and make the
  workflow use the same one: **Workflow settings > Timezone** (a new workflow, and n8n Cloud, take the zone of the
  instance or of the account, which is often not yours). When they differ the form refuses the entry and the hourly
  run and the answer flow stop with a message that names both zones. Nothing is sent in the wrong hour.
- **Customer data.** The workflow stores the name, the phone number, the appointment and the answer of each customer
  in your n8n and sends them a reminder. Tell your customers that you do, and delete old rows (Data tables tab:
  `appointments`) when you no longer need them. This is not legal advice; check what LGPD or GDPR asks of you.

## What it does

| Entry point | When | What happens |
|---|---|---|
| **Form: new appointment** | Someone on your staff submits the form (Basic Auth) | The entry is checked. A phone number typed in a local Brazilian format (`11 97777-0001`) is turned into `+5511977770001` when that is unambiguous, otherwise refused (see "Phone numbers"). The date and time are read in the workflow time zone and stored in UTC. A valid appointment is saved as a row with status `scheduled`, and the form answers what it saved, **with the phone number as it was understood** so a typo shows at once. The same phone at the same start, saved in the last 24 hours, is refused as a duplicate. A rejected entry saves nothing and the form answers **422 with the reason** to the person who typed it. At most `max_appointments_per_day` new appointments in 24 hours, and names, titles, places and notes are cleaned, length bound and refused when they hold a web address or an @mention. |
| **Every hour: remind and report** | Every hour, at minute 5 | Reads your message quota. Takes the `scheduled` rows that start between `min_notice_minutes` and `reminder_hours_before` from now, earliest first, and sends each a calendar invitation (title, start, end, place and date in the text, a WhatsApp alarm `invite_alarm_minutes_before` before, optional extra guests). One message of the quota always stays free for your report. The row becomes `reminded` and stores the message id. Then, in the same run and only after the last invitation was sent and recorded: rows that were due but not sent (quota left no room, booked with too little notice, already started because n8n was down) become `not_reminded`; rows `reminded` more than an hour ago with no answer whose appointment is within `no_answer_window_hours` become `no_answer` (`0` switches that report off). The order is fixed by a Merge node, **Wait for the invitations to finish**, which also lets this step run when there was nothing to send. You get **one message** listing the exceptions (see the example below). |
| **Poll: guest answered or delivery failed** | A guest answers, or WhatsApp could not deliver the invitation | The Turbo Notify WhatsApp Polling Trigger (works on every plan, once a minute at best). The row is found by the id of the invitation. `going` becomes `confirmed`, `maybe` becomes `tentative`, `not_going` becomes `declined`, with the extra guests in `extra_guests`. The customer gets a short thank-you, or "we will contact you to reschedule". On a decline you also get a text and the customer's contact card. A failed delivery becomes `send_failed` and you get a text with the reason and the number to check. An answer to an event that is not in the table is ignored. An answer given from the connected phone itself (`direction: "outbound"`, that is you answering) is ignored. |
| **Run once: create the table** | You, once | Creates the `appointments` Data Table, and reuses it when it already exists. Then add a first row with the form. |

The four texts a **customer** reads (the invitation, and the thank-yous for Going, Maybe and Not going) and the date
format are values in **Your settings**: `invite_text`, `thanks_going_text`, `thanks_maybe_text`,
`decline_customer_text` and `date_format`, each explained in the note of that node, so they can be translated without
opening code. In them `{name}` is the first name; `{business}`, `{when}`, `{where}`, `{title}` and `{guests}` are filled
in as the note says; `\n` is a line break; the line of the invitation that holds `{where}` is dropped when the row has
no location. The texts that **you** read (the exceptions report, the decline note, a failed delivery) are in the Code
nodes **Write the message to the owner** and **Write the answer messages**. All are in English, and so are the weekday
and month names that `{when}` prints.

### The message you get

```
Appointment reminders, Your Business Name (Tue 18 Nov 14:05, America/Sao_Paulo):

Not reminded (2):
- Rita Costa, Check-up, Tue 18 Nov 14:30: it starts in 25 minutes, less than the 60 minutes of notice a reminder needs
- Paulo Lima, Cleaning, Wed 19 Nov 09:00: the message quota had no room for it

Reminder failed (1):
- Ana Souza, Follow-up, Wed 19 Nov 10:00: the phone number is not valid (11977770017)

No answer yet (1):
- Bruno Lima, Check-up, Tue 18 Nov 17:00, +5511977770001, in 2.9 h

Message quota left: 0 of 300 (one message is always kept for this report), it resets on 1 Dec.

To try a row again, fix the cause and set its status back to scheduled in the appointments table.
```

"No answer yet" means the customer has not tapped Going, Maybe or Not going. A customer who typed a reply instead is
still listed: the workflow does not read typed replies, and they arrive on your phone.

## Setup

1. Install the community node: **Settings > Community Nodes > Install** `@turbo-notify/n8n-nodes-turbo-notify`
   ([n8n guide](https://docs.n8n.io/integrations/community-nodes/installation/)). On n8n Cloud, the package is a
   verified node: an admin turns on Verified Community Nodes in the Cloud admin panel first.
2. In the [Turbo Notify dashboard](https://dashboard.turbonotify.com), connect your WhatsApp number and, in **API
   keys**, create a key with the scopes this workflow uses: `messages:send`, `messages:read` and `events:read`. Choose
   the scopes when you create the key; to change them later, create a new key. (The **AI agent (MCP)** template of
   the dashboard also works: it carries these three and a few read-only ones.) In n8n create a **Turbo Notify API**
   credential with that key and select it in every Turbo Notify node (4 of them, plus the Polling Trigger).
3. Create a **Basic Auth** credential named **Form access (Basic Auth)** (a user name and a password you choose) and
   select it in the form trigger. Share the form's Production URL and the password **only with your staff**: anyone
   who has them can make your number send messages. Leave the form's path as imported: it is the node's own random id.
4. Open **Your settings** and change the values (each one is also explained on the canvas, under the node):

   | Value | Meaning | Default |
   |---|---|---|
   | `owner_phone` | Your own number, with `+` and the country code. Exceptions, decline notes and contact cards go here. It must be a **different phone from the number linked to Turbo Notify**: the workflow sends from that number, so it would be writing to itself. While it is the placeholder the hourly run and the answer flow stop with a message. | `+55XXXXXXXXXXX` |
   | `business_name` | Used in the event title and the texts | `Your Business Name` |
   | `business_location` | Used when the form's Location is empty | empty |
   | `expected_timezone` | The time zone of the times you type. The workflow time zone (Workflow settings > Timezone) must be the same | `America/Sao_Paulo` |
   | `default_country_code` | See "Phone numbers" below: it adds the code to local numbers for `55` (Brazil) only | `55` |
   | `reminder_hours_before` | The invitation goes out when the appointment is this many hours away or less | 24 |
   | `min_notice_minutes` | No invitation for an appointment that starts sooner than this (it is listed as not reminded) | 60 |
   | `invite_alarm_minutes_before` | WhatsApp reminds the guest this many minutes before the start | 60 |
   | `no_answer_window_hours` | A customer who has not tapped is listed once the appointment is this close. `0` switches this report off | 4 |
   | `default_duration_minutes` | Used when the form's duration is empty | 30 |
   | `allow_extra_guests` | Let guests bring extra people (the answer then carries a count) | false |
   | `max_text_length` | Longest customer name, title, place or note the form accepts | 100 |
   | `max_appointments_per_day` | The form refuses more new appointments than this in 24 hours | 50 |
   | `invite_text` | The text of the invitation (`{name}`, `{business}`, `{when}`, `{where}`) | see the node |
   | `thanks_going_text`, `thanks_maybe_text`, `decline_customer_text` | What the customer gets after Going, Maybe, Not going | see the node |
   | `date_format` | How `{when}` is written (Luxon tokens) | `cccc d LLLL 'at' HH:mm` |

5. Make sure the workflow uses the time zone in `expected_timezone`: **Workflow settings > Timezone**.
6. Set an **Error workflow** (Workflow settings > Error workflow) that tells you when this one fails. The one failure
   that matters: if your WhatsApp number is disconnected, the hourly run's invitations fail, the rows become
   `send_failed` and the day's reminders are stranded until the number is back. Reconnect it, then set those rows'
   `status` back to `scheduled` (the owner message lists them).
7. Run **Run once: create the table** (**Execute workflow** from that trigger). It creates the Data Table. If you
   prefer to create it yourself: **Data tables > Create**, name `appointments` (lower case), columns `customer_name`,
   `phone`, `title`, `location`, `start_at`, `status`, `reminder_message_id`, `reminded_at`, `rsvp_at`, `last_error`,
   `notes` (string) and `duration_min`, `extra_guests` (number).
8. **Activate** the workflow, open the form's Production URL and add a first appointment for your own number a few
   hours ahead. The next hourly run (minute 5) sends you the invitation: answer it in WhatsApp to watch the rest happen.
   Delete the test row afterwards.

### Phone numbers

The default country code is `55` (Brazil), changeable in **Your settings** (`default_country_code`). A number is
accepted only when it is certain:

| Typed | Result |
|---|---|
| `+5511977770001`, `+55 11 97777-0001`, `005511977770001` | accepted as typed |
| `5511977770001` (13 digits) | accepted |
| `11977770001`, `(11) 97777-0001`, `011 97777-0001` (area code and the 9 digit mobile) | `+55` is added |
| `1177770001` (10 digits, no ninth digit) | refused: it could be a landline or an old mobile, so it is not guessed |
| `12345`, `abc` | refused with the reason |

With another default country code, only numbers that start with that code or with `+` are accepted: the way a local
number is written (a leading 0, a trunk prefix) differs by country and cannot be told from the number itself, so the
workflow does not guess. Every phone it sends to starts with `+` (the node refuses a phone without it).

### The table

| Column | Type | Content |
|---|---|---|
| `customer_name`, `phone` | string | The customer. `phone` in E.164, for example `+5511977770001` |
| `title`, `location`, `notes` | string | What, where, free notes (notes are never sent or overwritten) |
| `start_at` | string | Start in UTC, ISO 8601 with `Z`. Always write it this way when you add rows by hand |
| `duration_min` | number | Minutes. Empty or 0 uses the default |
| `status` | string | `scheduled`, `reminded`, `confirmed`, `tentative`, `declined`, `no_answer`, `not_reminded`, `invalid_phone`, `send_failed` |
| `reminder_message_id` | string | Id of the invitation. Matches the answers |
| `reminded_at`, `rsvp_at` | string | When the invitation went out, and the time of the last answer |
| `extra_guests` | number | Extra guests of the last answer |
| `last_error` | string | The reason of a `not_reminded`, `send_failed` or `invalid_phone` row: the message, a period, then the hint |

**When a reminder did not go out.** A row in `not_reminded`, `invalid_phone` or `send_failed` has its reason in
`last_error` and was listed once in your message. Fix the cause (the phone number, the time, the quota) and set the
row's `status` back to `scheduled`: the next hourly run sends it, provided the appointment is still inside the window.

## Moving or cancelling an appointment

The invitation that already reached the customer's phone stays there. **Deleting a row, or changing its time in the
table, does not recall or change it.** The Turbo Notify WhatsApp node (1.5.15) sends calendar events but has no
operation to edit or cancel one, so this part is done through the API, by hand:

- **Cancel:** call `POST /v1/numbers/main/messages/<reminder_message_id>/edit` with the event's `name`, `start_at` and
  `"canceled": true` (an HTTP Request node with your API key as a Bearer header does it; the same call is the MCP tool
  `cancel_calendar_event`). WhatsApp shows the event as canceled and tells the guests. Then delete the row.
- **Move:** for a new date, time or place Turbo Notify advises to cancel the event and send a new one, because a guest's
  old "Going" would otherwise carry over ([Edit and delete](https://docs.turbonotify.com/en/messages/edit-delete/)).
  Cancel the old invitation as above, then change the row's `start_at` to the new time (UTC, with `Z`) and set its
  `status` back to `scheduled`: the next hourly run sends a new invitation.
- A reminder that has not been sent yet (status `scheduled`) can simply be edited or deleted in the table.
- The entry a guest created in their own calendar with "Add to calendar" is not changed by either call: ask them to
  delete it.

## Plans, limits and caveats

- The **Polling Trigger works on every plan**. The instant trigger (webhook) needs Lone Wolf and a public address; this
  template uses polling on purpose. An answer reaches the workflow within about a minute.
- **Plan ceilings** ([Quota and usage](https://docs.turbonotify.com/en/usage/quota/)): the Free plan reaches 2
  different contacts per billing cycle (you, the owner who gets the report, count as one, so one customer in practice)
  and 300 messages. Lone Wolf reaches 100 contacts and 1,800 messages. A number connected today also has daily limits
  for its first week. The workflow reads the quota before each hourly run, keeps one message free for your report, and
  lists the rows it could not send. When the quota is used up even for the report, the send fails and n8n shows a
  failed execution.
- Sends go out one by one, paced per number: a run with many due rows takes a while (about 15 seconds per message was
  seen on the real API), and the node retries a `429` on its own.
- Reminders are sent with an idempotency key built from the row id and the start time. A run that crashes between the
  send and the save, or a repeat run, cannot send the same invitation twice.
- Only the form (or a system that writes the same columns, see below) should add rows. If you add rows by hand,
  `start_at` must be a UTC ISO timestamp and `phone` an E.164 number.
- The duplicate check of the form looks at the rows created in the last 24 hours.
- Turbo Notify is an independent service, not affiliated with Meta. Read the
  [WhatsApp business policy](https://www.whatsapp.com/legal/business-policy/) before you message customers, and
  message only people who expect to hear from you.

## Customization ideas

- **You already keep an agenda.** The one place the workflow takes appointments in is the table: **Save the
  appointment** writes the 13 columns of "The table" above (`status` `scheduled`, `start_at` in UTC with `Z`, `phone` in
  E.164, empty strings or 0 for the rest), and everything after it reads that table. Let your agenda (a sync, another
  workflow) insert rows with those columns and the hourly run and the answers work unchanged; the form can then be
  left unused. Reading rows from another store (Google Sheets, Airtable, a database) means replacing every Data Table
  node, and that is not tested here.
- Several reminders (a day before and two hours before): add a second status such as `reminded_2` and a second window.
- Add a link to your booking page in `invite_text`.
- Add a Slack or e-mail node next to **Send a WhatsApp text** to copy the owner message.

## Test record

Tested end to end in **n8n 2.45.5** (image `n8nio/n8n:2.45.5`, 2026-11-17) with the community package
**@turbo-notify/n8n-nodes-turbo-notify 1.5.15**, against a simulated Turbo Notify API (same routes, answers,
events and errors as the public contract). **No message was sent to WhatsApp in this run.**

SHA-256 of the tested `workflow.json`:
`d64f75e4d40ba4cfcc01af765581d2d7a92f80bc652de5e00dd464bb4be35f57`

The exact `workflow.json` of this folder was imported into a fresh n8n instance, with no other change than the patch
listed below, and the scenario `test/scenario.mjs` ran it: 502 assertions passed, 0 failed, 60 executions observed, 410 seconds (the Polling Trigger ticks once a minute). The workflow time zone was `America/Sao_Paulo`, so the form's
14:30 was checked to be stored as 17:30 UTC. 26 working nodes, 11 sticky notes (37 in all).

| Branch | What ran | What it proved |
|---|---|---|
| Table | "Run once: create the table", twice | Creates the table with its 13 columns, reuses it the second time, keeps the rows, sends nothing |
| Hourly, window | 8 rows | Only the two rows inside the window are invited (23 h and 5 h ahead). The event name, start, end, alarm offset, place and the date and time in the text, and the idempotency key `appt-<row id>-<start ms>` were read from the request the mock received. A row with no place has no "Where" line. Too far ahead (50 h) and already reminded are untouched |
| Hourly, one message | Same run | A row whose start passed and a row booked 20 minutes ahead become `not_reminded` with a reason; a phone without `+` becomes `invalid_phone`; a reminded row 3 hours from its appointment with no answer becomes `no_answer`. The owner gets exactly **one** message with the four sections, the time zone and what to do, and it names no healthy row. The run sent three messages in all |
| Hourly, order | Same run, and a run with nothing to send | The node that flags unsent rows started after the last invitation was recorded. With no row to send it still ran (a row in the past was flagged and reported), so the order does not depend on the canvas |
| Hourly, repeat | A second run | Nothing at all is sent, not even the owner message: the exceptions were reported once |
| Hourly, crash | A row put back to `scheduled` | The request is sent again, Turbo Notify answers with the original message, so no second message exists |
| Hourly, send refused | The mock answers 422 once | The run goes on (Continue On Fail), the row becomes `send_failed` with the reason (the message, a period, then the hint, no doubled period), the owner message lists it, it is not retried by itself and not reported again. Setting the status back to `scheduled` sends it |
| Hourly, quota | The mock reports 3 messages left, then 1 | With 3 left two rows are invited, the third is `not_reminded` (quota had no room), and the owner message still goes out because one message was kept for it, with the quota line. With 1 left no invitation is sent and the owner is told |
| Hourly, no answer | 6 rows, then `no_answer_window_hours` 0 | Flagged `no_answer` once, only when the appointment is within `no_answer_window_hours` and the reminder is more than an hour old. Far, fresh, past, already flagged and confirmed rows are untouched or not listed. A second run lists nothing. Ninety minutes later the fresh one is flagged. With the setting at 0 nothing is flagged and nothing is sent; back at 4 the row is flagged |
| Texts from Settings | `invite_text`, `date_format` changed | The invitation shows the changed text and date format, and the line with `{where}` disappears for a row with no location |
| Answers | Polling Trigger, workflow active, answers injected in the mock | Going with 2 guests, not going (owner text, customer text and contact card, in that order), maybe with 1 guest, a guest who changes their mind. `extra_guests`, the texts and the untouched `notes` were checked. An answer to an event that is not in the table sends nothing and changes no row |
| Answers, n8n off | The workflow deactivated, an answer injected, the workflow activated again | Nothing is handled while it is inactive. After activation the answer is handled at the next poll (row `confirmed`), the customer gets exactly one thank-you, and the next poll does not repeat it |
| Answers, texts | Pinned answers with other texts in Settings | The Going (with `{guests}` and `{when}`), Maybe and Not going texts are the ones in Settings; the owner text is unchanged |
| Answers, failure | Recipient set to fail in the mock | The invitation is accepted, then `message.send.failed` arrives through the poller: the row becomes `send_failed` with the reason and the owner gets a text with it, the number to check and what to do |
| Answers, outbound | Pinned Polling Trigger output | An answer with `direction: "outbound"` (the owner answering from the phone) changes nothing and sends nothing; the same event as `inbound` is applied |
| Answers, repeat | The decline event processed again | The three messages are requested again with the same idempotency keys and no new message is created |
| Form | Real HTTP calls to the form's production URL with Basic Auth | A valid entry is saved and the form answers 200 with what it saved (name, the phone as understood, time zone applied, default duration). Local phone formats (`11 97777-0044`, `(11) 97777-0045`, `011977770046`, `5511977770047`, `0055 11 97777 0048`) become `+55...`. Seven rejected entries (letters, no ninth digit, no area code, another country without `+`, past date, bad time, empty name) answer **422** with the reason, save nothing and send nothing. Control characters are removed; a web address, an @mention, a text over `max_text_length` and a duration over a day are refused and the answer does not repeat the link. `max_appointments_per_day` refuses with the number in the reason and holds exactly at the cap |
| Form, duplicates | The same phone and start twice | The second is refused with the phone and the time and nothing is saved; the same person at another time, and another person at the same time, are saved |
| Form, same day | A booking 20 minutes ahead, one 5 hours ahead | The first is saved and the answer says no reminder will be sent; the second says it is reminded by the first hourly run within the window |
| Form, access | Calls without credentials, with a wrong password, and the page itself | 401 each time, no execution starts, nothing is sent, the table is unchanged. The form path is the node's own random id, not a word |
| Time zone | `expected_timezone` set to `Asia/Tokyo` | The hourly run and the answer flow stop with "Time zone mismatch: this workflow runs in America/Sao_Paulo but expected_timezone in Your settings is Asia/Tokyo ...", the form answers 422 with the same facts, nothing is sent or saved. Put back, it runs again |
| Safe default | `test/placeholder.mjs`, nothing patched | With the placeholder `owner_phone` the table can still be created, the hourly run stops with a message that says what to set, the row is untouched and nothing is sent (6 assertions) |

Patch made by the scenario (`prepare`): only the `owner_phone` value in **Your settings**, set to the fictitious
`+5511977770099`. Other values (the cap, the time zone, the texts, `no_answer_window_hours`) were changed through the
stored workflow the way a person edits the node, and put back. The scenario also lets the test tool create the **Form
access (Basic Auth)** credential the form asks for. No Data Table is created by the test tool: the workflow creates
its own.

Commands (from the `n8n-nodes-turbo-notify` module, Node 22, Docker):

```bash
node templates/harness/run-template.mjs templates/appointment-reminders-with-rsvp/workflow.json \
  --scenario templates/appointment-reminders-with-rsvp/test/scenario.mjs --image n8nio/n8n:2.45.5 --tz America/Sao_Paulo
node templates/harness/run-template.mjs templates/appointment-reminders-with-rsvp/workflow.json \
  --scenario templates/appointment-reminders-with-rsvp/test/placeholder.mjs --image n8nio/n8n:2.45.5 --tz America/Sao_Paulo
```

**What the mock does not prove.** Nothing reached a phone: how WhatsApp renders the invitation, the Going / Maybe /
Not going buttons, real delivery and the real answers were not exercised. Delivery, failure and answers are whatever
the mock was told to produce. The form was tested over HTTP, not in a browser. n8n's form page prints the text of the
answer whatever the status code, so a refusal shows its reason; that is read from the form page source of n8n 2.45.5
(the same reading as for the sibling template), not seen in a browser, and so is the new random address an imported
copy gets. Not tested: a very large table, several numbers, the Free plan's contact limit (`contact_quota_exceeded` is
handled like any refused send), a daylight saving change, n8n being down for hours (it was down for seconds), and a
table that is edited by hand while a run is in progress (a row added while the hourly run is working can be flagged
`not_reminded` and listed, which is the safe side). The scopes `messages:send`, `messages:read` and `events:read` are
what the nodes call; the real runs below used a key with more scopes, so a key with only these three was not run.

### Real API run on this version

2026-11-17 (evening, `America/Sao_Paulo`), **n8n 2.45.5**, package **1.5.15**, against `https://api.turbonotify.com`
with a production key, one run, **156 assertions passed, 0 failed**, 529 seconds. The `workflow.json` of this run is the
one described by the SHA-256 `d64f75e4d40ba4cfcc01af765581d2d7a92f80bc652de5e00dd464bb4be35f57` (the same file as the
simulated run above, with only the `owner_phone` value patched to the owner's test number). The plan of the key's
organization was **CUSTOM**, not Free.

**Messages:** 7 real messages sent, inside the budget of 8 (2 calendar invitations, 1 owner message listing two
exceptions, 1 thank-you, and the 3 messages of a decline). All went to the owner's test number only, from a different
number of the same owner; the guard in the test tool blocked nothing. All 7 were deleted for everyone at the end and the
Data Table was removed.

What ran for real on this version: **Run once: create the table**; the production form over HTTP with Basic Auth (401
without credentials, 200 with them, a phone typed in a local format stored as `+55...`, the time read in
`America/Sao_Paulo` and stored as the right UTC instant within the minute, the same entry sent twice refused with 422 and
nothing saved twice, a past date refused with 422); the hourly run sending 2 invitations, whose texts are now the ones in
Settings ("If you see the buttons below, tap one, or just reply here"), with the flag step chained after the sends; a
second hourly run with no POST at all; the same idempotency key replayed after a simulated crash (the real API answered
`202` with the original message id and the quota did not move); a phone without `+` refused by the node before any
request and a booking made too late, both reported in one real owner message with the time zone; the time zone guard
with the real `$now.zoneName`; the Polling Trigger live for about 150 seconds (3 requests to the events feed, every one
`200`, no execution started); and the answer branch (an outbound answer ignored, going, not going, then the decline
again with no new message). Both invitations read back as `content_type: "calendar"`, `origin: "tn"` and reached
`delivered` within seconds.

What differed from the mock: the real API paces sends per number, so two sends of the burst got `429 send_rate_spacing`
and the node retried each on its own until it ended `202` (the simulated run did not enforce pacing: it is an option of
the mock, off by default); the real quota answer carried the plan as the upper case `"CUSTOM"` with a very large quota,
where the mock used a small one; the form's start time drifted 58 seconds from the instant asked (the form has no
seconds, the simulated run compared to the minute); the live Polling Trigger ran on a feed with no event of ours, where
the mock injected answers. The two number-status shapes (`GET /v1/numbers` gives an object, `GET /v1/numbers/main` a
plain string) were already known from the earlier real run. Nothing in the template needed to change because of these.

Still not proven (cannot be automated here): a guest tapping Going, Maybe or Not going on a phone, so the real
`message.calendar_responded` payload is unseen (the answer branch was fed events of the documented shape by pinning the
trigger); how WhatsApp draws the invitation and its buttons on a phone, personal or Business account; the Free plan's
limits (`contact_quota_exceeded` and the message quota of Free; this key's plan was CUSTOM); a calendar request refused by
the real API; a key holding only the three scopes the nodes call (this key had more); a daylight saving change and hours
of real polling. Send an invitation to a phone, tap each button once and check the table and the messages to close the
first two.

### Real API run, on the previous version of this workflow

2026-11-17, **n8n 2.45.5** (workflow time zone `America/Sao_Paulo`), package **1.5.15**, against
`https://api.turbonotify.com` with a production key, one run, **150 assertions passed, 0 failed**, 361 seconds. The
`workflow.json` of that run had the SHA-256
`275ed80d33f0439429e6565491f2766df2e2401f268721eff7d192c2af3af61f`, which is **not** the file tested above: since then
the four customer texts and the date format moved into Settings (the invitation now asks "If you see the buttons below,
tap one, or just reply here"), the form refuses a duplicate and names the phone it saved, the flag step is chained after
the sends through a Merge node, `last_error` reads as message, period, hint, the failure text to the owner names the
number, and the form address is the node's own random id. Those changes were tested against the simulated API only.
Patch made by the scenario (`prepare`): only the `owner_phone` value, set to the owner's test number. Every message went
to that one number (a guard in the test tool refused any other recipient, and nothing was refused), from a different
number of the same owner. The organization's plan was **CUSTOM**, not Free.

**Messages:** 7 real messages sent (2 calendar invitations, 1 message to the owner that listed two exceptions, 1
thank-you, and the 3 messages of a decline: owner text, customer text, contact card), inside the budget of 8. All were
deleted for everyone at the end (a message still `pending` is waited for first), and the Data Table was removed.

What ran for real:

| Part | Result |
|---|---|
| Table | **Run once: create the table** created the table; no row, nothing sent |
| Form, over HTTP with Basic Auth | Without credentials the form answered 401. With them it saved the appointment and answered 200 with the "Saved: ..." text. A phone typed in a local format (area code, then the nine digit mobile number, with a space and a hyphen) was stored as `+55...`, and the time typed in `America/Sao_Paulo` was stored as the right UTC instant (within the minute: the form has no seconds). A past date answered **422** with the reason and saved nothing |
| Hourly run | Read the real quota (`remaining` a number, `tier` upper case `"CUSTOM"`) and sent **2 real calendar invitations** (the form row 3 h ahead and one 20 h ahead; a third row 75 h ahead was left alone). The real API accepted each with `202 {message_id, status}`, read them back as `content_type: "calendar"`, `origin: "tn"`, status `sent` then `delivered` within seconds, and both rows stored the real message ids |
| Hourly run, again | Made no POST at all, and the table did not change |
| Replay | A row put back to `scheduled` sent the same idempotency key again: the real API answered `202` with the **original** message id, no third message existed and the quota did not move |
| One owner message | A row with a phone without `+` (refused by the node before any request, row `invalid_phone` with the reason) and a row booked 20 minutes ahead (below `min_notice_minutes`, row `not_reminded`) were reported in **one** real message to the owner with the sections "Not reminded (1)" and "Reminder failed (1)", the time zone and the how-to line |
| Time zone guard | With `expected_timezone` set to `Asia/Tokyo` the hourly run stopped at **Write the invitations** with "Time zone mismatch: this workflow runs in America/Sao_Paulo but expected_timezone ... is Asia/Tokyo", so the real `$now.zoneName` was `America/Sao_Paulo`; nothing was sent. Put back, it ran again |
| Polling Trigger | Activated for about 150 seconds: it polled the real events feed (3 requests, every one `200`) and started no failed execution |
| Answer branch | Fed documented-shape `message.calendar_responded` events by pinning the trigger: an answer from the phone itself (`outbound`) changed nothing, `going` gave `confirmed` and one thank-you, `not_going` gave `declined`, an owner text, a customer text and the contact card, all accepted by the real API; the same decline processed again created no new message |

Real facts seen in the real runs:

- Sends are queued and paced per number. In a burst the API answered `429 {"error": "send_rate_spacing"}` with
  `Retry-After: 1` three times and the node retried each one on its own, so every send ended `202`.
- `GET /v1/numbers` lists a number's `status` as an object `{status, at, reason}`, while `GET /v1/numbers/main` gives
  a plain string `status` with `at` at the top level.
- A calendar invitation is accepted with `202 {message_id, status}`, reads back as `content_type: "calendar"`,
  `origin: "tn"`, and its status goes `pending`, `sent`, `delivered` (`status.at` is an ISO UTC timestamp with `Z`).
- The node refuses a phone number without `+` before any request (`'Phone Number' is not a valid international
  number`), although the API itself accepts digits only. The workflow therefore normalises to `+...` itself.
- A message still `pending` cannot be deleted (`400 message_not_deletable`).
- The receipt events of our own messages arrive with `direction: "inbound"` and `origin: "native"` and `data.id` equal
  to our message id: match by id, never by direction.
- The recipient's account type is not an API field: nothing tells whether a customer has a personal or a Business account.
- No `message.calendar_responded` and no `message.send.failed` event existed on the account (checked on the events
  feed before and after the runs: 0 of each), so the answer branch was fed events of the documented shape (the number
  without `+`, `extra_guests` omitted at zero; see [Calendar events](https://docs.turbonotify.com/en/webhooks/calendar-events/)).

**Still not proven** (cannot be automated): a real guest tapping Going, Maybe or Not going on a phone (so the real
`message.calendar_responded` payload and the way WhatsApp draws the invitation on a personal or a Business account are
unseen: send an invitation to a phone and tap each button once, then check the table and the messages); a calendar
request refused by the real API; the Free plan's limits (the plan was CUSTOM); a daylight saving change; hours of real
polling; the changes listed above against the real API.

Rerun against the real API (the test number comes from the environment, the key from a file, neither is in the
repository; 7 of the 8 allowed messages are used):

```bash
export TN_REAL_OWNER_PHONE='+<your test number>'
node templates/harness/run-template.mjs templates/appointment-reminders-with-rsvp/workflow.json \
  --real-api --api-key-file <file with the line "- Value: tn_live_..."> --max-sends 8 \
  --scenario templates/appointment-reminders-with-rsvp/test/real.mjs --image n8nio/n8n:2.45.5 --tz America/Sao_Paulo \
  --run-id t1real --ports 5691,9201
```
