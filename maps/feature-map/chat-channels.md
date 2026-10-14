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

Manual: For each supported provider being changed, send a unique message, verify the intended agent/company receives it, and inspect the actual external reply in the original thread. Repeat with an unlinked/unauthorized sender, duplicate inbound delivery, and one supported attachment. Record provider-specific results separately.

For Slack, enable **Require at-mention** and **Allow direct messages**. Send a
plain DM and follow up without a mention: both should reach the agent, with
top-level replies to top-level DMs. Channel messages and thread replies still
require a mention when that setting is enabled. Disable direct messages and
confirm a plain DM is rejected. Use a private channel for threaded conversations.

### `endpoint-management`

Automated: [channel integration](../../server/src/__tests__/chat-channels.integration.test.ts) covers shared endpoint/delivery behavior; live credential repair and provider ownership remain manual checks.

Manual: Inspect the bound agent and identity, recent activity, and delivery failure details. Repair a disposable credential, retry a safe message when offered, and verify exactly one external reply. Disable the endpoint and confirm new traffic is not silently processed.

For GitHub, submit a disposable PR and verify the summary heading uses the bot's
display name and the check remains **Paperclip Review**. For two separate bots on one PR, verify
their App-scoped checks and comments remain independent.

For GitHub publication recovery, interrupt a response after GitHub accepts a
write and verify one summary, finding, and App-scoped check. Retry the same tool
call and verify it returns the saved receipt. Leave a transient failure queued,
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
