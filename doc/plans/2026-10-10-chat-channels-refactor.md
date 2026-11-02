# Chat channel service extraction sequence

## Scope and finish line

Apply the refactor-large-file workflow to `server/src/services/chat-channels.ts`.
Map five responsibilities, then extract and verify one at a time. This slice
extracts provider message normalization without changing provider behavior,
public service exports, database contracts, authentication, or worker ownership.
Subsequent slices require reassessment against the preceding result. No merge or
deployment is part of this slice.

## Baseline

- Base: `1100682261` on a clean, detached task worktree.
- File: 39,132 lines / 1,502,701 bytes; imports occupy 421 lines.
- `chatChannelService`: 36,152 lines, including nested functions and wiring.
  This is not a measurement of orchestration alone. The first slice removes
  top-level normalization; it does not simplify that closure yet.
- Largest nested functions: `processMessage` (2,164 lines), `handleAction`
  (1,074), `applyProviderLifecycleEffect` (895), `configureWithCredentialLease`
  (868), `processSelectedPublication` (728), `handleModalSubmit` (708),
  `handleWebhook` (684), `failedChatRetrySource` (677), and
  `processLifecycleDelivery` (657).
- Existing siblings already own SDK runtimes/state, provider inventory reads,
  resource lifecycle parsing, GitHub app management, registration, publication
  projection/streaming, Teams transfers, Telegram media, and interaction forms.
  Extend those boundaries where appropriate instead of duplicating them.
- Callers include application assembly, chat routes, issue/agent routes, and
  existing unit/integration tests. Keep their imports and service API stable.

## Ranked extraction candidates

Estimates are source lines moved / net reduction after wiring. Later estimates
are provisional: explicit dependency contracts must precede each extraction.
New paths below are relative to `server/src/services/`.

| Rank / responsibility | Destination | Approx. move / net | Inputs and outputs | State and effects owned | Risk and verification |
| --- | --- | --- | --- | --- | --- |
| 1. Provider message normalization | `chat-channels/provider-messages.ts` | 540 / 520 | Provider payload, author, Request, Teams parser, or retained delivery → actor, lifecycle event, message ID, revision digest, timestamp | No mutable service state or DB writes; consumes the supplied GitHub Request body | Preserve exact revision hashes, limits, native IDs, malformed-input handling, and raw clock provenance. Existing public service integration tests cover all four providers. |
| 2. Resource inventory reconciliation and availability | `chat-channels/resource-reconciliation.ts`, alongside `chat-provider-inventory.ts` and `chat-provider-lifecycle.ts` | 1,300–1,500 / 1,200–1,400 | Endpoint, inventory/lifecycle effect, credential lease, DB and explicit runtime callbacks → reconciled resources and availability | Company-scoped resource/conversation transactions; GitHub stable repository identity and provider-order checks | Keep advisory locks, lease checks and the complete availability transaction together. Verify repository rename, removal/reinstall, resource auditing, Telegram migration and stale callbacks. |
| 3. Identity linking | `chat-channels/identity-links.ts` | 430–600 / 390–550 | DB, endpoint lookup, live public URL getter, principal, token, authenticated user → link preview/confirmation/revocation | Token hashes/expiry, membership checks, join requests and transactional audit records | No cached authority or URL snapshot. Preserve endpoint/company binding, replay behavior and revoked/conflicting links; run identity route and DB integration tests. |
| 4. Publication replacement and supersession | `chat-channels/publication-replacement.ts` (the existing reconciliation module owns wake signals, a separate responsibility) | 1,000–1,150 / 950–1,100 | DB, publication, current endpoint/conversation/run → replacement candidate or suppression reason | Scoped reads and existing issue/run authorization snapshots; no transport or queue ownership | Preserve exact outbound link ownership, interaction precedence, terminal failure replacement, and issue→run lock order. Run publication reconciliation, progress and integration fixtures. |
| 5. Failed chat run retry coordination | `chat-channels/failed-run-retry.ts` | 1,600–1,900 / 1,400–1,700 | DB, source/action IDs, explicit admission/heartbeat/publication hooks → authorized retry, claim and completion | Per-service in-flight retry promises and authority registration/cleanup, persisted source evidence | Higher risk: preserve single retry ownership, no replay of provider calls, live source revalidation and shutdown ordering. Run reconstructed-service, edited-source, revocation and concurrent retry integration fixtures. |

Start with candidate 1: it establishes a domain folder and removes an independent
responsibility without introducing a mutable context object. It is deliberately
smaller than the later stateful slices. Resource lifecycle effects remain in the
existing parser; message edits/deletes are a different normalization contract.

Do not move runtime leases, webhook authentication, conversation admission,
delivery transactions, transport attempts, or shutdown piecemeal. The service
must continue to show who admits work and who releases resources. Candidate 2
needs a narrow callback contract; candidate 5 must preserve the same service
lifetime for registration and in-flight promises. Candidates are sequential,
not independent concurrent changes to this file.

## Provider folder convention (2026-10-11)

Provider-specific code belongs under `chat-channels/<provider>/`, using the
existing provider identifiers. The normalization extraction now lives in
`telegram/messages.ts`, `slack/messages.ts`, `discord/messages.ts`,
`microsoft-teams/messages.ts` and `github/messages.ts`. Shared actor normalization,
actor data and the inbound text limit live in `message-lifecycle.ts`. The service
imports the provider modules directly. Future extractions should follow this
layout; move older flat provider modules when their responsibility is touched.

All 22 declarations retain their exact bodies. The service changes imports only.
The same 48 provider integration cases passed before and after this move, and
server typecheck and module boundaries pass. The historical extraction sizes
below predate this folder change: direct imports add 10 service lines / 281 bytes.
The six message modules now total 566 lines / 19,534 bytes, including imports.

## Verification and progress

Before the production move, run existing service integration cases for message
lifecycle, file revision identity, provider timestamps, Telegram zero-message
handling and rich content. These use disposable PostgreSQL and fixture provider
transports, not live third-party execution. Keep those tests at their existing
public entry points. Add characterization only if inspection exposes a gap.

After the move, repeat that selection, compare extracted declarations and the
remaining file mechanically against the base, then run the relevant adjacent
suites and repository typecheck, full test and build gates. Record blockers and
unverified checks explicitly; do not treat skipped integration tests as passes.

- Dependencies: installed with the repository-pinned pnpm 9.15.4. The host's
  newer pnpm ignored legacy patch settings, so verification uses the pinned tool.
- Original-base integration selection: 48 passed before and 48 passed after
  extraction. Existing tests cover the boundary; no new test-only exports or
  mock-only characterization were needed.
- Rebased onto `b1ebe3de3c` after master added fast-response acknowledgements
  and action queue notifications. The only conflict was the import block;
  retain upstream imports and add the normalization import. All 21 extracted
  declarations match the new base, ignoring added exports and two narrowed
  input types. Every remaining non-import declaration, including the entire
  service body, matches the new base exactly.
- Current size: 39,155 lines / 1,509,090 bytes before extraction; 38,633 lines /
  1,491,422 bytes after. Net reduction: 522 lines / 17,668 bytes. Destination:
  552 lines / 19,028 bytes, including imports and the shared text-limit constant.
- On the rebased source, the service spans 36,175 lines: 287 direct nested
  function declarations occupy 35,324 lines; 51 other statements occupy 504
  lines of state, wiring, registration callbacks and the public API. The rest
  is comments, whitespace and delimiters. Those counts remain unchanged by
  this slice; they make the remaining orchestration work explicit.
- The module takes only the Teams parser method and the two delivery fields it
  reads, rather than requiring an entire runtime or database row. These are
  type-only changes. It imports sibling implementations directly, never the
  service entry point. Public service exports remain unchanged.
- Initial full-test/typecheck runs were interrupted to rebase and are not
  passes. Rebased integration selection: 48 passed (the other 1,185 cases were
  excluded by the test-name filter). Module-boundary and whitespace checks pass.
  Workspace `pnpm -r typecheck` and `pnpm build`: passed. The full suite and
  remote checks were still running at PR opening; final results belong in the
  PR's Verification section below.

Reproduce the focused service-path check with the repository-pinned pnpm:

```sh
pnpm exec vitest run server/src/__tests__/chat-channels.integration.test.ts \
  -t 'records message edits and deletes durably|redacts lifecycle edits|Telegram edit|Teams edit, soft-delete|verified Telegram edited_message|verified GitHub comment edit|provider timestamp provenance|Telegram retained zero-message admission|Telegram current rich inbound compatibility|deduplicates Slack file-only revisions|preserves exact Discord source authority'
```

Branch: `codex/chat-channel-provider-messages`. The user authorized publishing
this slice to `paperclipai/paperclip`; subsequent extractions are not part of
this PR.

Review and final verification: [PR #15823](https://github.com/paperclipai/paperclip/pull/15823).

## Authorized stacked continuation

The user requested at least five stacked PRs on 2026-10-10. Continue the four
remaining boundaries in order, with each branch based on its predecessor. Keep
merge and deployment outside this series. Each PR carries its own current-head
verification and review results; do not transfer a prior head's pass to a new one.

### Slice 2: resource reconciliation and availability

The lifecycle handler also owns credential replacement, delivery claims and
runtime shutdown. Keep those responsibilities in the service. Extract the full
non-GitHub availability transaction, inventory reconciliation, repository rename
handling, provider ordering, resource listing and audited selection together.
The factory takes the database, endpoint lookup, existing credential lease
function, generation reader and error text limit. It creates no worker or cache.

- Source: 38,633 lines / 1,491,422 bytes → 37,720 lines / 1,454,762 bytes.
- Destination: 947 lines / 39,584 bytes in `resource-reconciliation.ts`.
- Mechanical comparison: 14 declarations and the complete availability
  transaction are unchanged; all other function bodies remain unchanged.
- Baseline: all three complete chat CI shards passed on predecessor `cbba30a526`.
- Local baseline and after selections could not start PostgreSQL and skipped
  the suite. They are not passes. Server typecheck and module boundaries pass.
- Require complete chat CI on this slice before starting the next extraction.

### 2026-10-12 channel-folder reassessment: slice 2

PR #15823 was merged at the user's request. Rebase this slice onto the merged
master, then retain the remaining four PRs for review in dependency order.

- GitHub payload parsing, repository coordinate repair, webhook recovery,
  repository pagination and bulk-selection entry points live in
  `chat-channels/github/resources.ts`.
- Telegram migration preparation and conversation migration live in
  `telegram/resources.ts`. They receive the existing transaction and timestamp;
  the shared coordinator still upserts the destination between those steps.
- Slack fallback labels, Teams conversation IDs and Photon participant parsing
  live in each provider's `resources.ts`.
- Shared inventory replacement, availability settlement and audited selection
  retain their transaction and credential-lease ownership. Small provider
  dispatch predicates remain next to the shared operation they select.
- All eight moved declarations and three transaction blocks retain their logic.
  The GitHub provider guard stays in the caller. No factory starts background work.
- Existing public-service tests: 15 resource cases and the Telegram migration
  case passed before; the same 16 cases passed after. The name filter excludes
  unrelated cases. No live third-party provider calls were made.

### Slice 3: identity linking

Extract six identity-link operations into `identity-links.ts`. Keep the live
public URL getter. Fetch confirmation runtime authority through a callback that
reads the existing service map after awaiting runtime creation. Keep the same
transaction locks, token consumption, membership checks and post-commit notice.

- Source: 37,720 lines / 1,454,762 bytes → 37,295 lines / 1,436,867 bytes.
- Destination: 459 lines / 19,970 bytes.
- Baseline: complete CI and 5/5 review on slice 2 (`c01f34ad2b`, PR #15834).
- Server typecheck, module boundaries and mechanical comparison pass. The only
  body substitution moves the runtime lookup behind the supplied live callback.
  All remaining statements are unchanged. Local PostgreSQL remains unavailable;
  record this slice's complete CI and review in its PR before continuing.

### 2026-10-12 channel-folder reassessment: slice 3

Keep identity-token consumption, principal scope, membership checks, link locks
and revocation in shared `identity-links.ts`. Move Slack receipt queries,
self-service access requests and confirmation-notice staging into
`slack/identity-links.ts`. GitHub identity fields live in `github/identity-links.ts`.
The shared confirmation transaction still stages the Slack notice before commit
and schedules it only after commit. The live runtime and public URL callbacks
remain live. The Slack factory holds no cache or worker state.

Four existing public-service cases passed before and after, including the full
Slack connect journey: discovery, preview, outsider access request, duplicate
request, member confirmation, provider notice, consumed-token rejection and
endpoint isolation. Receipt queries, access-request transaction and notice
payload retain their statements with explicit parameter substitutions.

### Slice 4: publication replacement and supersession

Move 13 functions into `publication-replacement.ts`. The module selects the exact
provider message a publication can replace and suppresses obsolete progress. It
uses the database, endpoint lookup and retained-source authorization callback.
Transport execution, publication claims and receipt reactions remain coordinated
by the service. No state or registration moves in this slice.

- Source: 37,295 lines / 1,436,867 bytes → 36,393 lines / 1,400,636 bytes.
- Destination: 963 lines / 38,724 bytes.
- Baseline: all 51 checks and 5/5 review passed on slice 3 (`581dd656c1`, #15836).
- All 13 bodies and every remaining statement match the predecessor exactly.
  Server typecheck, module boundaries and whitespace checks pass.
- Existing CI fixtures cover exact outbound ownership, interleaved control
  messages, consumed progress, interactions, committed failure replacement and
  issue-to-run lock order. Local database capacity remains blocked.

### 2026-10-12 channel-folder reassessment: slice 4

Publication replacement is shared ownership logic: exact outbound links, run and
wake scope, consumed progress messages, interaction prompts and retained-source
authorization. Keep those queries together. The close-message provider allowlist
is shared dispatch metadata, not four separate implementations.

Move the iMessage queued/working suppression policy and explanation to
`imessage-photon/publications.ts`. Preserve when endpoint lookup occurs and leave
all ownership queries unchanged. Baseline: 49 public-service publication and
Photon cases passed, including close-owned progress, interleaved Slack control,
Telegram confirmation and FIFO replacement. The same 49 cases passed after. Server typecheck and module boundaries pass.


### Slice 5: failed chat run retry coordination

Extract source validation, native failure evidence, retry preparation, claims,
wake authorization and retry notices into `failed-run-retry.ts`. Keep the
in-flight promise map, notice cursor, error class and two authority registrations
inside the factory so each service retains its own lifetime. Keep the live
shutdown and heartbeat callbacks. The service still owns cleanup order and waits
for the module's pending retries before unregistering authorities.

- Source: 36,393 lines / 1,400,636 bytes → 34,606 lines / 1,336,443 bytes.
  Net reduction: 1,787 lines / 64,193 bytes.
- Destination: 1,936 lines / 68,329 bytes.
- Baseline: all 52 checks and 5/5 review passed on slice 4 (`166ea04ac6`, #15844).
- Added three tests through the existing public service before the move. All
  three passed before and after: duplicate calls share a promise, shutdown
  during a pending read prevents a new claim and waits for completion, rejected
  work permits a later attempt, and old-service cleanup preserves replacement
  authority. These tests use controlled reads and do not require PostgreSQL.
- All 21 moved declarations and every remaining statement match the predecessor
  after restoring the documented live callbacks and pending-task accessor.
  Server typecheck, module boundaries and whitespace checks pass.
- Existing CI database fixtures cover corrected/edited sources, lifecycle epochs,
  native recovery evidence, recreated services and concurrent retries. Local
  full database execution remains blocked by the host's shared-memory limit.
  Current-head full CI, broad local gates and review results belong in the PR.

## Reassessment after five slices

The service falls from 39,155 lines / 1,509,090 bytes at the rebased baseline to
34,606 lines / 1,336,443 bytes: 4,549 lines and 172,647 bytes removed (11.6% of
source lines). The five modules total 4,857 lines / 185,635 bytes, including their
imports and typed boundaries. This is useful separation, not completion of the
larger decomposition.

The service function still spans 32,254 lines. Its 244 direct nested functions
occupy 31,525 lines; 48 other statements occupy 435 lines of state, wiring,
registration and public API. The remaining lines are whitespace, comments and
syntax. The largest functions are `processMessage` (2,166), `handleAction`
(1,074), `configureWithCredentialLease` (868), `processSelectedPublication` (729),
`handleModalSubmit` (708), `handleWebhook` (685), `processLifecycleDelivery` (657)
and `applyProviderLifecycleEffect` (593).

The best next planning candidate is inbound message admission and persistence,
starting from `processMessage` and its conversation/drain ownership. Define the
transaction, live-message retention and scheduling contracts before moving it;
do not move that entire function and claim its complexity is resolved. Action
resolution and endpoint configuration are later candidates. Keep runtime lease
acquisition, partial startup and shutdown together until their ownership contract
is explicit. This batch ends with five stacked PRs; merging is separate work.

### 2026-10-12 channel-folder reassessment: slice 5

Keep retry admission, complete source-batch authorization, ancestor checks,
in-flight deduplication, authority registration and shutdown coordination shared.
References to native runner providers describe execution recovery, not chat
channel implementations, and remain with that shared proof.

Move the exact Teams file-transfer continuation proof into
`microsoft-teams/file-transfer-source.ts`. It receives the caller's transaction,
explicit source identifiers and original denial factory; it returns only the
verified publication ID. The shared caller still validates the committed result,
all original inputs and other uncertain publications. All provider proof guards,
join predicates, row locks and attempt checks retain their statements.

Baseline: 59 retry cases plus six negative Teams authority cases passed. These
include service lifetime checks and transfer ambiguity without duplicate uploads.
The same 65 cases passed after. Server typecheck and module boundaries pass.
The remaining retry coordinator
has 1,825 lines; the Teams proof module has 149 lines.
