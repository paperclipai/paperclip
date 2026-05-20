# LET-503 — EAOS route map & backend data sources

Anchored at branch `enterprise-agent-os/LET-504` head `b086033b` (LET-505 evidence-package commit on top of the LET-504 manual-builder commit `a3e640f4` and the LET-503 commits `421b70ba` + `6f05c9f1`). This map covers every primary-nav surface and every page mounted under `/eaos/*` in `ui/src/App.tsx`.

Conventions:
- **API** column names the typed client function in `ui/src/api/*` (each function points at a documented `/api/...` endpoint scoped by `companyId`).
- **Truthful gap** rows mean the surface labels the gap inline; no fake data is ever rendered.
- Routes prefixed `kernel:` are not part of the EAOS primary rail — they remain reachable so operator/admin paths continue to work.

## Primary EAOS surfaces

| Route | Nav label | Component | API / data source | Counts and rows |
| --- | --- | --- | --- | --- |
| `/eaos` | Dashboard | `CommandCenterLanding` (`ui/src/eaos/CommandCenterLanding.tsx`) | `useMissionTelemetry()` → `issuesApi.list(companyId, …)` + `agentsApi.list(companyId)` | All five posture tiles (`active`, `attention`, `inReview`, `agents.active`, `done`) come from a single `MissionTelemetry` reducer over backend issue + agent rows. Loading shows `—`, error shows `!`, no company shows `·`. No fabricated counts. |
| `/eaos/missions` | Missions | `MissionsListPage` (`ui/src/eaos/missions/MissionsListPage.tsx`) | `issuesApi.list(companyId, { limit: 100, includeBlockedBy: true })` | Summary strip + 5 buckets are derived strictly from `resolveMissionRow(issue)` over the canonical Issue stream. Per-row Truth chip is `Backend-backed` for raw fields and `Backend-derived` for resolver rollups. |
| `/eaos/missions/:identifier` | (mission detail) | `MissionDetail` (`ui/src/eaos/MissionDetail.tsx`) | `issuesApi.get` + related queries | LET-467 read-only mission detail: header, replay feed, evidence board, inspector. No live action controls. |
| `/eaos/agents` | Agents | `AgentsRosterPage` (`ui/src/eaos/agents/AgentsRosterPage.tsx`) | `agentsApi.list(companyId)` | Roster table: name, role, status, adapter, last heartbeat, budget. `Open →` links route to the kernel agent detail page. Summary strip enumerates only counts the API supports. |
| `/eaos/agents/new` | (entered from Agents `New agent` CTA) | `AgentBuilderPage` (`ui/src/eaos/agents/builder/AgentBuilderPage.tsx`) | `agentsApi.hire(companyId, payload)` on submit; `companySkillsApi.list(companyId)` for the Skills step | 6-step stepper (Identity → Model → Invocations → Tools → Skills → Knowledge). Truthful labels for unavailable integrations — see `getInvocationChannelRows`, `getToolGroupCards`, `getKnowledgeRows` in `agent-builder-state.ts`. Sticky summary card reads exclusively from the live builder state. Single primary `Create agent` CTA only on the final step. |
| `/eaos/org` | Org | `OrgPage` (`ui/src/eaos/org/OrgPage.tsx`) | `agentsApi.org(companyId)` (primary); `agentsApi.list(companyId)` (fallback) | Pan/zoom/fit graph (`EaosOrgGraph`). `data-eaos-org-source` is `backend` when reporting edges came from the org endpoint, `derived` when the org endpoint had no edges and the tree was synthesised from roles, `empty` when no agents exist. Gap note is rendered inline. Right details sidebar renders only fields present on the selected agent. |
| `/eaos/projects` | Projects | `ProjectsRoadmapPage` (`ui/src/eaos/projects/ProjectsRoadmapPage.tsx`) | `projectsApi.list(companyId)` + `goalsApi.list(companyId)` | Project/goal table. |
| `/eaos/runs` | Runs | `RunsTimelinePage` (`ui/src/eaos/runs/RunsTimelinePage.tsx`) | `activityApi.list(companyId, { limit })` | Activity timeline. |
| `/eaos/approvals` | Approvals | `ApprovalsQueuePage` (`ui/src/eaos/approvals/ApprovalsQueuePage.tsx`) | `approvalsApi.list(companyId)` | Approvals queue. |
| `/eaos/knowledge` | Knowledge | `KnowledgePage` (`ui/src/eaos/knowledge/KnowledgePage.tsx`) | `companySkillsApi.list(companyId)` | Knowledge/skills index. |
| `/eaos/blueprints` | Agent Builder | `BlueprintsCatalogPage` (`ui/src/eaos/blueprints/BlueprintsCatalogPage.tsx`) | `blueprintsApi.list(companyId)` | Blueprint catalog. |
| `/eaos/blueprints/:slug` | (blueprint detail) | `BlueprintDetailPage` (`ui/src/eaos/blueprints/BlueprintDetailPage.tsx`) | `blueprintsApi.get` | Blueprint detail workbench. |
| `/eaos/admin` | Admin | `AdminPage` (`ui/src/eaos/admin/AdminPage.tsx`) | `accessApi.listMembers(companyId)` | Members table + link out to legacy kernel admin. |
| `/eaos/capabilities` | (reachable via Agent Builder / Admin) | `CapabilitiesPage` (`ui/src/eaos/capabilities/CapabilitiesPage.tsx`) | `agentsApi.list(companyId)` (adapter mix is derived strictly from live roster) | Capabilities/MCP overview. |

## Shell chrome

| Element | Component | Data source |
| --- | --- | --- |
| Top bar | `EaosTopBar` (`ui/src/eaos/EaosTopBar.tsx`) | Local React Router state + company picker (`useCompany`). |
| Primary nav | `EaosPrimaryNav` (`ui/src/eaos/EaosPrimaryNav.tsx`) | Static `EAOS_PRIMARY_NAV_ZONES` from `ui/src/eaos/nav-zones.ts`. Single-noun labels; no slash labels; no `Stub` count pills. |
| Posture strip | `EaosPostureStrip` (`ui/src/eaos/EaosPostureStrip.tsx`) | Contextual chips only — no global `Shell · BACKEND-BACKED` + `Data · PREVIEW · Not connected` dual chips. |

## Truthful gaps surfaced inline

| Surface | Gap and how it is labeled |
| --- | --- |
| `/eaos/org` | When `agentsApi.org` returns no reporting edges, the tree is synthesised from roles. Source label visible as `data-eaos-org-source="derived"` + a visible `GapNote` explaining that the dedicated team/reporting-graph endpoint is not wired. |
| `/eaos/agents/new` → Invocations | `getInvocationChannelRows({ agentSaved: false })` flags Thread / Slack / Telegram / Webhook / Email as `save-first` or `connect` (truthful) until the agent is persisted + invocation backend lands. Scheduled is `available` because `runtimeConfig.heartbeatEnabled` is wired. |
| `/eaos/agents/new` → Tools | `getToolGroupCards({ agentSaved: false })` returns `backend-gap` for tool cards whose registry endpoint is not in place. Inline note: "Integrations live in Admin → Integrations once a workspace integration is connected. No per-agent integration controls until the integrations registry endpoint lands." |
| `/eaos/agents/new` → Skills | Empty backend skills list shows: "No optional company skills installed yet. Install skills from Admin → Library." No fabricated rows. |
| `/eaos/agents/new` → Knowledge | `KNOWLEDGE_ACCESS_MODES` with `backendReady=false` (Curated, Team learning, Custom) render as disabled radios + an `AvailabilityBadge` of kind `backend-gap`. |
| `/eaos/missions` | When the issues query is in flight or errors, the chrome posture chip explicitly switches to `Data · PREVIEW · Not connected`; counts are hidden, not fabricated. |
| `/eaos` (Dashboard) | Each tile substitutes the value with `·` (no company), `—` (loading), or `!` (error) instead of rendering a fake number. |

## Notes for the reviewer

- The branch state at `b086033b` reflects the LET-503 cleanup (`6f05c9f1`), the first-class org graph (`421b70ba`), the LET-504 manual builder (`a3e640f4`), and the LET-505 evidence package (this commit).
- `/eaos/missions` retains the older LET-424 dual-chip posture row (`SHELL_POSTURE_LABEL` + `NOT_CONNECTED_DATA_LABEL`). That predates the LET-502 contract §3 reduction and is flagged as a follow-up in the implementation handoff. Other primary surfaces (`/eaos`, `/eaos/agents`, `/eaos/org`, `/eaos/agents/new`) follow the cleaner LET-502 §3 posture.
