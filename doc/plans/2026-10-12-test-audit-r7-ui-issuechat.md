# Test audit, Round 7 UI — Issue thread initial scroll follow-up

This separate packet removes **1 registered executions, 1 root renders and 50 net test lines** from `ui/src/components/IssueChatThread.test.tsx`. It adds no helper and changes no production lines. Audit base: `e3effbb9e5c66b838f67fd487987c8bf1007e413`. Prior committed evidence remains byte-identical. Render/execution savings are per complete-suite invocation; no measured runtime or CI-speed claim is made.

## Exact retirement map

| Retired registration | Keeper | Observations retained |
|---|---|---|
| `does not auto-scroll to the latest comment on initial load` | `can keep the page at the top on initial load while preserving manual jump-to-latest` | expect(elementScrollToMock).not.toHaveBeenCalled();; expect(scrollIntoViewMock).not.toHaveBeenCalled(); |

IssueChatThread.tsx keeps default initial viewport stable through the autoScrollToLatestOnInitialLoad opt-out, while an explicit Jump to latest action owns manual scrolling. The retired complete initial test is an exact AST subset of the keeper: all twenty setup/initial-judgment statements and all four cleanup statements match. Both use the exact same long-thread comments/runs/events/maps, fake timers, real scroll host, scrollTo mock, scrollIntoView prototype override and 500 ms timer advance. The keeper remains byte-identical, including both no-scroll guards before clicking. Hash routing, explicit auto-scroll and user-interruption cases remain byte-identical.

The AST verifier checks exact setup, shared enclosing hooks and matched cleanup where present, reconstructs candidate text solely from the declared registrations/assertion migrations, and requires exact byte equality plus full-program AST equality outside those edits. No fixture, helper, provider, action order, wait, assertion strength, timer or teardown changes. The IssueChatThread keeper is an existing complete subset proof; InlineEditor’s identical not-null guard is retained once. Every other case stays byte-identical. Default CI includes this file in `@paperclipai/ui` under `general-workspaces-a`, once across the two file shards; workflow/config unchanged.

## Complete owner-file results

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 100 | 100 | 0 | 0 |
| Candidate | 99 | 99 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/components/IssueChatThread.test.tsx`.

All 1 isolated positive controls passed. All 1 deliberate behavior regressions failed at their intended retained/migrated assertion, rather than setup, timeout or a different guard:

| Regression | Intended guard |
|---|---|
| initial-auto-scroll | `.not.toHaveBeenCalled();` |

Exactly one production owner was temporarily changed per control. Every owner was restored byte for byte after each mutation and matched pinned Git bytes. Filtered controls select one keeper; unselected tests do not count as full-suite evidence. [Controls JSON](2026-10-12-test-audit-r7-ui-issuechat-controls.json) records exact owner/source hashes, migration/input proof, complete-file run/log digests, mutation bodies, intended assertion failures and restoration receipts. Temporary raw verifiers and logs are identified by digests rather than committed in full.

The earlier broad `pnpm test:run` was intentionally stopped without completion and is not claimed as passed. Separate packet results are focused proof, not a completed combined delivery-head replay or pending full CI. No push, rebase, PR or merge is included here.
