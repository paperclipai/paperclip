# Handoff → design/UI session: update color-token test assertions to GLASSHOUSE `status-*` tokens

**From:** runtime session · **Date:** 2026-06-08 · **Priority:** MEDIUM — suite is red, but only your in-flight token migration

## TL;DR
The GLASSHOUSE color migration is **done in component source** (raw Tailwind colors →
`status-*` tokens), but the matching **test assertions still check the old raw colors**
(`border-amber-600`, `text-emerald`, `border-red-500/30`, …). That's ~14 deterministic
failures across 6 test files. They're in the design lane — please update the assertions to
the tokens the components now render. Verified: `grep` finds **zero** raw `*-{amber,cyan,
emerald,red,green}-NNN` left in these component sources, so this is test-only lag.

## Token mapping (old raw color → new GLASSHOUSE token)
| Old raw class (in tests) | New token (in component source) |
|---|---|
| `border-cyan-600` / `bg-cyan-600` | `border-status-running` / `bg-status-running` |
| `border-amber-600` | `border-status-warning` (also `text-status-warning`) |
| `border-red-600` | `border-status-error` (also `text-status-error`) |
| `border-red-500/30` | `border-status-error/30` |
| `bg-red-500/10` | `bg-status-error/12`  *(note: opacity 10 → 12)* |
| `text-emerald` (live service link) | `text-status-success` |

Mapping rule: **cyan→running, amber→warning, red→error, emerald/green→success, slate→info.**
Confirm exact opacity suffixes against the rendered `className` — a couple changed (e.g. `/10`→`/12`).

## Exact files + assertions to update
- **`ui/src/components/StatusIcon.test.tsx`** (5 failing) — lines ~28, 52, 76, 99–101, 123–125:
  `border-cyan-600`→`border-status-running`, `bg-cyan-600`→`bg-status-running`,
  `border-red-600`→`border-status-error`, `border-amber-600`→`border-status-warning`
  (and the matching `.not.toContain(...)` negatives).
- **`ui/src/components/IssueProperties.test.tsx`** (1) — line ~623: `text-emerald`→`text-status-success`.
- **`ui/src/components/ProjectWorkspaceSummaryCard.test.tsx`** (1) — line ~278: `text-emerald`→`text-status-success`.
- **`ui/src/components/IssueRunLedger.test.tsx`** (1) — lines ~456–457: `border-red-500/30`→`border-status-error/30`, `bg-red-500/10`→`bg-status-error/12`.
- **`ui/src/components/IssueChatThread.test.tsx`** (2–3) — asserts `amber` on the planning-mode composer → `status-warning`.
- **`ui/src/pages/Inbox.test.tsx`** (1) — "keeps status and live accents visible" → status-token accents.

## NOT color-token — leave these out of scope (different root causes)
These also fail but are **not** the token migration — don't lump them in:
- `MarkdownBody.test.tsx` (linkify behavior), `Sidebar.test.tsx` (plugin slots/launchers/workspaces),
  `OrgChart.test.tsx` (touch-gesture sim) — behavioral/feature, pre-existing.
- `SidebarAgents` / `SidebarProjects` / `Secrets.render` / `ImportFromVaultDialog` — **flaky under
  full-suite load** (they pass in isolation; `waitFor` timeouts under CPU contention), not real breaks.

## Hands off (runtime lane — do not revert)
The `/auth` auth-gating work is mine: `ui/src/hooks/useAuthedDataEnabled.ts` +
`enabled:` gates in `use-disabled-adapters.ts`, `use-adapter-capabilities.ts`,
`CompanyContext.tsx` (commits `533d74f5`, `6dd0f4fd`). Proven via stash-and-compare to add
**zero** new test failures. `CompanyContext.test.tsx` got a `vi.mock("@/api/health")` so its
gate opens — please keep it.

## Done = green
After updating the assertions above, `vitest run` should drop to only the non-color
behavioral/flaky residue. Re-run a couple times to confirm the flaky `Sidebar*`/`Secrets*`
files aren't deterministic before declaring victory.
