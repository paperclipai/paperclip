# Microsoft Teams live qualification result — 2026-09-05

> **Status: blocked before provider setup; no live Teams scenario executed.** The branch contains substantial Teams hardening and local regression coverage, but none of it is real-provider evidence. This document is a blocker record, not a PASS.

## 2026-09-06 live-attempt checkpoint

Paperclip endpoint `00758007-1c59-45e9-bbef-3dc92c0fb20c` remains `draft` at `provider_setup`. Its connection has zero credential secret references, zero deliveries, zero conversations, and only the endpoint-creation audit row. The public messaging endpoint is reachable at:

`https://richard-expansion-females-bedford.trycloudflare.com/api/chat-webhooks/2KMDqYFTcPXmEQVewVqmwMhBOnJyX7jJnzkjWOBNaqw/microsoft-teams`

An unauthenticated probe returned the expected `409 chat_endpoint_runtime_unavailable` while the endpoint is draft. This proves public routing and fail-closed state handling, not Microsoft webhook authentication or a Teams round trip.

The signed-in session is still the personal/free surface at `https://teams.live.com/v2/`. The exact external gates are:

- `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade` — a Microsoft 365 work/school tenant identity allowed to register applications;
- `https://portal.azure.com/#create/Microsoft.AzureBot` — Azure subscription/resource-group permission to create the single-tenant Azure Bot used by the documented manual path; and
- `https://dev.teams.microsoft.com/apps` — custom-app upload permission, or tenant-admin publication/approval.

No implementation defect was observed in this blocked attempt. The blocker is the absence of a usable Microsoft 365 organization/tenant and its required provider permissions, not a Paperclip credential or webhook failure. Teams-focused local verification at this checkpoint passed 28 focused server tests, 11 shared credential-validation tests, and 12 fresh-database integration tests; those results remain local evidence only.

## Attempted environment

- Final locally verified source revision: `6f13ec09e95717c4b3b248d1d8cb9ca4e55754ab`
- Teams FIFO, endpoint-generation fencing, per-thread and per-user service-URL egress, adapter compatibility, reach defaults, and pre-transport safety fixes are committed in the branch.
- Provider session: Microsoft Teams personal/free at `teams.live.com`

No Microsoft client secret, access token, cookie, password, or one-time identity-link URL is recorded here.

## Blocker

The signed-in personal/free Teams account cannot access the organization-backed Teams Developer Portal, Entra registration, Azure Bot, and custom-app installation path required for the customer-owned bot. Navigating into that path reaches Microsoft's work-or-school organization gate. Live setup requires a Microsoft 365 work or school tenant with permission to create a single-tenant Entra application and Azure Bot, configure a custom Teams app, and install it or obtain tenant-administrator approval.

The run stopped before credential entry and before any provider webhook activity. A Microsoft 365 tenant login, and possibly tenant administrator approval, is required before live qualification can begin.

## Code qualification progress

The committed code serializes Teams turns in FIFO order and stores the Bot Framework `serviceUrl` per external thread and user for deferred thread replies and direct-message creation. Every outbound operation uses an asynchronous context-local API client, so simultaneous conversations in different Microsoft regions cannot overwrite one another's route. The shipped setup is qualified only for Microsoft 365 commercial cloud tenants. Its defensive trust boundary accepts Microsoft-owned Connector host families or an exact explicitly configured API URL because signed activity carries the reply route; accepting a host is not sovereign-cloud qualification. Loopback, attacker-suffix, nonstandard-port, and wrong-path destinations fail before transport, and those local rejections are classified as definite failures rather than ambiguous `delivery_unknown` sends.

Additional hardening from this cycle is also local-only:

- Teams group chat reach now defaults to off. The change is delivered through forward-only migration `0244_tan_chat.sql`, so existing databases upgrade without rewriting migration history; group discovery no longer silently enables group reach.
- A reply that arrives before its root remains retryable and ordered instead of creating a detached task or being acknowledged as complete too early.
- Native file ingestion is limited to personal chats, where the bot file contract applies. Team channels and group chats retain bounded attachment metadata and provider links without invoking unsupported credentialed downloads.
- Runtime callbacks are fenced to the endpoint credential generation, and pause, reconnect, rotation, and removal share a mutation lease so an old callback cannot mutate task state after endpoint state changes.
- Stale or unauthorized Teams actions fail safely with a targeted payload-free notice; provider-retry duplicates cannot execute the action repeatedly.
- The UI does not present misleading DM/group rows as independently discovered destinations when Teams reach is controlled by the connection-level access switches.

The pinned adapter contract now fails initialization if the internal API client or any wrapped outbound method drifts. Published-adapter tests directly exercise post, edit, reaction add/remove, delete, and concurrent cross-region `openDM`; a fresh-database integration test covers the terminal pre-transport failure and the Teams delivery reorder window. Focused runtime/classifier tests passed 54/54, the published-adapter/classifier subset passed 27/27, the fresh PostgreSQL Teams subset passed 9/9, and server typecheck passed. These results address ordering, regional isolation, SSRF exposure, and error classification in code, but remain local evidence until exercised through a real Microsoft 365 tenant.

On revision `6f13ec09e`, the full chat-channel PostgreSQL integration suite passed 138/138 on fresh migrated database `chat_adapters_test_173`; focused chat server tests passed 115/115, focused UI tests passed 38/38, OpenAPI passed 6/6, server typecheck passed, and the deterministic browser suite passed 4/4. Shared/database/UI typechecks, token gates, and the full workspace build had already passed on the immediate parent before the final server-only race fix. This does not change the Microsoft 365 organization/tenant blocker or provide live Teams evidence.

## Qualification gap

All Teams live scenarios remain unexecuted: credential/setup verification, custom-app installation, team/channel discovery and enablement, channel root/reply boundaries, direct and group chats, identity linking and governance, Adaptive Cards/actions, native DM file handling and non-DM file fallback, post/edit publication behavior, duplicate delivery, permission or app revocation, reconnect/recovery, and cleanup. Deterministic local tests do not replace this missing real-provider evidence.
