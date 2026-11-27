# Test audit, Round 7 UI — Experimental settings follow-up

This separate packet removes **2 registered executions, 2 root renders and 10 net test lines** from `ui/src/pages/InstanceExperimentalSettings.test.tsx`. It adds no helper and changes no production lines. Audit base: `e3effbb9e5c66b838f67fd487987c8bf1007e413`. Prior committed evidence remains byte-identical. Render/execution savings are per complete-suite invocation; no measured runtime or CI-speed claim is made.

## Exact retirement map

| Retired registration | Keeper | Observations retained |
|---|---|---|
| `does not render the Pipelines experimental setting for now` | `does not render the Conference Room Chat experimental setting for now` | expect(headings).not.toContain("Pipelines");; expect(container.querySelector('button[aria-label="Toggle pipelines experimental setting"]')).toBeNull(); |
| `shows the cutoff-copy for the worktree run-execution toggle when off` | `renders and patches the worktree run-execution toggle when in a worktree` | expect(container.textContent).toContain(       "Only tasks created after enabling will run automatically",     );; expect(container.textContent).toContain("Toggling off and on resets the cutoff.");; expect(container.textContent).not.toContain("Running tasks created after");; expect(container.textContent).not.toContain("Execution is suppressed"); |

InstanceExperimentalSettings.tsx keeps the retired Pipelines/Conference Room settings absent and owns the worktree-run toggle and activation-state banners. Two initial page renders consolidate independently: hidden Pipelines heading/toggle checks join the hidden Conference Room keeper; all off-state cutoff/reset copy and armed/fail-closed banner exclusions join the existing worktree toggle keeper before its click. Runtime worktree metadata, shared settings fixture, renderPage helper and lifecycle match in each pair. Enabled/armed/mismatch/managed/runtime-specific and toggle-interaction cases remain unchanged.

The AST verifier checks exact setup, shared enclosing hooks and matched cleanup where present, reconstructs candidate text solely from the declared registrations/assertion migrations, and requires exact byte equality plus full-program AST equality outside those edits. No fixture, helper, provider, action order, wait, assertion strength, timer or teardown changes. The IssueChatThread keeper is an existing complete subset proof; InlineEditor’s identical not-null guard is retained once. Every other case stays byte-identical. Default CI includes this file in `@paperclipai/ui` under `general-workspaces-a`, once across the two file shards; workflow/config unchanged.

## Complete owner-file results

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 55 | 55 | 0 | 0 |
| Candidate | 53 | 53 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/pages/InstanceExperimentalSettings.test.tsx`.

All 6 isolated positive controls passed. All 6 deliberate behavior regressions failed at their intended retained/migrated assertion, rather than setup, timeout or a different guard:

| Regression | Intended guard |
|---|---|
| pipelines-heading | `expect(headings).not.toContain("Pipelines")` |
| pipelines-toggle | `expect(container.querySelector('button[aria-label="Toggle pipelines experimental setting"]')).toBeNull()` |
| cutoff-copy | `expect(container.textContent).toContain(` |
| reset-copy | `expect(container.textContent).toContain("Toggling off and on resets the cutoff.")` |
| armed-banner | `expect(container.textContent).not.toContain("Running tasks created after")` |
| fail-closed | `expect(container.textContent).not.toContain("Execution is suppressed")` |

Exactly one production owner was temporarily changed per control. Every owner was restored byte for byte after each mutation and matched pinned Git bytes. Filtered controls select one keeper; unselected tests do not count as full-suite evidence. [Controls JSON](2026-10-12-test-audit-r7-ui-experimental-controls.json) records exact owner/source hashes, migration/input proof, complete-file run/log digests, mutation bodies, intended assertion failures and restoration receipts. Temporary raw verifiers and logs are identified by digests rather than committed in full.

The earlier broad `pnpm test:run` was intentionally stopped without completion and is not claimed as passed. Separate packet results are focused proof, not a completed combined delivery-head replay or pending full CI. No push, rebase, PR or merge is included here.
