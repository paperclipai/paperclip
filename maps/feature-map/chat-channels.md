---
navigation: {"section":"Apps, channels, and extensions","sectionOrder":50,"order":30}
---

# External chat and email

People can talk to an assigned agent through configured external channels, bind their identity, exchange files, and inspect delivery state. Each provider has a different identity, threading, and attachment contract.

Feature ID: `chat-channels`.

Implementation: [endpoint setup](../../ui/src/pages/apps/chat/ChatEndpointSetup.tsx), [endpoint detail](../../ui/src/pages/apps/chat/ChatEndpointDetail.tsx), [email setup](../../ui/src/pages/apps/chat/EmailEndpointSetup.tsx).

Agent access: [companion](../agent-access-map/chat-channels.md).

## Sub-features

- `providers`: `chat-channels/providers` — configure the available Slack, Discord, Microsoft Teams, Telegram, GitHub, AgentMail, and experimental iMessage Photon and Speko paths; availability still depends on gates and provider support.
- `identity`: `chat-channels/identity` — link the external sender to the intended authorized Paperclip identity.
- `conversation`: `chat-channels/conversation` — route inbound messages to the selected agent and send replies to the correct thread.
- `attachments`: `chat-channels/attachments` — transfer supported files with inspectable delivery and failure states.
- `lifecycle`: `chat-channels/lifecycle` — inspect endpoint activity, repair auth, and disable delivery when required.
- `outbound-email`: `chat-channels/outbound-email` — start a task-bound AgentMail conversation, reply to its exact message, and inspect deduplicated publication and provider delivery.

## How to get to it (user POV)

### `external-thread`

Message the configured bot/address from its external provider and follow the corresponding Paperclip conversation/task.

### `endpoint-management`

Delegated setup can save ordinary bot tokens and API keys. Provider verification keys require the addressed human credential-entry step or verified provider provisioning. Generic setup returns the saved handoff without changing those keys, and generic connection updates cannot replace channel credential references. A replacement card waits for an actual protected-value change and restored verification; old health, unchanged entry and unrelated bot-token repair do not complete it. Fresh GitHub handoffs open the import form; configured endpoints retain reconnect. Credential-entry field sets and completion modes stay distinct while matching retries reuse their saved baseline. Complete human replacements can repair disabled, deleted or unreadable old vault values. Saved links name the requested fields and completion mode; configured GitHub forms support targeted replacements while keeping other saved credentials. Provisioned Slack challenge proof survives runtime storage only for the same signing key and callback URL. The actual-auth Slack/GitHub fixtures cover these boundaries, retries, revocation and permitted bot-token repair; live provider repair remains separately qualified.

Open `/apps/chat/:endpointId/settings` and the endpoint’s other available tabs; identity confirmation uses `/chat-identity/confirm`.

For GitHub external contributors, open the connection's Access tab and look up a username. The lookup uses that endpoint's active GitHub App installation with a metadata-only token. Verify that a person or bot resolves to its numeric identity and that unavailable accounts, rate limits, and installation failures show distinct errors. [Lookup regressions](../../server/src/services/chat-github-management.test.ts) use provider fixtures; live installation lookup remains separate evidence.

For delegated Slack test messages and identity invitations, apply a Block or Ask first rule to the calling agent while allowing the endpoint's assigned agent. Verify no message is sent. Exercise caller, target and shared rate limits: one shared quota admits one send and the next distinct request is denied. For a saved GitHub identity handoff on an otherwise healthy endpoint, verify the card stays pending before identity confirmation and after an OAuth callback alone. Confirm the addressed user's identity through their human session, then verify continuation becomes available. Revoked, expired, wrong-user and wrong-installation links must keep the handoff blocked. These cases pass through the assembled API with real key/JWT/session middleware and deterministic providers; live Slack/GitHub consent remains separate evidence.

### `outbound-agentmail`

Use `paperclipai email inboxes --company-id <company-id>`, then `email send --company-id <company-id> --file <new-email.json>` or `email reply --company-id <company-id> --file <reply.json>`. Inspect `email thread <email-task-id> --company-id <company-id>` and `email delivery <publication-id> --company-id <company-id>`. Agent mutations must provide --run-id or the active PAPERCLIP_RUN_ID.

## Driving it with Playwright and provider clients

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a
test provider account/channel with permission to send messages. Gates differ:
AgentMail bypasses the chat-connectors UI gate, GitHub uses
`enableGitHubReviewBots`, and other chat providers use `enableChatConnectors`.
Setup is covered in [connection setup](./connection-setup.md).

### `external-thread`

Automated: [channel integration](../../server/src/__tests__/chat-channels.integration.test.ts) uses provider fixtures; it does not prove a live Slack, Discord, Teams, Telegram, GitHub, email, or Photon delivery.

Monitor continuation regression: [database checks](../../server/src/services/chat-monitor-continuation.test.ts)
verify the exact originating conversation, rejected forged/mismatched receipts,
one working publication, no completion for a yielded run, and saved-response
recovery. In a disposable live thread, request work that needs deferred repository
preparation. Verify a useful continuation explanation, automatic resumption, and
the final result in that same thread. A successful provider turn alone is insufficient.

GitHub review comment regression (2026-10-19): repeated PR review requests reuse
one main App comment, including across restart and reconnect. Test a leading
request for an external bot (`@greptile review`) and verify it creates no wake or
acknowledgement. Stop execution before a milestone is staged, run maintenance,
and verify the existing comment reports the stop; saved requests on a blocked
task show paused state. Preserve newer progress and confirmed or uncertain replies.
Repeat terminal reconciliation with native identity and no legacy wake fields.
Check delayed acknowledgements, check-only assessments followed by formal reviews,
and combined requests with separate pre-upgrade placeholders.

GitHub review attention regression: publish a 3/5 assessment, then wait for the
next provider event. The task stays in review without a completion card or Mine
entry. A later 5/5 review with passing required checks can finish quietly. A real
repository-access request enters Mine until resolved. The native external-chat
database suite checks these states and revoked endpoints using stored provider
receipts; live model adherence remains a separate check.
It also checks saved monitors, disabled repositories, multiple reviewed heads,
read-only finish validation, withdrawal rollback, and separate approval gates.
Repeat the review wait after a tree resume and a same-agent continuation with
no new provider message. Accepted requester lineage and the latest saved review
publication keep the task in review without a self-wake or duplicate publication.
A newer unreviewed head, changed requester/repository, or revoked access cannot
inherit the prior head's passive wait. Omitted/null yielded continuation is filled
from authorized server task context after a current-head review, an accepted tree
resume inheriting it, or a same-head follow-up with this run's processed useful
reply bound to its exact current source. Pending or ambiguous replies and
acknowledgements do not authorize this fallback. A malformed first report can recover by omitting the continuation;
explicit malformed input remains rejected. Revocation between context read,
finish and commit preserves the task without self-waking. Done policy is unchanged.

Manual: For each supported provider being changed, send a unique message, verify the intended agent/company receives it, and inspect the actual external reply in the original thread. Repeat with an unlinked/unauthorized sender, duplicate inbound delivery, and one supported attachment. Record provider-specific results separately.

GitHub review prompt regression: open a PR and push twice. Each task message
contains the event and commit identifiers; configuration comes from the admitted
delivery snapshot and the PR description is fetched when needed. Inspect the
native provider's submitted envelopes: a verified resume sends only the current
batch and any changed configuration, while a fresh session receives full review
instructions and task context. Change configuration between pushes and verify
the queued older request retains its original snapshot. Integration fixtures
cover the database and prompt contracts; they do not prove live provider delivery.

For Slack, enable **Require at-mention** and **Allow direct messages**. Send a
plain DM and follow up without a mention: both should reach the agent, with
top-level replies to top-level DMs. Channel messages and thread replies still
require a mention when that setting is enabled. Disable direct messages and
confirm a plain DM is rejected. Use a private channel for threaded conversations.

For Slack acknowledgement latency, mention the bot with and without an attachment.
Eyes should appear after authorized task/comment persistence, independently of
file preparation, subscription and agent startup. Duplicate delivery must keep
one receipt; the final reply must remove only its source message's eyes. Record
live mention-to-reaction timing separately from the PostgreSQL fixture tests and
the `chat.slack.receipt` transport span described in [Observability](../../doc/observability.md).

During a top-level DM run, verify that the bot adds eyes to the source message
and removes them when the final reply arrives. The pinned Slack SDK encodes a
linear DM with an empty thread timestamp; receipt transport accepts that address
while still validating the channel and the source message timestamp.

For an agent with two linked Slack endpoints, compare assignment preparation and
tool discovery in the run trace. Endpoint checks may overlap in pairs. Confirm
that both permitted tool sets remain available, then revoke one linked identity
and confirm that the next preparation excludes it. The
[database regression](../../server/src/__tests__/slack-tool-preparation.test.ts)
uses real PostgreSQL with one connection and controlled credential resolution;
it does not prove live provider latency or an end-to-end response target.

Catalog discovery rechecks live authority and current credentials without
computing the unused compatibility fingerprint. Assignment snapshots and
governed calls retain full revision resolution. The same regression verifies
identical catalog membership, absence of digest SQL during discovery, and
revocation on the next preparation. A faster component is not proof of a faster
Slack reaction or final reply; measure those separately on the deployed revision.

For GitHub and Slack tool continuity, start a task from the channel, then admit
a later monitor or retry run for the same task. Check that the later run can
discover and call its channel tools without a new inbound message. For GitHub,
also continue from a board message by the same accepted requester and complete
the review in the original conversation, including when the original source is
recorded only in legacy wake metadata. Revoke the linked identity and check
that the next call fails. Repeat the boundary checks with another task, agent,
company, and requester. The channel and provenance fixtures above cover these
contracts with synthetic providers; record a live journey separately.
For a long-lived task, repeat more than 100 continuations and check that tool
access remains available. Fail a later GitHub run after a final answer and
check that the earlier answer remains intact.
After publishing a PR assessment, deliver an ordinary no-new-work author reply.
Hold native presentation after execution succeeds. Verify maintenance makes no
provider write while undecided, including repeated passes and the explicit
fallback path. Commit either a passive wait, genuine missing response, or failure
and verify that the same request settles once with the corresponding behavior.
Verify the actual shared summary stays unchanged during queued/running
acknowledgements and after the committed passive wait, including maintenance,
restart and cleanup. Confirm the per-request acknowledgement is terminal and a
second maintenance pass makes no write. Then request a real same-head and
changed-head assessment and confirm canonical publication can replace it.
Real-PostgreSQL provider fixtures cover this producer and missing/error/unknown
write safety; record hosted destination acceptance separately.

### `endpoint-management`

Automated: [channel integration](../../server/src/__tests__/chat-channels.integration.test.ts) covers shared endpoint/delivery behavior; live credential repair and provider ownership remain manual checks.

Manual: Inspect the bound agent and identity, recent activity, and delivery failure details. Repair a disposable credential, retry a safe message when offered, and verify exactly one external reply. Disable the endpoint and confirm new traffic is not silently processed.

For publication failures, reject one operation with a provider 403 and verify
that its failure remains visible while unrelated tools and publications continue.
Repeat with an authentication failure: the endpoint must require attention and
stop provider traffic, while the connection's enabled setting remains unchanged.
Reconcile persistent receivers and restart the service; authentication failures
must remain stopped while transient disconnections can still recover.
The PostgreSQL suite uses controlled provider failures for these cases; live
provider credential repair remains a separate acceptance check.

GitHub connections in attention or revoked state show a repair notice above the
settings. **Reconnect GitHub → Reconnect saved App** checks the same App with
stored credentials and repairs delivery. **Replace App credentials** is the
fallback, with the saved App ID, a link to its GitHub settings, and PEM upload or
paste instructions. The production management Storybook's **04 Recovery** group
covers these views, pending/failure/success, mobile, and light theme with simulated
provider responses. Verify actual credential validity and restored delivery
separately against GitHub; a Storybook success does not establish live recovery.

For an agent-requested GitHub credential handoff, open the saved link as the
addressed human and verify it asks for exactly the requested fields and all/any
completion mode. A fresh App opens import; a configured App opens replacement
through reconnect and retains credentials omitted from the request. Interrupt
the response after a successful rotation, reload, and verify the saved rotation
resumes without replacing the key again. Wrong-user access, unchanged credentials
and missing verification must not complete the request. After OAuth, confirm the
addressed user's exact endpoint identity before expecting task continuation.

For GitHub, submit a disposable PR and verify the summary heading uses the bot's
display name and the check remains **Paperclip Review**. For two separate bots on one PR, verify
their App-scoped checks and comments remain independent.
For a newly configured bot, verify `submit_review` describes body-only summary
and rationale fields. Submit a summary with repeated current-bot or legacy
score headings, including an old score; verify publication keeps one heading
with the structured score, preserves findings and rationale, and retains the
original assessment. The PostgreSQL-backed publication fixture covers this with
simulated GitHub responses; live model compliance remains separate evidence.

For GitHub publication recovery, interrupt a response after GitHub accepts a
write and verify one summary, finding, and App-scoped check. Retry the same tool
call and verify it returns the saved receipt. Include text longer than 500
characters and coverage with more than 50 entries. Change only the text suffix
or final coverage entry and verify rejection without another write. Remove the
completed durable publication and verify that a retry cannot dispatch a new write.
Also interrupt metadata reads before publication staging, repeat the exact
`begin_review` and `submit_review` requests, and verify typed results and one
assessment publication. Let the original metadata read finish alongside its
retry and verify that both converge on the same publication. Changed requests
and revoked access must still stop preflight recovery.
Leave a transient failure queued,
restart the instance, and verify publication resumes at its saved deadline
without another inbound message. Revoked access and permanent rejections must
stop retries. These recipes are separate from live provider proof.

Configure optional project and workspace defaults at the connection and destination
levels. Start a new conversation and inspect its task workspace. Verify that
inheritance, an explicit selection, and clearing a default remain distinct.
Changing defaults must not move an existing conversation or interrupt its run.

For experimental Speko, enable chat connectors, choose an agent during setup,
and verify the provider credentials. On an assigned task, use **Talk to agent**
to open browser voice controls. Check microphone denial, mute, end/restart,
navigation during a call, and access revocation. Inspect transcripts and the
connection's call history. Callback preferences, incoming phone configuration,
and incoming-call approval are separate settings and authorization journeys.
The [voice components](../../ui/src/components/voice/TaskVoiceLauncher.tsx)
and fixture tests cover presentation; they do not establish live answer retrieval
or telephone playback. Those provider outcomes remain explicit release gates.

### `outbound-agentmail`

Automated: [Email channel integration](../../server/src/__tests__/email-channels.integration.test.ts) uses controlled providers to test durable child tasks/intents, deduplication, reply binding, attachments, delivery, revocation, budgets, run authority, and company boundaries. No dedicated end-to-end CLI email test was identified; these fixtures do not establish actual recipient delivery.

Manual: Use a disposable parent task, authorized AgentMail inbox, and recipient you own. Put endpointId, a stable UUID idempotencyKey, text, parentIssueId, to, and subject in the new-message JSON; supply eligible attachmentIds only if needed. Send, inspect the child conversation/publication, and verify actual received mail. Repeat the identical request/key and confirm one child and provider send; changed content with that key must conflict. Reply with endpointId, conversationId, exact replyToMessageId, text, and a fresh stable idempotencyKey; inspect the actual recipients and received reply. Replies must reject caller-supplied recipient/subject/parent overrides. Test wrong inbox/task/company/run, a canceled task, revoked access/credentials, and an inaccessible attachment. Inspect uncertain provider outcomes before using the administrative resolution path.

Sources: [Email CLI](../../cli/src/commands/client/email.ts), [request schema](../../packages/shared/src/validators/email.ts), [email routes](../../server/src/routes/email.ts), and [email authority/publication](../../server/src/services/email-channels.ts).

## Gotchas

- New outbound email requires a parent task. A reply binds to its stored conversation/message and cannot replace recipients or subject; a queued 202 is not a delivered message.

- Visibility flags do not pause existing delivery. Disable the disposable
  endpoint itself to test stopped traffic.

- One provider’s passing fixture does not qualify another provider or live delivery.
- An accepted send request does not prove the recipient received the message or file.
- Use [steering](./steering.md) and [questions](./questions-and-approvals.md) for their channel-specific interaction checks.

### Storybook verification

#### `attachments`

Capability ID: `chat-channels/attachments`.

Scope: ui
Storybook: Mount TaskChatBubble attachments and ChatEndpointDetail provider-specific consent/upload/delivery failure and unknown-outcome states. Local email attachment dialog remains a prototype.
Production: Transfer a disposable supported file through each affected provider; verify recipient delivery, read scope, duplicate/replay handling and failure/unknown state without treating notification as file-upload proof.
Sources: Source: [TaskChatBubble.tsx](../../ui/src/components/task-chat/TaskChatBubble.tsx), [ChatEndpointDetail.tsx](../../ui/src/pages/apps/chat/ChatEndpointDetail.tsx), [chatEndpoints.ts](../../ui/src/api/chatEndpoints.ts), [chat-channels.ts](../../server/src/routes/chat-channels.ts). Tests: [TaskChatBubble.test.tsx](../../ui/src/components/task-chat/TaskChatBubble.test.tsx), [task-chat-attachments.test.ts](../../ui/src/components/task-chat/task-chat-attachments.test.ts), [chat-channels.integration.test.ts](../../server/src/__tests__/chat-channels.integration.test.ts), [issue-attachment-routes.test.ts](../../server/src/__tests__/issue-attachment-routes.test.ts)

### Documentation scope: Chat and email channel setup

Shared recipes name provider checks; each provider transport/thread/identity/file-size/type combination needs separate live evidence and deeper instructions.

Saved-input Retry regression: fail a disposable GitHub turn, change the
configured instruction skill, and send a new authorized request while an agent
budget gate blocks admission. Clear that gate and use the task thread's ordinary
**Retry** control. Verify the new saved message and its admitted skill snapshot
reach one run, rather than replaying the previous failed request. Preserve both
original receipts. With a committed failed native result, continuation requires
verified controller and environment cleanup; an unknown executor remains held.
After successful admission, reload and verify that the prior skipped receipt does
not strand a later real provider reply or tree resume. Provider fixtures support
this behavior; live fixed-source runtime and destination proof remain separate.

Also defer Retry behind cleanup, queue an independent board message, then
complete cleanup. Verify one run receives the exact GitHub batch and the board
message enters its own turn. For an older mixed batch rejected before provider
startup, ordinary task Retry must recover only certified undelivered receipts.
Changed input, active ownership, allocations and prior delivery must keep the
refusal effective. Check the restoration audit and unchanged failed-run history.

### `delegated-configuration`

Endpoint activity hides private-task events while retaining a next-page cursor across private-only windows, so older readable history stays reachable. Actual-JWT fixtures verify this separately from live provider delivery.

See the canonical [delegated configuration guidance and acceptance evidence](connection-setup.md#delegated-configuration).

GitHub finding category contract (2026-10-31): manual and automatic review
instructions list the repository policy categories. `begin_review` returns the
assessment snapshot's `findingCategories`; later settings do not change that
snapshot. Submit an unknown category and confirm rejection before publication,
then submit a listed custom category and inspect the saved assessment and
processed publication. The channel integration fixture covers real PostgreSQL
and the service path with simulated GitHub HTTP; live model behavior remains
unverified.
