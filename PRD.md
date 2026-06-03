# ValAdrien OS — Product Requirements Document

**Status:** Living document · Fork v0 (2026-05) · Maintained by `ValDola-stack` under [ValAdrien.DEV](https://valadrien.dev)
**Upstream:** Fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip) · MIT
**Related docs:** [README.md](README.md) · [Architecture.md](Architecture.md) · [ROADMAP.md](ROADMAP.md) · [doc/PRODUCT.md](doc/PRODUCT.md) · [doc/SPEC.md](doc/SPEC.md) · [docs/deploy/troubleshooting.md](docs/deploy/troubleshooting.md)

---

## 1. Summary

ValAdrien OS is an **open-source control plane for autonomous AI companies**.
A single deployment runs many companies; each company is an org chart of AI
agents with goals, budgets, tasks, approvals, and a human board. ValAdrien OS
does **not** ship an agent runtime — it orchestrates agents that already exist
(OpenClaw, Claude Code, Codex, Cursor, CLI tools, HTTP bots) into a real
company that runs work, tracks cost, and reports up.

> **One-line:** If OpenClaw is an _employee_, ValAdrien OS is the _company_.

---

## 2. Goals & non-goals

### 2.1 Product goals

| #   | Goal                                                                              | Measurable                                                                              |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| G1  | Time-to-first-success **under 5 minutes** for a fresh user                        | `npx valadrien-os onboard --yes` → CEO completes first task in one sitting              |
| G2  | A user with **20+ parallel coding agents** can answer "who is doing what?" at a glance | One dashboard view shows live state of every agent and every active issue              |
| G3  | **No runaway spend** — budgets are enforced atomically                            | Hard-stop fires before cost exceeds policy; queued work cancels automatically           |
| G4  | **Portable companies** — export/import an entire org with secret scrubbing        | `companies export` → `companies import` reproduces the org on another instance         |
| G5  | **Local-first, cloud-ready** — identical mental model across deployment modes     | `local_trusted` and `authenticated` (private/public) modes share the same surface      |
| G6  | **Bring-your-own-agent** — any runtime that can receive a heartbeat is hireable   | Adapters exist for local CLI sessions, processes, HTTP/webhook, plugins                |

### 2.2 Non-goals

- **Not a chatbot.** Agents have jobs, not chat windows.
- **Not an agent framework.** ValAdrien OS does not prescribe how to build the agent itself.
- **Not a workflow builder.** No drag-and-drop pipelines.
- **Not a Jira/GitHub replacement.** No PR review surface, no full ticketing-suite parity.
- **Not enterprise RBAC v1.** Company memberships and instance roles exist; fine-grained enterprise governance is post-v1.
- **Not single-agent.** If you have one agent, you probably don't need ValAdrien OS.

---

## 3. Target users

### 3.1 Primary persona — "The Operator"

A solo founder, indie hacker, or technical lead running multiple AI agents
across multiple ongoing initiatives. Has lost track of which Claude Code tab is
doing what. Wants the agents to **keep working when they close their laptop**,
and to wake up with an inbox of decisions to make instead of a tangle of dead
terminals.

**Pain points addressed by the product:**

- 20 Claude Code tabs, no persistence, no audit trail
- Hidden token burn from runaway loops
- Manual context-pasting between agents
- No "why is this agent doing this?" trace

### 3.2 Secondary persona — "The Portfolio Operator"

Runs **multiple autonomous companies** (each its own bet, brand, or experiment)
from one ValAdrien OS instance. Wants strict data isolation between companies,
shared infra, and one mobile-friendly board view.

### 3.3 Secondary persona — "The Plugin Author"

Extends ValAdrien OS with knowledge bases, custom tracing, queues, doc editors,
or other domain-specific surfaces. Needs a stable plugin contract and capability
model. See [doc/plugins/PLUGIN_SPEC.md](doc/plugins/PLUGIN_SPEC.md).

### 3.4 Out of scope for v0

- Enterprise security buyers (no SOC 2, no SSO/SCIM)
- Multi-board organizations with delegated authority
- Cross-company shared resources

---

## 4. User journeys

### 4.1 Day-zero install (the magical first 5 minutes)

```
npx valadrien-os onboard --yes
```

1. Embedded Postgres starts, schema migrates.
2. CLI asks for a company name and top-level goal.
3. User defines a CEO agent (adapter type + config).
4. CEO proposes a strategic breakdown → board approves.
5. Heartbeats begin. First task is completed and visible in the dashboard.

**Success criterion:** Steps 1–5 complete in ≤ 5 minutes on a clean machine.

### 4.2 Day-one operation

- User opens the dashboard from phone or laptop.
- Sees: active runs, costs to date, approvals waiting, work products produced.
- Approves a hire, overrides a priority, comments on an issue.
- Agents continue overnight.

### 4.3 Day-thirty governance

- Budgets exceeded on one agent → it's paused automatically.
- User reviews the spend by company → agent → project → issue.
- Routine reports fire on a schedule.
- User exports the company as a template, imports it into a new instance.

---

## 5. Functional requirements

### 5.1 Identity & access

- **R-IA-1** Two deployment modes: `local_trusted` (no auth) and `authenticated` (login required).
- **R-IA-2** Authenticated mode supports `private` and `public` exposure policies.
- **R-IA-3** Board users, agent API keys, and short-lived run JWTs are all distinct credential types.
- **R-IA-4** Every mutating request is traced to an actor (board user, agent, or system).
- **R-IA-5** Bind reachability (`loopback | lan | tailnet | custom`) is independent of auth mode.

### 5.2 Company & org chart

- **R-OC-1** A company is a first-order object. One instance runs many companies with strict data isolation.
- **R-OC-2** Every agent has: id, name, role, title, adapter type, adapter config, status, reporting line.
- **R-OC-3** Org-chart edits (hires, role changes, reporting changes) require board approval at v1.
- **R-OC-4** Agents below the CEO can be assigned budgets that cascade.

### 5.3 Work & tasks

- **R-WK-1** Every issue carries `company`, `project`, `goal`, `parent` links — work always traces to the top-level goal.
- **R-WK-2** Single-assignee model with **atomic checkout + execution lock** — no double-work.
- **R-WK-3** First-class blocker dependencies; comments; issue documents; attachments; work products; review/approval stages.
- **R-WK-4** Inbox state per actor — what needs your attention, what's blocked on you.

### 5.4 Heartbeat execution

- **R-HB-1** DB-backed wakeup queue with coalescing, budget check, workspace resolution, secret injection, skill loading, adapter invocation.
- **R-HB-2** Runs produce structured logs, cost events, session state, and audit trails.
- **R-HB-3** Orphaned-run recovery is automatic.
- **R-HB-4** Heartbeat triggers: cron schedule, event (assignment, @-mention), webhook, manual.

### 5.5 Budget & cost control

- **R-BG-1** Track tokens & cost by company, agent, project, goal, issue, provider, model.
- **R-BG-2** Scoped budget policies with warning thresholds and hard stops.
- **R-BG-3** Overspend pauses the agent and cancels queued work atomically.

### 5.6 Governance & approvals

- **R-GV-1** Board approval workflows with review/approval stages and decision tracking.
- **R-GV-2** Board can pause/resume/terminate any agent at any time.
- **R-GV-3** Config changes are revisioned; bad changes are rollback-safe.
- **R-GV-4** Full audit log of mutating actions, approvals, cost events, and state changes.

### 5.7 Plugins

- **R-PL-1** Out-of-process worker model with capability-gated host services.
- **R-PL-2** Plugins expose tools, contribute UI, register jobs, and respond to events.
- **R-PL-3** Plugins cannot modify core invariants (atomicity, audit trail, governance).

### 5.8 Routines & schedules

- **R-RT-1** Recurring tasks with cron, webhook, and API triggers.
- **R-RT-2** Configurable concurrency and catch-up policies.
- **R-RT-3** Each routine fire creates a tracked issue and wakes the assigned agent.

### 5.9 Workspaces & runtime

- **R-WS-1** Project workspaces, isolated execution workspaces (git worktrees, operator branches), and runtime services (dev servers, preview URLs).
- **R-WS-2** Agents run in the correct directory with the correct context every time.

### 5.10 Portability

- **R-PT-1** Export entire companies — agents, skills, projects, routines, issues — as a portable artifact.
- **R-PT-2** Secret scrubbing on export; collision handling on import.

### 5.11 Telemetry & privacy

- **R-TE-1** Anonymous usage telemetry, enabled by default, disable-able via env (`VALADRIEN_OS_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`), config, or CI detection.
- **R-TE-2** No personal info, issue content, prompts, paths, or secrets are ever sent.
- **R-TE-3** Private repo references are hashed with a per-install salt.

### 5.12 Hosted deployment (ValAdrien.DEV reference stack)

Requirements for internet-facing operator instances (GitHub → Vercel → Supabase):

- **R-HD-1** `authenticated` + `public` mode on the host; embedded Postgres is refused at startup.
- **R-HD-2** `DATABASE_URL` must be a `postgres://` or `postgresql://` URI to hosted Postgres (Supabase or equivalent).
- **R-HD-3** On IPv4-only serverless hosts (Vercel), `DATABASE_URL` must use Supabase **transaction pooler** (port **6543**, user `postgres.[PROJECT-REF]`, host `aws-0-[REGION].pooler.supabase.com`). Direct `db.[ref].supabase.co` URLs are not supported on Vercel when that host is IPv6-only.
- **R-HD-4** When `VALADRIEN_OS_MIGRATION_AUTO_APPLY=true`, set **`DATABASE_MIGRATION_URL`** to the Supabase **session pooler** URL (port **5432** on the same pooler host) so startup migrations use a session-compatible connection while runtime queries use port 6543.
- **R-HD-5** Public URL env vars (`VALADRIEN_OS_API_URL`, `VALADRIEN_OS_AUTH_PUBLIC_BASE_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`) must match the browser bar exactly (custom domain or `.vercel.app`).
- **R-HD-6** `/api/*` must return JSON from the API handler, not SPA `index.html` — verified by `GET /api/health`.
- **R-HD-7** Secrets (`BETTER_AUTH_SECRET`, `VALADRIEN_OS_SECRETS_MASTER_KEY`, provider keys) live in the host env (Vercel Environment Variables), not in git.

Operator procedures: [doc/plans/2026-06-02-host-valadrien-vercel-supabase-walkthrough.md](doc/plans/2026-06-02-host-valadrien-vercel-supabase-walkthrough.md). Failure modes: [docs/deploy/troubleshooting.md](docs/deploy/troubleshooting.md).

---

## 6. Non-functional requirements

| Category          | Requirement                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------- |
| **Performance**   | Onboard → first-task completion in ≤ 5 minutes on a clean Mac/Linux laptop               |
| **Reliability**   | Atomic checkout & budget enforcement; no double-work; orphaned-run recovery is automatic |
| **Portability**   | Embedded Postgres for local mode; hosted Postgres (Supabase pooler on Vercel) for production |
| **Observability** | Structured logs, cost events, durable activity log, immutable audit trail                |
| **Security**      | Encrypted local secret storage; provider-backed storage; capability-gated plugins        |
| **Compatibility** | Node.js 20+, pnpm 9.15+                                                                  |
| **Accessibility** | UI conforms to WCAG AA color contrast; brand SVGs in light + dark variants               |
| **License**       | MIT — preserved from upstream                                                            |

---

## 7. Fork-specific requirements

This document is for the **ValAdrien OS fork** of `paperclipai/paperclip`. The
following requirements are inherited from the fork's existence and are
**additive** to the upstream product surface.

| #     | Requirement                                                                                    | Status |
| ----- | ---------------------------------------------------------------------------------------------- | ------ |
| F-1   | All packages publish under the `@valadrien-os/*` npm scope                                     | ✅ rebranded; ⚪ publishing deferred |
| F-2   | All human-facing strings use **"ValAdrien OS"** (capital A) as the product name                | ✅ |
| F-3   | All git/manifest/badge URLs point to `ValDola-stack/valadrien-os`                              | ✅ |
| F-4   | Brand SVG assets (wordmark + mark, light/dark) live under `doc/assets/brand/`                  | ✅ |
| F-5   | Upstream `paperclipai/paperclip` is wired as a read-only `upstream` remote (`no_push`)         | ✅ |
| F-6   | CI policy/verify gates pass on the fork; transitional exemptions are documented and bounded   | ✅ (lockfile exemption + release-bootstrap warning, both reversible) |
| F-7   | `@valadrien-os/*` packages are `publishFromCi: false` until the scope is bootstrapped on npm   | ✅ deferred |
| F-8   | Brand-owner placeholders (`TODO_DOMAIN`, `TODO_DISCORD`, `TODO_TWITTER`) are explicit and grep-able | ✅ tokens are intentional |
| F-9   | Upstream copyright, license, and attribution are preserved                                     | ✅ |
| F-10  | Sync model with upstream is documented in `README.md` "About this fork"                        | ✅ |

---

## 8. Success metrics

### 8.1 Product metrics (post-launch)

- **TTFS (Time to First Success):** median ≤ 5 minutes; p90 ≤ 10 minutes.
- **DAU/MAU of board surface:** measures whether operators actually return.
- **Companies per instance:** distribution; we expect a long tail of users with 2–5 companies.
- **% agents under budget policy:** target > 95% — runaway spend should be the exception.
- **Approvals turned around per board user per day:** signal for governance ergonomics.

### 8.2 Fork health metrics

- **Days since last upstream merge.** Target: ≤ 30. Larger gaps create merge cost.
- **# merge conflicts per upstream sync.** Target: trending down as the rebrand stabilizes.
- **% upstream PRs forward-portable without manual fix.** Target: ≥ 80% within the first year.

### 8.3 Ecosystem metrics

- **GitHub stars on `ValDola-stack/valadrien-os`** (vanity but real).
- **# entries in `awesome-valadrien-os`** (community plugin / template signal).
- **# external adapter plugins published.**

---

## 9. Open questions

1. **When do we publish `@valadrien-os/*` to npm?** Today the scope is reserved
   but no packages are published. We need a yes/no on enrolling at least the
   CLI (`@valadrien-os/cli`) once brand placeholders resolve. Tracked in
   `scripts/release-package-manifest.json`.
2. **Will the fork accept upstream-incompatible changes?** Today we prefer
   forward-portability. The OpenClaw deeper integration (Roadmap Phase 5) may
   force a breaking divergence — we should pick a policy before it ships.
3. **Telemetry endpoint domain.** `TODO_DOMAIN` needs to resolve before
   telemetry can be enabled end-to-end on the fork.
4. **Brand surfaces.** Discord and Twitter placeholders are intentional;
   replacing them is a brand-owner decision, not a code one.
5. **Stubbed `scripts/release.sh` / `scripts/build-npm.sh`** — re-enable or
   delete before the first `@valadrien-os/*` publish.

---

## 10. Roadmap pointers

The product roadmap (shipped + planned) lives in [ROADMAP.md](ROADMAP.md). At
the time of this PRD, the fork is targeted at:

- **Stabilizing the rebrand pass** (this PR / branch)
- **Pulling the next upstream sync** without conflict surprises
- **Phase 5 — deeper OpenClaw integration** as the first fork-led feature

Anything beyond these three should be reviewed against the goals in §2.1 before
committing engineering time.

---

## 11. Appendix — upstream alignment

The fork's product surface is intentionally **a superset of upstream**, never a
subset. Concretely:

- All upstream features remain.
- All upstream APIs and data models remain.
- All upstream extension points (plugins, adapters, skills) remain.
- Names, brands, badges, and packaging change.
- The fork is free to **add** features (e.g. ValAdrien.DEV-branded UI,
  OpenClaw-first adapter polish) without removing anything.

This makes upstream sync mechanical for the foreseeable future. See
[Architecture.md](Architecture.md) §11 ("Fork delta") for the file-level
inventory of what the rebrand actually touches.
