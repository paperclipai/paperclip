# LET-503 — Role-gating audit (ordinary user surfaces)

Anchored at branch `enterprise-agent-os/LET-504` current head. Commit stack: `6f05c9f1` → `421b70ba` → `a3e640f4` → `b086033b` → `5e2f395a` → `0553b013` → `ce877d21` → `d3ffaedd` → this resubmission's customer-path cleanup commit (kernel-link gating on `/eaos/runs`, friendly action labels, adapter humanization, missions provenance gating).

Scope: every primary `/eaos/*` route the ordinary user can reach via the left rail or in-page CTAs. For each surface, this audit walks the rendered controls and confirms that no operator-/admin-only control is exposed.

The "forbidden categories" come from the LET-481 brief and reiterated in CEO comment 19eb0164 on LET-503:

1. Secrets / API keys / connection strings / proxy values
2. Raw provider config / destination identifiers
3. Deploy / restart / production-DB-migration / spend / live-vendor controls
4. Debug / admin-only internals

Verdict legend:

- **PASS** — no controls or data from the forbidden categories are rendered.
- **PASS — escape hatch only** — the surface only exposes a link out to the legacy kernel/admin path for operators (still reachable, never displayed inline).
- **FAIL** — a forbidden control or value is rendered to an ordinary user. **There are no FAIL rows.**

## `/eaos` — Dashboard (`CommandCenterLanding`)

| Forbidden category | Found? | Notes |
| --- | --- | --- |
| Secrets / proxies / connection strings | No | Only counts; titles run through `redactSecretLikeText`. |
| Raw provider config | No | None on this surface. |
| Deploy / restart / prod-migration / spend / live-vendor controls | No | The shell has no live-action buttons here. |
| Debug / admin internals | No | No internal logs/runs/internal IDs. |

Verdict: **PASS**.

## `/eaos/agents` — Agents (`AgentsRosterPage`)

| Forbidden category | Found? | Notes |
| --- | --- | --- |
| Secrets / proxies / connection strings | No | Per-row name, title, capabilities text run through `redactSecretLikeText` before render. |
| Raw provider config | No | The Runtime column displays a humanized adapter label via `humanizeAdapterType` (`claude_local` → `Claude Local`); raw enum strings like `CLAUDE_LOCAL` no longer reach the DOM. Status badges use `humanizeAgentStatus` (`pending_approval` → `Pending approval`) and the tooltip drops the `Backend status:` prefix. |
| Deploy / restart / prod-migration / spend / live-vendor controls | No | No control beyond `Open →` (link to kernel agent detail). Pause / resume / approve / terminate explicitly remain in the kernel page (file comment §1). |
| Debug / admin internals | No | No internal IDs, no debug toggles. Monetary budget is shown as USD (`$0` / `$X`), never as raw cents in a way that would expose internal numbers. |

Verdict: **PASS — escape hatch only** (link out to kernel agent detail page, which itself enforces operator-level gates).

## `/eaos/agents/new` — Manual builder (`AgentBuilderPage`)

| Forbidden category | Found? | Notes |
| --- | --- | --- |
| Secrets / proxies / connection strings | No | The builder does not accept or display tokens. The only freeform text input is name/description, which is rendered back via `redactSecretLikeText` in the inline error path. |
| Raw provider config | No | "Primary model" is a free-text model id (`claude-opus-4-7` etc) — that is the user-visible model identifier, not a provider secret. The advanced-config knobs (adapter-specific settings) are kept in the operator path `/agents/new` per the file header comment. |
| Deploy / restart / prod-migration / spend / live-vendor controls | No | The single submit is `agentsApi.hire` — a normal agent-create call. Per-query budget is a soft cap; the kernel still enforces monthly budget at the company level. |
| Debug / admin internals | No | No raw provider toggles or vendor enablement controls. Backend gaps are surfaced as visual badges, not as enabling controls. |

Verdict: **PASS**.

## `/eaos/org` — Org graph (`OrgPage` + `EaosOrgGraph`)

| Forbidden category | Found? | Notes |
| --- | --- | --- |
| Secrets / proxies / connection strings | No | Node names, agent capabilities, and selected company name all go through `redactSecretLikeText`. |
| Raw provider config | No | Only `name`, `role`, `status`, `adapterType`, `title`, `capabilities` are shown — same surface as the agents page. |
| Deploy / restart / prod-migration / spend / live-vendor controls | No | The only control is `Open agent profile →` link to the kernel agent page. |
| Debug / admin internals | No | The graph canvas exposes pan/zoom/fit controls and node selection only; no operator handles. |

Verdict: **PASS — escape hatch only**.

## `/eaos/missions` and `/eaos/missions/:identifier`

| Forbidden category | Found? | Notes |
| --- | --- | --- |
| Secrets / proxies / connection strings | No | Row titles pass through redaction. |
| Raw provider config | No | None. |
| Deploy / restart / prod-migration / spend / live-vendor controls | No | The page explicitly states "No live action controls are rendered here". The `APPROVAL REQUIRED` chip is advisory only. `disableIssueQuicklook` is set on the kernel-issue link so a quicklook can't surface unexpected internals. |
| Debug / admin internals | No | The `BACKEND-BACKED` / `Backed` / `Derived` provenance chips and the `FRESHNESS · Unknown` chip are gated behind `useEaosViewerRole().isOperator` — they only render for instance admins or `owner`/`admin`/`operator` company members. Customer viewers see plain status chips, friendly state copy (`In progress`, `Awaiting reviewer or approval`, `No owner assigned yet`), and clean field labels (`Owner`, `Next step`, `Dependencies`). Raw `issue.assigneeAgentId` / `issue.assigneeUserId` / `issue.executionAgentNameKey` reasons were rewritten as `Assigned to an agent` etc. |

Verdict: **PASS — escape hatch only** (`Open kernel issue →` link).

## `/eaos/projects` (`ProjectsRoadmapPage`)

PASS. Reads `projectsApi.list` + `goalsApi.list`; no operator controls in the surface.

## `/eaos/runs` (`RunsTimelinePage`)

PASS. Reads `activityApi.list`; renders activity rows. The per-row `Open in admin →` deep link is gated behind `useEaosViewerRole().isOperator` — customer viewers only see the `Open mission →` link. Raw activity action enums (`test_completed`, `comment_posted`, `document_updated`, `blocked_on_dependency`) are humanized via `humanizeActivityAction` before they reach the DOM, and the actor row no longer prints `agent · agent 00000000`-style debug ids (it shows just `Agent` / `User` / `System`).

## `/eaos/approvals` (`ApprovalsQueuePage`)

PASS. Reads `approvalsApi.list`; surfaces approvals only as a queue. The actual approve/reject flow lives on the kernel approval detail page (escape hatch).

## `/eaos/knowledge` (`KnowledgePage`)

PASS. Reads `companySkillsApi.list`; no install/uninstall/edit controls in the EAOS surface.

## `/eaos/blueprints` and `/eaos/blueprints/:slug`

PASS. The catalog and detail surfaces are read-only with redaction (LET-501 fix `60011502` redacted catalog card ref + identifier DOM attributes, and `53a1b904` extended redaction coverage). Instantiation goes through the LET-498 approval flow.

## `/eaos/admin` (`AdminPage`)

PASS — escape hatch only. Reads `accessApi.listMembers`; surfaces members + a link to the legacy kernel admin console (the operator/admin surface itself).

## `/eaos/capabilities` (`CapabilitiesPage`)

PASS. Adapter mix is derived from `agentsApi.list`. No raw MCP/capability toggles are exposed in the EAOS overview surface.

## Shell-level guards

- `EaosPrimaryNav` only renders `EAOS_PRIMARY_NAV_ZONES`, which does **not** include the legacy `Kernel / Admin` rail any more (`EAOS_KERNEL_NAV` is kept exported for secret-sweep tests but is not rendered in the primary rail).
- The top bar's `Kernel` escape hatch is rendered **only for operator-class viewers**: instance admins and company members whose role is `owner`, `admin`, or `operator`. Customer-class viewers (member / viewer / no membership) do not see the hatch — confirmed by the parallel `populated-customer/` screenshot bucket which captures the same routes with `--viewer customer-member`.
- The bottom posture strip's audit pin (`Audit · n/a`) and `Operator session` label are gated by the same `useEaosViewerRole` hook. Customer viewers see an empty `<footer role="contentinfo">` landmark (preserved for assistive tech) with no visible chrome; the live/approval state chips still appear for any viewer when the context actually applies.
- The kernel/`/agent-os` and `/dashboard` routes remain reachable (preserved per LET-503 requirement #8), so operators retain their normal entry points.
- Every visible string is funnelled through `redactSecretLikeText` at the call-sites that touch user-controlled content (agent name, issue title, capability blob, company name, error messages).

## Overall verdict

**PASS** — no operator-only, admin-only, or destructive control is rendered on any ordinary-user EAOS surface. Where the operator path is still required, the EAOS surface limits itself to an `Open …` link that hands off to the legacy kernel/admin page, which itself enforces operator gating.
