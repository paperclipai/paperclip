# Test audit, Round 7 UI — transcript follow-up

This follow-up removes **two duplicate registered invocations, two parser calls, and 15 net test lines (14 from the migrations and one blank-line cleanup)** from `ui/src/components/task-chat/transcript-adapter.test.ts`. It adds no helper and changes zero production lines. Combined with the [first UI batch](2026-10-12-test-audit-r7-ui.md) and [AppDetail migration](2026-10-12-test-audit-r7-ui-appdetail.md), the branch removes **386 net test lines and four registered invocations**. Helper cleanup accounts for 320 lines; the three retirement/migration batches account for 65, with one additional blank-line cleanup. No wall-time or CI-speed claim is made.

The transcript audit base is `51dc1eb69f5c52d6ef0e29cd2e4061da6c88871f`. This file still has its original Round 6 parent bytes at that base. Prior UI tests and reports remain unchanged.

## Exact migrations

| Retired registration | Retained keeper | Exact observations carried |
|---|---|---|
| `marks only the message still open at the tail as streaming` | `tags agent messages streamed inside a live run turn as interstitial` | Original kind-narrowing guard, first message streaming=false, tail message streaming=true. |
| `stamps atMs from the first streamed chunk` | `tags settled-history messages interstitial too, so live and history agree` | Original kind-narrowing guard, first timestamp Date.parse(TS), second timestamp Date.parse("2026-07-31T12:00:05.000Z"). |

Within each pair, the stream array, runId, running state, parser call and message-filter predicate match exactly. The live retired case uses an intermediate items variable; its parser expression and subsequent filter match the keeper's direct chain. Both scopes resolve stream to the same enclosing constant. The settled pair already uses the same direct chain. No hooks, mocks or producer state differ between paired cases. Existing keeper length and interstitial/settled-streaming assertions remain.

Live running=true and settled running=false remain distinct. **`marks no message streaming when the tail is a tool call` remains byte-identical.** Every other case remains byte-identical, including saved plans, final replies, provider activity, native response-wake authority, thinking state, tool identity, usage, grouping and timeline boundaries.

TaskChatThread calls the actual transcript parser and settledRunChildren for its run segments. The parser assigns each message timestamp from its first transcript entry and resets non-tail streaming state after the full input. The owner is `ui/src/components/task-chat/transcript-adapter.ts`. The complete suite remains included in `@paperclipai/ui` / `general-workspaces-a`; no CI routing or skip policy changes.

## Evidence

| Complete transcript file | Registered cases | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 105 | 105 | 0 | 0 |
| Candidate | 103 | 103 | 0 | 0 |

Run from `ui/`: `pnpm exec vitest run src/components/task-chat/transcript-adapter.test.ts`.

The audit checks parser inputs and filter ASTs, inserts the original three statements from each retired body, and compares the entire candidate/original program outside those declared migrations. It also reconstructs candidate text from exactly the two removals and two insertions, requiring byte equality. All other source bytes stay unchanged outside the declared blank-line cleanup before the enclosing describe closes. The initial edit clipped the enclosing suite boundary and failed to parse; the temporary codemod was corrected and the candidate regenerated from pinned source before the accepted run. That attempt supplies no passing evidence.

Both positive keeper controls passed. Both deliberate production regressions failed at the intended migrated assertion:

| Regression | Intended failure |
|---|---|
| Leave completed non-tail messages streaming | Live keeper expected false and received true for messages[0].streaming. |
| Shift parsed message timestamps by one millisecond | Settled keeper expected 1785499200000 and received 1785499200001 for messages[0].atMs. |

Neither control failed on setup, timeout or a different assertion. The production owner was restored byte for byte after each mutation and matched pinned Git bytes. Name-filtered controls select one keeper; unselected cases are not full-suite evidence.

[Transcript controls](2026-10-12-test-audit-r7-ui-transcript-controls.json) retain the exact source hashes, body-audit digest, migration map, complete-file counts, mutation descriptions, intended failures, run/log digests, prior proof hashes and byte-restoration receipts. Temporary raw verifiers/logs are identified by digests but not preserved in full. Across the three separate baseline/candidate packets, all thirteen complete files total 333 baseline cases and 329 candidate cases. After removing one extra blank line, a final complete-file replay passed all 103 cases on the polished source bytes. A delivery-head combined replay remains separate PR evidence.
