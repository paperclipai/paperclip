---
navigation: {"section":"Apps, channels, and extensions","sectionOrder":50,"order":30}
---

# External chat and email

People can talk to an assigned agent through configured external channels, bind their identity, exchange files, and inspect delivery state. Each provider has a different identity, threading, and attachment contract.

Implementation: [endpoint setup](../../ui/src/pages/apps/chat/ChatEndpointSetup.tsx), [endpoint detail](../../ui/src/pages/apps/chat/ChatEndpointDetail.tsx), [email setup](../../ui/src/pages/apps/chat/EmailEndpointSetup.tsx).

Agent access: [companion](../agent-access-map/chat-channels.md).

## Sub-features

- `providers`: configure the available Slack, Discord, Microsoft Teams, Telegram, GitHub, AgentMail, and experimental iMessage Photon and Speko paths; availability still depends on gates and provider support.
- `identity`: link the external sender to the intended authorized Paperclip identity.
- `conversation`: route inbound messages to the selected agent and send replies to the correct thread.
- `attachments`: transfer supported files with inspectable delivery and failure states.
- `lifecycle`: inspect endpoint activity, repair auth, and disable delivery when required.

## How to get to it (user POV)

### `external-thread`

Message the configured bot/address from its external provider and follow the corresponding Paperclip conversation/task.

### `endpoint-management`

Open `/apps/chat/:endpointId/settings` and the endpoint’s other available tabs; identity confirmation uses `/chat-identity/confirm`.

## Driving it with Playwright and provider clients

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a
test provider account/channel with permission to send messages. Gates differ:
AgentMail bypasses the chat-connectors UI gate, GitHub uses
`enableGitHubReviewBots`, and other chat providers use `enableChatConnectors`.
Setup is covered in [connection setup](./connection-setup.md).

### `external-thread`

Automated: [channel integration](../../server/src/__tests__/chat-channels.integration.test.ts) uses provider fixtures; it does not prove a live Slack, Discord, Teams, Telegram, GitHub, email, or Photon delivery.

GitHub review comment regression (2026-10-19): repeated PR review requests reuse
one main App comment, including across restart and reconnect. Test a leading
request for an external bot (`@greptile review`) and verify it creates no wake or
acknowledgement. Stop execution before a milestone is staged, run maintenance,
and verify the existing comment reports the stop; saved requests on a blocked
task show paused state. Preserve newer progress and confirmed or uncertain replies.
Repeat terminal reconciliation with native identity and no legacy wake fields.
Check delayed acknowledgements, check-only assessments followed by formal reviews,
and combined requests with separate pre-upgrade placeholders.

Manual: For each supported provider being changed, send a unique message, verify the intended agent/company receives it, and inspect the actual external reply in the original thread. Repeat with an unlinked/unauthorized sender, duplicate inbound delivery, and one supported attachment. Record provider-specific results separately.

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

For GitHub, submit a disposable PR and verify the summary heading uses the bot's
display name and the check remains **Paperclip Review**. For two separate bots on one PR, verify
their App-scoped checks and comments remain independent.

For GitHub publication recovery, interrupt a response after GitHub accepts a
write and verify one summary, finding, and App-scoped check. Retry the same tool
call and verify it returns the saved receipt. Include text longer than 500
characters and coverage with more than 50 entries. Change only the text suffix
or final coverage entry and verify rejection without another write. Remove the
durable publication and verify that a retry cannot dispatch a new write.
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

## Gotchas

- Visibility flags do not pause existing delivery. Disable the disposable
  endpoint itself to test stopped traffic.

- One provider’s passing fixture does not qualify another provider or live delivery.
- An accepted send request does not prove the recipient received the message or file.
- Use [steering](./steering.md) and [questions](./questions-and-approvals.md) for their channel-specific interaction checks.

### Storybook verification

#### `attachments`

Scope: ui
Storybook: Mount TaskChatBubble attachments and ChatEndpointDetail provider-specific consent/upload/delivery failure and unknown-outcome states. Local email attachment dialog remains a prototype.
Production: Transfer a disposable supported file through each affected provider; verify recipient delivery, read scope, duplicate/replay handling and failure/unknown state without treating notification as file-upload proof.
Sources: Source: [TaskChatBubble.tsx](../../ui/src/components/task-chat/TaskChatBubble.tsx), [ChatEndpointDetail.tsx](../../ui/src/pages/apps/chat/ChatEndpointDetail.tsx), [chatEndpoints.ts](../../ui/src/api/chatEndpoints.ts), [chat-channels.ts](../../server/src/routes/chat-channels.ts). Tests: [TaskChatBubble.test.tsx](../../ui/src/components/task-chat/TaskChatBubble.test.tsx), [task-chat-attachments.test.ts](../../ui/src/components/task-chat/task-chat-attachments.test.ts), [chat-channels.integration.test.ts](../../server/src/__tests__/chat-channels.integration.test.ts), [issue-attachment-routes.test.ts](../../server/src/__tests__/issue-attachment-routes.test.ts)

### Documentation scope: Chat and email channel setup

Shared recipes name provider checks; each provider transport/thread/identity/file-size/type combination needs separate live evidence and deeper instructions.
