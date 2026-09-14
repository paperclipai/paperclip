# AgentMail email connections

AgentMail is an experimental **channel** connection. Enable experimental chat
connections, open Apps → AgentMail, select which humans and agents may use the
credential, then enter an API key. In the saved connection’s Permissions page,
choose **Give an agent an email address**. The three-step wizard selects an agent,
creates or attaches an address, and reviews the setup. Selecting an agent outside
the current allowed list adds that agent when setup completes. Every provider thread in that inbox has one Paperclip task. Subjects are
not identifiers. The same email delivered to two connected inboxes creates two
independent tasks.

Setup accepts an AgentMail API key or the saved company credential from another
AgentMail connection. Organization and pod keys create an inbox-scoped runtime
key. An existing inbox-scoped key can connect only its own inbox. Credentials
are vaulted and resolved by the server; they are not passed to agents. An inbox
can have only one non-archived Paperclip endpoint across the instance.

Verified custom domains are selectable after checking the API key. Complete DNS
setup in [AgentMail](https://docs.agentmail.to/custom-domains). Paperclip does not
register domains or manage DNS.

The setup and Permissions page warn that an unrestricted inbox can receive mail
from anyone. Configure sender allowlists in AgentMail; Paperclip does not manage
or verify them. AgentMail controls new-message and reply lists separately. The
wizard recommends Paperclip’s existing **Low-trust review** preset and lets the
operator configure a project or root-task boundary. Incoming tasks are placed
inside that boundary. Low-trust execution also requires isolated workspaces and an active sandbox
environment selected for the agent; setup rejects an unavailable runtime. New
inbound tasks request isolated execution. The trust preset itself does not
sandbox filesystem or network access. Standard agents remain selectable with a warning.

Removing the assigned agent’s saved-connection access or revoking its credential
grant stops receiving and sending. Connection creation saves the vaulted binding,
human grants, and agent access in one database transaction.

## Receiving and task lifecycle

WebSocket is the default and needs no public HTTP URL. The server authenticates
with an Authorization header, keeping the provider key out of the connection URL
([provider handshake](https://www.agentmail.to/docs/api-reference/websockets/websockets)). The service holds a
renewable database lease, subscribes to the connected inbox, and reconnects with
backoff. Webhook mode needs the configured public HTTPS webhook base URL. Setup
registers a Paperclip-owned webhook. The raw request body is verified using Svix
before the inbox is admitted to the shared durable delivery queue.
The API key needs inbox-scoped `webhook_create`, `webhook_read`, and
`webhook_delete` permissions in addition to mail access. AgentMail's
"Send & read mail" preset alone cannot register a webhook. A rejected
registration while switching from WebSocket leaves live receiving active.

Both transports deduplicate by inbox, event kind, and provider message ID. A
per-conversation worker lease serializes work; independent conversations can
proceed concurrently. Provider messages, comments, and attachment links preserve
the provider message identity. A reply to a completed task reopens it. A cancelled
task retains new mail but does not wake its agent. Provider-classified spam,
blocked and unauthenticated mail do not start automatic work. Recognized automatic
replies can be retained in an existing conversation but do not wake an agent or
create a new task.

Activation establishes the intake cutoff. Activation, reconnect, and periodic
maintenance scan paginated message metadata and fetch eligible messages using a
receipt-time checkpoint with a five-minute overlap. Metadata scans traverse all
pages because AgentMail sorts messages by the sender's timestamp: a newly
received message can have an old Date header. Message-ID deduplication makes
repeated scans safe. Earlier messages in a newly active thread are imported as
context without separate historical wakeups. There is no automatic historical
mailbox import and no assumption of WebSocket replay.

Incoming mail wakes the selected agent through its normal task execution path,
including its configured permissions and budget controls. The external sender
is recorded in the email envelope; an email address never grants Paperclip
membership or board authority.

## Explicit email actions

Internal comments, progress, final responses, approvals, and errors never send
email. Email endpoints have an explicit publication mode; shared automatic chat
publication paths exclude them. Sending email does not close a task.

The task displays the email envelope, extracted reply text, full text context,
attachments, and delivery outcomes. Use the normal task conversation to ask the
agent to send an email or reply. There is no separate email composer or mode
switch. The agent uses an explicit email action; task messages themselves are
not sent as email. Reply uses Reply-To when present, otherwise the sender;
reply-all must be requested.
Bcc is retained in the originating envelope but is not copied to reply inputs.
Remote email images are not rendered. Attachments use Paperclip's content-type,
size, company, and task bounds.

An agent must own the inbox, be assigned the source task, and supply the running
source task's `X-Paperclip-Run-Id` at acceptance. Board actions require company
write access. Configured action policies apply to both. Authority is checked
again when the durable send executes. A new conversation creates its child task
and immutable send intent in one transaction before contacting AgentMail.

All paths below are relative to `/api`:

| Operation | Path |
| --- | --- |
| Save credential and human/agent access | `POST /companies/:companyId/email/connections` |
| Inspect a saved credential | `POST /companies/:companyId/email/connections/:connectionId/inspect` |
| List authorized inboxes | `GET /companies/:companyId/email/inboxes` |
| Inspect setup credentials (connection manager) | `POST /companies/:companyId/email/inspect` |
| Create or attach an inbox (connection manager) | `POST /companies/:companyId/email/inboxes` |
| Pause, resume, disconnect | `POST /email/inboxes/:endpointId/control` |
| Replace credentials / receiving mode | `POST /email/inboxes/:endpointId/reconnect` |
| Start an email child task or reply | `POST /companies/:companyId/email/send` |
| Read the email context of a bound task | `GET /companies/:companyId/email/tasks/:issueId` |
| Read delivery outcome | `GET /companies/:companyId/email/deliveries/:publicationId` |
| Resolve an uncertain outcome (connection manager) | `POST /companies/:companyId/email/deliveries/:publicationId/resolve` |

A new send request:

```json
{
  "endpointId": "<inbox-endpoint-uuid>",
  "parentIssueId": "<current-task-uuid>",
  "to": ["recipient@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Question about the proposal",
  "text": "Could you clarify the delivery date?",
  "attachmentIds": [],
  "idempotencyKey": "<new-request-uuid>"
}
```

A reply request uses `conversationId` and `replyToMessageId` from the bound task:

```json
{
  "endpointId": "<inbox-endpoint-uuid>",
  "conversationId": "<email-conversation-uuid>",
  "replyToMessageId": "<provider-message-id>",
  "replyAll": false,
  "text": "Thanks, that answers the question.",
  "attachmentIds": [],
  "idempotencyKey": "<new-request-uuid>"
}
```

Native runners with an active, authorized inbox receive `agentmail_inboxes`,
`agentmail_read_thread`, `agentmail_send`, and `agentmail_delivery`. The system
also installs the AgentMail skill for those agents through the normal runtime
skill path. These tools supply run authority and work independently of the
optional generic runtime API rollout. Where enabled, `search_api` and `call_api`
also expose these operations. The CLI uses the same authenticated
operations and inherits the agent run ID:

```sh
paperclipai email inboxes
paperclipai email thread "$PAPERCLIP_TASK_ID"
paperclipai email send --file email-request.json
paperclipai email reply --file email-reply.json
paperclipai email delivery '<publication-uuid>'
```

A `202` response includes task, conversation, and publication IDs immediately.
The publication progresses through queued, sent, delivered, failed, or uncertain.
Delivery callbacks update that publication and do not create new correspondence.
Retries reuse the same immutable request and provider idempotency key. The worker
stops automatic retries after 23 hours, conservatively inside AgentMail's 24-hour
deduplication window. An uncertain receipt can be resolved by matching its
provider message ID and Paperclip publication header, or by an operator confirming
that it was not sent. The latter marks it failed; any resend is a new explicit
action. Do not change an idempotency key just because a request timed out.

## Disconnect and diagnostics

Reconnect preserves inbox and task identity. Pause stops intake and sending.
Disconnect archives the local endpoint and removes its credential bindings,
unreferenced vaulted credentials, and only the webhook/runtime key created by
Paperclip. It never deletes the provider inbox or task history. If a revoked key
prevents provider cleanup, local disconnection still completes and reports that
Paperclip's provider registrations need cleanup in AgentMail.

Connection settings show state, receiving mode, catch-up time and errors. Tasks
show publication failures and uncertain delivery resolution. Delivery admission,
message processing and agent wakeup are separate from provider delivery and model
startup; live latency measurements must distinguish those stages.

## Verification and live qualification

Deterministic coverage lives in `server/src/__tests__/agentmail-api.test.ts`,
`server/src/__tests__/email-channels.integration.test.ts`, and
`tests/e2e/agentmail.spec.ts`. It exercises real database transactions with a fake
provider, plus browser setup and explicit task email actions.

Before labeling an installation live-qualified, use a disposable inbox and an
approved test recipient. In each transport mode, receive a message, verify one
task and one wake, send an explicit reply, and verify provider threading and
delivery. Also disconnect/reconnect, interrupt receiving, and verify catch-up.
Record provider message IDs and timestamps without copying credentials. Compare
the durable delivery `received_at` with the wake request time separately from
provider transit time and model startup. Automated fixtures do not constitute
live provider qualification.

Provider references: [inboxes](https://docs.agentmail.to/inboxes),
[webhook verification](https://docs.agentmail.to/webhook-verification),
[idempotency](https://docs.agentmail.to/idempotency),
[message listing](https://docs.agentmail.to/api-reference/inboxes/messages/list),
[reply API](https://docs.agentmail.to/api-reference/inboxes/messages/reply).

### Sandbox execution

AgentMail runs in the Paperclip control plane using its vaulted credentials. It
is a REST connection, not a local-stdio MCP server. The connection health check
validates the key against AgentMail; it does not launch a local command or discover
MCP tools.

Agents in Daytona and other sandbox environments use the same task email actions.
The sandbox callback bridge allows inbox discovery, bound-thread reads, delivery
reads, and explicit sends. The controller enforces company, inbox, task/run, and
action-policy checks. Mailbox setup, credential inspection, reconnect, and manual
delivery resolution remain outside that sandbox API surface. Native runners use
the assigned AgentMail tools through their run-bound tool channel. Neither path exposes the
AgentMail provider key to the sandbox.
