# External chat and email conversations

People can talk to an assigned agent through configured external channels, bind their identity, exchange files, and inspect delivery state. Each provider has a different identity, threading, and attachment contract.

Implementation: [endpoint setup](../ui/src/pages/apps/chat/ChatEndpointSetup.tsx), [endpoint detail](../ui/src/pages/apps/chat/ChatEndpointDetail.tsx), [email setup](../ui/src/pages/apps/chat/EmailEndpointSetup.tsx).

## Sub-features

- `providers`: configure the available Slack, Discord, Microsoft Teams, Telegram, GitHub, AgentMail, and experimental iMessage Photon paths; availability still depends on gates and provider support.
- `identity`: link the external sender to the intended authorized Paperclip identity.
- `conversation`: route inbound messages to the selected agent and send replies to the correct thread.
- `attachments`: transfer supported files with inspectable delivery and failure states.
- `lifecycle`: inspect endpoint activity, repair auth, and disable delivery when required.

## How to get to it (user POV)

### `external-thread`

Message the configured bot/address from its external provider and follow the corresponding Paperclip conversation/task.

### `endpoint-management`

Open `/apps/chat/:endpointId/settings` and the endpoint’s other available tabs; identity confirmation uses `/chat-identity/confirm`.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Enable chat connectors and use a test provider account/channel with permission to send messages. Setup is covered in [connection setup](./connection-setup.md).

### `external-thread`

Automated: [channel integration](../server/src/__tests__/chat-channels.integration.test.ts) uses provider fixtures; it does not prove a live Slack, Discord, Teams, Telegram, GitHub, email, or Photon delivery.

Manual: For each supported provider being changed, send a unique message, verify the intended agent/company receives it, and inspect the actual external reply in the original thread. Repeat with an unlinked/unauthorized sender, duplicate inbound delivery, and one supported attachment. Record provider-specific results separately.

### `endpoint-management`

Automated: [channel integration](../server/src/__tests__/chat-channels.integration.test.ts) covers shared endpoint/delivery behavior; live credential repair and provider ownership remain manual checks.

Manual: Inspect the bound agent and identity, recent activity, and delivery failure details. Repair a disposable credential, retry a safe message when offered, and verify exactly one external reply. Disable the endpoint and confirm new traffic is not silently processed.

## Gotchas

- One provider’s passing fixture does not qualify another provider or live delivery.
- An accepted send request does not prove the recipient received the message or file.
- Use [steering](./steering.md) and [questions](./questions-and-approvals.md) for their channel-specific interaction checks.
