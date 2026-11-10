# Test audit, Round 7 UI — Inline editor accessibility follow-up

This separate packet removes **1 registered executions, 1 root renders and 15 net test lines** from `ui/src/components/InlineEditor.test.tsx`. It adds no helper and changes no production lines. Audit base: `e3effbb9e5c66b838f67fd487987c8bf1007e413`. Prior committed evidence remains byte-identical. Render/execution savings are per complete-suite invocation; no measured runtime or CI-speed claim is made.

## Exact retirement map

| Retired registration | Keeper | Observations retained |
|---|---|---|
| `marks multiline preview textboxes as multiline` | `enters multiline edit mode from the keyboard preview surface` | expect(preview?.getAttribute("aria-multiline")).toBe("true");; expect(preview?.tabIndex).toBe(0); |

InlineEditor.tsx exposes a focusable multiline preview textbox and enters edit mode on Enter. Both tests use identical non-empty value, multiline prop, fresh resolved onSave mock, real root, act render, preview query and unmount. The keyboard keeper already has the same not-null assertion; that exact duplicate is retained once. Exact aria-multiline and tabIndex guards move before Enter, preserving keyboard editing and preview/editor assertions. Focus, nullable save, click-entry, prop-sync and blur behavior remain distinct and unchanged.

The AST verifier checks exact setup, shared enclosing hooks and matched cleanup where present, reconstructs candidate text solely from the declared registrations/assertion migrations, and requires exact byte equality plus full-program AST equality outside those edits. No fixture, helper, provider, action order, wait, assertion strength, timer or teardown changes. The IssueChatThread keeper is an existing complete subset proof; InlineEditor’s identical not-null guard is retained once. Every other case stays byte-identical. Default CI includes this file in `@paperclipai/ui` under `general-workspaces-a`, once across the two file shards; workflow/config unchanged.

## Complete owner-file results

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 10 | 10 | 0 | 0 |
| Candidate | 9 | 9 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/components/InlineEditor.test.tsx`.

All 2 isolated positive controls passed. All 2 deliberate behavior regressions failed at their intended retained/migrated assertion, rather than setup, timeout or a different guard:

| Regression | Intended guard |
|---|---|
| multiline | `expect(preview?.getAttribute("aria-multiline")).toBe("true")` |
| tab-index | `expect(preview?.tabIndex).toBe(0)` |

Exactly one production owner was temporarily changed per control. Every owner was restored byte for byte after each mutation and matched pinned Git bytes. Filtered controls select one keeper; unselected tests do not count as full-suite evidence. [Controls JSON](2026-10-12-test-audit-r7-ui-inline-controls.json) records exact owner/source hashes, migration/input proof, complete-file run/log digests, mutation bodies, intended assertion failures and restoration receipts. Temporary raw verifiers and logs are identified by digests rather than committed in full.

The earlier broad `pnpm test:run` was intentionally stopped without completion and is not claimed as passed. Separate packet results are focused proof, not a completed combined delivery-head replay or pending full CI. No push, rebase, PR or merge is included here.
