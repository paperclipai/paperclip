# Chat channel transport workflows, batch three

Base: `a2ac5c27157ab033a2e0e2731b1b8e35bf20e7b9`. The preceding stack
(#15976, #15979, #15981, #15985, #15987) is merged. The original service is
29,897 lines / 1,170,080 bytes. This batch creates five stacked PRs; merging is
separate work.

| Order / boundary | Destination | Approximate lines moved / net reduction | Inputs and outputs | State and effects | Verification |
| --- | --- | --- | --- | --- | --- |
| 1. Slack session status | `chat-channels/slack/session-status.ts` | 342 / 330 | Endpoint lookup, credential lease, runtime fence, publication run identity, credentials and fetch; return processed count | Claim and settle existing durable status actions. Keep selected revision, attempt ownership and live test barrier. No worker or new state. | Existing public-service status, restart, rate-limit, concurrent selection, stop and Idle cases before/after. |
| 2. Slack accepted-file receipts | `chat-channels/slack/file-receipts.ts` | 900 / 840 | Runtime/credential authorization, publication eligibility and endpoint lookup; record/recover accepted upload receipts | Preserve same-attempt leases, exact receipt identities, publication links and transaction boundaries. Keep generic publication transport shared. | Existing upload recovery, competing retry deadline, revoked reach and no-duplicate-upload cases before/after. |
| 3. Telegram publication drafts | `chat-channels/telegram/publication-drafts.ts` | 394 / 370 | Current runtime and callback fence, source publication authority; reserve draft or handle stopped generation | Preserve runtime map identity, stop scope, draft revision and transactional invalidation. Keep maintenance and shared publication admission in their existing owners. | Existing durable private draft Stop, stale generation and publication recovery cases before/after. |
| 4. Photon incoming events and responses | `chat-channels/imessage-photon/events.ts` | 820 / 780 | Runtime callbacks, principal authorization, question delivery and shared inbound admission | Preserve receiver sequence/lease checks, native interaction binding, transaction ordering and deferred publication. No receiver/startup or credential-inspection ownership move. | Existing Photon public-service integration suite before/after. |
| 5. Teams file-transfer authority | `chat-channels/microsoft-teams/file-transfer-authority.ts` | 940 / 900 | Source proof, runtime/credential fence, principal authorization; return current recipient and immutable file authority | Keep source, recipient, Board intent and byte identity proofs together. Preserve map lifetimes and no-wait locks. Transport, maintenance cooldowns and cleanup stay with the publication worker. | Existing Teams current file authority, consent, composed Board transfer and stale-runtime cases before/after. |

Use named, typed contracts and channel folders. Keep shared message admission,
provider startup/shutdown, generic publication transport and shared authorization
in the service. Do not introduce a mutable context bag or a runtime import back
to the service. Reconsider a candidate if its actual dependency contract proves
too broad.

For each slice, inspect its execution path and callers, run baseline tests, move
mechanically, compare normalized syntax, rerun the same public entry-point tests,
and check server types and module boundaries. Finish CI and current-head review
before opening the next PR. Run broad local gates once at the cumulative handoff.
Record failures and skipped groups accurately; a retry does not erase a failed
run. Fixtures exercise assembled services and persistence, not live providers.

The starting service function is 27,835 lines. Its 212 nested functions span
27,146 lines; 51 wiring/state/API statements span 435 lines. Imports span 423
lines. The largest shared function remains `processMessage` at 2,166 lines.
Remap these measurements after the fifth extraction and stop at five PRs.

## Slice 1: Slack session status

- Service: 29,897 lines / 1,170,080 bytes → 29,553 lines / 1,156,944 bytes.
- Destination: 408 lines / 15,730 bytes. The durable claim, provider status call
  and conditional settlement remain in one function. No state or worker moves.
- All six selected public-service cases passed before and after. They exercise
  restart/rate-limit recovery, stale selection, Stop and publication-driven Idle.
  Server typecheck, module boundaries, whitespace and normalized syntax parity
  passed. The selection hook remains live through an options getter.
- Next: accepted-file receipt recovery. Keep the generic outbound publication
  link writer shared and pass it as a typed callback to the Slack module.

## Slice 2: Slack accepted-file receipts

- Service: 29,553 lines / 1,156,944 bytes → 28,620 lines / 1,122,992 bytes.
- Destination: 1,000 lines / 36,807 bytes. Thirteen declarations move together:
  receipt validation, recording, authorization, recovery, settlement and due-work
  selection. The generic outbound-link writer remains shared.
- All nine selected public-service cases passed before and after. They cover
  accepted upload recovery without reposting, original-attempt ownership,
  competing retry deadlines, revoked reach and selected file publication.
  Server typecheck, module boundaries and syntax parity passed. No state or
  worker is added. Credential lease identity and all transactions are unchanged.
- Next: Telegram private draft reservation and stopped-generation callbacks,
  retaining shared runtime-map identity and source-publication authorization.

## Slice 3: Telegram publication drafts

- Service: 28,620 lines / 1,122,992 bytes → 28,219 lines / 1,108,711 bytes.
- Destination: 461 lines / 16,860 bytes. Both functions preserve their original
  bodies. Runtime maps remain the same per-service objects; the source authority
  callback and credential guard are unchanged.
- All 34 durable private-draft Stop cases passed before and after, including
  restart, bot-global identity allocation, concurrent Stop, transaction failure,
  uncertain final delivery and retained stale callbacks. Server typecheck,
  boundaries, whitespace and normalized syntax parity passed.
- Reassessment: Photon event handling can move without moving its receiver or
  setup inspection. For Teams, extract source/recipient/file authority as a
  coherent transaction-level API; keep transport protocol and scheduler lifetime
  in the service to avoid passing unrelated runtime/worker dependencies.

## Slice 4: Photon events

- Service: 28,219 lines / 1,108,711 bytes → 27,398 lines / 1,079,439 bytes.
- Destination: 903 lines / 33,080 bytes. Provider failure, incoming event and
  native response handling preserve all three function bodies. The receiver,
  lease ownership, checkpoint callbacks and setup inspection remain in the
  service; question delivery uses the original service object.
- All 18 Photon channel integration cases passed before and after. They use the
  assembled Chat SDK runtime, provider fixture streams and a disposable database
  to cover poll/confirmation responses, separate participant drafts, stale
  controls, receiver lease fencing, groups, echoes, restart and continuation.
  Server typecheck, boundaries, whitespace and syntax parity passed.
- Next: Teams file-transfer authority, with no transport or timer ownership move.

## Slice 5: Teams file-transfer authority

- Service: 27,398 lines / 1,079,439 bytes → 26,461 lines / 1,046,711 bytes.
- Destination: 1,041 lines / 36,532 bytes. Eleven declarations move into a
  transaction-level authority factory exposing Board intent staging and fresh
  authority derivation. It takes no database instance and starts no work.
- The original per-service runtime maps and retry-proof callbacks are passed
  after the retry factory initializes. No-wait row locks, identity advisory
  locks, source ordering and byte/recipient proof hashes preserve their bodies.
- All 50 selected Teams public-service cases passed before and after, including
  exact recipient admission, retained source continuation, composed Board file
  transfers, stale runtime callbacks and consent/file receipt recovery. Server
  typecheck, module boundaries, whitespace and normalized syntax parity passed.

## Reassessment after batch three

The service falls from 29,897 lines / 1,170,080 bytes to 26,461 lines /
1,046,711 bytes: 3,436 lines (11.5%) and 123,369 bytes removed. The five new
modules total 3,813 lines / 139,009 bytes. All 117 selected cases passed before
and after their respective extractions.

The service function spans 24,484 lines. Its 191 nested functions span 23,829
lines; 54 state/wiring/API statements span 425 lines. Imports span 412 lines.
The largest remaining functions are `processMessage` (2,166 lines),
`handleAction` (1,074), `configureWithCredentialLease` (868),
`processSelectedPublication` (729), `handleModalSubmit` (708), `handleWebhook`
(685), `processLifecycleDelivery` (657), `applyProviderLifecycleEffect` (593),
and `ingestAttachments` (574).

Future candidates include receipt-reaction recovery, provider-effect dispatch,
attachment ingestion and inbound delivery persistence/drain ownership. Teams
transport protocol and scheduling can be reconsidered after their lifetime
contract is explicit; this batch deliberately moved only authority proofs.
Do not move a large shared admission function wholesale merely to reduce LOC.
Stop this batch at five PRs. Cumulative local gates and current-head CI/review
results are recorded in the final PR; per-slice PRs retain their own evidence.
