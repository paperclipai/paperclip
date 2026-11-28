# MCP elicitation: an app's question becomes a task-chat card, and the agent's next call carries the answer

Status: plan, 2026-11-13. Owner: the mcp-elicitation session. Builds on #21119 and #21266 (MCP Apps), #21140 (stateless 2026-07-28 client), #21219 (Skills over MCP) and #21263 (MCP Tasks).

## Summary

**Recommendation: the run yields while it waits.** When a connected MCP app asks the person a question in the middle of a tool call, Paperclip does four things:

1. It saves the question durably.
2. It shows the question as a question card in the task chat, titled with the app's name.
3. It tells the agent to wait.
4. When someone answers, it wakes the agent through the existing answer-delivery outbox.

The agent then calls the tool again with the same arguments, and Paperclip sends the answer to the app exactly once. Nothing blocks and nothing stays in memory, so a restart at any point leaves no stuck call.

The flow covers both protocol eras:

- **Stateless servers (2026-07-28)** return `input_required`. Paperclip repeats the call with `inputResponses` and the exact `requestState`.
- **Older servers (2025-06-18 and 2025-11-25)** send `elicitation/create` over an open stream.
  - The first time, Paperclip answers `cancel` at once, so the server is never left hanging.
  - Once the person answers, the repeated call answers the same question from the card.

Three rules hold across both eras:

- Only people can answer. Agents cannot.
- Forms that ask for passwords, keys or card numbers are refused and never shown.
- Choosing **Skip** sends `decline`. A withdrawn, closed or expired card sends `cancel`.

## Foreword

- **Context.** Today Paperclip handles only part of what an MCP app can ask:
  - **URL requests** already become a provider link that the person opens.
  - **Form questions from background MCP Tasks** already become a question card, and the answer goes back with `tasks/update`.
- **Need.** Every other form question is a dead end:
  - A stateless server's form `input_required` ends in a "needs information Paperclip can't collect yet" error.
  - An older server's `elicitation/create` creates a card, but nothing ever reads the answer back. The card key `mcp-elicitation:<invocationId>` is never looked up again, so the server asks again on every retry.
  - Paperclip declares only `elicitation: { url: {} }`. A compliant stateless server therefore never asks a form question at all.
- **Task.** Make form elicitation work end to end in the task chat for both eras. The work must be restart-safe, company-scoped and logged in the activity log.
- **Object.** The document is organized as follows:
  - §1: what the spec requires.
  - §2: what exists today.
  - §3: the nine design decisions.
  - §4: the user journey.
  - §5: tests.
  - §6: risks and what is out of scope.

## 1. The spec: two transports carry one question model

Form and URL requests share one data model. Only the transport differs between eras.

### 1.1 Data model (client/elicitation, 2026-07-28)

- **Request.** `elicitation/create` has these parameters:
  - `mode`: `"form"` (the default when omitted) or `"url"`.
  - `message`: required.
  - Form mode adds `requestedSchema`.
  - URL mode adds `url` (and `elicitationId` on 2025-11-25).
- **Form schema.** A flat object whose properties are primitives:
  - **string**: `minLength`, `maxLength`, and `format` (one of `email`, `uri`, `date`, `date-time`).
  - **number / integer**: `minimum` and `maximum`.
  - **boolean**.
  - **Enums (SEP-1330):**
    - Single select: `enum`, or `oneOf: [{const, title}]`.
    - Multi select: `type: "array"` with `items.enum` or `items.anyOf: [{const, title}]`, plus `minItems` and `maxItems`.
  - **Defaults:** every type may carry a `default` (SEP-1034), which clients SHOULD pre-fill.
- **Response.** One of three actions:
  - `{ action: "accept", content }`.
  - `{ action: "decline" }`: the person explicitly said no.
  - `{ action: "cancel" }`: the request was dismissed with no choice made.
  - For URL mode, `accept` carries no content. It means "the person agreed to open the link", not "the step is done".
- **Capability.** The client declares `elicitation: { form: {}, url: {} }`, per request on 2026-07-28 and at `initialize` on older versions. `{}` alone means form only. A server MUST NOT use a mode that the client did not declare.

### 1.2 Transport

- **2026-07-28 (stateless).** Multi round-trip requests replace server-initiated requests.
  - On `tools/call`, `resources/read` or `prompts/get`, the server returns `resultType: "input_required"`. The result carries an `inputRequests` map (server-chosen keys) and/or an opaque `requestState`.
  - The client builds every requested input, then retries the *same* request with a new JSON-RPC `id`. The retry carries `inputResponses` (same keys) and echoes `requestState` byte for byte. The client MUST NOT inspect or alter `requestState`, and MUST NOT reuse it on any other request.
  - Retries may be delayed arbitrarily. Servers SHOULD re-ask for anything missing rather than fail.
- **2025-06-18 / 2025-11-25 (sessions).** The server sends a JSON-RPC request `elicitation/create` inside the open `tools/call` SSE stream. The client POSTs the JSON-RPC response while the stream stays open.
  - In 2025-11-25, URL mode can also arrive as error `-32042` carrying `data.elicitations`.

### 1.3 Security rules Paperclip must meet

- **Sensitive data.** Servers MUST NOT request secrets through forms: passwords, API keys, tokens or payment credentials. Such requests MUST use URL mode.
- **Consent and identity.** Clients MUST:
  - Show which server is asking.
  - Offer clear decline and cancel options.
  - Let the person review and edit a form before it is sent.
  - Before opening a URL, show the full address and get consent.
  - Clients SHOULD also validate answers against the schema.
- **Links.** Clients MUST NOT prefetch URLs. They SHOULD NOT render links inside form text as clickable.

## 2. Inventory: the pieces exist; the answer path does not

### 2.1 Gateway (`server/src/services/tool-gateway.ts`)

| Piece | Where | Today |
| --- | --- | --- |
| `extractMcpElicitationRequest` | `:6498` | Recognizes `elicitation/create` and vendor `_meta.elicitation` shapes |
| `elicitationQuestions` | `:6541` | Up to 10 properties. Enum becomes single select; everything else becomes "Provide answer" plus free text. Ignores type, format, default and multi select |
| `createElicitationCard` | `:6603` | `ask_user_questions` card titled "Tool needs input". No app name; resolver policy left at the default `anyone`, so agents may answer |
| `requestElicitationForRecordedToolCall` | `:6629` | Marks the invocation `awaiting_approval`, writes a call event and an audit entry, then throws 409 `elicitation_required` |
| Legacy stream `onRequest` | `:7928` | URL request: POSTs `cancel` and starts the link flow. Form request: creates a card and throws **without answering the server** |
| `mcpInputRequiredPending` | `:704` | URL-only rounds become the link flow; a bare `requestState` is kept in memory; **form rounds return `answerable: false`** |
| Modern `input_required` branch | `:8040` | A form round ends in `provider_input_required` ("can't collect yet") |
| `mcpContinuations` | `:1406` | In-memory `requestState` cache (lost on restart) |
| Capabilities (`server/src/services/mcp-http.ts:57`) | | Modern: `elicitation: { url: {} }`. Legacy: none |

### 2.2 MCP Tasks (#21263, `doc/connections/MCP-TASKS.md`)

- `planMcpTaskInput` (`:7125`) looks up the card by `mcp-task-input:<row>:<keyhash>`:
  - Pending: wait.
  - Answered with no `outcome`: `accept` with `elicitationContent`.
  - Anything else: `decline`.
- The answer goes back with `tasks/update`.
- **This plan reuses its card builder and answer mapping and does not duplicate them.** Both move into one module so that Tasks cards gain the same fields and app name.

### 2.3 Question cards (`issue_thread_interactions`, kind `ask_user_questions`)

- **Shape.** The payload can carry a canonical `questionSet` (`packages/shared/src/types/issue.ts:1385`):
  - `answerMode`: `single_select`, `multi_select` or `text`.
  - `initialText` for defaults.
  - `recommended` on options.
  - `textValidation` with `minLength`, `maxLength`, `pattern`, `inputType` (number or integer), `minimum` and `maximum`.
- **Validation.** On submit, the server validates answers against the `questionSet` (`question-interaction-answers.ts:69`, 422 `invalid_question_response`).
- **Statuses.**
  - Answered: `answered`.
  - Skip: `cancelled` with `outcome: "skipped"`.
  - Withdraw or close: `cancelled` with an outcome.
  - Superseded: `expired`.
  - Dismiss changes nothing.
- **Who may answer.** The respond route checks issue access, then the interaction's resolver policy (`issue-thread-interaction-resolution.ts`). `human_only` keeps agents out.
- **Wake on answer.** `answerQuestions` writes an `issue_question_response_deliveries` outbox row. The delivery worker wakes the assignee (`question-response-delivery.ts:1170`) with retries. The wake is durable.
- **UI.**
  - `TaskChatInteractionCard` shows "Unanswered question" and opens `AskUserQuestionsCard` / `QuestionForm` above the composer.
  - The header shows `interaction.title`.
  - Text, number and integer fields with validation already exist.

### 2.4 Waiting on a person elsewhere

- **Native runtime requests** (`native-runtime/runtime-request-resolution-authority.ts`) hold a live harness turn open and fall back to a durable card.
- **Tool approvals** (`tool_action_requests`) yield the call. A later identical call collects the approval.
- Elicitation follows the approval pattern (yield, then collect), not the harness pattern. A remote HTTP call cannot be held across a restart.

## 3. Design decisions

Each decision states the chosen option first, then why.

### D1. Waiting: the run yields; the agent's repeat call collects the answer

- **Chosen.** The call ends at once with 409 `elicitation_required` and a plain message:

  > "Linear asked a question in the task chat. Paperclip wakes you when it is answered. Then call this tool again with the same arguments. Don't ask the question yourself."

  An answer wakes the assignee through the durable question-response outbox. A repeat call before every card is resolved returns the same message without contacting the app.
- **Why not block with a time limit?** Blocking would:
  - Hold an HTTP stream and a run slot for minutes.
  - Die on deploys and restarts.
  - Need a second wake path anyway when the time limit passes.

  Yielding reuses the outbox, which already survives restarts, and matches the approval pattern.
- **Recovery.** Everything the retry needs lives in Postgres:
  - The `tool_mcp_elicitations` row, with `requestState` sealed.
  - The cards.

  A send is guarded by a lease (`claimed_at`). If the process dies mid-send, the next call reclaims the row once the lease is older than the tool timeout plus a margin. The answer is not lost and is not sent twice.

### D2. Who may answer: any person with access to the task, never an agent; the card names the app

- **Chosen.** `resolverPolicy: "human_only"` on every elicitation card. This applies to direct and Tasks questions alike.
- **Why not only the responsible user?** That person may be away, and other questions in the task chat already accept any member with access. Narrowing to one person would strand the run.
- **Why not agents?** Letting an agent answer its own tool's question defeats user consent.
- **Showing the app.**
  - Card title: "*App name* needs your input". The app name comes from the connection's display name.
  - Card description: the server's `message`, redacted, as plain text, so links are not clickable.
  - Submit label: "Send to *App*".
  - The person sees no raw IDs.

### D3. Mapping: every spec type becomes a real field; anything else is refused clearly

| Schema | Card field (`questionSet`) |
| --- | --- |
| `string` (+ `minLength`/`maxLength`) | `text` with those limits. `default` becomes `initialText` |
| `string` with `format` `email` / `date` / `date-time` / `uri` | `text` with a format hint. `pattern` for `email` and `date` |
| `number` / `integer` (+ `minimum`/`maximum`) | `text` with `inputType` and range. `default` becomes `initialText` |
| `boolean` | `single_select` Yes / No. `default` marks the recommended option |
| `enum`, `oneOf[{const,title}]` | `single_select`. Titles are labels; `default` is recommended |
| `array` of `items.enum` / `items.anyOf` | `multi_select`, with `minItems`/`maxItems` as help text |
| No properties | One `single_select` "Continue" option, sending `accept` with `{}` |

- **Answers back.** Answers map back to typed `content`: enum options return their `const` value, and numbers and booleans are typed.
- **Required fields.** Required follows `schema.required`.
- **Refused shapes.** Nested objects, arrays of non-enums, unknown types, more than 10 properties, more than 4 form requests in one round, or more than 100 options. Paperclip shows no card. The agent gets `elicitation_unsupported`:

  > "*App* asked a question Paperclip can't show here. Complete this step in *App*, then try again."

  A legacy server gets `cancel`. A stateless server needs no reply.

### D4. Sensitive fields: refuse, don't warn

- **Chosen.** If any field's name, title or description matches the secret pattern, the whole request is refused before a card exists. This covers password, passcode, secret, API key, access or refresh token, credential, private key, card number, CVV/CVC, SSN, one-time code and 2FA/MFA. A field marked `format: "password"` or `writeOnly` is refused the same way.
- **Why refuse rather than warn?** The spec forbids such forms. A warning still puts a secret into the task thread and the activity history, where it stays.
- **What happens on refusal.**
  - The agent gets `elicitation_sensitive_refused`:

    > "*App* asked for a password or key in a form. Paperclip doesn't collect secrets that way; the app must use a secure link."

  - A legacy server gets `cancel`.
  - The refusal is logged with field names only, never values.

### D5. What the agent sees

| Moment | Agent sees |
| --- | --- |
| Question asked | 409 `elicitation_required` with the wait-and-retry message, `interactionIds` |
| Retried too early | The same message. The app is not contacted |
| Answered, skipped or closed, then retried | The app's real result for `accept` / `decline` / `cancel` (the app decides what declining means) |
| App asks again | A new question; the cycle repeats |
| Round expired before an answer | The call goes out fresh, so the app asks again |

The agent never sees the answer values through Paperclip's message. Only the app's own result reaches it.

### D6. Persistence: one company-scoped table, sealed state, logged actions, 24-hour expiry

- **Table `tool_mcp_elicitations`.** One row per question round. Its columns:
  - Scope: `company_id`, `issue_id`, `agent_id`, `run_id`, `connection_id`, `grant_id`, `invocation_id`.
  - `call_identity`: an HMAC over endpoint, tool, arguments, grant and agent.
  - `era`: `modern` or `legacy`.
  - `sealed_request_state`: AES-256-GCM, bound to company and connection.
  - `questions`: jsonb `[{key, questionHash, interactionId, mode}]`. It holds no answers; the card is the single source of truth.
  - `status`: `waiting`, `sent`, `expired` or `refused`.
  - Bookkeeping: `claimed_at`, `expires_at`, `created_at`, `updated_at`.
- **Lookups.** Every lookup filters by company, issue, connection, grant, agent and call identity.
- **Expiry.** Rows expire after 24 hours. Expiry is checked lazily on the next call, so no background poller is added (this follows the sleep-aware-worker rule). On expiry, pending cards are withdrawn through the interaction service, so nobody answers a dead question. The app's own `requestState` TTL is usually shorter; if the app rejects stale state, it SHOULD re-ask.
- **Cap.** At most 10 waiting rounds per task. Beyond that the call fails with "too many open questions" instead of spamming cards.
- **Activity log.** The log records these events:
  - `tool_gateway.elicitation_requested` (exists).
  - `tool_gateway.elicitation_sent`, with the actions only.
  - `tool_gateway.elicitation_refused`.
  - `tool_gateway.elicitation_expired`.
  - The existing `issue.thread_interaction_answered`.

  Answer values are never logged.

### D7. Retry semantics: stateless servers are fully supported; older servers are answered from the card

- **Stateless (2026-07-28).**
  - Paperclip declares `elicitation: { form: {}, url: {} }` on HTTP `tools/call` when the call belongs to a task. That is the only place a card can be shown.
  - **Form rounds.** On `input_required` with form requests, Paperclip saves the round and creates the cards, which ends the call.
  - **The repeat call.** It finds the waiting round, checks that every card is resolved and claims the row. It then sends one `tools/call` with a new id, `inputResponses` for every key, and the unsealed `requestState`.
  - **Mixed rounds.** If a round mixes URL and form requests, the URL link flow goes first and is not persisted. Paperclip never claims URL consent that nobody gave. The fresh call that follows lets the server re-ask for the form.
  - **Bare `requestState`.** A round with only `requestState` keeps today's in-memory retry.
- **Legacy (2025-06-18 / 2025-11-25).** Paperclip declares `elicitation: { form: {}, url: {} }` at `initialize` (`{}` on 2025-06-18).
  - **When a form `elicitation/create` arrives on the stream,** Paperclip computes `questionHash`, a hash of the message and the canonical schema.
  - **If an answered, unsent round matches** this call identity and hash, Paperclip claims it, POSTs `accept` / `decline` / `cancel` and keeps reading the stream.
  - **Otherwise** it saves a round, creates the card and POSTs `cancel`, so the server stops waiting. Then it ends the call with `elicitation_required`.
  - **Why answer ahead from a saved card?** The person consented to that exact question for that exact call. Holding the stream open would break D1.
- **Never supported.** The vendor `_meta.elicitation` result shape keeps today's card-only behavior: it has no channel for answers.

### D8. Tasks interplay: one mapping, two transports

- The schema mapping, sensitive check, card builder and answer mapping move to `server/src/services/mcp-elicitation.ts`. MCP Tasks uses them unchanged in behavior, and its cards gain the app name, real fields and `human_only`.
- **With `enableMcpTasks` off,** `tools/call` never returns a task, and D7 handles every question.
- **With it on,**
  - A task's own `input_required` keeps its `tasks/update` path.
  - A non-task `input_required` uses D7.
  - The two never share a card key: tasks use `mcp-task-input:`, direct calls use `mcp-elicit:`.

### D9. MCP Apps: a view's tool call asks in the same chat

A tool call triggered from an MCP App view already runs in the task's gateway session, so D7 applies unchanged:

- The card appears in the chat beside the view.
- The view's call receives the wait message.
- Answering wakes the agent, which repeats the call.

Out of scope: a form rendered inside the view.

## 4. User journey and UI states

1. **Asking.** The agent calls Linear's `create_issue`, and Linear asks "Which team should own this?" The task chat shows "Unanswered question". Opening it shows the form:
   - Title: "Linear needs your input".
   - The app's message as plain text.
   - The fields.
   - **Send to Linear** and **Skip**.
2. **Answered.** The receipt shows the answers. The agent wakes, repeats the call and posts the result.
3. **Declined.** The person chooses **Skip**. The receipt reads "Skipped". The app receives `decline`, and the agent reports what the app did.
4. **Expired.** If nobody answers for 24 hours and the agent repeats the call, the card is withdrawn and its receipt reads "Withdrawn". The app asks again on a new card.
5. **Failed.** If the app rejects the answer (for example, a stale state), the agent receives the app's error and explains it. If the app asked for a secret, no card appears; the agent explains that the app must use a secure link.

**Storybook.** `ui/storybook/stories/questions-and-approvals/mcp-elicitation-question-card.stories.tsx` covers these stories:

- Asking, with all field types.
- Answered.
- Skipped.
- Withdrawn or expired.
- Two questions at once.

The fixtures are generated from the server's own mapper output, so the stories show the real card.

## 5. Test plan (red on master, green on the branch)

| # | Test | Proves |
| --- | --- | --- |
| T1 | Fake 2026-07-28 server: `input_required` form produces a card and `elicitation_required`; answer, repeat the call, and the server receives `inputResponses` + exact `requestState` | D1, D7 modern |
| T2 | Same, with Skip producing `decline` and a withdrawn card producing `cancel` | D5 actions |
| T3 | Repeat before an answer: no upstream request | D1 |
| T4 | Two form keys in one round produce two cards; a single send carries both answers | Two questions at once |
| T5 | New gateway instance (simulated restart) between ask and repeat; a stale `claimed_at` is reclaimed | Restart-safe |
| T6 | Fake legacy server over SSE: first ask receives `cancel` immediately and gets a card; after the answer, the repeat call's stream receives `accept` + content | D7 legacy |
| T7 | A password field is refused: no card, `elicitation_sensitive_refused`, legacy receives `cancel` | D4 |
| T8 | Company B's session with the same tool and arguments does not collect company A's round; an agent actor cannot answer the card | Scope, permissions |
| T9 | Unit: every schema type maps and round-trips (SEP-1330 single/multi, titled/untitled, SEP-1034 defaults) | D3 |
| T10 | MCP Tasks suites stay green, and a Tasks card now has `human_only` and the app title | D8 |
| T11 | Capabilities: modern declares `form` only when the call has a task; legacy `initialize` declares form | D7 |

**Live demo.** A local fake 2026-07-28 server, connected as a custom remote MCP app in a dev instance. An agent calls it, the question appears in the task chat, the answer is submitted in the browser, and the agent finishes. This is recorded in the PR.

## 6. Risks and scope

- **Older servers that never asked may start asking.** Declaring form on `initialize` invites questions. Mitigation: the first ask is always answered `cancel` at once, so no call hangs, and the agent gets a clear next step.
- **Answer-ahead could answer a different intent.** It matches only the same task, connection, grant, agent, tool, arguments, message and schema, within 24 hours, once.
- **Stale cards.** Expiry is lazy. A card can sit unanswered past 24 hours until the agent next calls; answering it then just wakes the agent, which re-asks. This is acceptable without a poller.
- **Migration.** One additive table, with no backfill. It is online-safe.

**Out of scope (follow-ups):**

- Sampling and roots requests.
- Form elicitation from stdio apps (they keep URL only).
- Forms rendered inside an MCP App view.
- `resources/read` and `prompts/get` input rounds.
- The vendor `_meta.elicitation` answer path.

## Conclusion

The plan ships form elicitation for both MCP eras without blocking:

- The question becomes a named, human-only card.
- The answer travels on the agent's repeat call, sent once from durable state.
- Secrets and unsupported shapes are refused up front.

**Next:** build `mcp-elicitation.ts`, the table, the gateway wiring and the tests (T1–T11). Then add the stories and `doc/connections/MCP-ELICITATION.md`, and open the PR.
