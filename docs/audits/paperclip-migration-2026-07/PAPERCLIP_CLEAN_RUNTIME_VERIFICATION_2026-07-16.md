# Paperclip Clean Runtime Verification — 2026-07-16

**Sprint:** 5B — Reversible Paperclip Runtime Isolation  
**Date:** 2026-07-16  
**Status:** Clean runtime NOT YET CREATED. This document records the verification criteria that will be applied once the corrected startup command is approved.

---

## 1. Why a Clean Runtime Was Not Created Yet

During Step 7 of Sprint 5B, the command `pnpm dev:server` (with `DATABASE_URL` unset) was executed. **It did not create a clean runtime.** Instead, it connected to the legacy embedded PostgreSQL database at `~/.paperclip/instances/default/db` on port 54329.

This occurred because:
1. The codebase's `DatabaseMode` type only supports `"embedded-postgres"` and `"postgres"` — there is no `pglite` mode.
2. AGENTS.md instruction `rm -rf data/pglite` is **misleading** for this repository version.
3. The only supported clean-dev mechanism is to set a **new `PAPERCLIP_INSTANCE_ID`**.

**This document defines the verification criteria for the corrected clean runtime startup.**

---

## 2. Clean Runtime Verification Checklist

Once the corrected command (with `PAPERCLIP_INSTANCE_ID=sprint5-clean`) is approved and executed, the following checks must pass before declaring Sprint 5B complete:

### 2.1 File System Isolation

| # | Check | Expected Result | Verification Method |
|---|-------|-----------------|---------------------|
| C1 | `~/.paperclip/instances/sprint5-clean/` exists | **YES** | `Test-Path` |
| C2 | `~/.paperclip/instances/sprint5-clean/db/` exists and was newly created | **YES** | `Test-Path` + timestamp check |
| C3 | `~/.paperclip/instances/sprint5-clean/config.json` exists | **YES** | `Test-Path` |
| C4 | `~/.paperclip/instances/sprint5-clean/logs/` exists | **YES** | `Test-Path` |
| C5 | `~/.paperclip/instances/default/db/` was NOT accessed during startup | **YES** | File timestamp check |
| C6 | `data/pglite` was NOT created in the repo | **N/A** (not used by this codebase) | `Test-Path` |

### 2.2 Port Isolation

| # | Check | Expected Result | Verification Method |
|---|-------|-----------------|---------------------|
| C7 | Port 54329 legacy listener | **NONE** | `Get-NetTCPConnection` |
| C8 | Clean database port (54330) listener | **ACTIVE** (PID of new PostgreSQL) | `Get-NetTCPConnection` |
| C9 | HTTP server port (3100) listener | **ACTIVE** (PID of Paperclip server) | `Get-NetTCPConnection` |
| C10 | Port 3101 fallback | **FREE** | `Get-NetTCPConnection` |

### 2.3 Process Isolation

| # | Check | Expected Result | Verification Method |
|---|-------|-----------------|---------------------|
| C11 | New embedded PostgreSQL process exists | **YES** (on port 54330) | `Get-Process` + port mapping |
| C12 | New Paperclip server process exists | **YES** (on port 3100) | `Get-Process` + port mapping |
| C13 | No process is listening on port 54329 | **YES** | `Get-NetTCPConnection` |
| C14 | Legacy `.paperclip/instances/default/db` files have no new timestamps | **YES** | File comparison |

### 2.4 API Verification

| # | Check | Expected Result | Verification Method |
|---|-------|-----------------|---------------------|
| C15 | `GET http://127.0.0.1:3100/api/health` returns 200 | **YES** | `Invoke-RestMethod` or curl |
| C16 | Health response body contains expected fields | **YES** | JSON inspection |
| C17 | `GET http://127.0.0.1:3100/api/companies` returns 200 with empty list | **YES** | `Invoke-RestMethod` |
| C18 | No 500 errors related to `issue_inbox_archives` or missing tables | **YES** | Response inspection |

### 2.5 Database Verification

| # | Check | Expected Result | Verification Method |
|---|-------|-----------------|---------------------|
| C19 | New database is at `~/.paperclip/instances/sprint5-clean/db` | **YES** | `Test-Path` |
| C20 | New database is NOT at `~/.paperclip/instances/default/db` | **YES** | Path verification |
| C21 | All 74 migrations from `packages/db/src/migrations/` were applied | **YES** | Query `__drizzle_migrations` table |
| C22 | `issue_inbox_archives` table exists in the new database | **YES** | Schema query |
| C23 | `qsl_findings` table exists in the new database | **YES** | Schema query |
| C24 | No legacy companies (QSL, Directory Factory) in the new database | **YES** | Query `companies` table |
| C25 | No legacy data in the new database | **YES** | Row count verification |

### 2.6 UI Verification

| # | Check | Expected Result | Verification Method |
|---|-------|-----------------|---------------------|
| C26 | `GET http://127.0.0.1:3100/` returns HTML (UI loads) | **YES** | `Invoke-RestMethod` or browser snapshot |
| C27 | No schema-related 500 errors in browser console or network log | **YES** | Console/network inspection |
| C28 | Onboarding page loads (no companies exist yet) | **YES** | Browser verification |

### 2.7 Configuration Isolation

| # | Check | Expected Result | Verification Method |
|---|-------|-----------------|---------------------|
| C29 | `DATABASE_URL` is NOT set in the running server process | **YES** | Environment check |
| C30 | `PAPERCLIP_INSTANCE_ID` is `sprint5-clean` in the running server process | **YES** | Environment check |
| C31 | The server loaded config from `~/.paperclip/instances/sprint5-clean/config.json` | **YES** | Log inspection |
| C32 | The repo root `.env` is NOT loaded (it was renamed to `.env.legacy`) | **YES** | File check |

---

## 3. Explicit Non-Sharing Requirements

The clean runtime must be proven to NOT share any of the following with the legacy runtime:

| Resource | Legacy | Clean | Expected Separation |
|----------|--------|-------|---------------------|
| **Database** | `~/.paperclip/instances/default/db` | `~/.paperclip/instances/sprint5-clean/db` | **Different directories** |
| **Database port** | 54329 | 54330 | **Different ports** |
| **Environment file** | `~/.paperclip/instances/default/.env` | `~/.paperclip/instances/sprint5-clean/.env` (or none) | **Different paths** |
| **Config file** | `~/.paperclip/instances/default/config.json` | `~/.paperclip/instances/sprint5-clean/config.json` | **Different paths** |
| **Upload/storage directory** | `~/.paperclip/instances/default/data/storage` | `~/.paperclip/instances/sprint5-clean/data/storage` | **Different directories** |
| **Background workers** | Legacy plugin scheduler (if any) | New clean scheduler | **Different process contexts** |
| **Runtime state** | `~/.paperclip/instances/default/telemetry/state.json` | `~/.paperclip/instances/sprint5-clean/telemetry/state.json` | **Different files** |
| **Logs** | `~/.paperclip/instances/default/logs/server.log` | `~/.paperclip/instances/sprint5-clean/logs/server.log` | **Different files** |

---

## 4. Evidence to Capture After Successful Clean Startup

Once the clean runtime is verified, the following evidence must be preserved:

1. **Server startup log** (first 100 lines showing initialization)
2. **Migration count** (`SELECT COUNT(*) FROM __drizzle_migrations`)
3. **Table list** from `information_schema.tables`
4. **Companies table** (`SELECT id, name FROM companies`)
5. **Port binding snapshot** (`Get-NetTCPConnection` output)
6. **Process list** (`Get-Process` for node/postgres processes)
7. **Instance directory tree** (`Get-ChildItem` of `~/.paperclip/instances/sprint5-clean`)

---

## 5. Failure Criteria

If ANY of the following occur during the corrected clean startup, the operator must be notified immediately and Sprint 5B must be halted:

- The server connects to `~/.paperclip/instances/default/db` (legacy database).
- The server listens on port 54329 (legacy database port).
- Any file in `~/.paperclip/instances/default/` gets a new timestamp.
- Fewer than 74 migrations are applied.
- `issue_inbox_archives` or other expected tables are missing.
- Legacy companies (QSL, Directory Factory) appear in the clean database.
- The server fails to start or crashes during initialization.

---

**End of document. Clean runtime has not been created yet. Awaiting operator approval for the corrected startup command.**
