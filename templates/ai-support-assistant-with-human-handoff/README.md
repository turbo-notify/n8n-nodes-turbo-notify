# AI support assistant with human handoff (WhatsApp, Turbo Notify)

A small business answers WhatsApp support chats with an AI agent that is told to answer only from what the business wrote down, and to ask for a person when it is unsure. The model is the small part. The workflow is the handling around it: who may be answered, when the assistant must stay silent, what happens when the model is unsure, what happens when a reply cannot be sent, and how the owner finds out.

## Read this first

- **It answers every private chat of EVERY number of the organization.** The poll reads the events of the whole organization. Use a dedicated business number (Turbo Notify recommends it in [Protect your number](https://docs.turbonotify.com/en/general/abuse/)), not a personal one. Friends, family and suppliers who also write to that number are answered too, unless you list them in `ignore_phones` (comma separated, with country code, any format). With several numbers in the organization the assistant answers on all of them: use a dedicated organization for it, or open the Polling Trigger, **Options > Number**, and choose the one number (that option exists in the node and was not run in the tests), or list the people in `ignore_phones`.
- **It does not run on sample data.** The workflow stops with a plain message while `owner_phone` is the placeholder, `business_name` or `business_facts` are still the samples, or the `faq` table is empty or still holds a row flagged `sample`. Nobody gets an answer written for a bakery that is not theirs.
- **A failed reply tells nobody until you set an Error workflow.** The run ends in an error, but only the Executions list shows it. Setup step 8 says how to be told.
- **A model can be wrong.** The agent is told to answer only from the FAQ and the facts and to ask for a person when unsure. A model can still say something you did not write down, or be talked out of its rules by a customer. Read the first conversations, keep the facts short and say in `rules` what it must never promise.
- **Privacy.** The text of every customer message goes to the model provider you choose, and the last 10 turns per customer stay in n8n memory (Simple Memory). The Data Table rows (phone, opt-out, pause, last event ids) stay in your n8n. Tell your customers they are talking to an assistant, delete a customer's rows on request (Data tables tab: `contacts_state`) and read your provider's data terms. This is not legal advice; check what LGPD or GDPR asks of you.
- **Real ceilings of your plan.** Free: 2 distinct contacts per billing cycle, and you (the owner who gets the alerts) count as one, so one customer. Lone Wolf: 100 distinct contacts and 1,800 messages per cycle, per number. Source: [Quota and usage](https://docs.turbonotify.com/en/usage/quota/) and [Rate limits](https://docs.turbonotify.com/en/messages/rate-limits/). A handover costs three messages (the fixed text, the alert, the contact card). When a limit is reached the send is refused: the workflow does not hide it, see "When a reply cannot be sent".
- **Messages while the workflow is off.** While the workflow is inactive nothing is answered. When you activate it again the poll hands over what arrived in the meantime (Turbo Notify keeps events for 90 days) and each one is answered late. A message whose text has already expired (content is kept 1 hour by default, up to 7 hours on Lone Wolf) becomes a handover with the fixed "a person will answer" text, never a guess. Look at the executions after any downtime and write to long-waiting customers yourself.

## What it does

- Checks your WhatsApp numbers every minute (Turbo Notify WhatsApp Polling Trigger on `message.received`, `message.replied` and `message.sent`). It works on every plan and needs no public address. On the Lone Wolf plan the instant Turbo Notify WhatsApp Trigger can replace it.
- Handles private chats. Group messages, messages the number sent through the API (its own replies), messages from the owner phone, numbers in `ignore_phones` and repeated events are skipped.
- Opt-out: a message that is exactly one of the STOP words (default `stop`, `parar`, `sair`, capitals, accents and punctuation do not matter) is answered once with a confirmation and saved in `contacts_state`. That phone is never messaged again by this workflow until it sends a START word (default `start`, `voltar`).
- Never talks over a person. When `human_until` of the chat is in the future the workflow does nothing. `human_until` is set when the assistant hands over, and also when you (or anyone) type in that chat from the WhatsApp app: the poll sees the outgoing `message.sent` with `origin = native` and pauses the assistant for `human_hours` again. Typing yourself only makes the assistant go quiet. The customer is not told and you are not alerted: the customer text, the owner alert and the contact card belong to a handover the assistant starts.
- Non-text messages (image, audio, video, document, sticker, location, contact, poll) get one fixed reply saying only text is read. No model call. A voice note carries a transcription only for inbound audio and only when you turned on BYO speech-to-text for your organization ([Get a message](https://docs.turbonotify.com/en/messages/get/)); this template does not read it. Voice notes are common in Brazil: every audio gets the fixed text and counts toward the hourly cap. Set `audio_to_person` to `true` and a voice note is handed to a person instead (the customer gets the handover text, you get the alert with the reason "the customer sent a voice note" and the contact card). Images, documents and the rest still get the fixed text.
- Text messages: reads the full text (the event only carries the first 50 characters), shows typing, and runs an AI Agent with a Chat Model, a per-phone Simple Memory and a tool that searches the `faq` Data Table. The system prompt is built from `Your settings`: business name, tone, facts and rules. The agent must answer with one JSON object `{answer, confidence, handoff, handoff_reason}`. A Code node reads it strictly.
- Hands over when: the agent says `handoff: true`; the confidence is below `confidence_threshold`; the agent fails or does not return readable JSON; the message cannot be read; the customer writes one of the `handoff_words` (words or short phrases such as "speak to a person", checked before the model is called); the customer sends a voice note while `audio_to_person` is `true`; or the same phone got more than `hourly_cap` automatic replies in one hour (loop and cost protection). On a handover the customer gets a fixed message (never AI text), the chat is held for `human_hours`, and the owner gets a WhatsApp text with the reason, the customer and the last message, plus the customer's contact card.
- One answer per message: three quick messages from the same customer get three answers (the hourly cap is the brake). There is no debounce.
- Manual branch "Run once: set up the tables": creates `faq` and `contacts_state` if they are missing and adds four sample FAQ rows flagged `sample`. The workflow refuses to answer customers until you delete or rewrite them. Running it again after you wrote your own FAQ adds the four samples back, and the workflow stops again until you delete them (that is the point: a sample row can never reach a customer).

### When a reply cannot be sent

A reply to a customer ("Send the reply", the opt-out and opt-in confirmations, "Tell the customer a person will answer") or an owner alert can be refused: contact quota used up (`402 contact_quota_exceeded`), message quota used up (`429 messages_quota_exceeded`), number disconnected, a new number's warm-up limit. These sends are set to Continue On Fail so the other events of the poll are still handled, and every event ends in `Record what failed for this event`. When all events are done, `Fail the run if a reply or an alert failed` fails the run with a message like:

`No answer reached these customers, write to them by hand: +5511977770099 (Name): <the reason Turbo Notify gave>. The owner could not be alerted about: ...`

It does not stop at the first failure on purpose: the poll already moved past these events, so stopping early would drop the others. The failure shows in your executions and triggers an Error Workflow if you set one. **Retry execution** skips the events already handled (they count as duplicates), so contact those customers by hand.

## Nodes

Live flow (28 working nodes, plus 9 sticky notes):

1. `Poll new WhatsApp messages` (Turbo Notify WhatsApp Polling Trigger)
2. `Your settings` (Edit Fields: everything you change, each value explained on the canvas)
3. `Read the FAQ rows` (Data Table, once per run, only for the sample check)
4. `Check the settings` (Code: stops the run while a setting or the FAQ is still a sample)
5. `Loop over events` (one event at a time, oldest first, so a STOP or a handover is saved before the next event of the same poll is read)
6. `Classify the event` (Code)
7. `Customer, owner or ignore` (Switch)
8. `Pause the assistant while the owner writes` (Data Table upsert)
9. `Read the whole message` (Turbo Notify: Message > Get)
10. `Read the contact state` (Data Table get)
11. `Decide how to handle the message` (Code: duplicate, STOP/START, opted out, person in the chat, non-text, handoff words, hourly cap)
12. `Route the decision` (Switch: fixed reply, ask the AI, hand over, stay silent)
13. `Show typing` (Turbo Notify: Send Typing Indicator, Continue On Fail)
14. `Support AI Agent` (AI Agent) with `OpenAI Chat Model`, `Chat memory per customer` (Simple Memory) and `Search the FAQ` (Data Table as a tool)
15. `Read the agent decision` (Code)
16. `Needs a person?` (If)
17. `Save the contact state` (Data Table upsert)
18. `Send the reply` (Turbo Notify: Reply, quoting the message, Continue On Fail)
19. `Handover starts here` (No Operation: the point where both ways to a handover meet)
20. `Hold the chat for a person` (Data Table upsert)
21. `Tell the customer a person will answer` (Reply, fixed text, Continue On Fail)
22. `Alert the owner` (Send Text, Continue On Fail)
23. `Send the customer contact card to the owner` (Send Contact Card, Continue On Fail)
24. `Record what failed for this event` (Code)
25. `Fail the run if a reply or an alert failed` (Code, on the "done" output of the loop)

Setup branch (5 nodes): `Run once: set up the tables`, `Create the faq table`, `Create the contacts_state table`, `Sample FAQ rows`, `Add the sample FAQ rows`.

## Setup

Works on n8n Cloud (community nodes enabled; the package is verified by n8n, so it is listed in the nodes panel) and on self-hosted n8n. Tested on n8n 2.45.5.

1. Install the community node package `@turbo-notify/n8n-nodes-turbo-notify` (tested with 1.5.15): Settings > Community Nodes > Install, or see [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/). Package page: https://www.npmjs.com/package/@turbo-notify/n8n-nodes-turbo-notify.
2. In Turbo Notify, connect your WhatsApp number and create an API key (the template "AI agent (MCP)" has the scopes this workflow needs: `messages:send`, `messages:read`, `events:read`). In n8n create a **Turbo Notify API** credential with that key.
3. Create the chat model credential. For **OpenAI** you need an API account with billing (a ChatGPT subscription is not an API key): create a key on the OpenAI platform and add credit, then create an **OpenAI account** credential. For any other OpenAI compatible provider, change the base URL in the credential and switch **Use Responses API** off in the `OpenAI Chat Model` node (it is on by default and such providers rarely implement it). What was verified for real: OpenRouter with `nvidia/nemotron-3-ultra-550b-a55b:free` and the switch off answered correctly; Groq with `openai/gpt-oss-120b` and `openai/gpt-oss-20b` did not work with n8n's agent (see the test record). OpenAI itself (the default `gpt-4.1-mini`) was only run against the scripted test model, not for real. You can also replace the node with any chat model that supports tool calling.
4. Import `workflow.json`. Select your credentials on **every** Turbo Notify node (the Polling Trigger, `Read the whole message`, `Show typing`, `Send the reply`, `Tell the customer a person will answer`, `Alert the owner`, `Send the customer contact card to the owner`) and on the `OpenAI Chat Model` node. An import does not always pick them for you.
5. Click **Execute workflow** on `Run once: set up the tables`. It creates the two Data Tables (below) and four sample FAQ rows. The Data Table nodes find the tables by name, so nothing has to be selected in them.
6. Open the `faq` table: **Data tables** tab next to Workflows and Credentials in your project (or in Overview). Delete the sample rows and write your own questions and answers (or rewrite them and set `sample` to false).
7. Open `Your settings` and replace `owner_phone` (your own number, with `+` and country code), `business_name` and `business_facts`. Set `ignore_phones` if other people write to this number. Adjust the rules and words, and translate the fixed messages if your customers do not read English (pt-BR texts below).
8. Set an **Error workflow**, so you are told when a reply or an alert cannot be sent. First create a second workflow whose first node is an **Error Trigger**, followed by a Send Email (or Slack) node that writes the workflow name and the error message. Then open this workflow, **Settings** (the `...` menu), choose that workflow under **Error workflow** and save. Without it the run still ends in an error, but only the Executions list shows it and nobody is told. (The Error workflow itself is not part of this template and was not run in the tests.)
9. Test from a phone that is NOT the owner phone (messages from the owner phone are ignored on purpose). Write a question, wait up to a minute, then try STOP, START, "I want to speak to a person" and an image.
10. Activate the workflow. Do it only after steps 5 to 7: while `Check the settings` stops the run (sample rows left, a placeholder setting), the poll has already taken the incoming events, and a fix afterwards does not answer those customers. Their messages are in the failed executions, so write to them by hand.

### Data Tables (created by the setup branch)

The names must stay exactly `faq` and `contacts_state` (lower case). To create them by hand instead: Data tables > Create, and add these columns.

`faq` (you edit it)

| Column | Type | Meaning |
|---|---|---|
| `question` | String | The question as a customer might ask it |
| `answer` | String | The answer the assistant may give |
| `keywords` | String | Words that find this row, separated by commas |
| `sample` | Boolean | True on the four sample rows. While any row is true the workflow refuses to answer customers. Leave it empty or false on your own rows |

`contacts_state` (the workflow keeps it; you can edit `human_until` and `opted_out` by hand)

| Column | Type | Meaning |
|---|---|---|
| `phone` | String | Customer phone with `+`, one row per phone |
| `opted_out` | Boolean | True after STOP, false after START |
| `human_until` | Date | The assistant stays silent in this chat until then. Clear it to give the chat back to the assistant |
| `last_message_at` | Date | When the last handled message came |
| `ai_answers` | Number | Automatic replies in the current one hour window |
| `ai_window_start` | Date | Start of that window |
| `recent_event_ids` | String | The last 20 event ids of this phone, for duplicate handling |

## Settings (the `Your settings` node)

| Field | Default | Meaning |
|---|---|---|
| `owner_phone` | `+55XXXXXXXXXXX` (placeholder, the run stops until you replace it) | Receives the alerts and the contact cards. Messages from this phone are ignored |
| `business_name`, `business_facts` | placeholders (the run stops until you replace them) | Go into the system prompt. Example facts: "Open Monday to Saturday, 7am to 7pm, closed on Sunday. Cakes need 48 hours notice. We accept card, cash and Pix." |
| `tone`, `rules` | generic | Go into the system prompt |
| `ignore_phones` | empty | Numbers the assistant never reads, answers or pauses for, comma separated with country code (spaces, dashes and the `+` do not matter). Use it for family, friends, suppliers |
| `handoff_words` | `speak to a person, talk to a person, speak to someone, talk to someone, a human, real person, attendant, atendente, humano, falar com alguem, falar com uma pessoa, falar com um humano, complaint, reclamar, reclamacao, refund, reembolso, unsubscribe, descadastrar, urgent, urgente` | Whole words or short phrases, comma separated (accents, capitals and extra spaces ignored). One of them hands the chat over before the model is called. The defaults are phrases on purpose: the single words "person", "agent" and "human" would hand over "how much per person?" and "can a travel agent book it?". `refund` and `urgent` hand over on purpose: money and urgency should reach a person |
| `optout_words`, `optin_words` | `stop, parar, sair` / `start, voltar` | The whole message must be the word |
| `confidence_threshold` | `0.7` | Below this the answer is not sent and a person is asked |
| `human_hours` | `4` | How long the assistant stays silent after a handover or after you write in a chat |
| `hourly_cap` | `6` | Automatic replies per phone in one hour window. The next message is a handover |
| `audio_to_person` | `false` | `true` hands a voice note to a person (handover text to the customer, alert and contact card to you) instead of the fixed `nontext_reply`. Only audio: images and other files keep the fixed reply |
| `optout_reply`, `optin_reply`, `nontext_reply`, `handoff_reply` | English texts, `handoff_reply` promises no time | The fixed messages. Never AI text |

Every value is also explained on the canvas, under the node.

## Plans, quota and pace

- The Polling Trigger works on every plan. The instant trigger needs Lone Wolf or higher and a public address.
- `Show typing` needs Lone Wolf or higher. On Free it is refused with `feature_not_available` (nothing is used), the node is set to Continue On Fail, and the answer is still sent.
- Each answer is one message of your quota and, for a customer you never wrote to in this cycle, one contact. A handover is three messages (the fixed message, the alert and the contact card). Each send has an idempotency key built from the event id, so a repeated run does not send twice. A new number has a daily warm-up limit (50 messages on its first day); test with a few chats.
- The send pace of your plan applies: the node waits and retries when Turbo Notify asks it to.
- Spend at the model provider is not capped by this workflow beyond `hourly_cap` per customer: set a budget limit in your provider account.

## Things to know before you rely on it

- Polling means a delay of up to one minute. A poll that fails (n8n or the API unreachable for a moment) is read again by the next tick, because each tick reads the last two minutes again. An execution that fails after the poll is not delivered again, and **Retry execution** skips the events that were already handled (they count as duplicates, and every send has an idempotency key). When a reply or an alert fails, the error names the customer: contact that customer by hand.
- Simple Memory lives in the n8n process: it is lost when n8n restarts and is not shared between workers. The workflow still works without it, the assistant just forgets earlier turns.
- STOP works only as the whole message. "Please stop writing to me" is not an opt-out keyword; add phrases like that to `handoff_words` so a person sees them (`unsubscribe` is already there). A customer who has opted out and then writes a real question gets silence and you are not alerted: the assistant respects the opt-out and tells nobody. Look at `opted_out` in `contacts_state` if you want to know who they are.
- The fixed messages are in English by default, while the model answers in the language the customer writes in (the default `tone` says so). Translate the fixed messages in `Your settings` (pt-BR texts are in Customization) if your customers do not read English.
- **WhatsApp Business app, greeting and away messages: not verified.** On a number used in the WhatsApp Business app, the phone sends a greeting or an away message by itself. If Turbo Notify reports those texts as an outgoing `message.sent` with origin `native`, this workflow reads each one as "a person wrote in this chat" and pauses the assistant for that customer for `human_hours`. This was not tested either way. Turn the greeting and away messages off on the phone of this number.
- Voice notes: see `audio_to_person`. Each audio counts toward `hourly_cap` and gets the fixed text, which the customer may find unhelpful. Decide which you prefer.
- The hourly cap counts windows (a window starts at the first automatic reply), not a sliding hour.
- A sender whose phone number the event does not carry is skipped (the workflow cannot answer or pause a chat it cannot name).
- A person who writes from another linked device or from the phone counts as "the owner" for the pause; a message sent through the API by another tool does not.
- Data Tables keep one row per phone forever. Delete rows of old customers if you need to.

## Customization

- Swap `OpenAI Chat Model` for another chat model node. With an OpenAI compatible provider other than OpenAI (change the base URL in the credential), switch **Use Responses API** off in the node: it is on by default and such providers rarely implement it. The model must support tool calling and must be able to write its final answer as plain text after the tool call. Seen in a real run: OpenRouter with `nvidia/nemotron-3-ultra-550b-a55b:free` answered correctly; Groq with `openai/gpt-oss-120b` and `openai/gpt-oss-20b` did **not** work with n8n's agent (the provider refuses the step after the tool call, see the test record), and the workflow then hands the chat over to a person, as designed.
- FAQ retrieval is one keyword search: the agent gives one word and `Search the FAQ` matches it against `question`, `keywords` and `answer` (up to 5 rows). It is enough for a short FAQ. For a long one, or when customers write in another language than the rows, put the keywords in both languages in the `keywords` column, paste a short FAQ into `business_facts`, or replace the tool with a vector store (a hint, not tested here).
- Change the fixed messages, the words, the thresholds and the hours in `Your settings`. Defaults in Brazilian Portuguese:
  - `optout_reply`: "Pronto. Você não receberá mais mensagens automáticas nossas. Envie VOLTAR para receber de novo."
  - `optin_reply`: "Bem-vindo de volta. Escreva sua dúvida e responderemos."
  - `nontext_reply`: "Só consigo ler mensagens de texto. Por favor, escreva sua pergunta em texto."
  - `handoff_reply`: "Obrigado. Passei sua mensagem para a nossa equipe. Uma pessoa vai responder por aqui."
- On Lone Wolf, replace the Polling Trigger with the Turbo Notify WhatsApp Trigger (instant) and keep the same three events.
- To be told when a reply or an alert fails, set an Error workflow (Setup, step 8).
- The agent answers in one JSON object that a Code node reads, and anything that is not readable becomes a handover. The more idiomatic n8n pattern is the **Structured Output Parser** on the AI Agent node. It was not used on purpose: the parser needs a model that follows the schema exactly, while the Code node also accepts a code fence or a sentence around the object and turns every other failure into a handover instead of a failed run. The cost: the format lives in the system prompt, so a model that does not follow it hands every chat over. In the real run (see the test record) the model followed it every time. If your model handles structured output well, swapping the parser in is a small change.

## Test record

Tested end to end from the exact `workflow.json` (SHA-256 below), in a fresh throwaway n8n, against a simulated Turbo Notify API and a scripted fake language model. Nothing reached WhatsApp and no real model answered in that run. A second run against the real Turbo Notify API with a real model is described in "Real API run" below: a first one on the previous version of the file and a final one on this exact file ("Real API run on this version"). See also "What is not proven".

| | |
|---|---|
| Date | 2026-11-17 |
| `workflow.json` | SHA-256 `3d8a9906543d5949220333af8cca849db7b1a74297f34d3da6c29d627bcdadd8` (`shasum -a 256 workflow.json`) |
| n8n | 2.45.5 (image `n8nio/n8n:2.45.5`, id `sha256:9f6d0a5987ab5a297c4b0b38fbf1a22285dd1364551478e93f03d506908fa74c`) |
| Package | `@turbo-notify/n8n-nodes-turbo-notify` 1.5.15 (built from this repository) |
| Mock API | `templates/harness/mock-api.mjs`, same routes, answers, events and errors as `public-docs-web/public/openapi.json` |
| Model | `templates/harness/fake-llm.mjs`, scripted replies and tool calls |
| Patches applied to `workflow.json` by the scenario | none in the file. The workflow is imported as exported, and the scenario proves it refuses to run with the placeholders. Then it types the values a person must type, through the stored workflow: `owner_phone` (a fictitious test number), `business_name`, `business_facts`, and temporarily `ignore_phones` and `audio_to_person`. It flips the `sample` flag of the four sample FAQ rows, as a person rewriting the FAQ would. The mock's contact quota is lowered for one step |
| Scenario | `test/scenario.mjs`, 33 steps, 776 assertions, 0 failed, 238 s (most of it waiting for real poller ticks; the count grew with the layout checks of the notes added to the "as exported" step). Run on this exact file after the last change of the canvas layout (2026-11-17), and it passed. An earlier version of the file failed once in the "contact quota used up" step on a run that shared the machine with another n8n container (that step took 31 s instead of 1 to 2 s; the cause was not found). It did not come back in this run, and the assertion message now prints the error and the sends if it does. On a loaded machine n8n can also fail a step with "Expression timed out" or "Turbo Notify did not answer in time"; the poller step skips a failed tick the way the next real tick would |
| Other checks | the module's own jest suites (17 suites, 359 tests, including the template tests: valid JSON, no placeholder credentials, no em or en dash, no invisible or bidirectional control characters, every node connected) and `npm run lint`, all green |

Rerun:

```bash
cd n8n-nodes-turbo-notify
node templates/harness/run-template.mjs templates/ai-support-assistant-with-human-handoff/workflow.json \
  --scenario templates/ai-support-assistant-with-human-handoff/test/scenario.mjs --image n8nio/n8n:2.45.5
```

Branches run (each step of the scenario asserts the requests the mock received, the rows in the tables and what the model was sent):

| Branch | Proved |
|---|---|
| Exported settings | `owner_phone`, `business_name` and `business_facts` are placeholders, `ignore_phones` is empty, `handoff_reply` promises no time, and the settings node explains every value on the canvas |
| Setup branch, twice | Both tables are created by the workflow, four rows flagged `sample`, no duplicate row on the second run, the Data Table nodes bind by name |
| Guard: placeholders | As exported, a customer message ends the run in an error that names `owner_phone`, `business_name`, `business_facts` and "still has 4 sample row(s)"; nothing was read, sent or asked of the model. Each setting is then fixed on its own and the message follows (a short number is refused, then the business, then the facts, then the sample rows, one flipped row counts down, an empty `faq` is refused, the setup branch refills it, with real settings and no sample row the run goes on) |
| Normal FAQ answer | Settings check passes, FAQ tool called with a keyword, row returned to the model, system prompt carries name, facts, rules and the JSON format, one typing request, one Reply quoting the message with idempotency key `reply-<event id>`, state row saved |
| Memory | Same phone sees its earlier turns, another phone does not |
| Group message | Ignored: not read, nothing sent, no model call |
| Own messages | The echo of the workflow's own replies, a message from the owner phone and a message from the number itself are ignored |
| `ignore_phones` | Two listed numbers (written as `+55 11 97777-0050` and `5511977770051`) are not read, not answered and not paused (also when the owner writes to them from the app), no state row is created, no model call; an unlisted customer is answered in the same run; with the list emptied again the number is answered like any other |
| Quoted customer message | `message.replied` inbound is answered like a new message |
| Non-text | Image and audio get the fixed text, no model call, no typing, counted against the hourly cap |
| Duplicates | The same event twice in one batch and again in a later run: one answer, one model call |
| STOP and START | Confirmation once, second STOP silent, silence while opted out, `PARAR!` with punctuation works, START brings the chat back, STOP and a question in the same batch never answers the question |
| Person in the chat | `human_until` in the future: silent, no model call, no typing; in the past: answers again |
| Owner types in the app | Outgoing native `message.sent` sets `human_until` about 4 hours ahead and keeps `opted_out` and counters; the assistant is then silent; STOP is still honored during the pause |
| Low confidence, `handoff: true`, unreadable JSON, model service down, message cannot be read | Each becomes a handover: the fixed message to the customer (the neutral default text), no AI text sent anywhere, alert with reason, customer and last message, contact card with the customer's name and phone, `human_until` set, silence afterwards |
| Handoff words and phrases | `a human` and `RECLAMAÇÃO` (accents, capitals) hand over before the model is called; `humanely` does not |
| Default handoff phrases | The defaults hold phrases, not the single words "person", "agent" and "human". "How much per person?", "Can a travel agent book a table for us?" and "Can a person pick it up for me?" are answered by the model, no handover and no alert. "I want to speak to a person", "Can I talk to someone?" and a Portuguese "Oi, quero  FALAR   com uma pessoa" (extra spaces, capitals) hand over before the model is called |
| `audio_to_person` | Exported as `false` (voice notes get the fixed text, covered above). With `true`: a voice note gets the handover text, the owner gets the alert "the customer sent a voice note" and the contact card, the model is not called, the chat is held; an image still gets the fixed reply. Back to `false`, the voice note gets the fixed reply again |
| Hourly cap | Seven messages in one batch: six answers, then the fixed message and one alert |
| Typing refused (Free-plan fault) | `402 feature_not_available`, the flow goes on and the answer is sent |
| Owner alert fails | The other event of the run is still answered, the run ends in an error ("The owner could not be alerted about: ...") that names the customer and does not blame the customer who was answered; the failure is raised by the last node, after the loop |
| Contact quota used up | A new customer's reply is refused (`contact_quota_exceeded`): the next customer is still answered, a handover customer in the same run is still handled, the run ends in an error "No answer reached these customers, write to them by hand: <phone> (<name>): The number's contact allowance is used up (contact_quota_exceeded)" naming only the refused customer |
| Handover message fails | The "a person will answer" reply fails, the alert and the contact card still go out, the chat is held, the error names the customer |
| Reply and alert fail in one run | Both lists appear, the customer list first, each with its customer |
| Real poller | The workflow was activated: the poller handed over the new message only (not the one written before activation), the answer was sent once, and the next tick delivered the echo of the workflow's own replies, which sent nothing |
| Inactive, then active again | A message that arrived while the workflow was deactivated was handed over by the first poll after reactivation and answered once. It is not lost (see "Messages while the workflow is off"). |

### Real API run

**The first run (this part) was made on the version of the file before the final round of changes** (SHA-256 `b85eec818d51bcfa710fca7ec659fde4261c1027dc39538fff553ba62ed93707`). Since then the default `handoff_words`, the new `audio_to_person` setting, the way the combining-accent range is written in the code of `Decide how to handle the message` and the canvas notes changed. The run on the final file is described in "Real API run on this version" further down. The model findings and the provider differences below still stand.

2026-11-17, **n8n 2.45.5** (image `n8nio/n8n:2.45.5`), package **@turbo-notify/n8n-nodes-turbo-notify 1.5.15**, the
first file named above,
real Turbo Notify API, real WhatsApp delivery and a real chat model. Two numbers owned by the same owner took part: the
assistant ran on one of them, and the "customer" was the other one, which belongs to another organization and wrote to
the first with its own key. A test guard allowed the assistant to message only the customer number, and the customer
key could only send plain text to the assistant number. The plan of the assistant organization was **CUSTOM**.

Patches made by the scenario (`prepare`): the values a person types in **Your settings** (`owner_phone`, set to the
assistant number itself so that an owner alert could not reach any other number, `business_name`, `business_facts`), the
model name on **OpenAI Chat Model**, and **Use Responses API** switched off on that node. The two sample FAQ rows were
replaced through the table by two real rows with `sample` false, so the guard passed.

**Messages:** 6 real messages in all, the budget. A first run sent 2 (the customer's question and the assistant's reply)
and stopped at a wrong expectation in the scenario; the final run sent 4 (the question, the reply, STOP and the opt-out
confirmation). Everything the assistant sent was deleted for everyone at the end, and so was everything the customer
sent. The two Data Tables were removed. A handover could not be run for real: it needs a third owned number to receive
the owner alert.

**The model.** First attempt: Groq's OpenAI compatible endpoint with `openai/gpt-oss-120b`. With n8n's default (**Use
Responses API** on) the agent failed with "Bad request". With the Chat Completions path (switch off) the first model call
asked for the FAQ tool correctly and the second call was refused by Groq with `400 tool_use_failed` ("attempted to call tool
'json' which was not in request.tools": the final JSON answer was written as a call to a tool named `json`). The same saved
request failed every time outside n8n (more than ten tries), `openai/gpt-oss-20b` failed in 8 of 9 tries, and the same request worked when the model's own
`reasoning` field was sent back with the tool call, which n8n's agent does not do. The other Groq model of that account
(`qwen/qwen3.8-27b`) was refused by the account's output token limit. This is a provider and model limit, not something to
fix in the template, and the template did what it should: the agent failure became a handover (route `handoff`, the fixed
"a person will answer" text, the chat held, reason "the assistant failed to run"). The reply text was never produced by
the failed call. The final runs used OpenRouter with `nvidia/nemotron-3-ultra-550b-a55b:free` through n8n's OpenAI
credential with the base URL changed.

What ran for real (final run, 49 assertions passed before the last accounting step, see below):

| Part | Result |
|---|---|
| Real poll | The customer's text arrived on the assistant number and the live Polling Trigger handed over the `message.received` event from the real events feed. The whole path from the customer's send to the end of the workflow run took about 56 seconds: the polling tick is the delay |
| Get Message | `200`, the full text was read |
| Send Typing Indicator | **Accepted** on this plan: `202` with `{operation_id, status: {state: "pending", at}}` (note: the answer carries an `operation_id`, not a `message_id`). On a plan without the feature it is refused and the flow goes on (mock only) |
| Real model, FAQ tool | The model called `Search the FAQ` once with the keyword `hours`, got the one matching row, and wrote its answer. The agent step took 2.5 to 3.9 seconds. The raw output was exactly one JSON object `{answer, confidence, handoff, handoff_reason}`, `confidence` 1.0 (0.95 in the first run), `handoff` false, and **Read the agent decision** parsed it. In the three times this model was run (a dry run and the two real runs) it followed the format every time, which proves little about a model in general |
| The reply | **Send the reply** (Reply, quoting the customer's message) was accepted with `202`, the text sent was exactly the model's `answer` (92 characters), it showed up in the customer organization as a received message (read back through its own key), and the contact state row was written (`ai_answers` 1, `opted_out` false, the event id remembered) |
| STOP | The customer's `STOP` produced exactly one message, the fixed `optout_reply` text, no model call, and the state row went to `opted_out` true |
| Guard | No call was blocked: the assistant never tried another number |

Two things were **not** run over the wire, because the 6 message budget was used up: the customer's second question after
STOP and the customer's START. They were fed to the real workflow as pinned events (every send node pinned) against the
**real** state row the real STOP had written: the second question ended silent (no model call, no reply, no handover) and
START took the fixed opt-in route with the opt-in text and put `opted_out` back to false. The silent and START branches
therefore ran on real state but not through a real incoming message.

The last step of the scenario (the final accounting of the run) failed on a mistake of the scenario itself, an object that
the guard client does not have, after every assertion above had passed. It is fixed in `test/real.mjs` and was not rerun for
lack of budget. The counts above come from the harness report (2 assistant messages, 2 customer messages, 0 blocked calls,
all deleted).

**Differences from the mock:** the real model's call keyword (`hours`) and answer wording, the `202 {operation_id}` answer of
the typing indicator, a polling tick of up to a minute for every inbound message, and, above all, providers: the Responses
API default and Groq's `gpt-oss` models did not work, which no fake model could show.

**Still not proven:** a handover for real (the alert and contact card to the owner), non-text messages, a group message, the
hourly cap, the owner typing in the app, the instant trigger, any adversarial customer, OpenAI's own models (the default
`gpt-4.1-mini` was not run), more than one question to one model (answer quality), the real START and the real second
question over the wire, memory across turns with a real model.

#### Real API run on this version

2026-11-18, **n8n 2.45.5** (image `n8nio/n8n:2.45.5`), package **@turbo-notify/n8n-nodes-turbo-notify 1.5.15**,
`workflow.json` SHA-256 `3d8a9906543d5949220333af8cca849db7b1a74297f34d3da6c29d627bcdadd8` (the final file, checked with
`shasum -a 256` before the run), real Turbo Notify API, real WhatsApp delivery, real chat model
(OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free` through n8n's OpenAI credential with the base URL changed and **Use
Responses API** off). Same setup as the first run: the assistant on one number, the "customer" on the other number of the
same owner (another organization, its own key, plain text only), plan of the assistant organization **CUSTOM**, the test
guard on and not bypassed. Harness result: **passed, 68 assertions, 0 failed, 739 s**. The scenario is
`test/real.mjs`: the model key is now taken by the provider the base URL names (the first version of the scenario picked the
first key it found in a file with several providers and failed its own pre-flight with a `401`; no message was sent
before the fix), and a handover step was added.

Patches made by the scenario: the same as in the first run (`owner_phone` set to the assistant number itself, `business_name`,
`business_facts`, the model name, **Use Responses API** off, the two sample FAQ rows replaced by two real rows). No node
was pinned in the real steps. Two steps used pinned events on purpose: the dry run of the model (no WhatsApp message) and
START (see below).

**Messages: 7 real messages, the whole budget.** The customer sent 4 (the question, STOP, a second question while opted
out, "I want to speak to a person") and the assistant sent 3 (the answer, the opt-out confirmation, the handover text).
Everything either side sent was deleted for everyone at the end (7 of 7), and the two Data Tables were removed.

What ran for real:

| Part | Result |
|---|---|
| Guard on the exported file | **Not run in this real run**: the scenario types the values a person types before the import, so the placeholders never reached a real send. That stop is proved only in the simulated run above |
| Setup branch and real settings | The setup branch created both tables and the four sample rows; the scenario replaced them with two real rows (`sample` false) |
| Dry run of the real model | A pinned event for a fictitious phone: the real model called `Search the FAQ`, got the row and answered in 2 seconds, no message was sent |
| Question over the wire | The customer's text was seen by the live Polling Trigger. The run from the customer's send to the end of the workflow took 81 seconds (the poll tick is most of it). Get Message `200`. Typing indicator accepted by the real plan: `202` with `operation_id` and `status.state` `pending`. The model called the FAQ tool once with the keyword `hours`, got one row and wrote exactly one JSON object (`confidence` 1.0, `handoff` false). The agent step took 22 seconds, much longer than the 2 seconds of the dry run on the same model (a shared free tier). **Send the reply** was accepted with `202`, the text sent was exactly the model's `answer` (43 characters), it showed up in the customer organization as a received message, and the state row was written (`ai_answers` 1, `opted_out` false) |
| STOP | Exactly one message, the fixed `optout_reply`, no model call, `opted_out` true |
| Second question while opted out | A real incoming message, handed over by a real poll: the run went through `Decide how to handle the message` and ended with no model call, no reply, no handover and nothing sent. `opted_out` stayed true |
| START | **Not over the wire** (the budget was reserved for the handover): the event was pinned and fed to the real workflow against the **real** state row that the real STOP wrote. It took the fixed opt-in route with the opt-in text and put `opted_out` back to false. The confirmation send was pinned, so nothing was sent |
| Handoff words, over the wire | The customer wrote "I want to speak to a person". A real poll handed it over, `Decide how to handle the message` chose the handover route without a model call, the chat was held (`human_until` about 4 hours ahead, as `human_hours` says), and **Tell the customer a person will answer** sent the fixed `handoff_reply` as a Reply, accepted with `202`, which showed up in the customer organization as a received message |
| Owner alert and contact card | **Tried, but refused by the test guard, not by the API.** The guard lets the test message only one number, the customer. `owner_phone` was the assistant number itself, so the two requests (a text of 235 characters that quotes the customer's message, and a contact card with `display_name` and `phones` of the customer) were addressed to the assistant's own number and the guard answered `403 harness_recipient_blocked` before anything was forwarded. They are not counted in the budget. The workflow did what the design says: both nodes continued on fail, the other steps of the event were done, and the run ended in an error whose message says the owner could not be alerted |
| Guard | Exactly 2 refused calls (the alert and the card), both to `owner_phone`, none to any other number. No call was blocked for another reason |

**Model behaviour, in plain terms.** In this run the free model followed the one JSON format every time (in the dry run and in
the real question) and used the FAQ tool with a sensible keyword. It added an emoji the FAQ did not have in the real answer,
and in the dry run it added "close at 7pm" to an answer about opening time (both facts are in the business facts). That
is one question twice, not a test of quality. No customer tried to talk the model out of its rules.

**Differences from the mock:** the poll tick makes every inbound message take up to a minute and a half, the
typing indicator answers with an `operation_id` instead of a `message_id`, the free model's latency varied from 2 to 22
seconds for the same call, and a handover on a real run could not deliver the owner alert and the card to anyone, because
the only recipient the guard allows is the customer. The mock accepts both.

**Not proven by this run:** that the real API accepts the owner alert and the contact card the workflow builds (the two requests were
built and addressed to the right number, but never reached the API); that an owner receives them; START over the wire
(it ran on the real state, not through a real incoming message); non-text messages, a group message, the hourly cap, the owner
typing in the app, the instant trigger, any adversarial customer, `audio_to_person` and the default handoff phrases other than
"speak to a person", OpenAI's own models, memory across turns with a real model.

Rerun (needs two numbers of the same owner, two keys, a model key; nothing is written to the repository):

```bash
export TN_REAL_OWNER_PHONE='+<the customer number: the only number the assistant may message>'
export TN_REAL_PERSONAL_PHONE='+<the number the assistant runs on>'
export T3_LLM_KEY_FILE=<file with an OpenRouter or Groq key> T3_LLM_BASE_URL=https://openrouter.ai/api/v1 \
  T3_LLM_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free T3_RESPONSES_API_OFF=1
node templates/harness/run-template.mjs templates/ai-support-assistant-with-human-handoff/workflow.json \
  --real-api --api-key-file <key of the assistant number> --customer-key-file <key of the customer number> --max-sends 7 \
  --scenario templates/ai-support-assistant-with-human-handoff/test/real.mjs --image n8nio/n8n:2.45.5 \
  --run-id t3real --ports 5693,9221
```

With `--max-sends 7` the scenario keeps two messages for the handover step (the customer's request and the fixed handover text) and runs START as a pinned event: the question, its answer, STOP, its confirmation, the second question and the handover go over the wire (7 messages). With a larger budget START goes over the wire too. The owner alert and the contact card need a third owned number to be delivered; the scenario asserts that the guard refused them.

### What is not proven

- A real run of the final file ran for the question, STOP, the silent second question and the handoff words (see "Real API run on this version"). Not proven there: delivery of the owner alert and the contact card (the test guard refused them), START over the wire, `audio_to_person` and the other default handoff phrases against a real model. Whether the default phrases hand over the right chats in a real business is a matter of reading your first conversations.
- Whether a WhatsApp Business app greeting or away message reaches the API as an outgoing event with origin `native` (see "Things to know").
- Setting the Polling Trigger to one number (**Options > Number**) and an organization with several numbers.
- An Error workflow: it is described, not built, and was not run.
- The quality, tone and safety of any real model. The model was scripted: the tests prove the wiring, the prompt that reaches the model, the tool call, and what the workflow does with an answer, a low confidence, prose, or a failure. Nothing here proves a model stays inside its rules against a customer who tries to talk it out of them.
- Real WhatsApp delivery and the real Turbo Notify API are covered only by the runs in "Real API run" above. The typing behavior on a real Free plan stays simulated with the mock's plan gate. The contact quota and message quota refusals come from the mock; the wording of the real refusal text is the node's own, quoted above from this run.
- The outgoing native `message.sent` event (the owner typing in the app) is shaped from the documentation; the mock cannot produce one, so that test feeds it through pinned data on the trigger.
- A message whose text has expired (content retention): the mock does not simulate it, so the "becomes a handover" claim for expired text rests on the code path for an unreadable message (tested with a fault) and on the documented fact that the text is gone.
- Reactivation after a long downtime was run for a few seconds of downtime, not hours or days.
- Multiple n8n workers, queue mode, an n8n restart in the middle of a run, and the Simple Memory node on n8n Cloud.
- n8n Cloud itself (the claim that the package is available there rests on the n8n verification noted in the module README).
- The canvas look was checked in the real n8n 2.45.5 editor on 2026-11-17 (`workflow.png` is that screenshot of the final file): every group leaves room under its nodes for the labels, no group description is crossed by a wire or a node, and the red note covers only the `Your settings` node. Other n8n versions can draw labels and wires a little differently.
- Anything above a few hundred events: the workflow handles events one by one.
