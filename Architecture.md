# ValAdrien OS — Architecture

**Status:** Living document · Fork v0 (2026-05) · Maintained by `ValDola-stack` under [ValAdrien.DEV](https://valadrien.dev)
**Upstream:** Fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
**Companions:** [README.md](README.md) · [PRD.md](PRD.md) · [doc/SPEC.md](doc/SPEC.md) · [doc/GOAL.md](doc/GOAL.md) · [doc/DEPLOYMENT-MODES.md](doc/DEPLOYMENT-MODES.md)

This document is the high-altitude architectural view. For wire-level field
definitions and protocol rules, follow the links into `doc/SPEC.md`. For the
fork-specific delta vs upstream, see §11.

---

## 1. Two-layer model

ValAdrien OS is split into a **control plane** (this repo) and **execution
adapters** (everything that actually runs an agent). The control plane never
runs agent code itself.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          CONTROL PLANE (this repo)                       │
│                                                                          │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│   │  Identity    │  │   Work &     │  │  Heartbeat   │  │ Governance  │  │
│   │  & Access    │  │   Tasks      │  │  Execution   │  │ & Approvals │  │
│   └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘  │
│                                                                          │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│   │  Org Chart   │  │ Workspaces   │  │   Plugins    │  │  Budget &   │  │
│   │  & Agents    │  │ & Runtime    │  │              │  │  Costs      │  │
│   └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘  │
│                                                                          │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│   │  Routines    │  │ Secrets &    │  │  Activity    │  │  Company    │  │
│   │ & Schedules  │  │ Storage      │  │  & Events    │  │ Portability │  │
│   └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                  ▲              ▲              ▲              ▲
            ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐
            │ Claude    │  │  Codex    │  │  CLI      │  │ HTTP/web  │
            │  Code     │  │           │  │  agents   │  │   bots    │
            └───────────┘  └───────────┘  └───────────┘  └───────────┘
                              EXECUTION ADAPTERS
```

The control plane is responsible for orchestration, durability, governance,
cost, and audit. Adapters are responsible for translating "wake up and do
work" into whatever the agent runtime actually understands.

---

## 2. Repository topology

ValAdrien OS is a **pnpm monorepo**. Major workspaces:

| Path           | Purpose                                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| `server/`      | Node.js API server, durable jobs, heartbeat queue, governance, cost tracking    |
| `ui/`          | React control surface (board view, agent view, issue view, approvals, costs)    |
| `cli/`         | The `valadrien-os` binary — `onboard`, `configure`, `companies`, `dev`, etc.   |
| `packages/*`   | Shared workspace libraries under the `@valadrien-os/*` scope                    |
| `doc/`         | Specs, plans, deployment, plugin spec, brand assets                              |
| `scripts/`     | Release manifest, bootstrap checks, lockfile policies                            |
| `.github/`     | PR policy, verify, release workflows                                             |

All package names use the `@valadrien-os/*` scope. The CLI publishes (in the
future) as the `valadrien-os` binary.

---

## 3. Runtime topology

### 3.1 Single-process local mode (`local_trusted`)

```
                     ┌─────────────────────────────────────┐
                     │  Single Node.js process             │
                     │                                     │
   browser/CLI ◀────▶│   ┌───────────┐    ┌────────────┐   │
                     │   │ API/HTTP  │◀──▶│ React UI   │   │
                     │   └────┬──────┘    └────────────┘   │
                     │        │                            │
                     │        ▼                            │
                     │   ┌───────────┐    ┌────────────┐   │
                     │   │ Job queue │◀──▶│  Adapters  │   │
                     │   └────┬──────┘    └────────────┘   │
                     │        │                            │
                     │        ▼                            │
                     │   ┌─────────────────────────────┐   │
                     │   │  Embedded Postgres + files  │   │
                     │   └─────────────────────────────┘   │
                     └─────────────────────────────────────┘
```

- Single process, embedded Postgres, local file storage.
- No login. Loopback bind by default.
- Optimized for the first-5-minute experience.

### 3.2 Authenticated mode (`authenticated` + `private`/`public`)

- Same code path, different auth + bind config.
- External Postgres recommended.
- Object storage (provider-backed) for attachments/work products.
- Bind: `lan` or `tailnet` for `private`; explicit `custom` config for `public`.

See [doc/DEPLOYMENT-MODES.md](doc/DEPLOYMENT-MODES.md) for the canonical mode
matrix.

---

## 4. Subsystems

### 4.1 Identity & Access

- **Actors:** board users, agents (API keys), runs (short-lived JWTs), system.
- **Mode-aware:** `local_trusted` skips human auth; `authenticated` enforces login.
- **Company memberships** scope a board user to one or more companies.
- **Bind** (`loopback | lan | tailnet | custom`) is independent of auth mode.

### 4.2 Org Chart & Agents

- Every employee is an **Agent**, defined by an **adapter type** + **adapter config**.
- Agents have role, title, reporting line, status, and budget bindings.
- ValAdrien OS protocol-level state is small: id, name, role, reporting, adapter
  type, adapter config blob, status. Adapter-specific config (e.g.
  `SOUL.md`, `HEARTBEAT.md`, `CLAUDE.md`) is opaque to the control plane.
- Built-in adapters: local CLI sessions (Claude Code, Codex, Gemini, OpenCode,
  Pi, Cursor), process exec, HTTP/webhook, OpenClaw gateway, plugin-provided.

### 4.3 Work & Tasks

- **Issue** is the unit of work. Carries: `company`, `project`, `goal`, `parent`, `assignee`, `state`, `priority`, `documents`, `attachments`, `work products`, `blockers`, `comments`, `review/approval state`.
- **Atomic checkout + execution lock** — single-assignee model, no double-work.
- **Blocker dependencies** are first-class and traversable.
- **Inbox** is a per-actor projection of "what needs you."

### 4.4 Heartbeat Execution

```
   schedule / event / webhook / manual
              │
              ▼
   ┌──────────────────────┐
   │  Wakeup queue (DB)   │   ◀── coalescing
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │  Budget check        │   ◀── hard-stop if over
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │  Workspace resolve   │   ◀── project / execution workspace
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │  Secret injection    │   ◀── scoped, per-run
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │  Skill loading       │   ◀── runtime skill injection
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │  Adapter invoke      │   ◀── adapter contract starts here
   └──────────┬───────────┘
              ▼
   structured logs · cost events · session state · audit
```

Orphaned-run recovery is automatic. Cost events stream during the run, not
just at the end, so budgets can hard-stop mid-flight.

**Run-id audit header:** Every mutating API request issued from inside a
heartbeat MUST carry the run id on the `X-Valadrien-Os-Run-Id` header
(canonical kebab-case; lowercased to `x-valadrien-os-run-id` by Node). The
server stamps it into the activity log so each side effect is traceable
back to the exact heartbeat run. The rebrand codemod also stamped a
no-dash spelling `X-ValadrienOs-Run-Id` into several TS callers (the MCP
client, the Cloudflare sandbox bridge, the signoff e2e test, several
adapter LLM-facing docstrings); `server/src/middleware/auth.ts` currently
accepts both forms as a compat shim. See
[`doc/plans/2026-05-29-canonicalize-run-id-header.md`](doc/plans/2026-05-29-canonicalize-run-id-header.md)
for the planned cleanup that retires the alternate spelling.

### 4.5 Governance & Approvals

- Approval workflows are **first-class workflow steps**, not ad-hoc comments.
- Reviewers, approval gates, change requests, decision records.
- Board has unrestricted live control: pause/resume any agent or work item,
  override priorities, modify budgets, terminate.

### 4.6 Budget & Cost

- Cost is tracked by `(company, agent, project, goal, issue, provider, model)`.
- Scoped budget policies with warning thresholds and hard stops.
- Overspend → pause + cancel queued work, atomically.

### 4.7 Plugins

- **Out-of-process worker** model with capability-gated host services.
- Plugins can: contribute UI, register tools, schedule jobs, listen on events.
- Plugins cannot break invariants (atomicity, audit trail, governance gates).
- See [doc/plugins/PLUGIN_SPEC.md](doc/plugins/PLUGIN_SPEC.md).

### 4.8 Routines & Schedules

- Cron / webhook / API triggers.
- Concurrency + catch-up policies.
- Each fire creates a real **Issue** and wakes an agent — recurring work uses
  the same data model as everything else.

### 4.9 Workspaces & Runtime

- **Project workspace** — the canonical directory for a project.
- **Execution workspace** — isolated per-run (git worktrees, operator branches).
- **Runtime services** — dev servers, preview URLs, attached to a workspace.

### 4.10 Secrets & Storage

- Instance + company secret scopes.
- Encrypted local storage by default; provider-backed object storage for
  production.
- Secrets are **never** in prompts unless a scoped run explicitly requests them.

### 4.11 Activity & Events

- Every mutating action, heartbeat state change, cost event, approval, comment,
  and work product is recorded as durable activity.
- Activity feeds both the audit log and the UI.

### 4.12 Company Portability

- Export/import an entire org (agents, skills, projects, routines, issues).
- Secret scrubbing on export.
- Collision handling on import.
- Foundation for ClipMart-style company templates.

---

## 5. Data model (high level)

```
Company
  ├── Initiatives (Goals)
  ├── Projects
  │     └── Issues ──┬── Comments
  │                  ├── Documents
  │                  ├── Attachments
  │                  ├── Work Products
  │                  ├── Blockers (→ Issue)
  │                  └── Review / Approval state
  ├── Agents
  │     ├── Adapter type + config blob
  │     ├── Org position (reports to / reports of)
  │     ├── Status
  │     └── Budget bindings
  ├── Routines
  ├── Budgets & Cost events
  ├── Approvals & Decisions
  └── Activity log (audit)

Instance
  ├── Board users
  ├── Company memberships
  ├── Instance roles
  ├── Plugins
  ├── Secrets (instance + company scopes)
  └── Telemetry config
```

Every record is **company-scoped**. The instance scope holds plugins,
secrets, and human users. Company isolation is enforced at the query layer.

See [doc/SPEC.md](doc/SPEC.md) §1–§5 for the canonical field-level definitions.

---

## 6. Request lifecycle

A representative path — "board user marks an issue ready for an agent":

```
1. UI (React)                  → POST /api/issues/:id/transition
2. API (server/)               → auth: board user, company-scoped
3. Domain logic                → state machine: must be a legal transition
4. Persistence (Postgres)      → atomic update + activity event
5. Heartbeat queue             → schedule wake for the assigned agent
6. Adapter resolution          → look up adapter type + config
7. Budget check                → fail-fast if over budget
8. Workspace + secrets         → prepare run scope
9. Adapter invoke              → the agent actually starts work
10. Run streaming              → cost events + logs land in real time
11. UI subscribes              → live update of run state + costs
```

Steps 2–5 are within a single transactional boundary so a partial failure
cannot leave the system inconsistent.

---

## 7. Invariants

These are non-negotiable. Plugins, adapters, and new features must respect
them. Violating any of these is a Sev-2+ bug.

| #   | Invariant                                                                                  |
| --- | ------------------------------------------------------------------------------------------ |
| I-1 | Issues have **at most one assignee** with an **execution lock** at any time                 |
| I-2 | Budget checks fire **before** adapter invocation and **during** a run                       |
| I-3 | Every mutating action is **traceable to an actor** (user / agent / system)                  |
| I-4 | **Company isolation** is enforced at the query layer; no cross-company reads in normal API |
| I-5 | Approvals are **revisioned**; rollback is safe                                              |
| I-6 | Telemetry **never** sends issue content, prompts, paths, or secrets                         |
| I-7 | Secrets are **not in prompts** unless a scoped run explicitly requests them                 |
| I-8 | Orphaned runs are **recovered**, not silently lost                                          |
| I-9 | All work traces to a **company goal**                                                       |

---

## 8. Cross-cutting concerns

### 8.1 Telemetry

Anonymous usage telemetry, off-by-default-able via env (`VALADRIEN_OS_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`), config, or CI detection. Private repo references are hashed per install. **Issue content, prompts, paths, and secrets are never sent.**

### 8.2 Logging & observability

- Structured logs per process.
- Cost events as durable records.
- Activity log as the audit trail.
- Plugin authors can subscribe to events but cannot mutate them.

### 8.3 Security

- Encrypted local secret storage; provider-backed object storage in production.
- Capability gates on plugins.
- Bind/auth modes are independent; `public` exposure requires explicit `authenticated`.

### 8.4 Performance

- Heartbeat queue uses coalescing to avoid thundering herds.
- Budget checks are O(1) per run; cost streaming is append-only.
- UI streams run state instead of polling.

---

## 9. Build, release, and CI

### 9.1 Local dev

```bash
pnpm install
pnpm dev              # API + UI in watch mode
pnpm typecheck
pnpm test             # Vitest (no Playwright)
pnpm test:e2e         # Playwright suite
pnpm build
```

### 9.2 CI gates (`.github/workflows/pr.yml`)

- **PR / policy** — lockfile gate, release-bootstrap validation, ownership rules.
- **PR / verify** — typecheck, build, unit tests (depends on policy).
- Fork-specific transitional exemptions:
  - `rebrand/valadrien-os` is exempt from the lockfile gate (one-time, removable after the rebrand merges).
  - `scripts/release-package-map.mjs` warns instead of throwing when zero packages are enabled for CI publish (so the fork can ship before the `@valadrien-os/*` npm scope is bootstrapped).

### 9.3 Release pipeline

- `scripts/release-package-manifest.json` enumerates publishable packages.
- v0 fork status: **all 24 `@valadrien-os/*` packages are `publishFromCi: false`**.
- The `scripts/check-release-package-bootstrap.mjs` script validates that every
  release-enabled package exists on npm before allowing CI to publish.
- `scripts/release.sh` and `scripts/build-npm.sh` are stubbed pending the
  publishing decision (originals saved as `.bak`).

### 9.4 Branching

- `master` — fork's primary branch (matches upstream's default branch name).
- `rebrand/valadrien-os` — the rebrand pass.
- `sync/upstream-YYYYMMDD` — periodic upstream merges (see §10).
- `chore/refresh-lockfile` — standing exemption for CI-driven lockfile refresh.

---

## 10. Upstream sync model

The fork is intentionally **a superset of upstream**, never a subset. This is
what keeps merges mechanical.

```
upstream (paperclipai/paperclip:master)
        │
        │ git fetch upstream
        ▼
   sync/upstream-YYYYMMDD  ◀── merge upstream/master, resolve renamed paths
        │
        │ pnpm install && typecheck && test
        ▼
   master (ValDola-stack/valadrien-os)
```

**Predictable conflict surface:**

- `package.json` (every workspace) — name/scope/repo URL fields
- `README.md` and `doc/*` — product name, badges, URLs
- CLI banners and onboarding strings
- Telemetry env-var prefixes (`VALADRIEN_OS_*`)
- Brand assets in `doc/assets/`

`upstream` is configured `no_push` so the fork cannot accidentally push fork
commits back to Paperclip:

```bash
git remote add upstream https://github.com/paperclipai/paperclip.git
git remote set-url --push upstream no_push
```

---

## 11. Fork delta vs upstream

The rebrand pass touches a predictable set of categories. Everything else is
**identical** to upstream.

| Category                  | Changed | What changed                                                                      |
| ------------------------- | ------- | --------------------------------------------------------------------------------- |
| Domain model              | ❌      | Same companies, agents, issues, heartbeats, budgets, approvals                    |
| APIs / wire protocols     | ❌      | Same routes, same payloads                                                        |
| Plugin contract           | ❌      | Same capability gates, same host services                                         |
| Adapter contract          | ❌      | Same callable / status-reporting / cost-reporting contracts                       |
| npm scope                 | ✅      | `@paperclipai/*` → `@valadrien-os/*` across 24 workspace packages                  |
| Product name strings      | ✅      | `Paperclip` / `PaperclipAI` → `ValAdrien OS`                                       |
| CLI binary                | ✅      | `paperclip` → `valadrien-os`                                                       |
| Telemetry env prefix      | ✅      | `PAPERCLIP_TELEMETRY_DISABLED` → `VALADRIEN_OS_TELEMETRY_DISABLED`                 |
| Repo / badge URLs         | ✅      | `paperclipai/paperclip` → `ValDola-stack/valadrien-os`                             |
| Brand assets              | ✅      | New `doc/assets/brand/` SVGs (wordmark + mark, light/dark)                         |
| CI policy exemptions      | ✅      | Lockfile gate + release-bootstrap warning — both bounded and removable             |
| Release manifest          | ✅      | `publishFromCi: false` on all `@valadrien-os/*` packages pending npm bootstrap     |

When in doubt: if a change is **renaming**, it belongs in the fork. If it
changes **behavior**, it should be upstream first.

---

## 12. Open architectural questions

These are the unresolved architectural decisions the fork will need to make.
They are tracked here so they don't get lost between PRs.

1. **Multi-board governance.** v1 assumes a single human board. The data model
   already supports `Company memberships` and `Instance roles` — the missing
   piece is the **approval routing policy** when more than one human can sign
   off. Block on real users requesting it.
2. **Cloud agent runtimes.** Cursor / e2b / sandboxed runtimes are a roadmap
   item. The adapter contract is already runtime-agnostic; the open question
   is **how to authorize a long-running remote sandbox without leaking a
   long-lived credential**.
3. **Work-product first-class status.** Roadmap calls out artifacts & work
   products as a future surface. Today they exist as attachments. The
   question is whether they get their own resource type and lifecycle.
4. **Self-organization safety boundary.** "Agents propose org-chart changes"
   is desirable; agents bypassing governance is not. We need a clear
   approval gate before any structural change agent-side.
5. **OpenClaw deep integration (Phase 5).** This is the first fork-led
   feature. We should pick a forward-portability policy before it ships:
   does it stay isomorphic with the upstream OpenClaw adapter, or does it
   diverge?

---

## 13. Tenancy, roles, and the ValAdrien.DEV bootstrap

ValAdrien OS is a **single-instance, multi-company platform**: one running
server hosts many companies, scoped at the application layer by `companyId`.
There is no per-tenant database; isolation is enforced in the API layer and in
every query.

### 13.1 Two orthogonal role planes

Roles live in two independent tables and stack additively:

1. **Instance roles** (`instance_role` on `users`). Platform-wide. Today the
   meaningful value is `instance_admin` — full access to *every* company,
   plus instance-level settings (auth, secrets backends, model providers,
   global plugin allow-list). All other users default to `member`.
2. **Company memberships** (`company_memberships`). Per-company. Roles are
   `owner`, `admin`, `member` (plus deployment-mode-specific overrides). A
   single user can have memberships in many companies with different roles
   in each.

These planes are independent on purpose: an instance admin who is *not* a
member of company X still gets API access to company X (they administrate
the platform), but their **personal work surface** — what shows up in their
sidebar, who they post issues as — is driven by company memberships.

### 13.2 The ValAdrien.DEV recipe

ValAdrien.DEV is *both* the platform operator (the body that runs the instance,
turns features on/off, manages provider credentials) and a real company
shipping work for clients. Concretely:

| Persona                          | Instance role     | Company memberships                              |
| -------------------------------- | ----------------- | ------------------------------------------------ |
| Adrien (you)                     | `instance_admin`  | `owner` of `ValAdrien.DEV`, `owner` of each of your two side companies, `admin` of each client company you bootstrap |
| Client human (after handoff)     | `member`          | `owner` of their own company                     |
| Sub-contractor on a client       | `member`          | `member` of that single client company           |

The pattern: you keep `instance_admin` permanently. For every new company
(yours or a client's), you create it like any other company, which auto-grants
you the `owner` membership for that company. When you hand a company off to a
client, you invite them as `owner` and (optionally) downgrade yourself to
`admin` or leave the company — the instance admin role is unaffected.

### 13.3 Bootstrap: how the first instance_admin is created

This is the part the upstream Paperclip docs leave implicit. The contract on
this fork:

- **First user wins.** On a fresh database, the very first user who completes
  signup is automatically promoted to `instance_admin`. There is no separate
  super-admin signup screen — the privilege is granted on first-write to the
  `users` table.
- **Subsequent users default to `member`.** They get whatever company
  memberships they are explicitly invited into, and no instance-level access.
- **Promoting later users** is an `instance_admin`-only action via the
  Instance Settings → Users panel. Demoting yourself is allowed only if at
  least one other `instance_admin` exists (no orphan-instance lockout).
- **Local trusted mode** (single-user dev install, the default for `valos
  start`) treats the OS user as instance admin automatically. No
  password / OAuth required.
- **Hosted / shared modes** require an actual sign-in flow before the first
  user is created, so the "first user wins" rule still applies but routes
  through whatever auth provider the operator configured.

### 13.4 Adding your existing companies

For a brand-new instance that is ValAdrien.DEV-operated:

1. Sign in once → you are now `instance_admin`.
2. Run the Onboarding Wizard for **ValAdrien.DEV** itself. Pick the
   `Onboarding Specialist` agent role and (optionally) paste the
   ValAdrien.DEV GitHub URL. You are now `owner` of ValAdrien.DEV.
3. Open the wizard again for each of your two existing companies. If they
   already have a repo, paste the URL — the Onboarding Specialist will
   introspect it, propose a mission, stack summary, and an initial agent
   roster, and only persist what you confirm.
4. For each client engagement, run the wizard once. Stay `owner` while you
   are setting them up. When they take over, invite their lead, promote them
   to `owner`, and (optionally) drop your own membership down.

You never run a separate "create instance admin" step. The privilege is a
property of being the first signed-in user; the wizard is just a normal
company-creation flow that you happen to run multiple times.

### 13.5 Cross-company visibility for ValAdrien.DEV

Because instance admins bypass `company_memberships` checks at the API layer,
you can:

- See the full company list across the whole instance.
- Read issues, runs, and audit log of any company without being a member.
- Modify shared infrastructure (auth, secrets, plugins, model providers).

You **cannot** do the following without an actual membership in that company:

- Be assigned to issues (agent-side and human-side assignment both consult
  `company_memberships`).
- Show up as an author on artifacts (commits, comments, work products).
- Be the routing target for approvals — approvals always pin to a member of
  the company they belong to.

This split keeps the audit trail honest: ops actions are clearly authored as
"instance admin Adrien", and client-facing work is authored as a normal
member of that client's company.

### 13.6 The Onboarding Specialist agent

A first-class agent role (`onboarding`) ships with its own instruction bundle
in `server/src/onboarding-assets/onboarding/` (`AGENTS.md`, `SOUL.md`,
`HEARTBEAT.md`, `TOOLS.md`) and a Skill at
`.agents/skills/onboarding-specialist/SKILL.md`. The Skill is the
*playbook*: discover (clone or read repo / read free-text description) →
propose (draft `PROFILE.md`, `AGENTS_ROSTER.md`, mission) → confirm
(present to the human as a single bundle) → execute (write durable artifacts,
hire the proposed roster, file follow-up issues). The bundle is the
*persona*: how the agent talks, what guarantees it makes (idempotency,
confirmation-before-write, audit trail), and which APIs it is allowed to
call.

The wizard surfaces this in two places:

1. **Step 2 role picker.** Choose `Onboarding Specialist` instead of `CEO`
   to hire an `onboarding`-role agent with the bundle wired up
   automatically.
2. **Step 3 existing-repo field** (shown only when the onboarding role is
   selected). Paste a GitHub URL or local path; the value is appended to the
   first task description so the agent has the introspection target it
   needs.

---

## 14. Hosted reference topology (Vercel + Supabase)

ValAdrien.DEV’s reference production layout keeps the **same monorepo** as local dev but changes how the process and database are hosted.

### Request flow

```text
Browser  →  Vercel Edge / CDN
              ├─ /* (except /api/*)  →  public/index.html + static assets (Vite build)
              └─ /api/*              →  api/index.mjs  →  server/dist/index.js (Express)
                                              ↓
                                    Supabase Postgres (pooler, port 6543)
```

| Artifact | Purpose |
| -------- | ------- |
| `vercel.json` | Build command `pnpm run build:vercel`; rewrite `/api/*` to serverless handler; SPA fallback excludes `/api/` |
| `api/index.mjs` | Lazy `startServer()` from compiled server; exports default handler for Vercel |
| `scripts/prepare-vercel-public.mjs` | Copies `ui/dist` into `public/` for static hosting |
| `scripts/patch-vercel-workspace-exports.mjs` | Ensures workspace packages resolve under Vercel’s install layout |

### Environment split (runtime vs migrations)

| Variable | Typical use on Vercel |
| -------- | --------------------- |
| `DATABASE_URL` | **Transaction pooler** — Supabase port **6543** (`?pgbouncer=true` optional) |
| `DATABASE_MIGRATION_URL` | **Session pooler** — same pooler host, port **5432** (required when `VALADRIEN_OS_MIGRATION_AUTO_APPLY=true`) |
| `VALADRIEN_OS_MIGRATION_AUTO_APPLY` | `true` on fresh Supabase projects so Drizzle migrations run at cold start |
| `VALADRIEN_OS_DEPLOYMENT_MODE` | `authenticated` |
| `VALADRIEN_OS_DEPLOYMENT_EXPOSURE` | `public` |
| `VALADRIEN_OS_API_URL` | Public origin, e.g. `https://os.valadrien.dev` |
| `VALADRIEN_OS_AUTH_PUBLIC_BASE_URL` | Same as API URL for Better Auth |
| `BETTER_AUTH_SECRET` | Random 32+ byte secret (Vercel env) |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Comma-separated origins (production + preview if needed) |

**Do not** point Vercel `DATABASE_URL` at `db.[ref].supabase.co` when that host is IPv6-only — Vercel functions resolve IPv4 only → `getaddrinfo ENOTFOUND`. Use the regional pooler hostname from Supabase **Connect → Transaction pooler**.

### Serverless adaptations

- `server/src/middleware/logger.ts` skips file logging when `process.env.VERCEL` is set.
- Heavy optional deps (e.g. `jsdom` in assets routes) load lazily to reduce cold-start failures.
- Long-running agent **workers** are not hosted on Vercel; use Railway/Docker sidecars per company when needed.

### Deployment modes vs topology

| Mode | Host | Database |
| ---- | ---- | -------- |
| Local dev | `pnpm dev` on laptop | Embedded PGlite (default) or local Postgres |
| Operator cloud | Vercel + custom domain | Supabase Postgres (pooler URLs) |
| Self-hosted Docker | `docker compose` / ECS | Operator-managed Postgres |

Managed-infra entitlements (`company_infra_entitlements`) describe what a **managed** company may consume; Phase 3+ fills bindings. Until provisioning automation ships, the operator instance env vars above back the shared pool.

### Verification

After deploy:

```sh
curl -sS "https://os.valadrien.dev/api/health"
# Expect JSON, e.g. {"status":"ok",...} — not HTML
```

See [docs/deploy/troubleshooting.md](docs/deploy/troubleshooting.md) for failure signatures.

---

## 15. Further reading

- [doc/SPEC.md](doc/SPEC.md) — field-level specification (Company, Agent, Issue, etc.)
- [doc/PRODUCT.md](doc/PRODUCT.md) — product definition (upstream-style)
- [doc/GOAL.md](doc/GOAL.md) — vision and goal hierarchy
- [doc/DEPLOYMENT-MODES.md](doc/DEPLOYMENT-MODES.md) — deployment + auth modes
- [doc/plugins/PLUGIN_SPEC.md](doc/plugins/PLUGIN_SPEC.md) — plugin contract
- [doc/execution-semantics.md](doc/execution-semantics.md) — atomic checkout, execution locks, recovery
- [doc/memory-landscape.md](doc/memory-landscape.md) — agent memory model
- [.agents/skills/onboarding-specialist/SKILL.md](.agents/skills/onboarding-specialist/SKILL.md) — Onboarding Specialist playbook
- [server/src/onboarding-assets/onboarding/](server/src/onboarding-assets/onboarding/) — Onboarding Specialist instruction bundle
- [ROADMAP.md](ROADMAP.md) — shipped + planned features
- [PRD.md](PRD.md) — product requirements for the fork
- [doc/plans/2026-06-02-host-valadrien-vercel-supabase-walkthrough.md](doc/plans/2026-06-02-host-valadrien-vercel-supabase-walkthrough.md) — operator runbook: GitHub → Vercel → Supabase
- [docs/deploy/troubleshooting.md](docs/deploy/troubleshooting.md) — hosted deploy failure modes and fixes
- [docs/deploy/overview.md](docs/deploy/overview.md) — deployment options (Docker, AWS, Vercel)
