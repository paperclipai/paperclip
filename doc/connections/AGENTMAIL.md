# AgentMail email connections

AgentMail is a default **channel** connection. Open Connectors → AgentMail;
no experimental setting is required. Setup has two steps: pick the agent, then
pick its email address and create it. For a new connection, the first step also
suggests an accessible saved AgentMail account key, or asks for a new API key.
New credentials default to company-wide human access and only the selected agent.
Reusing a key preserves its grants and other agent installs. The domain dropdown sits
beside the email name and defaults to the first verified custom domain, falling
back to `agentmail.to`. An explicit choice is preserved across reloads. Receiving
mode, sender guidance, and trust settings are under **Advanced options**; an
existing low-trust agent still needs its required work boundary and runtime.
There is no separate review or Permissions detour. Each provider thread in the
inbox becomes one Paperclip task. Subjects are not identifiers. The same email
delivered to two connected inboxes creates two independent tasks.

**Add connection** starts a fresh setup identity, so an earlier unfinished key
or address cannot silently replace the new form. **Finish setup** on a draft row
resumes that exact inbox with its saved account and request ID, including an
address already allocated before a later provider failure. Cancel and Done
return to Connectors; Email settings opens the inbox settings. The email step
groups the task/thread explanation under **How it Works**.

After allocation, the address is shown as text with **Finish connecting**.
**Choose a different address** restores the editable name and domain fields with
a new setup identity. The previous inbox stays in AgentMail, and its draft can
still be resumed from Connectors. Retrying never silently creates a replacement.
Changing accounts also opens a new setup URL after saving the replacement key
and retiring the empty draft, so refresh preserves the new account and request.

Get API keys from [AgentMail's API-key page](https://console.agentmail.to/dashboard/api-keys).
When an agent requests AgentMail in a chat or task, an inline card asks only for
the key. It defaults to company-wide human access and this agent only, then
creates an address (or connects the existing address for an inbox-scoped key).
The agent resumes only after its inbox is usable. Access can be adjusted later on the saved connection’s Permissions page.

Setup accepts an AgentMail API key or the saved company credential from another
AgentMail connection. Organization and pod keys create an inbox-scoped runtime
key. An existing inbox-scoped key can connect only its own inbox. Credentials
are vaulted and resolved by the server; they are not passed to agents. An inbox
can have only one non-archived Paperclip endpoint across the instance.

The shared API-key field offers labeled saved credentials and an explicit new-key
choice. The server filters suggestions by company, provider, active secret, and
current-user grants. Scope metadata is saved during key validation; legacy keys
are checked with bounded concurrency under a shared three-second deadline.
No secret values are returned. Use still rechecks authorization and the key.
Organization/pod keys are preferred over inbox-only keys. The same picker is used
by the inline card. Unrelated or unbound secrets are not suggested.

An inbox-only key is caught on the agent/key step before the email form. Choose
an account key to type a new name and pick a domain, or explicitly choose
**Use the existing inbox instead**. Old locked drafts recover at this key choice.
The selected credential or explicit new-key choice survives refresh without
storing the key text. Failed inline setup offers **Change API key** before any
address is allocated; it retires an empty draft and preserves the replacement
request identity across refresh.
Switching preserves the agent and starts a new setup request. Agent dropdowns
use the shared avatar-aware selector for both options and the selected value.
An already allocated inbox must finish its original setup before changing accounts.

Verified custom domains are selectable after checking the API key. Complete DNS
setup in [AgentMail](https://docs.agentmail.to/custom-domains). Paperclip does not
register domains or manage DNS.

Debounced address checks search the account's visible inbox list (up to 100
entries), rather than requesting a not-yet-created inbox by ID. Live testing
found that AgentMail retains negative inbox lookups: an address checked before
creation could return 404 during access-key creation even after the inbox was
created successfully. Listing avoids this failure. A match is taken; absence is
unknown because the address may be outside the returned page or credential scope.
Final creation still handles global address conflicts.

Failed provider requests retain their HTTP status, a fixed operation name, and
an allowlisted [AgentMail error code](https://docs.agentmail.to/errors). For
example, `create_inbox` with `missing_permission` differs from `limit_exceeded`.
An HTTP 403 alone does not establish the cause. Missing or unrecognized codes
appear as `unknown`. Error-body inspection is limited to 8 KiB and one second;
malformed, larger, or stalled responses keep the original HTTP failure. Provider
messages, suggested fixes, URLs, inbox identifiers, and credentials are excluded
from these diagnostics. These diagnostics do not retry or suppress failures.

Advanced options and the Permissions page explain that an unrestricted inbox can
receive mail from anyone. Configure sender allowlists in AgentMail; Paperclip does not manage
or verify them. AgentMail controls new-message and reply lists separately. The
setup lets the operator review the agent’s trust settings and configure a project
or root-task boundary for **Low-trust review**. Incoming tasks are placed
inside that boundary. Low-trust execution also requires isolated workspaces and an active sandbox
environment selected for the agent; setup rejects an unavailable runtime. New
inbound tasks request isolated execution. The trust preset itself does not
sandbox filesystem or network access. Standard agents remain selectable with a warning.

A boundary project without a configured workspace can process email in a private
task directory inside the selected sandbox. It does not need a Git repository.
An explicitly configured workspace strategy still applies and must be usable.

Removing the assigned agent’s saved-connection access or revoking its credential
grant stops receiving and sending. Connection creation saves the vaulted binding,
human grants, and agent access in one database transaction.
The catalog's **Remove connection** action uses the email inbox control API for
AgentMail, including unfinished drafts. It preserves provider inboxes and task
history while disconnecting Paperclip and removing its owned runtime credentials.

Each inbox has distinct **Settings**, **Access**, **Conversations**, and
**Activity** views. Access reuses the saved account's credential and agent controls,
so changes apply to every inbox using that account. Conversations links email
threads to their tasks; Activity shows the shared delivery and publication feed.
Settings leads with the agent’s email address: click it to copy with confirmation,
or use **View inbox** to open that inbox in AgentMail’s console. It also explains
how email becomes tasks.
Receiving mode, last mail check, and Pause/Resume are grouped below. Reconnect
credentials live in an expandable section, followed by a separate Disconnect
action. Inbox lifecycle controls use the email API, and reconnect opens inbox Settings.
Unconfirmed email delivery is resolved in its task rather than through chat replay.

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
| Check an address without creating an inbox (connection manager) | `POST /companies/:companyId/email/connections/:connectionId/check-address` |
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

Setup reads only allowlisted, documented provider error codes from a bounded
response body. An inbox-creation `resource_taken` or `already_exists` error,
including HTTP 403, appears beside the email field as “This email address is
already in use.” Other 403 errors retain permission guidance. Provider messages,
fixes, and links are never forwarded. Existing addresses visible to the saved
account are flagged before submission. The initial name and subsequent edits
trigger a read-only check after a 350 ms pause; changing the name or domain
aborts the previous request and ignores its result. Checks use the saved credential
behind the same company, connection-management, and connector-feature gates.
Taken addresses show clickable alternatives, excluding known conflicts. A failed
creation also remembers that address in the non-secret setup draft.

[AgentMail's `not_found` response](https://docs.agentmail.to/errors#not_found)
also hides inboxes outside the credential's scope, so a lookup cannot prove
global availability. Missing addresses show that availability is confirmed on
creation and offer alternatives without claiming they are free. Lookup failures
are visible and leave creation available for its authoritative check; known
conflicts and pending checks disable creation. Other taken addresses are reported
when creation is attempted, without leaving the address step.

Browser refresh preserves non-secret draft fields and the setup request ID;
API keys are never saved in browser storage. Retrying the same setup resumes any
inbox already created before the failure. Drafts are scoped to the agent requested
by the setup link. Once an inbox has been allocated, its agent and address stay
fixed during recovery. A failed progress lookup can be retried in place.

When the account and inbox share a setup request ID, completion replaces the
account’s untouched initial agent access with the final selected agent. That
default applies only once and only while the original install rows are unchanged.
Later permission edits and retries preserve existing agent or company installs.
Reusing an account from another setup also preserves its existing installs. Both paths use the email
setup permission (`tools:manage_connections`), without an additional agent-edit
permission.

## Verification and live qualification

Deterministic coverage lives in `server/src/__tests__/agentmail-api.test.ts`,
`server/src/__tests__/email-routes-provider-errors.test.ts`,
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
