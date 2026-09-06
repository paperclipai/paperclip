# Microsoft Teams live qualification result — 2026-09-05

> **Status: blocked before provider setup; no live Teams scenario executed.** FIFO, region-safe egress, and pre-transport safety fixes exist in the current working tree, but they are not real-provider evidence. This is a blocker record, not qualification evidence and not a PASS.

## Attempted environment

- Paperclip committed base reported by the live process: `4b868d3cbb7b16f784bded5da3183534881a9c32`
- Additional local state: uncommitted Teams FIFO, per-thread and per-user service-URL egress, adapter-compatibility, and pre-transport safety fixes on top of that base
- Provider session: Microsoft Teams personal/free at `teams.live.com`

No Microsoft client secret, access token, cookie, password, or one-time identity-link URL is recorded here.

## Blocker

The signed-in personal/free Teams account cannot access the organization-backed Teams Developer Portal, Entra registration, Azure Bot, and custom-app installation path required for the customer-owned bot. Live setup requires a Microsoft 365 work or school organization with permission to create a single-tenant Entra application and Azure Bot, configure a custom Teams app, and install or obtain administrator approval for that app in the test tenant.

The run stopped before credential entry and before any provider webhook activity. A Microsoft 365 tenant login, and possibly tenant administrator approval, is required before live qualification can begin.

## Code qualification progress

The current working tree serializes Teams turns in FIFO order and stores the Bot Framework `serviceUrl` per external thread and user for deferred thread replies and direct-message creation. Every outbound operation uses an asynchronous context-local API client, so simultaneous conversations in different Microsoft regions cannot overwrite one another's route. The trust boundary accepts only Microsoft's documented public, GCC, GCC High, and DoD Connector hosts or an exact explicitly configured API URL; loopback, attacker-suffix, nonstandard-port, and wrong-path destinations fail before transport. Those local rejections are classified as definite failures rather than ambiguous `delivery_unknown` sends.

The pinned adapter contract now fails initialization if the internal API client or any wrapped outbound method drifts. Published-adapter tests directly exercise post, edit, reaction add/remove, delete, and concurrent cross-region `openDM`; a fresh-database integration test covers the terminal pre-transport failure and the Teams delivery reorder window. Focused runtime/classifier tests passed 54/54, the published-adapter/classifier subset passed 27/27, the fresh PostgreSQL Teams subset passed 9/9, and server typecheck passed. These results address ordering, regional isolation, SSRF exposure, and error classification in code, but remain local evidence until exercised through a real Microsoft 365 tenant.

The full chat-channel PostgreSQL integration suite also passed 111/111 on fresh database `chat_adapters_test_153`. This does not change the Microsoft 365 organization/tenant blocker or provide live Teams evidence.

## Qualification gap

All Teams live scenarios remain unexecuted: credential/setup verification, custom-app installation, team/channel discovery and enablement, channel root/reply boundaries, direct and group chats, identity linking and governance, Adaptive Cards/actions, native DM file handling and non-DM file fallback, post/edit publication behavior, duplicate delivery, permission or app revocation, reconnect/recovery, and cleanup. Deterministic local tests do not replace this missing real-provider evidence.
