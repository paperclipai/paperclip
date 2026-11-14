# Test audit, Round 7 UI — Company menu opening follow-up

This separate packet removes **1 registered executions, 1 rendered scenarios and 28 net test lines** from `ui/src/components/SidebarCompanyMenu.test.tsx`. It adds no helper and changes no production lines. Audit base: `2e76f5157240ee8b2d42adbdcd4c345aea07c013`. All prior committed proof remains byte-identical. Registration/render savings are per complete-suite invocation; no measured runtime or CI-speed claim is made. A service-worker retirement counts only initializer setup, never a render.

## Exact retirement map

| Retired registration | Keeper | Exact observations migrated |
|---|---|---|
| `uses company-centric create copy without the chat flag` | `toggles company order editing without selecting a company` | expect(trigger?.classList).toContain("px-4");; expect(trigger?.classList).toContain("has-[>svg]:px-4");; expect(trigger?.classList).toContain("hover:bg-sidebar-accent");; expect(trigger?.classList).toContain("hover:text-sidebar-accent-foreground");; expect(trigger?.classList).toContain("dark:hover:bg-sidebar-accent");; expect(trigger?.classList).toContain("dark:hover:text-sidebar-accent-foreground");; expect(trigger?.classList).not.toContain("hover:bg-background");; expect(trigger?.classList).not.toContain("dark:hover:bg-background");; expect(trigger?.classList).not.toContain("dark:hover:bg-accent/50");; expect(document.body.textContent).toContain("Create organization");; expect(document.body.textContent).not.toContain("Add company..."); |

The original fresh QueryClient/provider/root setup, two flushes, trigger query and presence assertion match exactly. Both pointerdown/click opening statements and following flush also match. All nine original trigger-class checks move before opening; both Create organization/Add company copy checks move after opening and before Edit. The keeper retains order editing, reorder-button/row guards and no selection/navigation assertions. Existing health-enabled actions, sign-out, loading/error, selection and other menu cases stay distinct. The six exact trigger-class mutations cover the inset and light/dark hover styling behaviors; the three negative legacy-color guards also remain in the keeper. Adding a conflicting class was rejected as mutation evidence because tailwind-merge removed the required positive token before the negative guard. No token or production style change is included.

The verifier requires matching setup statements, enclosing hooks and explicit teardown where present. It reconstructs candidate source solely from the declared registrations/assertion migrations and requires exact byte equality plus full-program AST equality outside those edits. Existing shared variable bindings, mock arguments and provider/component inputs remain the same. No other fixture, helper, action order, wait, assertion strength, timer or cleanup changes. Default CI includes the file in `@paperclipai/ui` under `general-workspaces-a`, once across its two file shards, with no workflow/config change.

## Complete owner-file results

| Run | Registered | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 16 | 16 | 0 | 0 |
| Candidate | 15 | 15 | 0 | 0 |

From `ui/`: `pnpm exec vitest run src/components/SidebarCompanyMenu.test.tsx`.

All 8 separately selected positive controls passed. All 8 distinct production-owner regressions failed at intended retained/migrated assertions, not setup, timeout or another guard:

| Regression | Intended guard |
|---|---|
| trigger-inset | `expect(trigger?.classList).toContain("px-4")` |
| icon-inset | `expect(trigger?.classList).toContain("has-[>svg]:px-4")` |
| hover-background | `expect(trigger?.classList).toContain("hover:bg-sidebar-accent")` |
| hover-foreground | `expect(trigger?.classList).toContain("hover:text-sidebar-accent-foreground")` |
| dark-background | `expect(trigger?.classList).toContain("dark:hover:bg-sidebar-accent")` |
| dark-foreground | `expect(trigger?.classList).toContain("dark:hover:text-sidebar-accent-foreground")` |
| create-copy | `expect(document.body.textContent).toContain("Create organization")` |
| legacy-create-copy | `expect(document.body.textContent).not.toContain("Add company...")` |

Exactly one production owner changed per control, and every owner was restored byte for byte after each mutation and checked against pinned Git bytes. Literal keeper-name filters are escaped; unselected cases are not full-suite evidence. The initial first-install receipt verifier mistook emit( for it( and rejected its receipt despite the intended test failure. The declaration-boundary matcher was corrected and that control rerun; the rejected verifier attempt supplies no accepted evidence.

[Controls JSON](2026-10-12-test-audit-r7-ui-company-menu-controls.json) preserves source/owner hashes, exact before/after migrations, matched setup and variable-binding proof, complete-file run/log digests, intended assertion failures and restoration checks. Temporary raw scripts/logs are identified by digests rather than committed in full.

The earlier broad local `pnpm test:run` was intentionally stopped before completion and is not claimed as passed. These separate focused packets precede delivery-head replay and full CI. This packet includes no push, rebase, PR or merge.
