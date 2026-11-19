# Ask customers for an NPS score on WhatsApp after a purchase (Turbo Notify)

For a small shop, clinic or course that wants to know how customers feel after buying. Your shop or booking system posts an order or a service event. A day after the status you choose (default `delivered`), inside your sending hours, the customer gets one WhatsApp question: a number from 0 to 10. A happy customer (9 or 10) is thanked. A so-so customer (7 or 8) is asked what would make it a 10. An unhappy customer (0 to 6) is asked what went wrong, and you get an alert at once with the order, the score and the customer's contact card, then the comment. With a review page set, every customer who answered gets the same review button with the last thanks. Every Monday you get a short NPS report.

Other NPS templates exist in the n8n library (20880, 22663 and 4686 when this was checked, all based on Google Sheets). What this one adds: STOP handling, matching each answer to the open survey, a cooldown per customer, daily and per run caps, one re-ask, and everything kept in n8n Data Tables.

## Read this first

- **It asks, it does not chat.** The workflow only reads messages from customers who owe it an answer. Anything else written to the number (a question about an order, a photo, a group message) is ignored and never answered. A customer who writes something that is not a clear number gets ONE gentle re-ask (which also tells how to stop), then the survey closes. A person has to answer the other chats.
- **Tell your customers and honor STOP.** Ask only customers who agreed to be contacted by WhatsApp, and say so where they give you their number. Every question ends with the line "reply STOP" and a customer who does is never asked again, by this workflow. See [Protect your number](https://docs.turbonotify.com/en/general/abuse/) and the [WhatsApp business policy](https://www.whatsapp.com/legal/business-policy/). This is not legal advice: the rules that apply to you depend on your country and your business.
- **Reviews: ask everyone who answered, never only the happy ones.** With `review_url` set, the review button goes to every customer who answered with a score (`review_for` = `everyone`, the default), in the same neutral words, with their last thanks. Sending the link only to promoters is selective solicitation: review platforms such as Google prohibit it in their review policies, and consumer regulators treat it as deceptive. `review_for` = `promoters` exists for people who need it anyway and the setting note repeats the warning. `review_url` is empty by default: nobody gets a button until you set it (your Google Maps or Trustpilot page, not a complaint site). This is not legal advice.
- **n8n must run all day and all night, and your shop must reach it over HTTPS.** The webhook only works while the workflow is active and n8n is up. While n8n is off, the orders your shop sends are not received (unless your shop sends them again), nothing is asked and nothing is read. A local n8n needs a tunnel or a public address.
- **Your shop must be able to send a header of your choice.** The webhook is protected by a Header Auth credential: a request without the right header never starts a run. Native webhooks of Shopify and WooCommerce, as far as we could tell, only sign their body with their own header and cannot add a fixed header of yours, and their bodies are nested (the phone is inside `customer`). With those you need a relay in between (an automation tool, a small script you control) that adds the header and posts the flat JSON of "What your shop posts". This was not tested with any real shop.
- **It suits Lone Wolf or higher in practice.** Every customer you survey is a distinct contact of your number: the Free plan allows 2 per billing cycle (and 300 messages), Lone Wolf 100 (and 1,800 messages). The owner phone is one of those contacts too. One survey costs two to three messages and one contact; an unhappy customer costs up to six messages (the alerts to you included). See [Quota and usage](https://docs.turbonotify.com/en/usage/quota/).
- **n8n Cloud counts executions, and this workflow starts a lot of them.** n8n.io/pricing (read on 2026-11-18) lists 2,500 executions a month on Starter and 10,000 on Pro (Business, 40,000, is listed as self-hosted only). The 30 minute timer is 48 runs a day, about 1,440 a month. The 5 minute poll starts one run for every poll that finds a message on the number: up to 288 a day, about 8,640 a month on a busy number, far fewer when little is written. Your shop starts one more for every event it posts, also the ones that start no survey. A small plan can run out. Levers: slow the poll to 15 or 30 minutes (replies are then read later, the text is kept at least 1 hour), replace the timer by a Cron expression limited to your sending hours (`*/30 9-19 * * *`, about 660 runs a month), set Options > Number on the Polling Trigger when the account has several numbers, and make your shop post only the status that matters. Self-hosted n8n has no per execution price. Check the page again: prices change.
- **A reply is read within about 5 minutes, while its text still exists.** The workflow reads replies every 5 minutes. The text of a message is kept for 1 hour on the Free plan and up to 7 hours on Lone Wolf (see [Message retention](https://docs.turbonotify.com/en/messages/retention/)). A customer who answers while n8n is off is read at the next poll, but only if the text is still inside that period. After that the text is gone (`content_expired`, or a preview that says the content was redacted): such a reply is never read as an answer, never gets a re-ask, and the survey closes by itself after `close_after_days`. A STOP that expired unread cannot be honoured either: keep n8n up.
- **A disconnected WhatsApp number asks nobody for a while.** A question refused for a temporary reason (number not connected, Turbo Notify answering 5xx or not at all, the warm-up limit of a young number, the send pace) goes back to `queued` and is tried again at every run, until `close_after_days` after it was due. The run still ends in an error that names the order (setup step 6 explains how to be told), so with an Error workflow you hear about it at every run while it lasts. A refusal that waiting does not cure (a quota, `reply_ratio_too_low`, a key without the scope) becomes `send_failed` and waits for a person.
- **It does not run on sample settings.** The run stops with a plain message while `owner_phone` is the placeholder `+55XXXXXXXXXXX` or `business_name` is the sample. The two timers also stop while the time zone of the workflow is not `expected_timezone`; an order and a reply never depend on it, so a mismatch cannot lose an order or a STOP. Nobody is asked and nothing is stored. Activate only after step 5.
- **First messages to people who never wrote to your number are what WhatsApp users report.** A survey is exactly that. The defaults are small on purpose: 25 questions a day (`max_surveys_per_day`) and 5 per run (`max_surveys_per_run`, so a backlog at the opening of the sending hours is not sent as a burst). A new number may send only 50 messages on its first day, 200 on the second, 500 on the third (see [Rate limits](https://docs.turbonotify.com/en/messages/rate-limits/#warm-up-of-new-numbers)). Turbo Notify also refuses sends with `429 reply_ratio_too_low` when a number sends far more than it receives, which this workflow can cause on a quiet number: the refused question is recorded as `send_failed` with the reason and is not retried. Every answer you receive is a reply that helps. If it happens, lower `max_surveys_per_day`, survey only customers who already know the number, and let replies catch up; waiting alone does not help.
- **Privacy.** The poll reads the events of the whole number, so the n8n execution list shows the first 50 characters of every message that arrives on your number, whoever wrote it. The table holds the phone, the name, the score and the comment of your customers. If the number is also used to chat with customers, set the workflow setting "Save successful production executions" to "Do not save" (failed runs are still saved). Old rows are deleted by the workflow once a week (`purge_days`, 180 by default, 0 switches it off).

## Before you use it

The note on the canvas is short on purpose. What did not fit in it is here.

- **Plan.** Every customer is a contact, so in practice you need Lone Wolf or higher (Free reaches 2 contacts per billing cycle). See "Plans, quota and pace".
- **Your shop.** It must send a fixed custom header. Shopify and WooCommerce native webhooks usually cannot, so use a relay. Outside Brazil send numbers with `+` and the country code.
- **Executions on n8n Cloud.** The 30 minute timer is about 1,440 executions a month and the 5 minute poll up to 8,640. Slow them down on a small plan.
- **Error workflow.** Set one, so that you hear about a failed send.
- **Other NPS templates.** Others exist (20880, 22663, 4686, and ones based on Google Sheets). This one adds STOP, reply matching, a cooldown, a daily cap and a re-ask.
- **Install and tested on.** See [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/). It works on n8n Cloud and self-hosted, tested on n8n 2.45.5.

## What it does

- **Entry (A).** A Webhook receives a JSON order or service event. It requires a Header Auth credential: a request without the right header is answered `403` by n8n (the same answer for a missing and for a wrong value) and never starts a run. Fields are mapped from names you set (`field_order_id`, `field_customer_name`, `field_phone`, `field_status`, `field_order_url`, `field_items`), so any tool that can post a flat JSON body works. Only the statuses in `start_statuses` (default `delivered`, `*` for any status) start a survey. Any other status is not lost silently: one note row `status-01` to `status-20` (a ring of 20 slots, newer orders overwrite older ones) says "order 1042: status "paid" does not start a survey (start_statuses: delivered)", with no phone and no name. Text is cut (`max_text_length`, 100 by default), control and direction characters are removed, the order id must be 1 to 64 letters, digits or `. _ # : -` and must not start with `report-`, `optout-` or `status-` (the table uses those for its own rows), and a customer name or a list of items that carries a web address is dropped, because it would be written to the customer. The phone is turned into E.164 only where that is unambiguous (see "Phone numbers" below). An order whose phone is not valid is kept as `skipped`, with the reason, so you can fix it. The same order twice is ignored. A customer who opted out is skipped. A customer who was surveyed in the last `cooldown_days` (default 30) is skipped, with the order that was asked. Everything else is stored as `queued`, due `delay_hours` later (default 24). Nothing is sent at that moment.
- **Asking (B).** A Schedule Trigger runs every 30 minutes. It asks the queued surveys that are due, but only inside the sending hours (`window_start` to `window_end` in `expected_timezone`, default 09:00 to 20:00), at most `max_surveys_per_run` (default 5) per run and `max_surveys_per_day` (default 25) per local day, the earliest due first. A customer who still owes an answer is not asked about another order. The question is ONE Send Text: a friendly question for a number from 0 to 10 ("you may add one sentence") and the line to reply STOP. The idempotency key is built from the order id, so a question that was marked as asked but never confirmed (n8n stopped in between) is sent again with the same key and Turbo Notify returns the first message instead of a second one. A refused question is never silent: the row records it (`queued` again for a temporary refusal, `send_failed` for the others) and the run ends in an error that names the order.
- **Answers (C).** The Polling Trigger reads `message.received` and `message.replied` (a customer who swipes and answers the question arrives as `message.replied`). Only a private text message from a customer who owes an answer (an `asked` survey, or an `answered` one waiting for a comment) is looked at, plus a STOP from any customer of the table, and only on the number in `number_alias`. Everything else is ignored without a reply: another number of the account, a group, a voice note, the owner, a stranger, a sender whose number WhatsApp hides (it cannot be matched to a survey; this was handled in the code, no real event of that kind was seen), and a message whose text expired. The poll carries only the first 50 characters, so the whole message is read before it is judged. A score is ONE whole number from 0 to 10, written as digits (`9`, `9 !`, `10/10`, `7 out of 10`, `nota 8`) or as a word in English or Portuguese up to ten (`nine`, `dez`, `ten out of ten`). Two different numbers, a decimal, a number above 10 or no number is not a score: the customer gets ONE gentle re-ask, and after a second unclear answer the survey closes without another message. A valid score is stored with its category and answered:
  - **Promoter (9 or 10):** one thank you. With `review_url` set it is ONE link button message (the thanks above a button to your review page), without it a plain text. The survey is closed.
  - **Passive (7 or 8):** a thank you and the question "what would make it a 10?". The next message of the customer is stored as the comment, answered with one short thanks, and the survey is finished.
  - **Detractor (0 to 6):** an apology and "what went wrong?", and AT ONCE a text to the owner with the order, the score and the order link, followed by the customer's contact card. The next message of the customer is stored as the comment, forwarded to the owner and answered with one short thanks. These alerts are not held back by the sending hours: a detractor who answers at 23:00 pings you at 23:00.
  - A sentence in the same message as the score ("nota 10, entrega rápida e atendimento ótimo") is already the comment: no follow-up question is asked.
  - **The review button.** With `review_url` set and `review_for` = `everyone`, the last thanks of every customer who answered with a score is a link button message with the same neutral invitation (`msg_review_invite`): the thanks to a promoter, and the short thanks after the comment of a passive or a detractor. A customer who gives a score and never writes the comment is not sent the link. With `review_for` = `promoters` only a 9 or 10 gets it. Nothing the owner receives has a button.
  - **STOP and its words** (a whole message, `optout_words`: `stop, parar, sair, pare, cancelar, descadastrar, unsubscribe, para`) opt the customer out, are confirmed once, stop every open or queued survey of that customer and make the next orders `skipped`. A sentence that holds one of them ("please stop messaging me") is not an opt-out: it is an unclear answer, gets the one re-ask, and the re-ask says how to stop.
- **Report (D).** A Schedule Trigger every Monday at 8:00 sends the owner a short text: questions sent, answers and the response rate, the NPS (promoters minus detractors, as a percent of the answers), the three latest comments of unhappy customers (first name, score and text), the surveys that could not be sent and the orders skipped for a bad phone. No phone number appears in it. It is sent once per week: the week is written as a row `report-YYYY-Www` in the table. The same run deletes old rows (`purge_days`).
- **Cleaning up (E).** The 30 minute run closes a question nobody answered, or a comment nobody wrote, after `close_after_days` (default 7), and skips a survey that was never asked in that time. Once a week (the report run) closed, skipped and failed rows older than `purge_days` and the status notes go; a customer who opted out and every survey still open stay.
- **Setup branch (F).** "Run once: create the table" creates `surveys` when it is missing and does nothing when it exists.

### What it does not do

It is not a chatbot and it does not follow up more than described: the question, at most one re-ask, the follow-up question for a passive or a detractor, and one short thanks. It does not read voice notes or images as answers. It does not check that the shop's order is real. It does not retry a question refused for a reason that waiting does not cure, and it does not catch up a weekly report that fell while n8n was off.

### Phone numbers

`default_country_code` (default `55`, Brazil) completes local numbers. For Brazil the area code and the 9 digit mobile number are required: `(11) 9XXXX-XXXX`, `119XXXXXXXX`, `55119XXXXXXXX`, `0055119XXXXXXXX`, `0119XXXXXXXX` and `+55119XXXXXXXX` all become `+55119XXXXXXXX`. A number that cannot be told apart from a landline or that lacks the ninth digit is NOT guessed. With another country code, and in any other country than Brazil, your shop must send numbers with `+` and the country code: only numbers that start with `default_country_code`, or with `+`, are accepted, and an order with any other number is kept as `skipped`. The workflow never adds a `+` to digits it cannot place.

## Nodes

Live flow (24 working nodes, plus 9 notes):

1. `Receive an order` (Webhook, Header Auth)
2. `Poll WhatsApp replies` (WhatsApp by Turbo Notify Polling Trigger, every 5 minutes)
3. `Every 30 minutes: ask the surveys that are due` (Schedule Trigger)
4. `Every week: send the NPS report` (Schedule Trigger)
5. `Your settings` (Edit Fields: every value you change, each explained on the canvas)
6. `Check the settings` (Code: stops the run on a sample, a wrong time zone (timers only) or a setting that makes no sense, then names the entry point)
7. `Read the surveys` (Data Table, once per run)
8. `Decide what to do` (Code: a new order, the due surveys, the report and the clean-up, or which replies to read)
9. `Where does this go?` (Switch: read a reply in full, delete old rows, or save a plan)
10. `Delete old rows (purge_days)` (Data Table delete, new in this version)
11. `Read the whole message` (Turbo Notify: Get Message, Continue On Fail)
12. `Decide about the replies` (Code: score, re-ask, comment, STOP, expired text, one reply after the other)
13. `Save the survey before sending` (Data Table upsert, before anybody is messaged)
14. `Write the messages` (Code: the one place that makes every text from the settings)
15. `Which kind of message?` (Switch: text, review button, contact card)
16. `Send the text` (Turbo Notify: Send Text, Continue On Fail)
17. `Send the thank you with the review button` (Turbo Notify: Send Link Button, Continue On Fail)
18. `Send the contact card to the owner` (Turbo Notify: Send Contact Card, Continue On Fail)
19. `Gather the answers of Turbo Notify` (Merge, three inputs)
20. `Record the answers` (Code: matches each answer with its message, writes the id or the failure)
21. `Save the survey after sending` (Data Table upsert)
22. `Report what failed` (Code: fails the run when a message was refused)

Setup branch (2 nodes): `Run once: create the table`, `Create the surveys table`.

The previous version had 23 working nodes: the only new node is the delete node (the `If` that routed replies became a `Switch` with a third output).

## Setup

Works on n8n Cloud (community nodes enabled, Verified Community Nodes turned on: the package is a verified node) and on self-hosted n8n. Tested on n8n 2.45.5.

1. Install the community node package `@turbo-notify/n8n-nodes-turbo-notify` (tested with 1.5.15): Settings > Community Nodes > Install, or see [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/). Package page: https://www.npmjs.com/package/@turbo-notify/n8n-nodes-turbo-notify.
2. In Turbo Notify, connect your WhatsApp number and create an API key with the scopes `messages:send`, `messages:read` and `events:read`. In n8n create a **Turbo Notify API** credential with that key.
3. Create the credential for the webhook: **Header Auth**, named exactly **Order access (Header Auth)**. Choose a header name (for example `X-Order-Token`) and a long random value (30 or more characters, from a password generator). That value is the key to your customers' phones: share it only with your shop or booking system. Then import `workflow.json`. Select your credentials on the Webhook node and on **every** Turbo Notify node (the Polling Trigger, `Read the whole message`, `Send the text`, `Send the thank you with the review button`, `Send the contact card to the owner`). An import does not always pick them for you. The `path` of the webhook is fixed in the file: after an import in the editor read the **Production URL** the node shows and use that one. If you import through the API or the CLI, change the `path` (and the `webhookId`) to a new random UUID first. The protection is the header, not the secrecy of the address.
4. Click **Execute workflow** on `Run once: create the table`.
5. Open `Your settings` and replace `owner_phone` (your own WhatsApp number, with `+` and the country code, a different phone from the number linked to Turbo Notify: messages to yourself have no push) and `business_name`. On Free the owner phone is one of the 2 contacts per cycle. Choose `start_statuses`: the status that means the customer HAS the product (`delivered`; a question 24 hours after payment can arrive before the parcel). Check `number_alias`, `expected_timezone`, the sending hours (`window_start`, `window_end`), `delay_hours`, `review_url` (and `review_for`) and the texts (pt-BR texts below). Make the workflow time zone the same as `expected_timezone`: **Workflow settings > Timezone**.
6. Set an **Error workflow**, so you are told when a message was refused. First create a second workflow whose first node is an **Error Trigger**, followed by a Send Email (or Slack) node that writes the workflow name and the error message. Then open this workflow, **Settings** (the `...` menu), choose it under **Error workflow** and save. Without it the run still ends in an error, but only the Executions list shows it. (The Error workflow is not part of this template and was not run in the tests.) A WhatsApp message cannot be the channel for this one: it is the channel that failed.
7. **Activate** the workflow (the toggle at the top). The Production URL, the timer and the poll only work while it is active. Do it only after steps 3 to 5: while `Check the settings` stops the run, the poll has already taken the replies of that minute.
8. Test with a number you own, before your shop is connected. Post a `delivered` order with your own phone to the **Production URL** with the header of step 3 (the `curl` below). The Production URL answers only while the workflow is active; the Test URL answers only after you click "Listen for test event" on the Webhook node. Open the table and set `due_at` of the new row to a time in the past (or set `delay_hours` to `0`). The next 30 minute run asks the question; to see it at once, open the workflow and click **Execute workflow** on the timer node. Answer from that phone with `3`, wait for the poll (up to 5 minutes), then with a sentence, and look at the alert on the owner phone.
9. Only then point your shop at the **Production URL** of `Receive an order`, method POST, over HTTPS, with the header of step 3 and a JSON body (example below). n8n must be reachable from the internet at that address.

### What your shop posts

A flat JSON body. The names of the fields are settings, these are the defaults:

```json
{
  "order_id": "1042",
  "customer_name": "Ana Souza",
  "phone": "+55119XXXXXXXX",
  "status": "delivered",
  "order_url": "https://shop.example.com/admin/orders/1042",
  "items": ["Chocolate cake", "Tea"]
}
```

`order_id` and `phone` are required. `status` must be one of `start_statuses` (`*` accepts any, also a missing one). `customer_name`, `order_url` and `items` are optional. `items` can be a text, a list of names, or a list of objects with a `name` or a `title`.

```bash
curl -X POST 'https://YOUR-N8N-ADDRESS/webhook/THE-PATH-IN-THE-NODE' \
  -H 'X-Order-Token: YOUR-LONG-RANDOM-VALUE' -H 'Content-Type: application/json' \
  -d '{"order_id":"1042","customer_name":"Ana Souza","phone":"+55119XXXXXXXX","status":"delivered"}'
```

The shop gets `200` as soon as n8n accepts the request, before the order is checked. A rejected order (no valid id, no JSON body) shows only as a failed run. An order that is ignored on purpose (another status, the same order again) shows as a successful run that stored no survey: another status leaves a note row, the same order again leaves nothing.

**What the sender must be able to do.** Send an HTTP POST with a JSON body and ONE fixed header of your choice that carries the secret. A shop that cannot add a header of its own (many only sign their webhooks with a secret, which this template does not check; Shopify and WooCommerce native webhooks work that way as far as we could tell) needs something in between that can: a small relay, an automation tool, or a script you control. Nested bodies are not read: the relay must produce the flat body above. The tests simulated the shop with plain HTTP requests.

### The Data Table `surveys` (created by the setup branch)

The name must stay exactly `surveys` (lower case). To create it by hand: Data tables > Create, with these columns (dates are text in ISO 8601, UTC).

| Column | Type | Meaning |
|---|---|---|
| `order_id` | String | The id from your shop. One row per order. `report-YYYY-Www` rows record a weekly report, `optout-<digits>` rows remember a STOP from a customer that had no open survey and `status-01` to `status-20` rows note a status that started nothing |
| `customer_name`, `phone` | String | As received (name cut), phone in E.164. Empty phone: the order was skipped for a bad number (or the row is a status note) |
| `status` | String | `queued` (waiting for `due_at`), `asked` (the question went out), `answered` (a score is stored, a comment is awaited), `commented` (finished with a comment), `closed` (finished without one), `opted_out`, `skipped` (see `note`), `send_failed` (the question was refused, see `note`) |
| `score` | Number | 0 to 10, empty until the customer answers |
| `category` | String | `promoter`, `passive` or `detractor` |
| `comment` | String | What the customer wrote after the score, complete (cut at `max_comment_length`) |
| `asked_at`, `answered_at`, `due_at`, `created_at` | String | When the question went out, when the score came, when the question is due, when the row was created |
| `message_id` | String | The Turbo Notify id of the question. Empty until it is confirmed |
| `reasks` | Number | 0 or 1: whether the gentle re-ask was used |
| `note` | String | Why a row was skipped, closed or failed, or that a refused question will be tried again. Empty otherwise |
| `order_url`, `items` | String | From the order, kept for the owner alert and the texts |

You can edit rows by hand: set `status` to `queued` to ask a failed survey again, to `closed` to stop one.

**Never delete a row whose `status` is `opted_out`, or whose `order_id` starts with `optout-`.** Those rows are how the workflow remembers who said STOP: deleting one silently makes that customer askable again. The workflow itself never deletes them. For the rest, a safe cutoff is rows older than 31 days (or `cooldown_days`, if longer): the workflow does not read them any more, so they are only history. With `purge_days` (default 180, never below 60) the workflow does it for you once a week and leaves opted-out rows and open surveys alone. Set it to 0 if you want to keep everything and clean by hand.

## Settings (the `Your settings` node)

| Field | Default | Meaning |
|---|---|---|
| `owner_phone` | `+55XXXXXXXXXXX` (placeholder, the run stops until you replace it) | Gets the alerts about unhappy customers (at any hour) and the weekly report. Not the phone linked to Turbo Notify |
| `business_name` | `Your Business Name` (sample, the run stops) | `{business}` in the texts |
| `number_alias` | `main` | The number that sends and reads: `main`, an alias or a `num_` id. Replies to other numbers are ignored |
| `review_url`, `review_button_text` | empty, `Leave a review` | The review page. Empty: nobody gets a button. The button text is 20 characters at most |
| `review_for` | `everyone` | `everyone`: every customer who answered with a score gets the button with the last thanks. `promoters`: only a 9 or 10 (selective solicitation, see "Read this first") |
| `expected_timezone` | `America/Sao_Paulo` | The time zone of the sending hours. The workflow time zone must be the same (the two timers stop otherwise) |
| `default_country_code` | `55` | Completes local phone numbers |
| `start_statuses` | `delivered` | The order statuses that start a survey, comma separated, or `*` for any. Choose the status that means the customer has the product |
| `delay_hours` | `24` | Hours between the order event and the question |
| `window_start`, `window_end` | `09:00`, `20:00` | The sending hours of the questions. Outside them nobody is asked. Alerts to the owner are not limited by them |
| `cooldown_days` | `30` | One survey per customer per period. 0 switches it off |
| `max_surveys_per_day` | `25` | Most questions per local day |
| `max_surveys_per_run` | `5` | Most questions per run of the timer |
| `close_after_days` | `7` | When a survey nobody answered is closed, and when a question that could not be sent is given up |
| `purge_days` | `180` | Old closed, skipped and failed rows are deleted once a week. 0 never deletes, otherwise 60 or more |
| `max_text_length`, `max_comment_length` | `100`, `500` | Longest name and list of items; longest comment |
| `optout_words` | `stop, parar, sair, pare, cancelar, descadastrar, unsubscribe, para` | A whole message that stops the questions |
| `name_fallback` | `there` | What `{name}` becomes when there is no name |
| `field_order_id`, `field_customer_name`, `field_phone`, `field_status`, `field_order_url`, `field_items` | the names in the example above | Which field of your JSON holds what |
| the eleven `msg_` texts | English texts | Everything a person receives. Placeholders are listed in the notes of the node. `\n` is a line break |

Every value is also explained on the canvas, under the node.

## Plans, quota and pace

- The Polling Trigger works on every plan and needs no public address on the Turbo Notify side. The Webhook of this template is n8n's own, and it needs one.
- **Free: 300 messages and 2 distinct contacts per billing cycle.** Each customer you survey is a contact (and so is the owner phone). With 2 contacts one customer and you fit, and a third person is refused (`402 contact_quota_exceeded`): the question is recorded as `send_failed`. **Lone Wolf: 1,800 messages and 100 contacts per cycle**, so about 100 customers a month, which is why this template suits Lone Wolf or higher in practice. Sources: [Quota and usage](https://docs.turbonotify.com/en/usage/quota/) and [Rate limits](https://docs.turbonotify.com/en/messages/rate-limits/).
- Messages per survey: the question; a promoter one thank you (two to three messages in all), a passive two more (a follow-up and a thanks), a detractor up to five more (an apology, the alert and the card to you, then the forwarded comment and a thanks).
- The send pace is one message every 6 seconds on Free and every 1.2 seconds on Lone Wolf, and the node waits when Turbo Notify asks it to. A new number sends a limited volume a day in its first week (50 messages the first day, see [Rate limits](https://docs.turbonotify.com/en/messages/rate-limits/#warm-up-of-new-numbers)): keep `max_surveys_per_day` below that on a young number. The warm-up limit counts every message of the number, the thanks and the alerts too.
- `reply_ratio_too_low` (`429`, see [Rate limits](https://docs.turbonotify.com/en/messages/rate-limits/)): the number sent far more than it received. It comes without `Retry-After`, waiting does not help, and the question becomes `send_failed`. Levers: fewer questions a day, survey customers who already write to the number, and let answers arrive. It was never provoked on the real API: the behavior here rests on the documentation and a simulated answer.
- A refused question does not use quota. Test with your own phone first and look at the numbers in the dashboard before you rely on the ceilings.
- Everything is sent from the number in `number_alias` (default `main`), on the five Turbo Notify nodes. Replies to other numbers of the account are ignored by the code. Also set **Options > Number** on the Polling Trigger to save reads (that option exists in the node and was not run in the tests: it is a setting of the trigger itself, so type the same alias there).

## Things to know before you rely on it

- **One open question per customer.** A customer who has not answered yet is not asked about a second order until the first survey is finished or closed.
- **The first matching event of an order wins.** If your shop sends several statuses of `start_statuses` for the same order, the survey starts with whichever comes first, the later event is ignored as the same order.
- **The same order read again later starts a new survey.** The workflow reads only the open surveys, the customers who opted out and everything created in the last 31 days (or `cooldown_days`, if longer). A shop that posts `delivered` again for an order that is older than that finds no row: a new survey is created and its row overwrites the old one (same `order_id`). A customer who opted out is still protected, and the cooldown protects 30 days. The overwritten row is history only.
- **The table is read in part on every run.** That is fine for the thousands of surveys of a small business, not for a very large one.
- **A run is not atomic.** The row is written before the first message and again after it. If n8n stops between a send and the second save, the next run asks the same question again, and the idempotency key makes Turbo Notify return the first message instead of sending a second one (tested by putting the row back to its earlier state, not by killing n8n). A reply is saved before the thanks goes out, so a restart cannot lose an answer.
- **A question that timed out may have gone out.** When Turbo Notify did not answer in time the question goes back to `queued`; the next try uses the same idempotency key, so a message that did go out is returned, not sent twice.
- **Two customers answering at the same moment** are judged one after the other, in the order they were written.
- **A customer who answers a different question.** A customer with an open survey who writes something else gets the one re-ask, and then the survey closes. Other messages stay unanswered, by design.
- **STOP is honoured for customers of the last 31 days.** The workflow only reads the rows of the last 31 days (or `cooldown_days`, if longer), the open surveys and everyone who opted out. A STOP from a customer surveyed longer ago than that is not answered.
- **A reply that is not text** (a voice note, a photo, a sticker), **a reply whose text expired** and **a reply from a sender whose number WhatsApp hides** is not read as an answer.
- **A weekly report that fails to send is not sent again** that week. Delete its row `report-YYYY-Www` and run the weekly trigger by hand to send it.
- **The executions list fills up** (one run every 30 minutes, one for each poll that finds a message). n8n prunes it by itself (see its settings for "Prune data").
- **The webhook accepts any size n8n accepts.** The text that is kept is cut as described above, but an oversized request is still received by n8n first. Keep the address private.

## Customization

- **Other channels in the same shape.** Everything that leaves the workflow goes through `Write the messages`, which returns one item per message (`to`, `text`, `key`, `kind`, ...). To add an e-mail to the owner next to the WhatsApp alert, put your node after that Code node, in parallel with the three send nodes. This is a hint: it was not built or tested.
- **Another score scale or more categories.** The thresholds (9 and 10, 7 and 8, 0 to 6) are in `Decide about the replies`. Not tested with other values.
- **Wording.** All the texts are in `Your settings`. Brazilian Portuguese:
  - `msg_question`: `Olá {name}, obrigado pelo seu pedido {order_id} na {business}. De 0 a 10, qual a chance de você nos indicar a um amigo? Responda com um número (se quiser, acrescente uma frase). Para não receber mais estas perguntas, responda PARAR.`
  - `msg_reask`: `Desculpe, não entendi. Responda com um número de 0 a 10, por favor, ou PARAR para não receber mais estas perguntas.`
  - `msg_promoter`: `Obrigado, {name}! Ficamos felizes que você tenha gostado.`
  - `msg_review_invite`: `Se tiver um minuto, uma avaliação pública ajuda outras pessoas a nos encontrar.`
  - `msg_passive`: `Obrigado, {name}. O que faria a sua nota ser 10?`
  - `msg_detractor`: `Sinto muito, {name}. O que deu errado? Uma pessoa vai ler a sua resposta.`
  - `msg_comment_thanks`: `Obrigado, {name}. A sua resposta chegou até nós.`
  - `msg_optout_confirm`: `Pronto. Não vamos perguntar de novo.`
  - `msg_owner_alert`: `Cliente insatisfeito: {customer_name} deu nota {score} ao pedido {order_id}.\n{order_url}`
  - `msg_owner_comment`: `{customer_name} escreveu sobre o pedido {order_id} (nota {score}): {comment}`
  - `msg_report`: `Relatório NPS, últimos {days} dias\nPerguntas enviadas: {asked}\nRespostas: {answered} ({rate}% das perguntas enviadas)\nNPS: {nps}\nPromotores {promoters}, neutros {passives}, detratores {detractors}\nÚltimos comentários de clientes insatisfeitos:\n{comments}\nNão enviadas: {failed}\nIgnoradas, telefone inválido: {skipped}`
  - `review_button_text`: `Deixar avaliação`, `name_fallback`: `cliente`, `optout_words`: `parar, stop, sair, pare, cancelar, descadastrar, unsubscribe, para`.
  - Number words in Portuguese up to `dez` are read as scores already.
- **Sending hours and the delay.** `delay_hours` 24 asks a day after the event: for a clinic or a course use a few hours after the appointment. The hours are the hours of your customers, in `expected_timezone`.
- **Fewer executions on n8n Cloud.** See "Read this first": a slower poll, a Cron expression for the timer limited to your sending hours.

## Test record

Tested end to end from the exact `workflow.json` (SHA-256 below), in a fresh throwaway n8n, against a simulated Turbo Notify API. Nothing reached WhatsApp in that run. A second, shorter run against the real API follows ("Real API run"). See "What is not proven".

| | |
|---|---|
| Date | 2026-11-18 |
| `workflow.json` | SHA-256 `e7db9973641b05855cfe229edb2bc3ea879307744837f25ef0e8970fd4684fef` (`shasum -a 256 workflow.json`) |
| Notes reformatted | Notes reformatted 2026-11-18 after n8n review feedback on T1; node logic unchanged; mock scenario rerun: 795 assertions, 0 failed (n8n 2.45.5, package build 1.5.16). The file before the reformat had the SHA-256 `d21c34a7b7e0f176bda01211dcc8335618689f6838620eb94c02b1d5576ab2d0`, and the real API runs below were made on it. `workflow.png` was retaken on 2026-11-18 in the n8n 2.45.5 editor and shows the reformatted notes. The overview note height was trimmed afterwards, after a look at the canvas in n8n 2.45.5 (only the size of that note changed, so the mock scenario was not run again). |
| Canvas relaid out | Canvas relaid out 2026-11-19 after n8n returned the first template (appointment reminders) a second time over the sticky notes: only node positions and the size of the notes changed (a left to right layout in sections, every node inside exactly one section, no overlapping sections, the warning inside its section over the node it concerns, the overview at the top left), and node logic, names, connections and note texts were unchanged by that step. The SHA-256 before the layout was `f16c57a2ea56a6e72d097c4d9fd6a132a9c9d7fcec77f5178c898029059c7f58`. `workflow.png` was retaken from the final layout in the n8n 2.45.5 editor. Text edits of the same day (round 2 of the review, no logic change; only sticky notes, a placeholder, comments and ids): the overview starts with "Ask customers for a 0 to 10 score on WhatsApp a day after their order.", the next sentence lost its repeated "WhatsApp question, 0 to 10" and step 1 of Setup says it is a verified community node. The SHA-256 above is the file after these edits; the layout alone had `d0562a21b9a70a9af82145be3dd362bf98ce58290bc10758c8c4384428f5b133`. The layout file (`d0562a21...`) ran the full scenario: 795 assertions, 0 failed, 51 steps, 2,544 s (a first attempt on a loaded machine had failed one assertion with "Turbo Notify did not answer in time", the failure the README already describes, so it was repeated on a quiet machine). On the final file `test/placeholder.mjs` was run again (15 assertions, 0 failed, 19 s) and the template guard tests (97 passed); the full scenario was not repeated because only the overview note changed and the scenario does not read it. |
| n8n | 2.45.5 (image `n8nio/n8n:2.45.5`, id `sha256:9f6d0a5987ab5a297c4b0b38fbf1a22285dd1364551478e93f03d506908fa74c`), time zone `America/Sao_Paulo` |
| Package | `@turbo-notify/n8n-nodes-turbo-notify` 1.5.15 (built from this repository) |
| Mock API | `templates/harness/mock-api.mjs`, same routes, answers, events and errors as `public-docs-web/public/openapi.json` |
| Patches applied to `workflow.json` by the scenario | none in the file. The workflow is imported as exported and the scenario proves it refuses to survey anybody with the sample settings. Then it types the values a person must type, through the stored workflow: `owner_phone`, `business_name` and the sending hours (the whole day, so that the run does not depend on the clock). For single steps it also changes one setting and puts it back (the field names, the texts, `start_statuses`, `optout_words`, `max_text_length`, `max_surveys_per_day`, `max_surveys_per_run`, `purge_days`, `number_alias`, `review_url`, `review_for`, `cooldown_days`, `default_country_code`, `expected_timezone`, the sending hours). `delay_hours`, `cooldown_days` and `close_after_days` stay at their exported values: the clock is moved by writing older timestamps into the table (`due_at`, `asked_at`, `created_at`), which a person could do too. The timer (30 minutes) and the poll (5 minutes) run at their exported rhythm in the live block |
| Scenario | `test/scenario.mjs`, 51 steps, 795 assertions, 0 failed, 2,550 s (rerun 2026-11-18 after the notes were reformatted: see the row above; the scenario waits up to 120 s, not 30 s, for the sends after a reply and for the timer run to finish) (including one wait for the real 30 minute timer and several for the real 5 minute poll). A second scenario, `test/placeholder.mjs`, runs the file with nothing patched (3 steps, 15 assertions) |
| Other checks | the module's own jest suites (including the template tests: valid JSON, no placeholder credentials, no em or en dash, no invisible or bidirectional control characters, every node connected, overview note and section notes, authentication on the webhook) and `npm run lint`: 17 suites, 410 tests, all green; `npm run lint` exits 0. |

Rerun (from the `n8n-nodes-turbo-notify` module, Node 22, Docker; the time zone must be the one of the template; the first scenario takes about an hour because of the two real clocks):

```bash
node templates/harness/run-template.mjs templates/post-purchase-nps-survey/workflow.json \
  --scenario templates/post-purchase-nps-survey/test/scenario.mjs --image n8nio/n8n:2.45.5 --tz America/Sao_Paulo
node templates/harness/run-template.mjs templates/post-purchase-nps-survey/workflow.json \
  --scenario templates/post-purchase-nps-survey/test/placeholder.mjs --image n8nio/n8n:2.45.5 --tz America/Sao_Paulo
```

How each entry point was reached: the order branches run from the Webhook node with a pinned request (a webhook cannot be started by hand), and the real HTTP behavior is in the live block at the end; the reply branches run from the Polling Trigger with events taken from the mock's own event feed (the mock turns an incoming message into the same event the API serves); the 30 minute run and the weekly report run from their Schedule Triggers by hand. The last block activates the workflow and uses real HTTP requests, the real poller and, once, the real 30 minute timer. A message whose text expired is served by a fault injected into the mock (`content_expired: true`, empty text), the way the retention page documents it.

Branches run (each step asserts the requests the mock received and the rows in the table):

| Branch | Proved |
|---|---|
| Exported file | The webhook needs Header Auth, accepts POST only and is addressed by its random id. The samples are in `Your settings`, each value is explained on the canvas, no text has an em or en dash. Defaults: `delivered` only, 25 a day, 5 per run, purge after 180 days, `review_for` everyone, the extended opt-out words, a poll every 5 minutes, a timer every 30. The three send nodes take the number from `number_alias`. No run of 8 or more digits anywhere in the file |
| Setup branch, three times | The table is created by the workflow, running it again creates nothing and keeps the rows |
| Guard: samples | As exported, an order, the 30 minute run, the weekly report and a reply each end the run in an error that names `owner_phone` and `business_name`; nothing was read, sent or stored. Each setting is then checked on its own: a short owner number, the time zone (`Asia/Tokyo` against `America/Sao_Paulo`: the timer is refused, an order is not), hours that end before they start, hours that are not HH:mm, a negative delay, a daily cap of 0, a cap per run of 0, `purge_days` 30, an empty `number_alias`, a `review_for` that is neither, closing after 0 days, a review link that is not http or https, a button text over 20 characters, no start status, no opt-out word, an empty field name, an empty text, a country code that is not digits |
| A new order | Mapped fields, `due_at` 24 hours later, nothing is sent at that moment |
| Start statuses | With `delivered` only: `paid`, `pending`, `cancelled`, `refunded`, `created`, an empty and a missing status start nothing and leave one note row each (`status-NN`, no phone, no name) that says which status arrived; `DELIVERED` with spaces starts a survey; a `delivered` event after a `paid` one for the same order is not blocked by the note; `paid, delivered` as a setting; `*` starts a survey for any status and for none. 26 orders with a status that starts nothing leave at most 20 note rows |
| Field limits | Name and items cut at 100 (a setting), direction, zero-width and control characters removed, a name or a list with a web address or an @mention dropped, an order link that is not http or https or is over 500 characters dropped, a list of names, of objects and a text all read |
| Bad requests | No order id, an id over 64 characters, with a slash, a web address or a space, an id that starts with `report-`, `optout-` or `status-`, a body that is a list, a text or missing: the run fails with a plain message, nothing is stored |
| Phone numbers | Eight shapes of a Brazilian number become one E.164 number; a short number, no digits, a number without the ninth digit, a landline, a wrong `+` number and a missing phone are skipped with the reason in the row; with `default_country_code` 44 only numbers that start with 44 or `+` are accepted |
| Same order again | Ignored, the row is untouched, also when the first survey is finished |
| Cooldown | The second order of the same phone is skipped with the order that was asked; still skipped at 29 days, queued at 31; a failed survey and another customer do not count; `cooldown_days` 0 switches it off |
| Other field names | A tool that names its fields differently works through the settings; a body with the old names is refused |
| The question | Not sent before it is due; then ONE text with the key `nps-question-<order>`, the row is `asked` with the message id; the next runs ask nobody again; the wording (`{name}`, `{items}`, `{business}`, a line break, `there` without a name) is a setting |
| Idempotent resend | A row put back to `asked` without a message id is sent again with the SAME key: two requests, ONE message in the mock, the row has the first id again. A question asked a minute ago is not repeated |
| Sending hours | Outside them nothing is sent and the survey waits; inside it is asked |
| Time zone guard | With `expected_timezone` `Asia/Tokyo` the timer and the weekly report stop at `Check the settings` with the plain message (nothing read, sent or changed); a new order is still queued, a reply is still read and a STOP is still honoured |
| Daily cap and cap per run | Cap 2 with three due surveys: the two that were due first are asked, the next run sends nothing, a day later the third is asked. A cap of 2 per run with four due: two, then the next two |
| One open question | A customer who still owes an answer is not asked about a second order; a customer is asked once per run; the waiting order is asked after the first is closed |
| Refused question | `402 contact_quota_exceeded` on the send: the row is `send_failed` with the reason and not counted for today, the run fails naming the order and no phone number, the next run does not try again, set back to `queued` it is asked |
| Temporary refusal | `409 number_not_connected`, `503` and `429 warmup_limit_exceeded`: the row goes back to `queued` (asked time and message id cleared, due time kept, note "will try again"), the run still fails naming the order and says it will try again, the next run asks it with the same key and the old note is gone. `429 reply_ratio_too_low` is `send_failed`. A queued row due 8 days ago is skipped "not sent in time", so a retry never goes on forever |
| Cleaning up | `asked` after 8 days closed with "no answer in 7 days", `answered` after 8 days closed with the score kept, `queued` and due 8 days ago skipped "not sent in time"; at 6 days and 2 days nothing changes; nothing is sent |
| The score | 43 replies in four polls: digits, `9 !`, `9!!!`, `10/10`, `7 de 10`, `5 out of 10`, `nota 8`, `nota8`, `Score: 6`, words in English and Portuguese (`nine`, `Ten`, `dez`, `Oito!`, `zero`, `ten out of ten`, `nota dez`, `um`, `uma estrela`, `sete`, `três`, `one of the best, ten`, `nove nove`, `9 9`); not a score: `hello`, `thanks!`, an emoji, `7 or 8`, `seven eight`, `8.5`, `8,5`, `11`, `100%`, `a 5 and a 9`, `order 123 was a 9`, `nine or ten`, `um atendimento ruim` (one re-ask each) |
| Quoted reply | A `message.replied` event counts like a message |
| Promoter | One plain text, closed, no follow-up; with `review_url` ONE `cta_url` link button message with the thanks above the button; whatever comes next is ignored |
| Review for everyone, or for promoters | With `review_for` everyone: a passive, a detractor, a passive with a sentence and a promoter each get ONE link button (the last thanks) with the same words; the follow-up questions and everything the owner receives stay plain texts. With `promoters`: only the 9 or 10 gets the button, a passive and a detractor get plain thanks. Without `review_url` nobody gets a button |
| Passive | The question "what would make it a 10", then the next message (a long one, read in full) is the comment, ONE short thanks, nothing to the owner |
| Detractor | The apology, the alert (order, score, order link) and the contact card to the owner at once; the next long message is stored complete, forwarded to the owner and thanked once. Without an order link that line is dropped; without a name the phone names the customer in the alert and `name_fallback` is used for the customer |
| A sentence with the score | A promoter, a passive and a detractor who write a sentence next to the score get no follow-up question; the owner gets the alert, the comment and the card for the detractor only |
| Re-ask | ONE gentle re-ask (which names STOP), then the survey closes without another message; a late score is ignored |
| Order of replies | Two messages of the same customer in one poll are judged in the order written; an unclear answer then a score does not cost the survey |
| Unrelated chat | A stranger, a customer with a closed survey, the owner, a group message, a voice note and the echo of our own messages: nothing is read, sent or changed |
| Expired reply | A reply whose message is served with `content_expired: true` and no text, for a survey that waits for a score and for one that waits for a comment: nothing is sent, no re-ask is counted, the row does not change. A preview that holds the redaction marker is dropped before the message is even read. After `close_after_days` the survey closes by itself. A readable answer afterwards is handled as before |
| Hidden number | An event whose sender has no number is ignored: nothing read, nothing sent, the survey unchanged |
| `number_alias` | With `main` a reply written to another number is ignored (not even read); with `sales` a reply to main is ignored and a reply to sales is read, and the thank you and the question leave from `/numbers/sales/`; the `num_` id of that number works the same |
| STOP | `Stop!`, `PARAR` and `Sair`, then the other default words (`unsubscribe`, `Pare`, `cancelar`, `Descadastrar!`, `para`) and a word of your own (`optout_words`): confirmed once, open and queued surveys stop, a second STOP is not confirmed again, the next order is skipped with the reason and nothing is ever asked; after a finished survey a marker row remembers it; a stranger is not answered; STOP inside a sentence is not STOP (one re-ask that says how to stop) |
| The whole way | An order from the webhook to the end of the survey: six messages, in order, each with its own key, none twice |
| Weekly report | An empty week says so; a full week: questions sent, answers and rate, NPS, the three latest unhappy comments (first names), failures and bad phones with their order ids, rows older than 7 days and marker rows not counted, no phone number in the text; a second run in the same week sends nothing; a report that is sent again after its row was deleted has other numbers and is not refused as a key conflict; a refused report fails the run naming it |
| Weekly clean-up | Closed, commented, skipped and failed rows, a status note and an old report row older than `purge_days` are deleted; a STOP (`opted_out`), a STOP marker, an open survey and a recent row stay; `purge_days` 0 deletes nothing |
| Live webhook | No header: `403`; a wrong value: `403`, the same answer; the token in the `Authorization` header: `403`; GET: refused; none of them starts a run or stores a row. A correct request: `200`, the order is queued, the same request again stores nothing, a very long name is cut |
| Live poller | A reply written to the number was read by the real Polling Trigger (the real tick, up to 5 minutes) and the survey went on; the echo of our own messages started nothing more |
| Inactive, then active again | A reply written while the workflow was switched off was read by the first poll after switching on, complete. It is not lost |
| Live 30 minute timer | A due survey was asked by the real timer, once |

### Real API run

A second test ran the same `workflow.json` against the real Turbo Notify API, with real WhatsApp delivery between two numbers of the same owner (the number under test sends the questions, the number of another organization plays the customer and answers). The harness guard allowed one recipient and a budget of messages. Nothing in the file was edited.

| | |
|---|---|
| Date | 2026-11-18 |
| `workflow.json` | SHA-256 `d21c34a7b7e0f176bda01211dcc8335618689f6838620eb94c02b1d5576ab2d0` (the file before the notes were reformatted on 2026-11-18; only sticky notes differ from the current file) |
| n8n | 2.45.5 (image `n8nio/n8n:2.45.5`, id `sha256:9f6d0a5987ab5a297c4b0b38fbf1a22285dd1364551478e93f03d506908fa74c`), time zone `America/Sao_Paulo` |
| Package | `@turbo-notify/n8n-nodes-turbo-notify` 1.5.16, the local build of this module that the harness copies into n8n (the latest version on npm is also 1.5.16, but the template does not depend on a package version: it needs a Turbo Notify node and the two triggers) |
| API | `https://api.turbonotify.com`, key of an organization on a plan with a large quota (not the Free plan) |
| Patches applied by the scenario | the values a person types in `Your settings` (`owner_phone` a fictitious number, `business_name`, `review_url` `https://example.org/reviews`, the sending hours: the current hour and the next one), the poll from 5 to 1 minute and the timer from 30 to 1 minute (the smallest intervals n8n allows). The clock of a survey was moved by writing an older `due_at` or `created_at` into the table |
| Scenario | `test/real.mjs`, 9 steps, 63 assertions, 0 failed, 556 s |
| Messages | 10 real messages: 6 sent by the workflow through the number under test and 4 written by the customer number. All were deleted for everyone when the run ended |

Rerun (from the `n8n-nodes-turbo-notify` module, Node 22, Docker, two API keys of two organizations that each have a connected number you own; the guard allows one recipient and stops at the budget):

```bash
export TN_REAL_OWNER_PHONE='+<the customer number>'
export TN_REAL_PERSONAL_PHONE='+<the number under test>'
node templates/harness/run-template.mjs templates/post-purchase-nps-survey/workflow.json \
  --real-api --api-key-file <key of the number under test> --customer-key-file <key of the customer number> --max-sends 10 \
  --scenario templates/post-purchase-nps-survey/test/real.mjs --image n8nio/n8n:2.45.5 --tz America/Sao_Paulo \
  --run-id t6real --ports 5697,9251
```

What ran for real, in order: the table created twice by the workflow; the webhook refusing a call without the header and with a wrong one (`403` both); an order with the status `paid` leaving a note row and no message; survey 1 with the phone typed the local way (turned into E.164) and the same order posted twice (stored once); the real timer asking the question once, with the key `nps-question-<order id>` (state `delivered`); a second order of the same phone skipped by the cooldown with nothing sent; the customer answering `10` from the other number, read by the real Polling Trigger, and the thanks arriving as a link button that the API accepted (`202`, state `delivered`); survey 2 for a passive customer: the question, the answer `8`, the follow-up question, the comment, then the last thanks as a link button; the customer writing `STOP`, confirmed once; an order after STOP skipped with nothing sent. The guard blocked nothing, and the request log shows no `429` and no `content_expired`.

Differences from the simulated API:

- **Reply latency.** A reply written from the other number was in the table 46 to 65 seconds later, with the poll patched to one minute. The events feed already had the reply by the next tick, so with the exported 5 minute poll expect a reply to be read within about 5 minutes.
- **The link button.** The API accepted it every time (`202`) and the state reached `delivered`. How the phone draws it was not seen.
- **Idempotency lasts longer than a run.** A question sent with the key of an order that had been asked by an earlier attempt of the same day came back as the message of that earlier attempt (same message id, its old state) and nothing new was delivered. A new order id always makes a new question, so a shop is not affected, but it is the reason the scenario puts a per-run suffix on its order ids.
- **The number is a real inbox.** Other people wrote to the number under test while the workflow was on. None of those chats produced a message.
- **The owner is not a customer.** The template ignores messages written by `owner_phone`, so a customer that is also the owner never gets read (a first attempt of this test stopped at the first answer because of that, with nothing wrong in the file). The scenario now uses a fictitious `owner_phone`.
- **`429` and `content_expired`** never appeared in this run, as in the simulated API only when injected.

### What is not proven

- **Real WhatsApp delivery to a human.** Delivery between two owned numbers was proven (see "Real API run"): the question, the follow-up, the confirmation and both link buttons reached `delivered`. A person did not read them: how the link button looks on a phone, on a personal account and on a Business account, was not seen. The owner side was not run for real: the alert, the comment, the contact card and the weekly report go to `owner_phone`, which cannot be the customer's number, and the guard allows one recipient. The contact card, the detractor path and the re-ask were therefore tested only against the simulated API. A separate owner number could not be covered.
- **Any real shop or booking tool.** Shopify, WooCommerce, forms and booking tools were not connected; their payloads were simulated with flat JSON. That their native webhooks cannot send a header of your choice is our reading, not something we tested. Nested payloads are not read.
- **n8n Cloud execution counts.** The figures in "Read this first" are arithmetic from the timer and the poll rhythm and from the prices page as read on 2026-11-18, not measured on a Cloud plan.
- **Reply latency on the exported poll.** Measured once with the poll patched to one minute (46 to 65 seconds). The exported 5 minute poll was not waited for against the real API.
- **The real Free plan and the real limits.** The real run used an organization on a large plan: no Free plan, no warm-up limit, no spacing and no `429` appeared. The `402`, `409`, `503` and `429` answers came from faults injected into the mock, from the documented contract. No Free plan, no warm-up limit, no `reply_ratio_too_low` and no spacing of 6 seconds was exercised end to end. How n8n itself reacts to a real `429` with a long `Retry-After` was not studied: the warm-up fault was tested without that header.
- **Real expired content.** `content_expired` never appeared in the real run. The expired reply was a fault served by the mock, built from the retention page. The mock does not expire content by itself, and the exact marker of a redacted preview was taken from the code of the webhook worker, not seen in a real event.
- **A sender whose number is hidden.** Handled in the code and tested with an event with the number removed; a real event of that kind was not seen.
- **The weekly clock.** The weekly report was run by hand; Monday at 8:00 was not waited for. The 30 minute timer was waited for once. The weekly clean-up ran with the weekly trigger by hand, against the data table of this n8n version.
- **An Error workflow.** It is described in Setup step 6, not built, and was not run.
- **An n8n restart in the middle of a run, several n8n workers or queue mode.** The repeated question was tested by putting the row back, not by killing n8n. Two identical orders at the same instant were not tested.
- **A time zone other than `America/Sao_Paulo`** on the working path (only the mismatch guard was tested with `Asia/Tokyo`), and daylight saving changes.
- **A very long outage.** Reactivation was tested after a few seconds off.
- **The Portuguese texts and the Portuguese `optout_words`.** The scenario ran the English defaults (which include the Portuguese words) and a few texts of its own; the pt-BR texts above were not run through the workflow (they use the same placeholders). Scores written as words were tested in English and Portuguese only.
- **The canvas look.** Where the sticky notes sit was computed from node and note rectangles with room for the labels, not seen in a browser. How the notes under `Your settings` render in the flow was not seen.
- **n8n Cloud itself.** The claim that the package works there rests on its verification by n8n, noted in the module README.
