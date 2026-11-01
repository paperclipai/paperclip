# Test audit, Round 7 UI — Timeline default render follow-up

This isolated follow-up removes **2 registered executions, 2 root renders and 26 net test lines** from `ui/src/pages/Timeline.test.tsx`. It changes no production lines and adds no helper. The pinned audit base is `c39262305b6b48a5decd564af8369083cd972b33`. Prior UI proof remains unchanged. Registration/render reductions are per complete-suite invocation; no measured runtime or CI-speed claim is made.

## Exact migrations

| Retired registration | Keeper | Original observations retained |
|---|---|---|
| `requests the collapsed app sidebar by default` | `renders range controls plus icon zoom controls without the user lens selector or visible-duration readout` | expect(container.querySelector('[data-testid="request-collapsed-sidebar"]')).not.toBeNull(); |
| `requests the company timeline without a user lens parameter` | `renders range controls plus icon zoom controls without the user lens selector or visible-duration readout` | expect(mockWorkTimelineApi.get).toHaveBeenCalledWith(       "company-1",       expect.objectContaining({         from: expect.any(String),         to: expect.any(String),       }),       { signal: expect.any(AbortSignal) },     );; expect(mockWorkTimelineApi.get.mock.calls[0]?.[1]).not.toHaveProperty("userId"); |

Timeline.tsx calls loadTimelineWindow with the selected company, computed date window and AbortSignal. The default unembedded render requests RequestCollapsedSidebar. All three paired cases use the same emptyTimeline beforeEach result, company context, blank URL search, fresh query client, render and flush. Sidebar-request and complete API argument/no-userId guards move after existing controls assertions. Populated stats, pagination, clipping, overlap and project scope remain distinct.

The verifier reconstructs the exact candidate text from only the declared removals and insertions, requires byte equality, and compares the entire program AST after the same migrations. Every unrelated source byte, hook, mock, test body and binding remains unchanged, outside the audit receipt’s explicitly declared duplicate-title or blank-line cleanup where applicable. Setup ASTs are equal except the explicitly normalized attachment callback binding described above where applicable. No tests are skipped, softened, suppressed or added. Each file remains included in `@paperclipai/ui` under CI `general-workspaces-a`; Vitest file sharding selects it once across the two shards, with no workflow/config change.

## Complete-file evidence

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 9 | 9 | 0 | 0 |
| Candidate | 7 | 7 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/pages/Timeline.test.tsx`.

All 6 separately selected positive keeper controls passed. Every deliberate behavior mutation failed at the corresponding intended keeper assertion, not setup, timeout or another guard:

| Mutation | Intended assertion |
|---|---|
| collapsed | `expect(container.querySelector('[data-testid="request-collapsed-sidebar"]')).not.toBeNull()` |
| userId | `expect(mockWorkTimelineApi.get.mock.calls[0]?.[1]).not.toHaveProperty("userId")` |
| company | `expect(mockWorkTimelineApi.get).toHaveBeenCalledWith(` |
| from | `expect(mockWorkTimelineApi.get).toHaveBeenCalledWith(` |
| to | `expect(mockWorkTimelineApi.get).toHaveBeenCalledWith(` |
| signal | `expect(mockWorkTimelineApi.get).toHaveBeenCalledWith(` |

Every mutated production owner was restored byte for byte after each mutation and checked against pinned Git bytes. Name-filtered controls select exactly one keeper; their unselected tests are not full-suite evidence. [Compact controls](2026-10-12-test-audit-r7-ui-timeline-controls.json) preserve source/owner hashes, exact migration map, body verifier digests, complete run/log digests, intended failure receipts and restoration checks. Temporary AST/receipt scripts initially needed corrections for chained assertions or statement position; those verifier attempts produced no accepted test evidence.

The earlier broad local `pnpm test:run` was intentionally stopped before completion; it is not claimed as a pass. These focused runs do not substitute for pending delivery-head CI. No push, rebase, pull request or merge is included in this packet.

The mutation controls preceded the final blank-line cleanup. Exact byte reconstruction confirms that every intended migrated guard and its source location stayed unchanged; the final polished complete file passed again. The controls JSON records both candidate hashes.
