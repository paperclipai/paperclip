# Test audit, Round 7 UI — App error boundary follow-up

This isolated follow-up removes **1 registered executions, 1 root renders and 20 net test lines** from `ui/src/components/AppErrorBoundary.test.tsx`. It changes no production lines and adds no helper. The pinned audit base is `c39262305b6b48a5decd564af8369083cd972b33`. Prior UI proof remains unchanged. Registration/render reductions are per complete-suite invocation; no measured runtime or CI-speed claim is made.

## Exact migrations

| Retired registration | Keeper | Original observations retained |
|---|---|---|
| `renders a reload prompt instead of a blank page when the shell throws in render` | `reports one captured error and keeps the reload prompt` | expect(container.textContent).toContain("Paperclip hit an error");; expect(container.textContent).toContain("Maximum update depth exceeded"); |

main.tsx wraps the app in AppErrorBoundary. The paired tests create the same root and render the same BoomRender throw under the real boundary, with identical hooks/unmount. Move title and original error detail before retained capture/count/metadata/reload-button checks. The retired reload-button expression already matches the retained expression exactly. Effect errors, healthy children and DOM insertion/translation errors remain distinct and unchanged.

The verifier reconstructs the exact candidate text from only the declared removals and insertions, requires byte equality, and compares the entire program AST after the same migrations. Every unrelated source byte, hook, mock, test body and binding remains unchanged, outside the audit receipt’s explicitly declared duplicate-title or blank-line cleanup where applicable. Setup ASTs are equal except the explicitly normalized attachment callback binding described above where applicable. No tests are skipped, softened, suppressed or added. Each file remains included in `@paperclipai/ui` under CI `general-workspaces-a`; Vitest file sharding selects it once across the two shards, with no workflow/config change.

## Complete-file evidence

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 6 | 6 | 0 | 0 |
| Candidate | 5 | 5 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/components/AppErrorBoundary.test.tsx`.

All 2 separately selected positive keeper controls passed. Every deliberate behavior mutation failed at the corresponding intended keeper assertion, not setup, timeout or another guard:

| Mutation | Intended assertion |
|---|---|
| title | `expect(container.textContent).toContain("Paperclip hit an error")` |
| detail | `expect(container.textContent).toContain("Maximum update depth exceeded")` |

Every mutated production owner was restored byte for byte after each mutation and checked against pinned Git bytes. Name-filtered controls select exactly one keeper; their unselected tests are not full-suite evidence. [Compact controls](2026-10-12-test-audit-r7-ui-appboundary-controls.json) preserve source/owner hashes, exact migration map, body verifier digests, complete run/log digests, intended failure receipts and restoration checks. Temporary AST/receipt scripts initially needed corrections for chained assertions or statement position; those verifier attempts produced no accepted test evidence.

The earlier broad local `pnpm test:run` was intentionally stopped before completion; it is not claimed as a pass. These focused runs do not substitute for pending delivery-head CI. No push, rebase, pull request or merge is included in this packet.
