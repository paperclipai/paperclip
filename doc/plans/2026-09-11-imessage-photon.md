# iMessage Photon channel

Date: 2026-09-11. Status: approved for implementation; qualification tracked below.
Base: origin/master, 1c4bcff2b. Branch: codex/imessage-photon.

## Approved scope update — 2026-09-12

The operator approved Pro-compatible shared DMs with groups disabled. This
supersedes the dedicated-only exclusions below for DMs. Shared setup uses the
project token and fixed `imessage.spectrum.photon.codes:443` gateway, reserves the
project across non-archived endpoints, and derives a project-scoped conversation
and checkpoint namespace. It never claims ownership of a pool phone number.
Sender enrollment in Photon and identity linking in Paperclip are separate gates.
Dedicated lines retain the original behavior. Allocation changes require a new
channel. Native groups remain unavailable on shared channels at every boundary.

The real qualification uses an isolated clean database, a test-only agent, the
operator's enrolled Messages identity, and the existing Apps wizard. Photon offers
a terminal development provider and control-plane CLI; neither substitutes for
an iMessage Cloud round trip. Record actual live results separately from fixtures.

## Outcome and defaults

Add **iMessage Photon** (`imessage-photon`) behind the existing experimental
chat-connectors UI gate, in Apps and each agent's Channels panel. Use Photon
Cloud and one dedicated number per channel/agent. People initiate DMs and
explicitly enabled groups; every authorized group message can start or continue
work without a mention. Require linked Paperclip people by default. Unlinked
senders require an explicit operator opt-in. Never infer authority from a phone
number, email address, display name, or group membership, or merge those identities.

Messages remain bound to tasks through the existing chat subsystem: company
scope, vaulted credentials, durable admission, endpoint/conversation leases,
ordered wakeups, external principals, task generations, publication outbox,
attachment provenance, budgets, pauses, native and legacy execution. Keep
`connectionPurpose: channel` and `chat_sdk` transport. Chat-approved external
responses publish automatically; AgentMail's explicit email-send policy stays
specific to email. Do not add a second agent loop, Spectrum application runtime,
generic Photon MCP connection, or arbitrary send API.

Excluded initially: local Mac access, shared-pool numbers, SMS/RCS, unsolicited
new conversations, agent-created groups, calls, location, stickers, backgrounds,
custom iMessage apps, and native Live Photo reassembly. Hiding experimental UI
must not stop existing channels; Pause/Disconnect control runtime behavior.

## Provider and credentials

Implement an in-repo Chat SDK adapter using `@photon-ai/advanced-imessage@2.1.0`
with explicit gRPC dependencies. Reference upstream Photon adapter behavior but
persist correlation by IDs, not in-memory poll titles. Separate Cloud client,
receiver/recovery, adapter, attachment, and interaction helpers.

Accept project ID and write-only project secret. Inspect Photon using Basic
project authentication and its project/token endpoints. Return only project
identity, allocation eligibility, line IDs, and numbers to managers through
`POST /api/chat-endpoints/:endpointId/photon/inspect`; never return minted tokens.
Verify dedicated allocation from actual token data. Auto-select a sole eligible
number; require explicit selection for multiple numbers. Reject shared allocation.
Vault the secret; store validated project/selected-line config separately. Mint
line tokens in memory, renew before expiry, bind every RPC and stream to the
selected instance, and recheck number/ownership on renewal. Missing, changed,
or ineligible line enters Attention. Rotation preserves project and number;
a new identity needs a new endpoint. Retire old ownership before replacement.

Extend provider contracts across db/shared/server/UI and generate a forward
migration. Reserve the Photon number across companies for every non-archived
endpoint, including paused/revoked endpoints. Persist checkpoints, typed poll
bindings, per-person drafts, immutable send identities, upload receipts, and
side effects in company/endpoint-scoped state/action stores.

## Setup and management

Three steps: choose an invokable agent; connect and inspect Photon credentials
and select a dedicated line; test from Apple Messages. Link Photon dashboard and
dedicated-line documentation. Defaults: DMs on, unlinked people off, individual
groups disabled. Show actionable missing/shared/duplicate/invalid credential
errors. Show the copyable number and discovered sender, support the existing
identity-link confirmation. Only a linked sender's fresh message that creates a
task and receives a successful publication completes setup. Credential verification
alone does not. Optional group test: add number in Messages, discover group,
enable it in Paperclip, send a fresh authorized request.

Management shows agent/project/number, health, receive/send timestamps, discovered
groups and participants/availability/enablement, linked people/revocation,
delivery retry/unknown outcomes, pause/resume/reconnect/disconnect. Explain that
group replies are visible to all members while sender authorization is separate.
Use existing design tokens/components, official branding with provenance, themes,
keyboard/loading/error/narrow-screen states, task links and copyable number;
never invent individual iMessage web permalinks.

## Conversations and authorization

DMs/groups are linear: one active task generation per endpoint/chat. Fresh
authorized input creates work when none is active; follow-ups append and use
existing ordered queue/coalescing. Per the September 12 product correction,
terminal tasks reopen on the next message in the same conversation. Only an
explicit `/new` or `/close` followed by a fresh message creates a new generation.
Inbound comments appear live with “Sent from iMessage” attribution. Support `/status`.
Preserve native reply GUID/part as context; it does not create a separate task.
Chronology guards protect later generations from stale controls. Rename/avatar
changes affect presentation only. Bot removal marks a group unavailable and
blocks sends. Ignore outgoing echoes and system/read/typing/reaction/metadata
events as work triggers. Linked identity/current membership and resource/endpoint
policy are rechecked at admission and interaction resolution.

## Questions and approvals

Support ordinary ask_user_questions and eligible request_confirmation. Single
select 2–10 canonical options uses native polls with persistent returned poll
GUID/option-ID bindings, plus text fallback. Never match by title/label. Questions
appear sequentially with a short reference. Accept exact native prompt replies
or `/answer <reference> <value>`; support free text, custom/numbered multi-select,
optional skipping, and canonical validation including numerical constraints.
Per-person drafts cannot mix; multiple-question sets require `/submit <reference>`.
A single question resolves on first valid authorized submission.

Confirmations show the approved external summary and Accept/Reject, collecting a
required rejection reason via correlated text. Revalidate target revision,
audience, linked user permission, generation and endpoint before using canonical
interaction/continuation services. Arbitrary yes/tapbacks are never approvals.
Credential disclosure, connection authorization, governed tool execution, and
review kinds requiring the full Board surface get an explanation/task link.

Handle recognized responses before normal comment ingestion. Duplicate votes,
missing actors, stale/expired links, changed membership, late poll changes and
participant-added options cannot resolve. Unvotes only clear unsubmitted drafts.
Exactly one canonical resolution and continuation; terminal acknowledgement;
old polls inert. Test provider poll creation before local binding crash and votes
before binding finalization without title matching or duplicate resolution.

## Photos, attachments, and publication

Support text and policy-allowed images/documents/audio/video. Persist a closed
line/chat/message/attachment/optional-part locator before fetching. Authenticate
over selected line and verify attachment ownership via message/chat. Bound
metadata, bytes, time and decoded dimensions. Keep Paperclip's configured limits,
not Photon's larger allowance. Retry attachmentNotReady before agent wake,
without duplicate comments. Preserve attachment-only input, captions, multiple
images and multipart order; surface unavailable/rejected files in the task.

Add HEIC/HEIF to default policy while honoring overrides. Preserve originals and
produce a labeled JPEG derivative for preview/agent image input through bounded
`heif2jpeg@0.1.6`; verify packaged platform binaries. Preserve provenance. Keep
Live Photo still/allowed companion video as related files.

Outbound files need existing company/task/agent/originating-run authorization.
Send bytes, never private storage URLs. Immutable outbox carries stable
clientMessageId for each text part/file/poll/correction; retry same key/payload.
Persist upload receipt before send. Split plain readable text at paragraph
boundaries near 4,000 Unicode-safe characters, preserving order/URLs/code.
Final messages plus typing, not token bubbles. Use native reply references.
Edits within provider limits; expired edits fail visibly or require staged correction.
Internal reasoning/commentary/tools/credentials remain internal.

Transmission timeout is delivery_unknown. Reconcile exact receipts, never
similar text; operator resolution handles unresolved results, never silently
mint a new idempotency key. Do not assume undocumented provider key retention.

## Receiving and recovery

Elect one receiver per endpoint with lease renewal/generation fencing. Subscribe
to live message/chat/group/poll events concurrently with catch-up. Dedupe by line
instance/event sequence and message GUID. Advance checkpoint only after all
preceding events are durably admitted/classified, including irrelevant events.
Bound intake; execution follows durable admission. Rebuild chats, attachments,
and poll mappings after restart without SDK caches.

Initial activation cutoff suppresses historical work while allowing metadata and
checkpoint establishment. Pause stops execution/publication and retains accepted
work; record pause boundaries to suppress intentional pause interval input.
Outages catch up eligible missed events. Missing/reset/gapped history enters
Attention, never silently skips. Distinguish auth/line/quota/network/preparation/
ambiguous send failures, bound retries, expose recovery actions. Disconnect stops
streams, invalidates interaction authority, archives endpoint/removes owned secret
bindings; never deletes Photon project/number/subscription/history. No webhook.
Diagnostics stay local; any Telemetry change needs separate strict review.

## Delivery and verification

1. Worktree/isolation, source versions, shared contracts/state, generated migration.
2. Cloud inspection, line auth/renewal, adapter lifecycle, synthetic gRPC fixtures.
3. Durable ingress, authorization/linking/resources/generations/queue/publication.
4. Attachments/recovery/HEIC, polls/text drafts/confirmations/continuation.
5. Catalog/setup/management, browser checks, docs, live qualification, PR preparation.

Keep logical commits; existing Slack/Discord/AgentMail and native/legacy paths
remain functional. Acceptance covers invalid/missing/shared/multiple/duplicate
lines; interrupted setup; unlinked/revoked/viewer/wrong-company/wrong-line inputs;
disabled/removed groups; concurrent/ordered bursts and generation commands;
restart/duplicate/out-of-order/takeover/renewal/catch-up/pause; stable multipart
keys, Unicode, rate limits, successful-send crash/unknown/partial uploads/edit
expiry; image-only/multiple/HEIC/corrupt/oversize/delayed files; exact poll IDs,
free/custom/multiselect/partial/submitted/invalid drafts; accept/reject/reason,
stale target, Board race and one continuation; accessible responsive UI.

Run targeted suites, migration/package checks, affected chat-adapters browser
suite, then `pnpm check:token-gates`, `pnpm -r typecheck`, `pnpm test:run`,
`pnpm build`. Leave lockfile to the repository bot. Update channel setup,
troubleshooting/feature boundaries and relevant spec addendum; regenerate catalog.
Prepare every PR-template section and explicitly report unavailable credentials,
failed checks and unqualified behavior.

Live proof requires a dedicated test line and known participants: linked DM and
agent reply; enabled group with two linked participants/attribution; unlinked
denial; both-direction photos including real iPhone HEIC; poll/text continuation;
rejection reason; restart retaining DMs/groups/questions; pause/resume/reconnect/
remove; terminal conversations idle until fresh input. Record tested commit,
versions, redacted IDs, observable outcomes and limitations. Mocks are not live
qualification. Full DM/group/media/interaction/restart/auth loop is required.

## Primary sources (verified during planning 2026-09-11)

- https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing
- https://github.com/photon-hq/advanced-imessage-ts
- https://github.com/photon-hq/spectrum-ts/blob/main/packages/core/src/utils/cloud.ts
- https://photon.codes/docs/advanced-kits/imessage/polls
- https://photon.codes/docs/advanced-kits/imessage/attachments
- https://photon.codes/docs/advanced-kits/imessage/events
- https://photon.codes/docs/advanced-kits/imessage/error-handling
- https://photon.codes/docs/utilities/heif2jpeg

Inspected versions: advanced-imessage 2.1.0, Photon chat adapter 3.2.0,
Spectrum core/iMessage 12.8.0, heif2jpeg 0.1.6. Cloud Basic auth project endpoint:
`https://spectrum.photon.codes/projects/{projectId}/`; token exchange:
`POST .../imessage/tokens`; dedicated response has `auth` and `numbers` maps keyed
by instance ID and `expiresIn`. Line gRPC host: `{instanceId}.imsg.photon.codes:443`.

## Implementation evidence

Implemented in the fresh `codex/imessage-photon` worktree. Provider contracts,
forward migration, Cloud inspection, leased recovery, source-bound media,
immutable publication, native interaction continuation, and the setup/management
UI are present. The channel remains experimental.

The [channel runbook](../connections/IMESSAGE-PHOTON.md) documents operation and
supported boundaries. The [verification record](../connections/IMESSAGE-PHOTON-VERIFICATION.md)
records automated results and the still-unrun live qualification matrix. No live
Photon credentials or approved test participants were available. Implementation
must not be represented as live-provider qualification.
