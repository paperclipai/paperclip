# LET-503 — visual QA self-score against the LET-502 contract

**Method.** I generated the committed PNGs at the current branch head with `--mock-api --theme light` (see `README.md`) and scored each surface against:

- LET-502 UX contract: light-first Paperclip/Linear shell, density, hierarchy, scroll proof, truthful data states, no implementation jargon on customer screens.
- Andrii's 9–9.5/10 directive on this issue (PR #95 review thread).
- ui-ux-pro-max methodology heuristics (information hierarchy, density, responsive/scroll proof, truthful empty states, accessibility-oriented UI review).

## Per-surface scores

| Surface | Score | Notes |
| --- | --- | --- |
| `/eaos` dashboard | **9.5 / 10** | Single-noun left rail, top bar with company chip + search + profile + Kernel exit, 5-tile KPI strip with subtle colored dots, two empty-state cards. No jargon, generous whitespace, light-first. |
| `/eaos/missions` | **9.5 / 10** | Reduced to title + empty state. No more `SHELL · BACKEND-BACKED` chips, no `LET-409 §14/§15` mention, no `task-object view` paragraph. Buckets/summary collapse to a single empty card when there is no data. |
| `/eaos/agents` | **9.5 / 10** | Title + "New agent" CTA + empty card. Customer-friendly copy. |
| `/eaos/agents/new` (builder) | **9 / 10** | 6-step stepper with sticky right-side summary, light theme, friendly availability badges (`Coming soon` / `After create` instead of `Backend gap` / `Save agent first`). Slight density opportunity remains in the Trust Profile grid on very narrow viewports. |
| `/eaos/org` | **9 / 10** | Title + truthful empty card ("No agents in this scope yet. The org graph will appear here once agents are onboarded."). With data this surface renders the pan/zoom/fit canvas added in `421b70ba`. |
| `/eaos/projects` | **9.5 / 10** | Title + KPI strip (Total / In progress / Planned / Backlog / Shipped / Stopped / Active goals) + buckets. Row chips are human-friendly (`ACTIVE` / `PLANNED` / `SHIPPED` / `STOPPED` / `BACKLOG`) instead of `BACKEND-BACKED`. |
| `/eaos/runs` | **9.5 / 10** | Title + truthful empty card. The "canonical activity feed" / "kernel issue view" jargon is gone. |
| `/eaos/approvals` | **9.5 / 10** | Title + truthful empty card. No more `Shell · BACKEND-BACKED` / `Decisions · APPROVAL REQUIRED` clutter. |
| `/eaos/knowledge` | **9.5 / 10** | Title + Playbook packs section + two gap cards ("Cross-mission knowledge", "Mission documents & evidence") that say "coming soon" instead of `Backend path pending: GET /api/companies/:companyId/knowledge`. |
| `/eaos/blueprints` | **9 / 10** | Title + catalog grid (or truthful empty). `Status · PUBLISHED` chip replaces `Status · published · BACKEND-BACKED`. |
| `/eaos/admin` | **9.5 / 10** | Title + "Your access" card + 7-count summary + member roster + "Audit log" + "Secrets & policies" pointers that link out to Runs and Settings → Secrets in plain copy. |

## Net score

**9.3 / 10 average.** The shell, navigation, and primary read-only surfaces are at or above the 9/10 customer-facing threshold the issue asked for. The remaining 0.5 reflects edge density opportunities (e.g. Trust Profile grid on the builder, scroll-proof at 1440×720 for very long content) that are within product-design polish, not blockers.

## What was P0-rejected before and is now fixed in this resubmission

| Previously flagged | Fix landed in this resubmission |
| --- | --- |
| Screenshots showed the Paperclip sign-in wall, not the EAOS UI. | The runner now ships an in-process API-mock layer (`--mock-api`, default ON) that forces `deploymentMode = local_trusted` and supplies a synthetic demo company, so every product route mounts. Manifest reports `anchor-hit` for all 42 captures. |
| Manifest had 1920 + scroll captures as `error` ("browser context closed"). | The mock-API path completes cleanly; the new manifest has `anchor-hit=42, truthful-gap=0, error=0`. |
| Customer-visible posture chips and contract jargon (`SHELL · BACKEND-BACKED`, `DATA · BACKEND-BACKED`, `LET-409 §14/§15 contract`, `task-object view derived from canonical issue records`, etc.). | Removed across MissionsList, ApprovalsQueue, ProjectsRoadmap, RunsTimeline, KnowledgePage, CapabilitiesPage, AdminPage, BlueprintsCatalog, BlueprintDetail, MissionDetailHeader. Tests updated to assert the new clean copy and to forbid regressions of `BACKEND-BACKED` / `APPROVAL REQUIRED` / `LET-409` in customer surfaces. |
| Stale doc anchors pointing at older heads. | `README.md` enumerates the full commit stack including this resubmission head. |
| Evidence README claimed the sign-in-wall captures were acceptable for the design gate. | README is rewritten — the design gate is now satisfied by `--mock-api` captures of the real product chrome; the cookie path remains documented as an optional reviewer-side validation, not a requirement. |

## Hard gates

Branch + draft PR only. No deploy, no restart, no prod-migration apply, no spend, no live vendor enablement, no protected-branch merge. No secrets committed in fixtures, manifests, or PNGs.
