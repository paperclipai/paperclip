# Paperclip — Maintainer Guide

> What a maintainer must understand in the first hour, what practices to copy, and what to remove/simplify/archive.
> Read-only analysis, 2026-06-20, `master` @ `bb5f60ef`. `[OBSERVED]` / `[DOCUMENTED]` as in the other harvest docs.

---

## Part 1 — The First Hour

### 1. What this is (2 minutes)
Paperclip is a **control plane for AI-agent companies**: an Express REST API + React board UI that gives heterogeneous AI agents an org chart, ticketing, budgets, governance, scheduling, and coordination. *Not* an agent framework, *not* a chatbot. "If it can receive a heartbeat, it's hired." This repo is a **fork** of `paperclipai/paperclip` (upstream "Dotta") + HenkDz QoL line + **51 founder commits** that add an institutional ops layer. `[OBSERVED]`

### 2. Read these, in order (15 minutes) — per `AGENTS.md`
1. `doc/GOAL.md` → 2. `doc/PRODUCT.md` → 3. `doc/SPEC-implementation.md` (the concrete V1 build contract) → 4. `doc/DEVELOPING.md` → 5. `doc/DATABASE.md`. Then `README.md` for the feature map and `architecture_changelog.md` + `governance_risks.md` + `liveness_report.md` for the founder's operational decisions. `[OBSERVED]`

### 3. Get it running (10 minutes)
```sh
pnpm install
pnpm dev            # API + UI at http://localhost:3100, embedded Postgres auto-provisioned
curl http://localhost:3100/api/health
```
Reset local DB: `rm -rf data/pglite && pnpm dev`. Requirements: Node 20+, pnpm 9.15+. `[OBSERVED in README/AGENTS]`
> Fork note (`AGENTS.md` §11): fork runs on **port 3101+** if 3100 is taken; on NTFS use `node node_modules/vite/bin/vite.js build` (not `npx vite build`); server cold-start from NTFS takes 30–60s — don't assume failure. `[DOCUMENTED]`

### 4. The mental map of the code (15 minutes)
```
server/                Express REST API + ~110 orchestration services (~60k LOC)
  src/routes/          39 route groups under /api
  src/services/        heartbeat.ts (the heart), budgets, approvals, routines,
                       company-portability, recovery/*, provider-routing, qsl-review
ui/                    React + Vite board (pages/, components/ui = shadcn-style)
packages/db/           Drizzle schema (~70 tables) + migrations
packages/shared/       types + Zod validators + constants + API path constants  ← contract source of truth
packages/adapters/     7 agent adapters (claude/codex/cursor/gemini/opencode/pi/openclaw)
packages/adapter-utils/ shared adapter contract + process/runtime helpers
packages/plugins/      out-of-process plugin SDK (JSON-RPC over stdio)
packages/mcp-server/   ~40 Paperclip tools exposed over MCP
cli/                   paperclipai CLI (onboard, doctor, heartbeat run, …)
skills/                5 runtime-injectable agent skills
scripts/*.py           founder's runtime-health / governance stack (7 Python files)
```

### 5. The five invariants you must not break (`AGENTS.md` §5) — memorize these
1. **Single-assignee** task model.
2. **Atomic issue checkout** (`FOR UPDATE` locks, `agent-start-lock` mutex) — no double-work.
3. **Approval gates** for governed actions.
4. **Budget hard-stop auto-pause** behavior.
5. **Activity logging** for every mutation.
Plus: keep everything **company-scoped** and enforce boundaries in routes/services. `[OBSERVED]`

### 6. The one workflow rule that bites people
**Contract sync across four layers.** Any schema/API change must update `packages/db` → `packages/shared` → `server` → `ui` together. DB changes: edit `schema/*.ts` → export from `schema/index.ts` → `pnpm db:generate` → `pnpm -r typecheck`. `drizzle.config.ts` reads *compiled* `dist/schema/*.js`, so generate compiles `db` first. `[OBSERVED]`

### 7. How to verify work (don't over-run CI)
- Cheap default: `pnpm test` (Vitest only — **no Playwright**).
- Browser suites are opt-in: `pnpm test:e2e`, `pnpm test:release-smoke`.
- "Run the smallest relevant check first." Full `pnpm -r typecheck && pnpm test:run && pnpm build` only for PR-ready hand-off. `[OBSERVED]`

### 8. The founder ops layer (know it exists)
`scripts/*.py` is a self-contained runtime-health/governance stack that **actually runs** against the live instance. Latest run `[OBSERVED]`: health **90.2**, status **warning**, escalation **critical** (7 consecutive warnings), 2 companies / 13 agents, 17 backups (631 MB). Governance checkpoints are hash-chained (`logs/governance-checkpoints/checkpoint-index.jsonl`). If you touch backups, topology, or instance layout, re-run `runtime_guardian.py` and check it stays green-ish.

### 9. Live business context (so you don't break production)
Two real companies run here: **QSL** (security; 15-agent cabinet, CrawDaddy revenue, `qsl_findings`/`qsl-bridge`/`QslReview`) and **SELARIX** (PQC tool, daily swarm health-check routine SEL-1). Both reach external EC2 (`3.20.79.143`) via company secrets. **Do not read secrets**; do not assume EC2 scripts are mockable. `[OBSERVED config / DOCUMENTED infra]`

---

## Part 2 — Engineering Practices to Copy Elsewhere

1. **Single shared package owns the contract** (types + Zod validators + constants + API paths) consumed by db/server/ui. Eliminates drift.
2. **Invariants written at the top of `AGENTS.md`** — the explicit "do not break" list.
3. **Atomicity by default** — `FOR UPDATE`, `db.transaction()`, an explicit start-lock mutex; not optimistic hand-waving.
4. **Dated architecture changelog + risk register (GR-001…) + sequenced hardening order** (`persistence → liveness/deadlock → data confidence → backup/recovery → provider routing`) as committed files. Decisions are legible months later.
5. **Deterministic, hash-chained governance checkpoints** — auditable continuity without spending LLM tokens.
6. **Approval-aware, non-destructive remediation** — auto-run inspections, gate mutations, dedup by fingerprint, expire stale plans.
7. **Fallback hierarchy with a source header** (`database → bridge_error_fallback → bridge → empty`, surfaced via `X-QSL-Source`).
8. **Secret-ref bindings + regex log redaction** so secrets never enter prompts/logs.
9. **Tiered verification etiquette** to keep agent heartbeats cheap.
10. **PR template demanding "Thinking Path" + "Model Used"** — traceability of AI-assisted changes.

---

## Part 3 — What to Remove, Simplify, or Archive

> The repo's biggest hygiene problem is **working-tree clutter**: ~20 untracked operational/marketing markdown files and stray artifacts at the root (see `git status`). None are code, but they obscure the project.

### Archive (move out of repo root → `docs/harvest/archive/` or a separate ops vault)
These are point-in-time operational reports, not living docs. Several are stale (Mar–Apr 2026):
- `AWS_MARKETPLACE_RESEARCH.md`, `BLUEPRINT_DEPLOYMENT_REPORT.md`, `CONTENT_DRAFTS.md`, `CONTENT_LOG.md`, `CONTENT_PIPELINE_REPORT.md`, `CRAWDADDY_PRELAUNCH_REPORT.md`, `EC2_STATUS_REPORT.md`, `GUIDE_DRAFTS.md`, `PAPERCLIP_ORG_SETUP_COMPLETE.md`, `SECURITY_DIVISION_REPORT.md`, `SELARIX_OPS_SETUP.md`, `QSL_Blueprint_v3.1_*.{docx,txt}`. `[OBSERVED clutter]`
- Reason: they're institutional history, valuable but not repo-root material. Keep them, but out of the way.

### Consolidate (these are *config that drifts* — make one source of truth)
- `QSL_CONFIG.md`, `SELARIX_CONFIG.md`, `MOLTBOOK_INTEGRATION.md` — live business config scattered at root. Fold into `doc/` or, better, into the Paperclip companies themselves (they're already companies). Risk: these contain wallet addresses and infra IPs — review before any are committed/shared. `[OBSERVED]`

### Fix or retire
- **Moltbook integration** — broken (401, "key doesn't match any registered agent") since **2026-04-09** per `MOLTBOOK_INTEGRATION.md`. Either regenerate the key and fix, or archive the integration so it stops looking live. `[OBSERVED BROKEN]`
- **`provider-routing` (Stage 0)** — decision logic with no live fallback wired. Per the founder's own hardening order, it's intentionally deferred behind data-confidence + liveness work. Leave it, but **don't enable fallback** until GR-003/GR-006 close. `[OBSERVED + DOCUMENTED]`

### Remove from version control / gitignore
- `seller-watchdog-fixed.sh`, `ecosystem.config.cjs` (PM2, machine-specific `cwd`), `.test-bridge/`, `scripts/__pycache__/`, `templates/qsl-instance-backup/secrets/` — none belong in the tree. **Confirm `secrets/` is gitignored** before anything else. `[OBSERVED untracked]`
- `board_exports/` is *generated* (`server/scripts/generate-board-export.ts`) — treat as build output, not source.

### Simplify (lower priority, real wins)
- **`heartbeat.ts` (~1100+ lines)** and **`company-portability.ts` (~1000 lines)** are the two giant services. Not broken, but the highest-value candidates for decomposition when you next touch them — extract environment resolution, workspace realization, and result processing from heartbeat.
- **`recovery/service.ts`** is the densest subsystem; ensure its thresholds (1h/4h/30m, max-2 attempts) stay documented in `liveness_report.md` as they change.

### Do NOT touch without understanding
- The `qsl_findings` persistence + fingerprint-upsert logic (`qsl-review.ts`) — it exists *because* a naive resync was destroying human review decisions (GR-001). The "never overwrite review_state" rule is load-bearing. `[OBSERVED]`
- The hash-chain in `governance_checkpoint.py` — breaking it breaks continuity verification.

---

## TL;DR for the new maintainer
Run `pnpm dev`. Read `doc/SPEC-implementation.md` + `architecture_changelog.md`. Respect the 5 invariants and the 4-layer contract sync. The code is mature and disciplined; the **mess is at the repo root** (clutter + drifting config + one broken integration), not in `server/`. Two real businesses depend on this — don't touch secrets, don't enable provider-routing fallback, and re-run the guardian after any infra/backup change.
