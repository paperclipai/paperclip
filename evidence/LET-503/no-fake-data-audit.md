# LET-503 — No-fake-data audit

Anchored at branch `enterprise-agent-os/LET-504` current head. Commit stack: `6f05c9f1` → `421b70ba` → `a3e640f4` → `b086033b` → `5e2f395a` → `0553b013` → `ce877d21` → `d3ffaedd` → this resubmission's customer-friendly copy + role-gated provenance cleanup commit.

Each row walks the on-screen counts/cards/rows for a route and classifies the source. Verdict legend:

- **PASS — real**: value is read from a backend API on render.
- **PASS — derived**: value is computed from real backend rows by an explicit reducer/resolver.
- **PASS — truthful gap**: explicit "unavailable / loading / error / backend gap" label, no number rendered.
- **FAIL**: a number or activity is shown without backing data. **There are no FAIL rows in this audit.**

## `/eaos` — Dashboard (`CommandCenterLanding`)

| Element | Source | Verdict |
| --- | --- | --- |
| `Active missions` tile (`active`) | `MissionTelemetry.counts.active` from `issuesApi.list` | PASS — real |
| `Needs attention` tile (`attention`) | `MissionTelemetry.criticalAttention` from `issuesApi.list` | PASS — derived |
| `In review` tile (`in-review`) | `MissionTelemetry.counts.inReview` from `issuesApi.list` | PASS — real |
| `Agents active` tile (`agents-active`) | `MissionTelemetry.agents.active` from `agentsApi.list` | PASS — real |
| `Recently done` tile (`done`) | `MissionTelemetry.counts.done` from `issuesApi.list` | PASS — real |
| Placeholder when no company | `·` literal placeholder; no count rendered | PASS — truthful gap |
| Placeholder while loading | `—` literal placeholder; no count rendered | PASS — truthful gap |
| Placeholder on error | `!` literal placeholder; no count rendered | PASS — truthful gap |
| `Needs attention` list rows | `MissionTelemetry.recent` from `issuesApi.list` | PASS — real |
| `Recently completed` list rows | `MissionTelemetry.recentlyCompleted` from `issuesApi.list` | PASS — real |

## `/eaos/agents` — Agents (`AgentsRosterPage`)

| Element | Source | Verdict |
| --- | --- | --- |
| Summary strip (Total/Active/Running/Idle/Paused/Error/Pending/Terminated) | `summarizeAgents(agentsQuery.data)` over `agentsApi.list` | PASS — derived |
| Per-row Name, Title, Role, Status, Runtime (humanized adapter), Last seen, Budget | `buildAgentRosterRow(agent)` directly off `agentsApi.list` row; raw enums humanized via `humanizeAdapterType` + `humanizeAgentStatus` before render | PASS — real |
| Status badge title | `statusTitle(row)` (humanized status; "paused — paused: <reason>" when applicable) | PASS — real |
| `Last seen` `Never` text | Renders only when `lastHeartbeatAt` is `null` | PASS — truthful gap |
| Empty / Loading / Error / NoCompany states | Discrete components; no count rendered | PASS — truthful gap |

## `/eaos/agents/new` — Manual builder (`AgentBuilderPage`)

| Step | Element | Source | Verdict |
| --- | --- | --- | --- |
| Identity | Name, Description, Trust profile, Theme | Local form state | PASS — real (state-bound) |
| Model | Primary model, Extended thinking toggle, Per-query budget, Subagent model | Local form state | PASS — real (state-bound) |
| Invocations | Thread/Slack/Telegram/Webhook/Email rows | `getInvocationChannelRows({ agentSaved: false })` returns availability `save-first`/`connect`; nothing fabricated | PASS — truthful gap |
| Invocations | Scheduled toggle | Wired to `state.scheduledEnabled` + `runtimeConfig.heartbeatEnabled` in the create payload | PASS — real |
| Tools | Integrations area | Dashed note: "Integrations live in Admin → Integrations…"; no fake integrations listed | PASS — truthful gap |
| Tools | Execution / Research / Data tool cards | `getToolGroupCards({ agentSaved: false })` returns `backend-gap` for unwired registries; disabled cards | PASS — truthful gap |
| Skills | Skills list rows | `companySkillsApi.list(companyId)` filtered to non-`paperclipai/paperclip/` keys; empty state explains where to install | PASS — real / truthful gap |
| Skills | Skill discovery toggle | Local state; surfaced in summary | PASS — real (state-bound) |
| Knowledge | Access mode tiles | `KNOWLEDGE_ACCESS_MODES` with `backendReady=false` rendered as disabled + `backend-gap` badge | PASS — truthful gap |
| Knowledge | Sources detail rows | `getKnowledgeRows()` returns availability per source | PASS — truthful gap |
| Sticky summary card | Reads only `state` via `summarizeAgentBuilder(state)` | PASS — real (state-bound) |
| `Create agent` CTA | Posts `agentsApi.hire(companyId, payload)` only on final step | PASS — real |

## `/eaos/org` — Org graph (`OrgPage` + `EaosOrgGraph`)

| Element | Source | Verdict |
| --- | --- | --- |
| Graph canvas nodes | `agentsApi.org(companyId)` primary; falls back to a synthesised tree from `agentsApi.list` when org endpoint returns no edges | PASS — real / derived |
| `data-eaos-org-source` (`backend` / `derived` / `empty`) | Explicit string label per source | PASS — truthful gap surfaced via attribute |
| Per-node Workload (`N reports`) | Strictly `node.reports.length`; never inflated | PASS — derived |
| Per-node Status dot tone | `agent.status` field directly | PASS — real |
| Details sidebar Title, Status, Adapter, Capabilities | Read straight from the selected `Agent` record | PASS — real |
| Sidebar "Agent record not found" note | Renders only when graph node references an unknown agent | PASS — truthful gap |
| Inline gap note paragraph | Differentiates `backend` / `derived` / `empty` clearly | PASS — truthful gap |

## `/eaos/missions` — Missions (`MissionsListPage`)

| Element | Source | Verdict |
| --- | --- | --- |
| Summary strip (Total/Active/Blocked/InReview/DoneWithEvidence/Stale) | `summarizeMissionList(rows)` over canonical Issue records | PASS — derived |
| Mission row cards | `resolveMissionRow(issue)` (LET-424 resolver) — primary state reasons now render as customer-friendly copy (`In progress`, `Awaiting reviewer or approval`, `No owner assigned yet`) instead of `Backend status is …`; owner reasons no longer surface raw field names like `issue.assigneeAgentId`. | PASS — derived |
| Per-row `Live data` / `Derived` provenance chip | Operator-gated via `useEaosViewerRole().isOperator`; never rendered to customer-class viewers. Tone is muted (border-only) instead of full BACKEND-BACKED colour. | PASS — truthful labelling (operator-only) |
| Per-row Freshness chip | Operator-gated; for customers the chip only appears when `freshness === "Stale"`. Label is plain English (`Fresh` / `Aging` / `Stale` / `Unknown activity`) — no `Freshness · UNKNOWN` jargon. | PASS — truthful labelling (operator + stale-customer) |
| Per-row field labels (`Owner` / `Evidence` / `Next step` / `Dependencies`) | Static strings; the inline `Backed`/`Derived` corner marks are operator-gated by `showTruth`. | PASS — truthful labelling |
| `Open details →` link | Generated from `row.kernelRoute`; no inferred URLs | PASS — real |
| `APPROVAL REQUIRED` chip | Renders only when `row.riskSummary.liveActionMentioned` is `true` | PASS — derived |

## `/eaos/runs` — Run timeline (`RunsTimelinePage`)

| Element | Source | Verdict |
| --- | --- | --- |
| Summary strip (Runs/Events/Agents/Missions/Last event) | `summarizeRunTimeline(events)` over real activity rows | PASS — derived |
| Per-row action badge | `humanizeActivityAction(row.latestAction)` translates raw enums (`test_completed`, `comment_posted`, `document_updated`, `blocked_on_dependency`) into title-cased English; no raw enum reaches the DOM | PASS — derived |
| Per-row actor line | `humanizeActorType(row.latestActorType)` (`Agent` / `User` / `System`); the legacy `agent · agent 00000000` debug-id suffix has been removed entirely | PASS — derived |
| Per-row identifier badge | `row.issueIdentifier` from activity `details.identifier` only | PASS — real |
| `Open mission →` link | Routes to `/eaos/missions/:identifier` (or row.issueId) | PASS — real |
| `Open in admin →` link | Operator-gated via `useEaosViewerRole().isOperator`; never rendered to customer-class viewers | PASS — escape hatch only |

## `/eaos/projects`, `/eaos/approvals`, `/eaos/knowledge`, `/eaos/admin`, `/eaos/capabilities`, `/eaos/blueprints`

All rows on these surfaces come from typed API clients (`projectsApi.list`, `goalsApi.list`, `approvalsApi.list`, `companySkillsApi.list`, `accessApi.listMembers`, `agentsApi.list`, `blueprintsApi.list/get`). No tile/row is constructed from a constant. Empty / loading / error states are explicit components rendered in lieu of counts. Verdict: PASS — real.

## Static guards in the shell

- `secret-redact.ts` filters every visible string before render (issue titles, agent names, company name, capabilities). No raw provider config or token can leak through into the DOM even if a downstream API returns one.
- `EaosPrimaryNav` no longer renders dashed `Stub` count pills (removed in `6f05c9f1`).
- The shell `EaosPostureStrip` no longer renders a global `Shell · BACKEND-BACKED` + `Data · PREVIEW · Not connected` chip pair.

## Overall verdict

**PASS** — every visible count or row in the EAOS shell is either backed by a typed API call, derived by an explicit reducer/resolver over backend rows, or replaced by an inline `truthful-gap` element (`save-first`, `connect`, `backend-gap`, `empty`, `loading`, `error`). No constant or decorative number is rendered on any EAOS primary surface.
