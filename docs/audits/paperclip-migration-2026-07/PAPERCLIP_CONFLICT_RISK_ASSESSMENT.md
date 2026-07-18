# Paperclip Conflict Risk Assessment

**Sprint:** 5A — Runtime Isolation and Canonical Instance Determination  
**Date:** 2026-07-16  
**Scope:** Analysis of discovered conflicts, shared resources, and contamination risks  

---

## 1. Executive Summary

**Risk Level: HIGH** — The legacy embedded PostgreSQL instance is actively running with a stale schema, while the audited repository code expects a database 30 migrations newer. Additionally, the `.env` file contains a port mismatch that would cause a fresh `pnpm dev` to connect to a non-existent database. Before implementing the governed decision loop, these conflicts must be resolved through isolation, not in-place mutation.

---

## 2. Conflict Matrix

### 2.1 Port Conflicts

| Resource | Claimed By | Actual State | Conflict? | Severity |
|----------|-----------|--------------|-----------|----------|
| **54329** | Embedded PostgreSQL (legacy) | **Active listener** (PID 87504) | **YES** — occupies a non-standard port that is not documented in `.env` | Medium |
| **5432** | `.env` DATABASE_URL | **No listener** | **YES** — `.env` points to a dead port | High |
| **3100** | Historical Paperclip server | **Free** | No | Low |
| **3101** | Historical Paperclip server (fallback) | **Free** | No | Low |
| **5173** | Historical Vite dev server | **Free** | No | Low |

**Analysis:**
- The `.env` file in the canonical repository points to `localhost:5432`, but the actual database is on `54329`.
- If a developer runs `pnpm dev` with the current `.env`, the server will fail to connect to a database.
- The embedded PostgreSQL on 54329 is effectively orphaned: no running Paperclip server is connected to it, yet it holds the only copy of QSL and Directory Factory data.

### 2.2 Database Conflicts

| Resource | Legacy Instance | Canonical Repo Expectation | Conflict? | Severity |
|----------|----------------|---------------------------|-----------|----------|
| **Schema version** | Migrations 0000–0044 applied | Migrations 0000–0072 present | **YES — 30 migrations stale** | **Critical** |
| **`issue_inbox_archives` table** | **Missing** | Expected by `packages/db/src/schema/issues.ts` | **YES — causes 500 errors** | High |
| **`issue_inbox_archives` table** | Not in migration 0044 | Added in later migration | Confirmed missing | High |
| **QSL findings table** | Unknown state | `qsl_findings` expected | Likely missing or incomplete | Medium |
| **`__drizzle_migrations` state** | Stopped at 0044 | Should be at 0072 | **YES** | Critical |

**Evidence:**
- Server log shows repeated `500` errors: `relation "issue_inbox_archives" does not exist` (PostgresError code 42P01).
- The log also shows successful reads for routines, goals, and dashboards, meaning the core tables work but newer features crash.
- This means the server was running in a partially-broken state for weeks before it stopped.

### 2.3 Environment / Configuration Conflicts

| File | Key | Legacy Value | Canonical Expectation | Conflict? | Severity |
|------|-----|--------------|----------------------|-----------|----------|
| `repo/.env` | `DATABASE_URL` | `localhost:5432` | Should match `localhost:54329` or be unset for pglite | **YES** | High |
| `repo/.env` | `SERVE_UI` | `false` | `config.json` says `serveUi: True` | **YES** | Medium |
| `instance/.env` | `PAPERCLIP_AGENT_JWT_SECRET` | `[REDACTED]` | Should match repo secrets config | Unknown | Low |
| `instance/config.json` | `database.embeddedPostgresPort` | `54329` | Repo `.env` ignores this | **YES** | High |

**Analysis:**
- The repository `.env` and the instance `config.json` are out of sync.
- The repository was likely updated (newer migrations, newer code) while the instance `config.json` and embedded database were left behind.
- This suggests the server was being launched via the Paperclip application/CLI (which uses `config.json`) rather than via `pnpm dev` from the repo (which would use `.env`).

### 2.4 Shared Resource Conflicts

| Resource | Shared By | Risk |
|----------|-----------|------|
| `C:\Users\mikeb\.paperclip\instances\default\db` | Legacy embedded PG only | **Low** — no other process is using this data directory |
| `C:\Users\mikeb\.paperclip\instances\default\data\storage` | Legacy instance only | **Low** — no upload directory overlap detected |
| `C:\Users\mikeb\.paperclip\instances\default\logs\server.log` | Legacy instance only | **Low** — historical artifact |
| Node.js runtime / npm cache | Paperclip, MCP servers, PM2, Cursor | **Low** — no version lock conflicts observed |
| `C:\Users\mikeb\paperclip\node_modules` | Canonical repo only | **Low** — no other repo shares this tree |

**Analysis:**
- There is **no evidence** of multiple installations sharing the same database, port, domain, upload directory, or background workers.
- The only "sharing" issue is that the legacy embedded PostgreSQL occupies port 54329, which is hardcoded in `config.json`.

### 2.5 Code / Data Contamination Risk

| Risk | Description | Likelihood | Impact |
|------|-------------|------------|--------|
| **Stale schema corruption** | Running new code against old DB may create inconsistent state if migrations are attempted ad-hoc | High if uncontrolled | **High** — could damage the only copy of QSL/Directory Factory data |
| **Dual-database creation** | If `pnpm dev` is run with `.env` intact, it may fail to connect to 5432 and create a **new** pglite DB in `data/pglite`, splitting state | High | **High** — two divergent databases |
| **Accidental `.paperclip` instance reuse** | If the Paperclip CLI is launched, it may reconnect to the stale DB on 54329 and resume the broken runtime | Medium | **Medium** — would resurrect the conflict |
| **Workspace git-repo contamination** | 12 workspaces exist in `.paperclip/instances/default/workspaces`. Some may contain uncommitted agent work. | Unknown | **Medium** — potential data loss if instance is deleted |

---

## 3. Company Isolation Assessment

| Company | ID | Data Location | Schema Compatibility | Status |
|---------|----|---------------|---------------------|--------|
| **QSL** | `839bfea4-f16b-448b-9b1a-d040aededb90` | `companies/839b...`, `projects/839b...`, `storage/839b...` | Partial — works for core tables, fails on `issue_inbox_archives` | **Historical / At Risk** |
| **Directory Factory** | `11dc08e7-2135-4c0f-a605-034285555d8e` | `companies/11dc...`, `projects/11dc...` | Partial — same schema gap | **Historical / At Risk** |

**Key Finding:**
- Both companies are **company-scoped** as per Paperclip design.
- There is **no cross-company leakage** in the data directory structure.
- However, because the **schema is global** (not per-company), a single schema migration gap affects **all companies** in the database.

---

## 4. Audit Trail Contamination Check

| Concern | Finding | Risk Level |
|---------|---------|------------|
| **Current repo branch contains audit artifacts** | 12 uncommitted files in `docs/audits/` and `docs/constitution/` | **Low** — these are the intended audit deliverables and do not modify code |
| **Audit branch is ahead of master** | 4 commits ahead; contains only documentation | **Low** — no runtime or schema changes |
| **Working tree is dirty** | Uncommitted docs only | **Low** |
| **Server log contains audit queries** | The server log shows PowerShell user-agent requests on 2026-06-22 (likely from prior audit scripts) | **Low** — read-only API calls |

**Conclusion:** The repository is **not contaminated** by older runtimes. The audit branch is clean from a code perspective.

---

## 5. Risk Register

| # | Risk | Probability | Impact | Mitigation Strategy |
|---|------|-------------|--------|---------------------|
| R1 | Starting `pnpm dev` with current `.env` creates a second (empty) database on 5432, leaving 54329 orphaned | High | High | **Isolate `.env` before any dev start** |
| R2 | The embedded PostgreSQL on 54329 is accidentally reused by a new runtime, propagating the stale schema | Medium | High | **Stop the 54329 process and document it** |
| R3 | QSL or Directory Factory data is lost because the legacy DB is treated as disposable | Low | Critical | **Preserve `.paperclip/instances/default` read-only; do not drop DB** |
| R4 | A migration run against the stale DB fails partway, leaving the DB in an inconsistent state | Medium | High | **Do not migrate the legacy DB; use a clean DB for development** |
| R5 | Workspace directories contain uncommitted agent work that is lost if the instance directory is moved/deleted | Unknown | Medium | **Archive `.paperclip/instances/default/workspaces` before any move** |
| R6 | `.env` secrets (BETTER_AUTH_SECRET, PAPERCLIP_AGENT_JWT_SECRET) are stale or rotated | Unknown | Medium | **Do not expose secrets; treat them as legacy** |
| R7 | Hostinger VPS or `paperclip.quantumshieldlabs.dev` is still serving an older Paperclip build | Unknown | Unknown | **Investigate remote deployment in follow-up** |

---

## 6. Unsupported Assumptions in This Assessment

1. Assumed the `.env` `DATABASE_URL` password is the literal string `paperclip` (visible in the redacted line).
2. Assumed no other Paperclip `.env` files exist in parent directories or sibling repos.
3. Assumed the `issue_inbox_archives` error is representative of the full migration gap; other missing tables may exist.
4. Assumed the server stopped on 2026-06-22 due to a crash or system reboot (no graceful shutdown log); actual cause unknown.
5. Assumed the `quantumshield-api` repo has no hidden Paperclip runtime or shared database.
