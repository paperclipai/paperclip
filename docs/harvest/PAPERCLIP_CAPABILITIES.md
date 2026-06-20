# Paperclip — Capabilities Harvest

> Final Claude Max institutional harvest. Read-only analysis. No code modified.
> Generated 2026-06-20 against `master` @ `bb5f60ef`.
>
> **Legend:** `[OBSERVED]` = confirmed by running code, on-disk artifacts, or schema/source inspection during this harvest. `[DOCUMENTED]` = stated in repo docs/README/config but not independently confirmed against a live runtime in this pass.

---

## 1. What Paperclip Actually Does Today

Paperclip is a **control plane for AI-agent companies** — a Node.js (Express) REST API + React/Vite board UI that orchestrates a team of heterogeneous AI agents toward business goals. It is *not* an agent framework and *not* a chatbot; it models the **organization** the agents work inside: org charts, budgets, governance, goals, ticketing, and coordination.

The mental model: **OpenClaw is an employee; Paperclip is the company.** "If it can receive a heartbeat, it's hired."

### Runtime shape `[OBSERVED]`
- Single Node process in dev, embedded PostgreSQL (PGlite / embedded-postgres) auto-provisioned, local file storage. API at `http://localhost:3100`, UI served by the same process in dev middleware mode.
- This repo is a **working fork** of `paperclipai/paperclip` (upstream author "Dotta", 1894 commits) carrying the HenkDz fork QoL line, with **51 founder commits (Michael Bennett)** layering institutional-grade operational tooling on top. 2371 commits total, Feb–May 2026.
- It is **actively run as a live business control plane**, not a demo: on-disk runtime artifacts show 2 real companies (QSL, SELARIX), 13 agents, 12 prompt caches, 17 DB backup archives (631 MB), most recent backup 0.5h before the last guardian run.

### The core control-plane systems `[OBSERVED in source]`

| System | What it does | Where it lives |
|---|---|---|
| **Identity & Access** | Two deploy modes (trusted local loopback / authenticated). Board users (full-control operator), agent bearer API keys (SHA-256 hashed at rest), short-lived run JWTs, company memberships, invites, join-request dedupe. | `server/src/auth`, `server/src/agent-auth-jwt.ts`, `server/src/services/access.ts` |
| **Org Chart & Agents** | Agents have roles, titles, reporting lines, permissions, budgets, adapter type + config. Org chart SVG generation. | `server/src/routes/agents`, `org-chart-svg`; `packages/db/src/schema/agents.ts` |
| **Work & Tasks (Issues)** | Issues carry company/project/goal/parent links, **atomic checkout with execution locks** (`FOR UPDATE`), first-class blocker dependencies, comments, documents (plans/work products), labels, inbox state, single-assignee invariant. | `server/src/services/heartbeat.ts`, `issue-tree-control.ts`; `schema/issues.ts` |
| **Heartbeat Execution** | DB-backed wakeup queue with coalescing, budget checks, environment/workspace resolution, secret injection, skill loading, adapter invocation. Produces structured logs (stdout/stderr/system), cost events, session state, audit trail. ~1100-line coordinator. | `server/src/services/heartbeat.ts`, `run-log-store.ts`, `agent-start-lock.ts` (30s in-memory mutex) |
| **Governance & Approvals** | Approval workflows (pending→approved/rejected/revision), execution policies with review/approval stages, decision tracking, budget hard-stops, agent pause/resume/terminate, dangerous-permission reporting (`dangerouslySkipPermissions`), stale-agent detection (7d). | `services/approvals.ts`, `issue-approvals.ts`, `governance-risks-export.ts` |
| **Budget & Cost Control** | Token/cost tracking by company, agent, project, goal, issue, provider, model. Scoped budget policies, warning thresholds, hard-stops that auto-pause agents and cancel queued work. Quota-window aggregation across providers. | `services/budgets.ts`, `costs.ts`, `finance.ts`, `quota-windows.ts` |
| **Workspaces & Runtime** | Project workspaces, isolated execution workspaces (git worktrees, operator branches), environment leases (ephemeral/sticky/managed), runtime services (dev servers, preview URLs) with readiness/liveness. | `services/execution-workspaces.ts`, `environments.ts`, `workspace-realization.ts`, `workspace-runtime.ts` |
| **Routines & Schedules** | Recurring work via cron/webhook/API triggers. Lightweight 5-field cron parser. Concurrency + catch-up policies (max 25 catch-up runs). Each run creates a tracked issue and wakes the assignee. Trigger signing (none/basic/jwt). | `services/routines.ts`, `cron.ts` |
| **Plugins** | Instance-wide out-of-process worker plugins (JSON-RPC 2.0 over stdio), capability-gated host services, job scheduling, tool exposure, custom DB/entities, UI contributions (sidebar/pages/widgets), custom API routes, environment drivers. | `packages/plugins/sdk`, `server/src/services/plugin-*.ts` (lifecycle, worker-manager, job-coordinator, event-bus, tool-dispatcher) |
| **Secrets & Storage** | Instance + company secrets (versioned), encrypted local storage, S3 object storage, attachments, work products. Sensitive-env regex redaction in logs. Secret-ref bindings resolved only for scoped runs. | `services/secrets.ts`, `server/src/storage/` (local-disk, s3), `log-redaction.ts` |
| **Activity & Events** | Durable audit log of mutating actions, heartbeat state changes, cost events, approvals, comments, work products. Mapped to plugin domain events. | `services/activity-log.ts` |
| **Company Portability** | Export/import entire orgs (agents, projects, workspaces, issues, routines, skills, goals, sidebar order) with secret scrubbing, collision strategies (error/rename/merge/overwrite), preview, checksum change-detection. ~1000-line service. | `services/company-portability.ts` |

### Surface area `[OBSERVED]`
- **39 REST route groups** under `/api` (agents, issues, approvals, costs, routines, plugins, secrets, environments, execution-workspaces, company-portability, board-export, instance-database-backups, qsl-bridge, etc.).
- **~110+ service files, ~60k lines** of orchestration logic in `server/src/services`.
- **~70 Drizzle tables** in `packages/db/src/schema` (companies, agents, issues, heartbeat_runs, approvals, budget_policies, cost_events, finance_events, routines, plugins + plugin_*, environments, company_secrets, activity_log, agent_runtime_state, agent_task_sessions, qsl_findings, workspace_operations, …).
- **MCP server** (`packages/mcp-server`) exposes ~40 Paperclip tools over stdio for Claude Code / compatible clients (inbox, issues CRUD, checkout, comments, documents, suggest-tasks / ask-questions / request-confirmation interaction kinds, approvals resolve, workspace runtime control).
- **7 agent adapters** (`packages/adapters`): `claude-local`, `codex-local`, `cursor-local`, `gemini-local`, `opencode-local`, `pi-local`, `openclaw-gateway` — all implementing one `ServerAdapterModule` contract (`execute`, `testEnvironment`, `sessionCodec`, `listSkills/syncSkills`, `getConfigSchema`, `listModels/refreshModels`, `onHireApproved`, `getQuotaWindows`).
- **React board UI** (`ui/src/pages`): Dashboard (+Live), Activity, Agents/AgentDetail/NewAgent, OrgChart, Issues/IssueDetail/MyIssues, Projects, Workspaces/ExecutionWorkspaceDetail, Approvals/ApprovalDetail, Goals, Costs, Routines, CompanySettings/Access/Invites/Skills/Export/Import, InstanceSettings, PluginManager, AdapterManager, **QslReview**, plus UX-lab + DesignGuide showcases. Shadcn/UI-style primitives under `components/ui`.
- **CLI** (`cli/src`): `onboard`, `doctor`, `configure`, `run`, `env`, `allowed-hostname`, `db:backup`, `auth bootstrap-ceo`, `heartbeat run`, and client command groups (company, issue, agent, approval, activity, dashboard, plugin, routines, worktree).

---

## 2. Capabilities That Already Exist (Founder May Have Forgotten)

These are real, in-tree, and easy to overlook because they were built in focused sprints and then left running:

1. **A full institutional runtime-health stack in Python** (`scripts/*.py`, ~145 KB across 7 files) — `[OBSERVED on disk + executed]`:
   - `runtime_topology_report.py` — enumerates all companies/projects/agents/caches/storage/backups; detects orphans, duplicates (instruction-hash collisions), missing metadata, staleness (14d).
   - `runtime_guardian.py` — weighted 0–100 health score across 6 dimensions (durability, governance, topology_stability, remediation_health, backup_reliability, operational_continuity) + 7 checks; `--watch`, `--remediate`, `--history`, `--trends`; escalation tracker.
   - `runtime_remediator.py` — approval-aware, non-destructive corrective workflow engine; state machine pending→approved→executed/failed/expired; fingerprint dedup; auto-runs safe inspections, gates destructive ops.
   - `runtime_history.py` — append-only JSONL snapshot trends.
   - `runtime_rotation.py` — deterministic retention/rollover (no silent deletion).
   - `runtime_export.py` — portable, SHA-256-verifiable continuity bundles (migration / incident recovery / cold storage).
   - `governance_checkpoint.py` — durable, deterministic governance checkpoints with **hash-chained continuity** (each checkpoint hashes the previous).
   - **This stack has actually run** `[OBSERVED]`: `logs/runtime-guardian/guardian-latest.json` (health 90.2, status warning, escalation=critical after 7 consecutive warnings), 3 governance checkpoints in a verified chain (`GENESIS → CHAIN-79de… → CHAIN-c9a1…`), pending + executed remediation plans, and 2 full export bundles (`logs/exports/paperclip-export-20260516-*`).

2. **QSL findings persistence subsystem** — a DB-backed security-finding review system with fingerprint dedup, append-only review history, durable human approve/deny decisions, and a `database → bridge_error_fallback → bridge → empty` fallback hierarchy exposed via `X-QSL-Source` header. `qsl_findings` table (migrations 0071/0072), `services/qsl-review.ts`, `routes/qsl-bridge.ts`, `ui/pages/QslReview.tsx`. `[OBSERVED in source + changelog]`

3. **Board intelligence export** (`board_exports/`, `server/scripts/generate-board-export.ts`) — generates a board-review packet: agents.{json,md}, company_map, issues triage, governance.md (approval rules, pending approvals, permission grants, authority tiers), crawdaddy_transaction_integrity.md, and a combined `board_review_packet.md`. This directly implements the user's "always generate review packet first" rule. `[OBSERVED on disk]`

4. **Provider routing infrastructure (Stage 0)** — deterministic provider routing with risk classification (low/medium/high), circuit-breaker state, fallback eligibility — **decision logic only, no live fallback wired yet**. `services/provider-routing.ts`, `provider-routing-policy.ts`. `[OBSERVED in source]`

5. **Recovery / liveness / deadlock subsystem** — `server/src/services/recovery/*` + `run-liveness.ts`, `run-continuations.ts`: run-liveness states (active/stalled/succeeded/failed/continued/cancelled/unknown), output-silence detection (1h suspicion / 4h critical / 30m rearm), issue-graph liveness (blocked-by-unassigned/uninvokable/cancelled), automatic continuation with attempt limits (max 2), pause-hold guard. `[OBSERVED in source]`

6. **Heartbeat quota-protection guardrails** (latest commit `bb5f60ef`) — guards to prevent runaway Claude quota drain. `[DOCUMENTED in commit; source present]`

7. **Company templates / clipmart precursor** — `templates/qsl-instance-backup/` is a complete portable instance snapshot (companies, data, db, projects, workspaces, config) and `templates/QSL_PAPERCLIP_CONTEXT.md` is a 160-line agent operating charter. This is the raw material for upstream's "Clipmart" (download-and-run companies). `[OBSERVED on disk]`

8. **5 runtime-injectable skills** (`skills/`): `paperclip` (core coordination), `paperclip-create-agent`, `paperclip-create-plugin`, `paperclip-dev`, `para-memory-files` (PARA-method file memory for long-running agents). `[OBSERVED on disk]`

---

## 3. Why Paperclip Looks More Mature Than Most Ecosystem Repos

- **Contract discipline across 4 layers.** `AGENTS.md` mandates that any schema/API change be synced across `packages/db` → `packages/shared` (types/validators/constants/API paths) → `server` routes/services → `ui` clients. Shared Zod validators + typed API path constants make the seams explicit. `[OBSERVED]`
- **Hard control-plane invariants, written down and enforced:** single-assignee tasks, atomic checkout, approval gates, budget hard-stop auto-pause, activity logging for every mutation. `[OBSERVED in AGENTS.md + heartbeat/checkout source]`
- **Atomicity is real, not aspirational:** `FOR UPDATE` row locks in heartbeat/checkout, `db.transaction()` around access/agent/company mutations, a dedicated `agent-start-lock` mutex to serialize concurrent heartbeat starts. `[OBSERVED]`
- **Operational governance as a first-class engineering artifact:** dated `architecture_changelog.md`, a real risk register (`governance_risks.md`, GR-001…GR-006), a subsystem assessment (`liveness_report.md`), and a stated, defended hardening order: **persistence → liveness/deadlock → data confidence → backup/recovery → provider routing**. Most repos have none of this. `[OBSERVED]`
- **Tiered verification etiquette:** cheap default (`pnpm test` = Vitest only), opt-in browser suites, "run the smallest relevant check first," full `typecheck+test+build` only for PR-ready hand-off. `[OBSERVED in AGENTS.md]`
- **Disaster recovery that has actually executed** — backups (17 archives), continuity exports, hash-chained governance checkpoints. The maturity is *demonstrated by artifacts*, not just claimed. `[OBSERVED]`
- **Telemetry, security policy, contributing guide, PR template with "Thinking Path" + "Model Used"** — open-source-grade project hygiene. `[OBSERVED]`

---

## 4. Engineering Practices Worth Copying Across the Ecosystem

(Expanded in `PAPERCLIP_MAINTAINER_GUIDE.md` §"What to copy.")

1. **Four-layer contract sync** (db ↔ shared ↔ server ↔ ui) with a single shared package owning types, validators, constants, and API paths.
2. **Invariant list at the top of `AGENTS.md`** — the non-negotiables an agent/contributor must not break.
3. **Dated architecture changelog + risk register + sequenced hardening order** as committed files.
4. **Deterministic (non-AI) governance checkpoints with hash chains** — cheap, auditable, restorable continuity that doesn't burn tokens.
5. **Approval-aware, non-destructive remediation** — auto-run safe inspections, gate destructive actions, dedup by fingerprint, expire stale plans.
6. **Fallback hierarchy with source-of-truth header** (`database → fallback → bridge → empty`, surfaced via response header) for any system bridging files and a DB.
7. **Tiered test etiquette** to keep agent heartbeats cheap.
8. **Secret-ref bindings + log redaction** so secrets never enter prompts/logs unless a scoped run needs them.

---

## 5. Observed vs Documented — Summary Table

| Claim | Status | Evidence |
|---|---|---|
| 2 live companies, 13 agents, 12 caches | `[OBSERVED]` | `guardian-latest.json` topology_summary |
| 17 DB backups, 631 MB, freshest 0.5h | `[OBSERVED]` | guardian `backup_freshness` check |
| Health score 90.2, escalation=critical (7 warnings) | `[OBSERVED]` | `guardian-latest.json` |
| Governance checkpoint hash-chain works | `[OBSERVED]` | `checkpoint-index.jsonl` (GENESIS→CHAIN→CHAIN) |
| Remediation plans pending + executed | `[OBSERVED]` | `logs/runtime-remediation/{pending,executed}` |
| QSL findings DB persistence + fallback | `[OBSERVED]` | source + `architecture_changelog.md` |
| Atomic checkout / FOR UPDATE / tx | `[OBSERVED]` | `heartbeat.ts`, access/agent/company services |
| Provider routing **live fallback** | `[DOCUMENTED]` | Stage 0 = decision logic only, not wired |
| Heartbeat quota guardrails effective | `[DOCUMENTED]` | commit `bb5f60ef`; not load-tested here |
| Multi-company isolation in production | `[DOCUMENTED]` | enforced in source; not penetration-tested here |
| Moltbook integration | `[OBSERVED BROKEN]` | `MOLTBOOK_INTEGRATION.md`: 401, key rejected since 2026-04-09 |
