# Test audit, Round 7 UI — Route error boundary follow-up

This isolated follow-up removes **2 registered executions, 2 root renders and 31 net test lines** from `ui/src/components/RouteErrorBoundary.test.tsx`. It changes no production lines and adds no helper. The pinned audit base is `c39262305b6b48a5decd564af8369083cd972b33`. Prior UI proof remains unchanged. Registration/render reductions are per complete-suite invocation; no measured runtime or CI-speed claim is made.

## Exact migrations

| Retired registration | Keeper | Original observations retained |
|---|---|---|
| `reports one captured error and keeps the recovery button` | `recovers and renders children again after the route changes` | expect(captureBrowserExceptionMock).toHaveBeenCalledTimes(1);; expect(captureBrowserExceptionMock).toHaveBeenCalledWith(expect.any(Error), {       boundary: "route", componentStack: expect.stringContaining("Boom"),     });; expect(       Array.from(container.querySelectorAll("button")).some(         (button) => button.textContent === "Go back",       ),     ).toBe(true); |
| `renders a recoverable error card instead of a blank page when a child throws` | `recovers and renders children again after the route changes` | expect(container.textContent).toContain("This page hit an error");; expect(container.textContent).toContain("Maximum update depth exceeded");; expect(container.querySelector("pre")).not.toBeNull(); |

Layout.tsx and Layout.production.tsx wrap the routed Outlet with RouteErrorBoundary. Its inner boundary captures the thrown error and component stack, renders recovery UI and resets after pathname/search changes. Paired initial createRoot/Boom/act subtrees and unmount statements are AST-identical. All migrated guards run before route mutation and retain the original capture metadata, count, Go-back presence, title, detail and pre checks. The duplicate original title assertion is removed after proving equality with the migrated title guard; the separate actual Go-back click/navigation test remains unchanged.

The verifier reconstructs the exact candidate text from only the declared removals and insertions, requires byte equality, and compares the entire program AST after the same migrations. Every unrelated source byte, hook, mock, test body and binding remains unchanged, outside the audit receipt’s explicitly declared duplicate-title or blank-line cleanup where applicable. Setup ASTs are equal except the explicitly normalized attachment callback binding described above where applicable. No tests are skipped, softened, suppressed or added. Each file remains included in `@paperclipai/ui` under CI `general-workspaces-a`; Vitest file sharding selects it once across the two shards, with no workflow/config change.

## Complete-file evidence

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 4 | 4 | 0 | 0 |
| Candidate | 2 | 2 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/components/RouteErrorBoundary.test.tsx`.

All 7 separately selected positive keeper controls passed. Every deliberate behavior mutation failed at the corresponding intended keeper assertion, not setup, timeout or another guard:

| Mutation | Intended assertion |
|---|---|
| capture-count | `expect(captureBrowserExceptionMock).toHaveBeenCalledTimes(1)` |
| capture-boundary | `expect(captureBrowserExceptionMock).toHaveBeenCalledWith(` |
| capture-stack | `expect(captureBrowserExceptionMock).toHaveBeenCalledWith(` |
| go-back | `).toBe(true);` |
| title | `expect(container.textContent).toContain("This page hit an error")` |
| detail | `expect(container.textContent).toContain("Maximum update depth exceeded")` |
| pre | `expect(container.querySelector("pre")).not.toBeNull()` |

Every mutated production owner was restored byte for byte after each mutation and checked against pinned Git bytes. Name-filtered controls select exactly one keeper; their unselected tests are not full-suite evidence. [Compact controls](2026-10-12-test-audit-r7-ui-route-controls.json) preserve source/owner hashes, exact migration map, body verifier digests, complete run/log digests, intended failure receipts and restoration checks. Temporary AST/receipt scripts initially needed corrections for chained assertions or statement position; those verifier attempts produced no accepted test evidence.

The earlier broad local `pnpm test:run` was intentionally stopped before completion; it is not claimed as a pass. These focused runs do not substitute for pending delivery-head CI. No push, rebase, pull request or merge is included in this packet.

The mutation controls preceded the final duplicate original-title removal. Exact byte reconstruction confirms that every intended migrated guard and its source location stayed unchanged; the final polished complete file passed again. The controls JSON records both candidate hashes.
