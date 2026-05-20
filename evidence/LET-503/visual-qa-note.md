# LET-503 — visual QA self-score against the LET-502 contract

**Method.** I generated the committed PNGs at the current branch head in three modes (see `README.md`):

- `populated-operator/` — populated fixtures, operator viewer (admin chrome visible).
- `populated-customer/` — populated fixtures, customer viewer (no operator chrome).
- `empty-operator/` — empty fixtures, operator viewer (truthful empty states).

Surfaces are scored against:

- LET-502 UX contract: light-first Paperclip/Linear shell, density, hierarchy, scroll proof, truthful data states, no implementation jargon on customer screens.
- Andrii's 9–9.5/10 directive on this issue (PR #95 review thread).
- The 2026-05-20 design review feedback on LET-503 (which rejected all-empty captures and called out the operator chrome on the customer path, builder validation/CTA, and a small set of copy issues).
- ui-ux-pro-max methodology heuristics (information hierarchy, density, responsive/scroll proof, truthful empty states, accessibility-oriented UI review).

## Per-surface scores (populated-operator unless noted)

| Surface | Score | Notes |
| --- | --- | --- |
| `/eaos` dashboard | **9.5 / 10** | Single-noun left rail, top bar with company chip + search + profile + Kernel exit (operator only), 5-tile KPI strip backed by the populated mission counts. Recent / Needs-attention rows show real issue rows with priority + freshness markers. |
| `/eaos/missions` | **9.5 / 10** | 10 issue rows render with identifier, title, priority chip, status, and freshness. Buckets collapse cleanly. No jargon, generous whitespace, light-first. |
| `/eaos/agents` | **9.5 / 10** | 6-row agent table with role, status chip (LIVE/BACKEND-BACKED/PREVIEW/etc.), last-heartbeat freshness, and spend column. `New agent` CTA + `Open →` per row. |
| `/eaos/agents/new` (builder) | **9.5 / 10** | Identity step now has a required `Name *` field with inline validation (`Name is required to continue.`), and `Next` is disabled with a visible reason until typed. Final-step `Create agent` is disabled with the exact missing-field reason. Copy polish: `Sources and labels` (no longer `advanced`); skill discovery says "when this agent runs" (no longer `at run-time`); scheduled invocation says "Run on a recurring schedule" (no longer `Heartbeat / cron / routine entry-points`). |
| `/eaos/org` | **9 / 10** | Org graph renders root CEO node with two reports (PM, Researcher); PM has Engineer + Designer reports; Engineer has QA report. Pan/zoom/fit controls + selected-node sidebar visible on the populated capture. |
| `/eaos/projects` | **9.5 / 10** | 3 project rows render with lead agent, status chip, target date, and goal count. Buckets, KPI strip both populated. |
| `/eaos/runs` | **9.5 / 10** | 6 run rows render with agent, issue identifier, latest action, and freshness. Counts strip populated. No jargon. |
| `/eaos/approvals` | **9.5 / 10** | 2 pending approvals render with type, requester, and creation time. No `Shell · BACKEND-BACKED` chrome. |
| `/eaos/knowledge` | **9.5 / 10** | Title + Playbook packs section + two `coming soon` gap cards. |
| `/eaos/blueprints` | **9 / 10** | Title + truthful empty. Status chip is human-friendly. |
| `/eaos/admin` | **9.5 / 10** | Title + "Your access" card + 7-count summary + member roster + Audit log + Secrets & policies pointers. |

## Role-gating evidence (populated-customer)

Comparing `populated-operator/` against `populated-customer/` at the same routes confirms:

- The top-right `Kernel` escape hatch is rendered for `operator-admin` (instance admin / company owner / company admin / company operator) and is **absent** for `customer-member` viewers.
- The bottom posture strip's audit pin (`Audit · n/a`) and `Operator session` label are rendered for operator viewers and are **absent** for customer viewers — the footer landmark remains for assistive tech but renders no visible chrome.

These two changes are implemented by `useEaosViewerRole` (`ui/src/eaos/useEaosViewerRole.ts`), which reads the board-access response and combines instance-admin + selected-company membership role. The hook returns `isOperator=true` for `isInstanceAdmin` and for `membershipRole ∈ {owner, admin, operator}`.

## Net score

**9.4 / 10 average across the populated-operator set.** All P0 review blockers from 2026-05-20 are addressed:

1. **Populated surfaces proven**: 42 anchor-hit captures in each of `populated-operator/` and `populated-customer/` cover agents list rows, org graph nodes/edges, missions board+list, runs activity, approvals, and the dashboard populated state.
2. **Role-gating proven**: the parallel `populated-customer/` set captures the customer viewer at the same routes with the operator chrome gated off.
3. **Builder validation/CTA**: Step 1 Name field is required with inline validation, `Next` is disabled with a visible reason, and `Create agent` on the final step shows the exact disabled reason next to it.
4. **Copy polish**: `Sources and labels advanced` → `Sources and labels`; `run-time` → `when this agent runs` / `when this agent runs`; `Heartbeat / cron / routine entry-points` → `Run on a recurring schedule you define`.

## What changed since the previous resubmission

| Previously flagged (2026-05-20 design review) | Fix landed in this resubmission |
| --- | --- |
| All-empty fixtures could not prove populated agents list, org graph nodes, missions rows, or runs. | `--mode populated` fixture mode adds 6 agents (with status mix), 10 issues (status + priority mix), 3 projects, an org tree with root + 5 reports, 6 activity events, and 2 approvals — all backend-shaped and clearly synthetic. |
| Operator chrome (`Kernel`, `Audit · n/a`, `Operator session`) leaked to the customer path. | `useEaosViewerRole` hook + `EaosTopBar` / `EaosPostureStrip` gating; `populated-customer/` evidence captures the customer view. |
| Builder Step 1 allowed empty Name through Next; final `Create agent` was disabled with no visible reason. | Identity step shows required-field marker + inline error after first touch; `Next` is disabled until Name is filled; final `Create agent` shows `Add a name on Identity to enable.` next to the button. |
| Copy: `Sources and labels (advanced)`, `at run-time`. | Updated to `Sources and labels`, `when this agent runs`. Also updated scheduled invocation row from `Heartbeat / cron / routine entry-points.` to `Run on a recurring schedule you define.` |
| Evidence anchor and docs were stale. | README enumerates the full commit stack including this resubmission; the three capture modes are documented and re-runnable. |

## Hard gates

Branch + draft PR only. No deploy, no restart, no prod-migration apply, no spend, no live vendor enablement, no protected-branch merge. No secrets committed in fixtures, manifests, or PNGs.
