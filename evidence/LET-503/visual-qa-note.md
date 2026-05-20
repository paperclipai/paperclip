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
2. **Role-gating proven**: the parallel `populated-customer/` set captures the customer viewer at the same routes with the operator chrome gated off — including the per-row `Open in admin →` link on `/eaos/runs` and the `BACKEND-BACKED` / `Backed` / `Derived` / `Freshness · Unknown` provenance chips on `/eaos/missions`. Confirmed by `evidence/LET-503/customer-string-audit.json` (`findings: 0` over 9 routes).
3. **Builder validation/CTA**: Step 1 Name field is required with inline validation, `Next` is disabled with a visible reason, and `Create agent` on the final step shows the exact disabled reason next to it. The disabled-reason text waits for the field to be touched, so a pristine pageload no longer shouts `Name is required`. The footer is sticky to the bottom of the main column so Back/Next stay visible at 720px viewport.
4. **Copy polish**: `Sources and labels advanced` → `Sources and labels`; `run-time` → `when this agent runs`; `Heartbeat / cron / routine entry-points` → `Run on a recurring schedule you define`. `claude_local` → `Claude Local`; `pending_approval` → `Pending approval`; activity enums (`test_completed`, `comment_posted`, `document_updated`, `blocked_on_dependency`) → title-cased English; `Last heartbeat` column → `Last seen`; `Adapter` column → `Runtime`.

## What changed since the previous resubmission

| Previously flagged | Fix landed in this resubmission |
| --- | --- |
| `Open in Kernel/Admin →` link on every run card (customer-visible). | Per-row admin link is gated by `useEaosViewerRole().isOperator`; customers only see `Open mission →`. Confirmed by the new `populated-customer` capture + the customer-string audit. |
| Raw activity enums on `/eaos/runs` (`TEST_COMPLETED`, `COMMENT_POSTED`, `DOCUMENT_UPDATED`, `BLOCKED_ON_DEPENDENCY`). | New `humanizeActivityAction` helper renders `Test completed`, `Comment posted`, `Document updated`, `Blocked on dependency`. Run-row badge is a rounded pill (not a debug dashed box). |
| `agent · agent 00000000` debug-id suffix in the run-row actor line. | Removed; the actor line now reads `Agent` / `User` / `System` via `humanizeActorType`. |
| `BACKEND-BACKED` / `Backed` / `Derived` / `FRESHNESS · UNKNOWN` chips on populated `/eaos/missions`. | Provenance chips are operator-gated via `useEaosViewerRole`; customers see only the primary state chip plus a `Stale` chip when applicable. The TruthChip now renders `Live data` / `Derived` in a muted tone instead of full BACKEND-BACKED colour for operators. |
| Customer-visible `issue.assigneeAgentId` / `issue.assigneeUserId` / `issue.executionAgentNameKey` reasons on mission rows. | `resolveOwner` rewritten to emit `Assigned to a human teammate` / `Assigned to an agent` / `Picked up by a role-based agent` / `No owner assigned yet`. Field labels: `TREE` → `Dependencies`; `NEXT GATE` → `Next step`; `CURRENT OWNER` → `Owner`. `primaryStateReason` rewritten to drop `Backend status is …`. |
| Raw `CLAUDE_LOCAL` adapter enum on `/eaos/agents`. | New `humanizeAdapterType` helper renders `Claude Local`. Column header renamed `Adapter` → `Runtime`. `Last heartbeat` → `Last seen`. Status badge tooltip drops the `Backend status:` prefix; status text uses `humanizeAgentStatus` (`pending_approval` → `Pending approval`). |
| Builder Step 1 surfaced `Name is required` on a pristine pageload. | `nameTouched` is lifted into the parent so both the inline error and the footer disabled-reason wait for first touch. The button itself stays disabled while empty — only the explanation is delayed until touch. |
| Builder footer (`Back` / `Next` / `Cancel`) could fall below the fold at 720px. | StepperFooter is now `sticky bottom-0` with backdrop blur, so Back/Next stay visible inside the main column. |
| `Decide in Kernel/Admin →` / `Open decision in Kernel/Admin →` copy on `/eaos/approvals`. | Replaced with `Open to decide →` / `Open decision →`; secondary helper says `Approve / reject lives on the detail page.` instead of `No live action on this surface.` |
| `Backend status: in_progress` tooltip on dashboard mission row chips. | Tooltip now uses the chip label itself. |

## Hard gates

Branch + draft PR only. No deploy, no restart, no prod-migration apply, no spend, no live vendor enablement, no protected-branch merge. No secrets committed in fixtures, manifests, or PNGs.
