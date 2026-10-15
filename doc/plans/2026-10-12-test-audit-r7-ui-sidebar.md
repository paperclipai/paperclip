# Test audit, Round 7 UI — Sidebar loading state follow-up

This isolated follow-up removes **4 registered executions, 4 root renders and 40 net test lines** from `ui/src/components/Sidebar.test.tsx`. It changes no production lines and adds no helper. The pinned audit base is `c39262305b6b48a5decd564af8369083cd972b33`. Prior UI proof remains unchanged. Registration/render reductions are per complete-suite invocation; no measured runtime or CI-speed claim is made.

## Exact migrations

| Retired registration | Keeper | Original observations retained |
|---|---|---|
| `does not flash the Workspaces link while experimental settings are loading` | `keeps the simplified navigation while experimental settings are loading` | expect(container.textContent).not.toContain("Workspaces"); |
| `reserves the Goals nav slot while experimental settings are loading` | `keeps the simplified navigation while experimental settings are loading` | expect([...container.querySelectorAll("nav a")].map((a) => a.textContent?.trim())).not.toContain("Goals");; expect(container.querySelector('[data-testid="sidebar-goals-placeholder"]')).not.toBeNull(); |
| `does not flash the Conference Room item while experimental settings are loading (PAP-137)` | `keeps the simplified navigation while experimental settings are loading` | expect(container.textContent).not.toContain("Conference Room"); |
| `does not flash the Pipelines nav item while experimental settings are loading` | `keeps the simplified navigation while experimental settings are loading` | expect(container.textContent).not.toContain("Pipelines"); |

Sidebar.tsx loads instance settings through useQuery. Workspaces, Goals, Conference Room and Pipelines derive from the same unresolved experimentalSettings value; Goals preserves its pending placeholder. The keeper uses the exact original never-resolving promise and renderSidebar helper. Existing nav checks remain; all five original moved assertions run before the unchanged unmount. Enabled, disabled, mobile, legacy, chat and permission/navigation variants remain distinct.

The verifier reconstructs the exact candidate text from only the declared removals and insertions, requires byte equality, and compares the entire program AST after the same migrations. Every unrelated source byte, hook, mock, test body and binding remains unchanged, outside the audit receipt’s explicitly declared duplicate-title or blank-line cleanup where applicable. Setup ASTs are equal except the explicitly normalized attachment callback binding described above where applicable. No tests are skipped, softened, suppressed or added. Each file remains included in `@paperclipai/ui` under CI `general-workspaces-a`; Vitest file sharding selects it once across the two shards, with no workflow/config change.

## Complete-file evidence

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 35 | 35 | 0 | 0 |
| Candidate | 31 | 31 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/components/Sidebar.test.tsx`.

All 5 separately selected positive keeper controls passed. Every deliberate behavior mutation failed at the corresponding intended keeper assertion, not setup, timeout or another guard:

| Mutation | Intended assertion |
|---|---|
| workspaces | `expect(container.textContent).not.toContain("Workspaces")` |
| goals | `expect([...container.querySelectorAll("nav a")].map((a) => a.textContent?.trim())).not.toContain("Goals")` |
| conference | `expect(container.textContent).not.toContain("Conference Room")` |
| pipelines | `expect(container.textContent).not.toContain("Pipelines")` |
| goals-placeholder | `expect(container.querySelector('[data-testid="sidebar-goals-placeholder"]')).not.toBeNull()` |

Every mutated production owner was restored byte for byte after each mutation and checked against pinned Git bytes. Name-filtered controls select exactly one keeper; their unselected tests are not full-suite evidence. [Compact controls](2026-10-12-test-audit-r7-ui-sidebar-controls.json) preserve source/owner hashes, exact migration map, body verifier digests, complete run/log digests, intended failure receipts and restoration checks. Temporary AST/receipt scripts initially needed corrections for chained assertions or statement position; those verifier attempts produced no accepted test evidence.

The earlier broad local `pnpm test:run` was intentionally stopped before completion; it is not claimed as a pass. These focused runs do not substitute for pending delivery-head CI. No push, rebase, pull request or merge is included in this packet.
