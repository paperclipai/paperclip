# MCP elicitation: an app's question, answered in the task chat

When a connected MCP app needs to ask the person something in the middle of a tool call, Paperclip handles it in five steps:

1. The question appears in the task chat as a card that names the app.
2. The agent's call stops with a message telling it to wait.
3. A person answers the card.
4. Answering wakes the agent.
5. The agent repeats the call with the same arguments, and Paperclip sends the answer to the app exactly once.

Nothing blocks while the person thinks, and nothing is held only in memory. A deploy or restart while a question waits loses nothing.

The design and its alternatives are in [`doc/plans/2026-11-13-mcp-elicitation.md`](../plans/2026-11-13-mcp-elicitation.md).

## What is supported

| App asks | Paperclip does |
| --- | --- |
| A form question, from a stateless (2026-07-28) server (`input_required`) | Shows a question card. The repeated call sends `inputResponses` together with the server's exact `requestState` |
| A form question, from an older (2025-06-18 / 2025-11-25) server (`elicitation/create` on the open stream) | Answers `cancel` at once, so the server never waits, and shows the card. When the same question arrives on the repeated call, Paperclip answers it from the card |
| A URL step (any version) | Shows the provider link, as before. Paperclip never claims the person's consent ([MCP-PROTOCOL-VERSIONS.md](./MCP-PROTOCOL-VERSIONS.md)) |
| A form beside a URL step | The link goes first. On the next call the app asks for the form again |
| A form question inside a background MCP Task | Shows the same card. The answer goes back with `tasks/update` ([MCP-TASKS.md](./MCP-TASKS.md)) |
| A password, key, token, card number or one-time code in a form | Refused. No card is shown, and the agent is told the app must use a secure link |
| A schema outside the spec, or a form with no task | Shows no card. The agent gets a clear reason |

## Capability

Paperclip declares `elicitation: { form: {}, url: {} }` in two places:

- **2026-07-28:** per request, only on HTTP `tools/call` requests that belong to a task, because that is where a person can answer.
- **Older HTTP sessions:** at `initialize`, only on the session that tool calls use, because that is the path that answers questions. Sessions that only read (resources, prompts, listing) declare none, so they are never asked a question they would leave waiting. A 2025-06-18 session gets `{}`, which means form only. Questions that arrive outside a task are answered `cancel` at once.

Stdio apps keep URL only.

## How the card works

- **Shows which app is asking.** The card's title is "*App* needs your input", using the connection's name. The app's message is shown as plain text: links are not clickable, and secrets are redacted.
- **Only people can answer** (`resolverPolicy: "human_only"`). An agent answering its own tool's question would be consent given on nobody's behalf.
- **Lets the person review before sending.** The form is the standard question form: fields can be edited, and nothing is sent until **Send to *App***. **Skip** declines.
- **Is checked on submit.** Required fields, lengths, number ranges and the date format are validated before the card is resolved. Email and web address show a hint and are checked by the app, because the form only checks fixed-width patterns.
- **Wakes the agent either way.** Answering wakes the agent through the question-response outbox. **Skip** on an app's question also wakes it (ordinary questions do not), because the decline only reaches the app on the agent's next call.

Each form field maps to one card field:

| Schema | Card field |
| --- | --- |
| `string` (`minLength`, `maxLength`, `default`) | Text. The default is filled in |
| `string` with `format` `email` / `date` / `date-time` / `uri` | Text with a hint. `date` is validated |
| `number`, `integer` (`minimum`, `maximum`, `default`) | Number field |
| `boolean` (`default`) | Yes / No. The default is marked as recommended |
| `enum`, or `oneOf` with `const` + `title` | Single choice. Titles are the labels |
| `array` with `items.enum` or `items.anyOf` (`minItems`, `maxItems`, `default`) | Multiple choice |
| No properties | One **Continue** choice |

Paperclip refuses the following shapes rather than showing part of the form:

- Nested objects.
- Arrays of anything but choices.
- Unknown formats.
- More than 10 fields.
- More than 100 choices.
- More than 4 form questions in one round.

## What goes back to the app

| The card | Sent |
| --- | --- |
| Answered | `{ action: "accept", content }`, with values typed to the schema (choices are sent as their `const`) |
| Skipped | `{ action: "decline" }` |
| Withdrawn, task closed, expired, or deleted | `{ action: "cancel" }` |

## What the agent sees

| Moment | Result |
| --- | --- |
| The app asks | `elicitation_required`: "*App* asked a question, and it is waiting for a person in the task chat. Paperclip wakes you when it is answered; then call this tool again with the same arguments to continue." |
| Repeated before every card is resolved | The same message. The app is not contacted |
| Repeated after | The app's own result for the answer, decline or cancel |
| A secret was asked for | `elicitation_sensitive_refused` |
| An unsupported form | `elicitation_unsupported` |
| 10 questions already waiting on the task | `elicitation_limit_reached` |

The agent never receives the person's answers from Paperclip, only the app's result. Within one run, a repeated side-effecting call normally replays the earlier result. A call that stopped for a question runs again instead.

## Storage and recovery

- **Table.** `tool_mcp_elicitations` holds one row per question round. It is company-scoped and records:
  - The task, agent, run, connection and grant.
  - A keyed call identity, covering endpoint, tool, arguments, grant, agent and any forwarded routing headers (such as a tenant). One tenant's answers never go out with another tenant's headers.
  - The server's `requestState`, sealed with AES-256-GCM and bound to the company and connection.
  - Each question's key, words, schema and card.
- **Answers.** Answers live only on the cards.
- **Saving.** The round is saved before its cards, and each card has a fixed key. If the process stops between the two, the next call makes the missing card under the same key, so no question is lost or shown twice.
- **Who can collect a round.** Only the identical call can collect it: same company, task, connection, grant, agent and call identity.
- **Older apps that ask several questions.** An answer is spent only when the app finishes the whole call. An app that asks Q1 and then Q2 gets Q1's answer again on the next call, without a second card. An app that refuses the reply (an HTTP error) keeps the answer for the next call.
- **Keyed retries.** A call with an unsent round runs again (instead of replaying its last result, even a failed send) only if it has the same tool and arguments as the saved round.
- **One round per call.** At most one waiting round exists per call (per question, for older servers), enforced by a unique index. Two matching calls at once share its cards.
- **Ask-first actions.** An approved action that stops for a question keeps its approval. The repeated call continues the same approved action and sends the answer, with no second approval.
- **Claims.** A repeated call claims the round before sending. If the process dies mid-send, the claim lapses after the tool timeout plus a minute, and the next call sends again. A failed send releases the claim at once.
- **Expiry.** Rounds expire after 24 hours, checked when the call is next made; no background poller is involved. Expired cards are withdrawn, so nobody answers a dead question, and the call starts over.
- **Activity log.** The log records `tool_gateway.elicitation_requested`, `tool_gateway.elicitation_sent` (the actions only, never values), `tool_gateway.elicitation_refused` (field names only) and `tool_gateway.elicitation_expired`. Answers are logged as `issue.thread_interaction_answered`.

## MCP Apps

A tool call made from an MCP App view runs in the task's session. Its questions appear in the same chat.

## Not supported yet

- Enforcing `minItems` and `maxItems` on the card. Today they show as help text, and the app checks them when the answer arrives.
- Sampling and roots requests.
- Form questions from stdio apps.
- Forms rendered inside an MCP App view.
- `input_required` on `resources/read` and `prompts/get`.
- Answers to the vendor `_meta.elicitation` result shape, which has no channel for them.

## Tests

`server/src/__tests__/mcp-elicitation.test.ts` covers the following:

- The schema mapping and answer typing.
- The sensitive-field refusal.
- Capabilities.
- A fake stateless server: answer, skip, two questions at once, restart while waiting, a crash mid-send, a second company, expiry, and an agent trying to answer.
- A fake 2025-06-18 server that asks over the open stream.

Stories: `Tasks and conversations/Questions and approvals/MCP App Questions`.
