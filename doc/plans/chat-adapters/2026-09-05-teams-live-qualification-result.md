# Microsoft Teams live qualification result — 2026-09-05

> **Status: blocked before provider setup; no live Teams scenario executed.** The branch contains substantial Teams hardening and local regression coverage, but none of it is real-provider evidence. This document is a blocker record, not a PASS.

## 2026-09-06 live-attempt checkpoint

Paperclip endpoint `00758007-1c59-45e9-bbef-3dc92c0fb20c` remains `draft` at `provider_setup`. Its connection has zero credential secret references, zero deliveries, zero conversations, and only the endpoint-creation audit row. The public messaging endpoint is reachable at:

`https://kim-chair-figures-typical.trycloudflare.com/api/chat-webhooks/2KMDqYFTcPXmEQVewVqmwMhBOnJyX7jJnzkjWOBNaqw/microsoft-teams`

An unauthenticated probe returned the expected `409 chat_endpoint_runtime_unavailable` while the endpoint is draft. This proves public routing and fail-closed state handling, not Microsoft webhook authentication or a Teams round trip.

The signed-in session is still the personal/free surface at `https://teams.live.com/v2/`. The exact external gates are:

- `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade` — a Microsoft 365 work/school tenant identity allowed to register applications;
- `https://portal.azure.com/#create/Microsoft.AzureBot` — Azure subscription/resource-group permission to create the single-tenant Azure Bot used by the documented manual path; and
- `https://dev.teams.microsoft.com/apps` — custom-app upload permission, or tenant-admin publication/approval.

The live attempt did not progress far enough to observe a provider-side implementation defect. The blocker is the absence of a usable Microsoft 365 organization/tenant and its required provider permissions, not a Paperclip credential or webhook failure. Teams-focused local verification at this checkpoint passed 28 focused server tests, 11 shared credential-validation tests, and 12 fresh-database integration tests; those results remain local evidence only.

## Production-readiness audit — 2026-09-06

The Teams connector is **not yet live-qualified or production-ready**. A code-level stress audit found and fixed additional defects:

- When direct-message reach was disabled, Paperclip filtered the turn before creating a task but had already persisted the full message and external principal. Admission now reads the current DM switch under the endpoint row lock and stores only a payload-free delivery envelope.
- Outbound Teams files were passed to the pinned adapter in personal chats as though this were a native upload. The adapter only created a base64 data-URI activity attachment; it did not implement Microsoft's required file-consent card, accept invoke, provider-issued upload URL, upload, and file-information card sequence. Paperclip now publishes a safe task link for Teams attachments in every conversation surface instead of making that unsupported provider call.
- Reach authorization was checked before the later issue/comment mutation, leaving a stale-admission window. The final task mutation now locks and revalidates the endpoint plus destination in one transaction for every provider. If DM, group, channel, repository, or chat reach was revoked first, Paperclip atomically stores only a payload-free filtered delivery, removes the event's otherwise-orphaned external principal, and creates no task or comment. Deterministic fresh-database races cover all three Teams reach controls and a Slack DM.
- The pinned Teams adapter exposes its public `parseMessage` contract but does not dispatch Bot Framework `messageUpdate` activities. Paperclip now supplements the authenticated webhook path for the documented `messageUpdate` plus `channelData.eventType=editMessage` envelope, preserving the adapter's canonical thread and principal mapping. Concurrent duplicate callbacks collapse to one lifecycle row, while distinct edits with the same provider timestamp remain distinct through a content-bound revision key.
- Opening a Teams question modal previously rechecked authority before resolving the form but not at the final provider-effect boundary. Paperclip now locks and revalidates the endpoint, destination, principal link, and Paperclip membership before opening the modal. A deterministic race proves that demotion from operator to viewer during the callback prevents the modal from opening.
- Telegram and Teams edit lifecycle rows now retain the normalized external actor and perform the same locked principal authorization check before creating a Paperclip system comment. If an identity link or membership is revoked after webhook receipt, the late edit is filtered and its text is redacted from the durable delivery row.

The setup wizard also now provides an exact Entra, Azure Bot, Teams Developer Portal, and Teams custom-upload field map plus a copyable Paperclip-specific manifest block. It explicitly distinguishes that block from a complete app package, so operators are not left to infer where each value belongs. The block omits `webApplicationInfo`: Paperclip does not use Teams single sign-on, and the connector does not require an Entra Application ID URI or delegated Microsoft Graph permissions.

One remaining risk requires real-provider evidence before a production claim: private denial notices use Teams targeted messages. Microsoft moved this feature to general availability on July 30, 2026, although the pinned adapter README still calls it public preview. The local suite proves the adapter call contract, but the denial, removal-from-roster, and bounded-fallback paths still need real-provider validation.

The remaining live matrix is unchanged: installation, real webhook authentication, channel/root/reply ordering, DMs and group chats, reactions, Adaptive Card actions, identity linking, provider revocation, file receipt and publication, reconnect, retry, and cleanup have not run against Microsoft Teams.

## Attempted environment

- Final locally verified source revision: `77ad5383e3a8badf7b1b0933a7e9c66469186d55`
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

On the current verified working tree based on revision `77ad5383e`, the full chat-channel PostgreSQL integration suite passed 177/177 on a fresh migrated database; focused shared tests passed 11/11, focused server tests passed 194/194, focused UI tests passed 41/41, and the deterministic browser suite `tests/e2e/chat-adapters-ui.spec.ts` passed 4/4. Shared, database, server, and UI typechecks all passed. This does not change the Microsoft 365 organization/tenant blocker or provide live Teams evidence.

## Qualification gap

All Teams live scenarios remain unexecuted: credential/setup verification, custom-app installation, team/channel discovery and enablement, channel root/reply boundaries, direct and group chats, identity linking and governance, Adaptive Cards/actions, native DM file handling and non-DM file fallback, post/edit publication behavior, duplicate delivery, permission or app revocation, reconnect/recovery, and cleanup. Deterministic local tests do not replace this missing real-provider evidence.
