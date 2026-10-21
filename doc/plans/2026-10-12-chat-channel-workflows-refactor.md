# Chat channel workflow refactor, batch two

Base: `37913e4907324838ae2c8c94dc8155002b6d4223` (fresh master after the previous stack merged). The previous five PRs
(#15823, #15834, #15836, #15844, #15845) are merged. The service remains
34,603 lines. This batch creates five dependent PRs; merging is separate work.

| Order / responsibility | Destination | Approximate lines moved | Contract and ownership | Verification |
| --- | --- | --- | --- | --- |
| 1. Telegram maintenance and Stop subscription repair | `chat-channels/telegram/maintenance.ts` | 850 | Endpoint lookup, credential lease, credential resolution, runtime fence, live webhook URL, fetch. Own the per-service subscription scan cursor. Preserve claim/confirmation/settlement ordering. | Existing maintenance, rotation, lost-lease, subscription recovery and durable draft Stop integration cases before/after. |
| 2. Slack session stopping | `chat-channels/slack/session-stop.ts` | 750 | Stage and consume durable stop receipts; call shared principal authorization and task-control publication. Preserve captured target, event chronology and transaction locks. | Existing Slack stop, stale-session, authorization and failure-recovery cases before/after. |
| 3. GitHub durable webhook ingress and recovery | `chat-channels/github/webhook-ingress.ts` | 1,400 | Persist verified ingress, replay through the shared webhook entry point, recover provider failures. Keep persistence lease, live shutdown check and current endpoint/credential fences. | Existing signed webhook, restart/replay, recovery and stale-source integration cases before/after. |
| 4. Slack task-start admission | `chat-channels/slack/task-start.ts` | 920 | Recover task starter receipt, revalidate principal/resource/runtime and admit via the shared message path. Preserve lease ownership, synthetic message identity and claim barrier. | Existing slash-task concurrency, partial-post and recovery cases before/after. |
| 5. Discord native commands | `chat-channels/discord/commands.ts` | 550 | Reconcile command registration and admit native controls; shared service retains gateway ownership and authorization. Read gateway ownership live. | Existing command registration, stale runtime, gateway ownership and native command cases before/after. |

Keep message admission, shared control authority, provider runtime startup,
publication transport and service shutdown together. Each factory receives named,
typed dependencies. Do not copy mutable maps or snapshot live values. Shared
runtime record types may move to a type-only sibling module; do not introduce a
runtime import back to the original service.

For each slice: baseline existing public-service tests, mechanical extraction,
syntax/body parity, same tests afterward, server typecheck and module boundaries,
then PR checks and current-head review. Run broad local gates once at final
handoff. Record failures honestly; a retry does not erase the original failure.

## Slice 1: Telegram maintenance

- Service: 34,603 lines / 1,337,182 bytes → 33,718 lines / 1,306,801 bytes.
- `telegram/maintenance.ts`: 931 lines / 32,792 bytes; type-only shared runtime
  records: 38 lines / 1,200 bytes.
- Twelve moved declarations and six shared types preserve token-level syntax;
  all remaining service statements are unchanged. The module owns the existing
  scan cursor and creates no timers or background work. Its live callbacks retain
  credential-lease checks and runtime fencing around every provider mutation.
- The same 41 existing Telegram public-service cases passed before and after.
  Server typecheck, module boundaries and whitespace checks passed. Full local
  repository gates are deferred to the cumulative handoff; remote CI/review will
  be recorded in this slice's PR.
- Reassessment: keep Telegram draft Stop admission and publication transport in
  the orchestrator. Slack durable session stopping remains the next cohesive cut.

## Slice 2: Slack session stopping

- Service: 33,718 lines / 1,306,801 bytes → 32,928 lines / 1,279,554 bytes.
- `slack/session-stop.ts`: 858 lines / 30,166 bytes.
- All six moved declarations and all remaining service statements preserve
  token-level syntax. A getter retains the original live heartbeat property
  access. Shared principal authorization and publication staging stay in the
  caller; the entire captured-target claim and settlement transactions move.
- Both existing public-service scenarios passed before and after. They cover
  exact-run cancellation, retry/deduplication, guest denial, delayed events,
  queued wakeups, a wakeup promoted after Stop, and cancellation losing to run
  completion. Server typecheck passes. This factory owns no mutable state.
- Reassessment: GitHub ingress/recovery has a coherent durable inbox and replay
  contract; preserve its shutdown getter and persistence compare-and-set lease.

## Slice 3: GitHub webhook ingress and recovery

- Service: 32,928 lines / 1,279,554 bytes → 31,438 lines / 1,225,374 bytes.
- `github/webhook-ingress.ts`: 1,579 lines / 58,233 bytes.
- All 26 moved declarations and remaining statements preserve syntax after the
  explicit shutdown getter substitution. The replay barrier remains a live
  getter. Persistence and credential leases remain the same service instances.
- The same 84 existing public-service cases passed before and after, including
  authentication before retention, disabled-repository filtering, restart,
  recovery epochs, concurrent scans, ambiguous redelivery, operator retries,
  canonical-source changes and stale-runtime replay. Server typecheck passes.
- Reassessment: Slack task starter confirmation, recovery and failure settlement
  form one boundary. Keep normal message admission shared and pass its exact
  existing call contract; do not duplicate provider-visible posts during recovery.

## Slice 4: Slack task starts

- Service: 31,438 lines / 1,225,374 bytes → 30,449 lines / 1,190,643 bytes.
- `slack/task-start.ts`: 1,075 lines / 39,262 bytes.
- Nine moved declarations and all remaining statements preserve syntax. The
  existing positional message-admission contract is unchanged. The claim barrier
  remains live through a getter; no worker or mutable per-service state moves.
- The same 25 public-service cases passed before and after, covering slash-task
  admission, provider-confirmed recovery without reposting, reclaimed admission,
  stale credential ownership, ambiguous sends and explicit operator retries.
  Server typecheck passes.
- Reassessment: Discord command registration and native control admission can
  share a channel module. Expose only a live lease-key/token lookup; retain the
  gateway ownership map, renewal, partial acquisition and shutdown in the service.

## Slice 5: Discord commands

- Service: 30,449 lines / 1,190,643 bytes → 29,897 lines / 1,170,080 bytes.
- `discord/commands.ts`: 639 lines / 25,036 bytes.
- Both moved function bodies and all remaining statements preserve syntax after
  replacing the map read with a live lease-key/token callback. Gateway map,
  renewal, runtime identity, partial startup and shutdown ownership stay shared.
- The same 53 registration and native-command integration cases passed before
  and after. They cover registration failure, stale/runtime/gateway authority,
  command receipts, exact target replay and current principal/resource access.
  Server typecheck passes. Network work remains outside command transactions.

## Reassessment after batch two

The service falls from 34,603 lines / 1,337,182 bytes to 29,897 lines /
1,170,080 bytes: 4,706 lines and 167,102 bytes removed (13.6% of source lines).
The five provider modules total 5,082 lines, plus 38 shared type lines.

The service function itself spans 27,835 lines. Its 212 nested functions account
for 27,146 lines; 51 state/wiring/registration/public API statements account for
435 lines. Imports account for 423 lines. This batch reduces provider workflow
mixing; it does not resolve the large shared admission functions.

The largest remaining functions are `processMessage` (2,166 lines),
`handleAction` (1,074), `configureWithCredentialLease` (868),
`processSelectedPublication` (729), `handleModalSubmit` (708), `handleWebhook`
(685), `processLifecycleDelivery` (657), and `applyProviderLifecycleEffect` (593).
Future candidates include Teams file-transfer authority/protocol and shared
inbound persistence/drain ownership. Preserve the shared transaction and live
message contracts before attempting those cuts. Stop this batch at five PRs.

Cumulative verification: `pnpm -r typecheck` and `pnpm build` passed. Full local
test suite results and current-head CI/review are recorded in the final PR.
