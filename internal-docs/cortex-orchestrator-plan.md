# Cortex — Orchestrator Plan & Implementation Notes

**Status:** Living document. Treat as the source of truth for *current intent*; the spec docs (`cortex-bayesian-engine-spec.md`, `cortex-branch-strategy.md`) are referenced from here when relevant.
**Owners:** Cov (human), Claude / Coda (AI agents)
**Started:** 2026-05-03
**Updated:** 2026-05-03

---

## How to use this doc

This is both a **PRD** (what we're building, why, and in what order) and a **dynamic log** (what's changed, what we've decided, what's still open). Don't split it into separate docs — one source of truth.

When something material changes:
1. Add an entry to **§9 Decision Log** (or **§10 Status Changelog** for non-decision changes).
2. Update the affected section(s) above so the top of the doc always reflects current intent.
3. If a decision contradicts an entry in `cortex-bayesian-engine-spec.md` or `cortex-branch-strategy.md`, note the override in §9 — don't silently re-edit the spec docs.

---

## 1. Mission & Scope

**Cortex is the orchestration / brain layer of the WBIT ecosystem.** It receives requests routed from sibling apps, decides how to handle them (which agent, what action, what data to read/write), and dispatches accordingly. It is *not* a chat surface, *not* a CRM, *not* a file store — those are sibling apps.

**What Cortex owns:**
- Task queues and agent dispatch (inherited from paperclip's `agents`, `routines`, `issues`, `workspace-*` services)
- Decision-making about routing (deterministic today; Bayesian Decision Engine planned — see `cortex-bayesian-engine-spec.md`)
- Cross-app coordination — knowing which sibling holds which data, calling them, stitching results
- Audit trail, budgets, approvals, cost tracking (paperclip already provides scaffolding)
- Plugin lifecycle for sibling integrations (see §5)

**What Cortex does *not* own:**
- User-facing chat / communication UI → AgencyOS
- Customer / contact / deal data → WorkPipe
- File storage and document access → WBIT-Drive

---

## 2. Ecosystem Map

| App | Role | Relationship to Cortex |
|---|---|---|
| **AgencyOS** | Smart communication layer — chat UI, message ingest. Paperclip has no built-in chat, so AgencyOS fills that gap. | Forwards user messages → Cortex; renders Cortex-driven responses back to the user |
| **Cortex** | Orchestrator / brain. Decides how to handle each request and which agent runs it. | Receives requests from AgencyOS, calls WorkPipe / WBIT-Drive as needed, dispatches agents |
| **WorkPipe** | CRM — contacts, deals, pipelines, customer records | Cortex reads/writes via WorkPipe's API (or via plugin — see §6) |
| **WBIT-Drive** | Shared file storage (Google-Drive-style), accessible to both users and agents | Cortex reads/writes documents via WBIT-Drive's API (or plugin) |

**Maturity:** All sibling apps are being built **in parallel at different stages of completion**. None can be assumed stable. Cortex's interfaces to siblings should be defensive (versioned, feature-flagged, gracefully degrading when a sibling is offline).

**Canonical end-to-end flow (from Cov, 2026-05-03):**

> A user communicates via AgencyOS → AgencyOS routes the task to Cortex → Cortex decides how to proceed and which agent handles the request → the chosen agent (running inside Cortex) acts, pulling from WorkPipe and/or WBIT-Drive as needed → results flow back through AgencyOS to the user.

---

## 3. Multi-Tenancy

**Internal first, architected for multi-tenant from day one.**

The product unit is a **WBIT subscription**. A subscription includes AgencyOS + WorkPipe + WBIT-Drive + Cortex bundled. WBIT is the first tenant (eating own dog food). Soon: external companies (e.g. "ABC Co subscribes to WBIT" → gets the full bundle, with Cortex orchestrating their internal operations).

**Implications for Cortex architecture:**
- Org isolation is non-optional. Paperclip's existing `companies`, `projects`, `agents` schemas already model multi-tenant data — extend, don't replace.
- Per-org configuration: which agents, which routing rules, which Bayesian beliefs (the `belief_state` schema in the Bayesian spec is already org-scoped — good).
- Cost / budget / quota enforcement per org. Paperclip's `budgets`, `costs`, `quota-windows` services give us a head start.
- Cortex itself stays internal initially (no public-facing Cortex API for ABC's developers). May expose later if marketing/opportunity warrants — design to allow this without rework.

---

## 4. What Cortex Inherits from Paperclip

Hard fork taken 2026-04-27 from `paperclipai/paperclip`. **Default stance: extend everything; deprecate later when we know what's not needed.** Don't gut anything in the first pass.

**Highly relevant existing services** (in `server/src/services/`):

| Service | Why it matters |
|---|---|
| `agents.ts`, `agent-instructions.ts`, `agent-permissions.ts`, `agent-start-lock.ts` | Agent definition, instruction sets, permission enforcement, run locks |
| `issues.ts`, `issue-*.ts` (~12 files) | Issue/task model with assignment, approvals, execution policy, liveness tracking, thread interactions |
| `routines.ts`, `cron.ts` | Scheduled work (key for an orchestrator) |
| `workspace-*.ts` (~6 files) | Execution environments / workspace runtime |
| `companies.ts`, `company-*.ts` | Multi-tenant data already modeled |
| `approvals.ts`, `issue-approvals.ts`, `budgets.ts`, `costs.ts`, `quota-windows.ts` | Governance / cost controls |
| `feedback.ts`, `activity-log.ts`, `live-events.ts`, `heartbeat*.ts` | Observability + audit |
| `dashboard.ts`, `inbox-dismissals.ts`, `sidebar-*.ts` | UI-side state Cortex emits |
| `plugin-*.ts` (~22 files) | **The plugin system — see §5, this is a major asset** |

Things to inventory but not depended on yet: `goals.ts`, `documents.ts`, `assets.ts`, `secrets.ts`, `environments.ts`, `environment-*.ts`, `finance.ts`, `github-fetch.ts`, `hire-hook.ts`, `invite-grants.ts`, `instance-settings.ts`, `board-auth.ts`.

---

## 5. Paperclip's Plugin System (asset summary)

Paperclip ships a substantial plugin architecture. Worth understanding before deciding the integration model in §6.

**What it does:**
- **Discovery:** scans `~/.paperclip/plugins/` and `node_modules` for packages matching `paperclip-plugin-*` naming convention
- **Manifest-driven:** plugins declare capabilities via `PaperclipPluginManifestV1`; install is rejected if manifest doesn't validate
- **Capability gating:** `plugin-capability-validator` ensures plugins only get host APIs they declared (least privilege)
- **Lifecycle state machine:** `plugin-lifecycle` enforces install → activate → shutdown transitions
- **Worker isolation:** `plugin-worker-manager` runs plugins in separate processes (out-of-process — crash isolation, resource limits)
- **Host services SDK:** `plugin-host-services` exposes a controlled API surface — `companies`, `agents`, `projects`, `issues`, `goals`, `documents`, `assets`, `budgets`, `costs`, `live-events`, etc.
- **First-class infrastructure:** plugin entities, jobs, job runs, webhook deliveries, secrets, state store, event bus, tool dispatcher, UI slots — all schema-backed
- **SSRF-hardened HTTP:** plugin outbound `fetch` validates protocol, resolves DNS, blocks private IPs, pins resolved IP into the request to defeat DNS rebinding
- **Logging & telemetry:** `plugin-logs` table, telemetry hooks, log retention policy

**What this means for WBIT:** sibling apps (AgencyOS, WorkPipe, WBIT-Drive) have at least three viable shapes. See §6.

---

## 6. Integration Model — siblings ↔ Cortex

**DECIDED 2026-05-03: Option C (hybrid bridge plugins).** Sibling apps remain independent services; each gets a thin `paperclip-plugin-wbit-{sibling}` bridge installed in Cortex. See decision rationale in §9.

Three options were considered:

### Option A — Siblings hit Cortex's HTTP API
- Siblings are fully independent services that call Cortex over HTTP.
- **Pros:** loose coupling, sibling teams ship independently, sibling tech stacks can diverge from Cortex.
- **Cons:** Cortex is a passive recipient — can't observe sibling state without polling or webhooks; no shared schemas; integration boundary repeated for every sibling; auth/permissions/audit/cost-attribution all need to be re-built per integration.
- This is what Cov originally planned.

### Option B — Siblings ARE Cortex plugins
- Each sibling implements a `paperclip-plugin-*` package that runs inside Cortex's plugin runtime.
- **Pros:** free use of host services (companies, agents, issues, etc.), capability-gated permissions, worker isolation, telemetry, SSRF protection, lifecycle management. We get all this without building it.
- **Cons:** siblings constrained to paperclip's plugin SDK, must be Node.js, must be co-deployed with Cortex (worker processes). Hard if AgencyOS or WBIT-Drive want their own deployment / scaling / language story.

### Option C — Hybrid: siblings are independent apps, with a "bridge plugin" in Cortex
- Each sibling runs as its own service. Cortex installs a thin `paperclip-plugin-wbit-{agencyos,workpipe,drive}` per sibling that:
  - Exposes the sibling's resources to Cortex (via the host-services pattern but reaching out)
  - Provides Cortex with idiomatic typed handles (`workpipe.contacts.find(...)`) instead of raw HTTP
  - Centralises auth, retry, error mapping, telemetry per sibling
- **Pros:** keeps siblings deployable independently (their teams aren't constrained to plugin SDK), but Cortex gains the plugin system's lifecycle, capability gating, and observability around the integration. Multi-tenant scoping (which org's WorkPipe to talk to) is enforced inside the bridge plugin.
- **Cons:** more upfront work — both an external sibling API *and* a bridge plugin per sibling.
- **Chosen.** Right answer for AgencyOS / WorkPipe / WBIT-Drive given they're built in parallel as separate apps. Pure plugins (Option B) may still suit small additive integrations later (e.g. "Stripe billing plugin," "Slack-notify plugin").

---

## 7. Phased Roadmap (DRAFT — pending §6 decision)

Order of work that makes sense given today's understanding. Phase boundaries are soft.

### Phase 0 — Foundations (now)
- [x] Branch strategy implemented (master / upstream-sync / integration / wbit-cortex-prod)
- [x] Internal docs folder seeded
- [x] This doc created
- [x] §6 integration model decided (Option C — hybrid bridge plugins)
- [x] CLAUDE.md created in repo root (branch discipline + plan doc as required reading)
- [ ] Confirm Neon DB + pgvector availability (called out in Bayesian spec — needed for any DB-backed work)

### Phase 1 — Sibling integration shape
- [ ] Define the contract for sibling ↔ Cortex (depends on §6)
- [ ] Build the first bridge / API endpoint for AgencyOS (it's the message ingress, so it's the gating dependency)
- [ ] Stand up minimal end-to-end flow: AgencyOS sends a message → Cortex receives → existing paperclip routing acts → response flows back
- [ ] Multi-tenant scoping verified end-to-end (org_id propagated through every hop)

### Phase 2 — Real orchestration (today: deterministic)
- [ ] Map the canonical flow (§2) to existing paperclip services — what gets created (issue? agent task session?) when AgencyOS delivers a message?
- [ ] Wire WorkPipe + WBIT-Drive bridges so agents can read/write CRM and files inside their runs
- [ ] Approvals + budgets enforced for cross-app actions
- [ ] Activity log + dashboard visibility for cross-app flows

### Phase 3 — Bayesian Decision Engine (the spec doc)
- Picked up only once Phase 1 + Phase 2 are working with deterministic routing.
- Translate `cortex-bayesian-engine-spec.md` Python pseudocode → TS, slot Bayesian intent into the routing layer built in Phase 2.
- The 5-phase plan inside the Bayesian spec collapses into this one phase from the orchestrator-plan perspective.

### Phase 4 — Productization for external tenants
- Onboarding flow for new orgs
- Per-org configuration UI
- Documentation, support runbooks
- Decision: expose Cortex API externally? (deferred per §3)

---

## 8. Open Questions (active conversation surface)

| # | Question | Status | Notes |
|---|---|---|---|
| Q1 | Integration model — Option A / B / C from §6? | **DECIDED 2026-05-03** | Option C (hybrid bridge plugins). See §9. |
| Q2 | Is Neon DB provisioned? With pgvector enabled? | OPEN | Bayesian spec assumes yes; Phase 1 may not need it but Phase 3 will. |
| Q3 | Are the local Gemma + Gemini + Claude API keys / runtime wired in? | OPEN | Needed for Bayesian model-tier routing (spec §5). |
| Q4 | Maturity snapshot of each sibling — what's already built in AgencyOS / WorkPipe / WBIT-Drive today? | OPEN | Determines which sibling we integrate first. |
| Q5 | CLAUDE.md in repo root encoding branch discipline + this doc as required reading? | **DECIDED 2026-05-03** | Created. See §9. |
| Q6 | Naming: `wbit-cortex-prod` is the prod branch — should release tags be `cortex@vX.Y.Z` (per branch-strategy doc) or `wbit-cortex@vX.Y.Z`? | OPEN | Tiny but worth pinning before first tag. |
| Q7 | Does AgencyOS already have a defined message-ingress contract, or do we get to design it together? | OPEN | If it's open, that gives us the cleanest entry point to design Cortex's external surface. |
| Q8 | Order of bridge-plugin builds — which sibling first? Likely AgencyOS (it's the message ingress and gates the canonical flow), but depends on Q4. | OPEN | Spawned by Q1 decision. |

---

## 9. Decision Log (newest first)

### 2026-05-03 — CLAUDE.md added at repo root
- **Decision:** Repo-root `CLAUDE.md` created encoding the inviolable rules: branch discipline, pointer to this doc as required reading, stack basics, extension-over-replacement default for paperclip code.
- **Why:** Auto-loads into every Claude/Coda session; means future agents won't accidentally commit to `wbit-cortex-prod`, won't miss the orchestrator plan, and won't propose gutting paperclip services. Resolves Q5.
- **Alternatives considered:** Rely on memory only. Rejected — memory is per-agent and per-session-start; CLAUDE.md is repo-resident and applies to any agent that opens this directory.

### 2026-05-03 — Integration model: Option C (hybrid bridge plugins)
- **Decision:** Siblings (AgencyOS, WorkPipe, WBIT-Drive) remain independent deployable services. Each gets a thin `paperclip-plugin-wbit-{sibling}` bridge installed in Cortex that exposes the sibling's resources via the host-services pattern, centralises auth/retry/telemetry, and enforces multi-tenant scoping.
- **Why:** Best of both worlds. Siblings keep deployment / scaling / language independence (they can't be forced into the plugin SDK since they're built in parallel by different teams/agents). Cortex gets free use of the paperclip plugin system's lifecycle, capability gating, worker isolation, SSRF protection, and observability around the integration boundary. Without this, we'd reinvent all that scaffolding per sibling.
- **Alternatives considered:**
  - **Option A** (siblings hit Cortex's HTTP API directly): rejected — Cortex would be passive, no shared schemas, every integration repeats auth/retry/audit/cost-attribution scaffolding.
  - **Option B** (siblings *are* plugins): rejected for primary integration — too constraining (Node-only, co-deployed with Cortex), but kept as a viable shape for small additive integrations later (Stripe, Slack-notify, etc.).
- **Trigger:** Cov picked C in this session after seeing the §6 writeup.
- **Next:** Resolves Q1. Spawns Q8 (which sibling bridge to build first). Phase 1 scope tightens around defining the bridge-plugin shape.

### 2026-05-03 — Custom code lives on `integration`, never directly on `wbit-cortex-prod`
- **Decision:** All custom WBIT work (including doc edits in `internal-docs/`) lands on `integration`. `wbit-cortex-prod` is fast-forward-only from `integration`, plus the documented hotfix back-port pattern.
- **Why:** Hard rule from `cortex-branch-strategy.md` confirmed by Cov. The 3-branch + master model only delivers clean upstream conflict resolution if direct prod commits are avoided.
- **Alternatives considered:** Allow incidental edits (docs, .gitignore tweaks) directly on prod for speed. Rejected — slips erode the model and there's no real cost to the discipline.
- **Trigger:** Caught a `M .gitignore` change sitting on `wbit-cortex-prod` in this session; moved to `integration` before editing further.

### 2026-05-03 — One living doc instead of separate PRD + dynamic log
- **Decision:** Use a single `cortex-orchestrator-plan.md` for both the PRD and the running implementation/decision log.
- **Why:** Avoids the two-docs-drift-apart failure mode. Keeps "what we intend" and "what's changed since" colocated.
- **Alternatives considered:** Separate `cortex-orchestrator-prd.md` + `cortex-implementation-notes.md`. Rejected — splitting before we have content to split risks both being half-baked.

### 2026-05-03 — Bayesian engine is a phase, not the foundation
- **Decision:** Bayesian Decision Engine implementation is deferred until orchestrator scaffolding (Phases 1 & 2) is in place with deterministic routing.
- **Why:** Cov clarified the actual mission is Cortex-as-orchestrator across the WBIT ecosystem; the Bayesian spec is one feature inside that, not the foundation. Building Bayesian on top of an undefined orchestrator surface risks building the wrong thing.
- **Alternatives considered:** Start with the Bayesian spec's Phase 1 (DB tables + EvidenceCollector + BayesianIntentEngine) since it's the most concretely specified work. Rejected — it presumes routing decisions Cortex doesn't yet own.

---

## 10. Status Changelog

### 2026-05-03 — Option C decided + CLAUDE.md + first commits
- Q1 (integration model) and Q5 (CLAUDE.md) closed. See §9 for both decision entries.
- CLAUDE.md created at repo root.
- First commits to `integration` since fork: `.gitignore` tweak, `internal-docs/` (all four planning docs), `CLAUDE.md`.

### 2026-05-03 — Doc created, working branch confirmed
- Created this doc on `integration` branch.
- Confirmed all 4 branches exist on origin (`master`, `upstream-sync`, `integration`, `wbit-cortex-prod`).
- Confirmed onboarding doc claim "no local clone yet on this machine" is stale — repo is cloned at `D:\WBIT-Cortex\cortex`, deps installed.
- Inventoried `server/src/services/` — ~95 services, including a substantial plugin system (~22 plugin-* files) that wasn't apparent from the existing planning docs.

---

## Appendix — Related Docs

- `cortex-branch-strategy.md` — formal branch model + workflow recipes (canonical, don't override silently — log here if intent changes)
- `cortex-bayesian-engine-spec.md` — Bayesian Decision Engine architecture (treat as Phase 3 spec; Python pseudocode needs TS translation when picked up)
- `quick-onboarding-doc.md` — point-in-time onboarding snapshot (archival; some claims are stale, e.g. "no local clone yet")
