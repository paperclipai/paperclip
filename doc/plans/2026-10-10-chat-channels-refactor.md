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
- The module takes only the Teams parser method and the two delivery fields it
  reads, rather than requiring an entire runtime or database row. These are
  type-only changes. It imports sibling implementations directly, never the
  service entry point. Public service exports remain unchanged.
- Initial full-test/typecheck runs were interrupted to rebase and are not
  passes. Rebased integration selection: 48 passed (the other 1,185 cases were
  excluded by the test-name filter). Module-boundary and whitespace checks pass.
  Workspace `pnpm -r typecheck` and `pnpm build`: passed. Full `pnpm test:run`:
  pending.

Reproduce the focused service-path check with the repository-pinned pnpm:

```sh
pnpm exec vitest run server/src/__tests__/chat-channels.integration.test.ts \
  -t 'records message edits and deletes durably|redacts lifecycle edits|Telegram edit|Teams edit, soft-delete|verified Telegram edited_message|verified GitHub comment edit|provider timestamp provenance|Telegram retained zero-message admission|Telegram current rich inbound compatibility|deduplicates Slack file-only revisions|preserves exact Discord source authority'
```

Branch: `codex/chat-channel-provider-messages`. The user authorized publishing
this slice to `paperclipai/paperclip`; subsequent extractions are not part of
this PR.
