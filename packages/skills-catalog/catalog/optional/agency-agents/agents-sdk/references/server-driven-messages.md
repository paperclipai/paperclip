# Server-Driven Messages

Read [Autonomous responses](https://developers.cloudflare.com/agents/communication-channels/chat/autonomous-responses/) for scheduled, webhook, email, and agent-triggered turns, message schemas, response hooks, and client streaming status.

Choose `saveMessages` to persist messages and request a model response, or `persistMessages` to update context without starting a turn. Use `onChatResponse` to react to turns regardless of their trigger. For webhooks that need a quick acknowledgement, consult the documented `submitMessages` path.

Before reading conversation history or calling `saveMessages` from non-chat entry points, await `waitUntilStable` and handle a timeout without proceeding as if the conversation were stable. Prefer the functional `saveMessages` form when calls can queue, so each update uses the latest history.
