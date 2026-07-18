# Paperclip Data and Database Map

**Sprint:** 5A — Runtime Isolation and Canonical Instance Determination  
**Date:** 2026-07-16  
**Scope:** Read-only survey of all databases, storage, backups, and persistent state  

---

## 1. Primary Database — Embedded PostgreSQL

### 1.1 Location & Configuration

| Attribute | Value |
|-----------|-------|
| **Data directory** | `C:\Users\mikeb\.paperclip\instances\default\db` |
| **Port** | **54329** |
| **Host** | `localhost` |
| **Database name** | `paperclip` |
| **User** | `paperclip` |
| **Password** | `paperclip` (embedded default) |
| **PID** | 87504 (from `postmaster.pid`) |
| **Status** | `ready` |
| **First created** | 2026-03-27 16:04:19 |
| **Managed by** | Paperclip embedded-postgres launcher (not system PostgreSQL) |

### 1.2 Schema State — Critical Finding

| Metric | Value | Assessment |
|--------|-------|------------|
| Migrations applied at first run | 45 (0000 through 0044) | Log evidence |
| Migrations present in repo | **74** files in `packages/db/src/migrations/` | Current code |
| Missing migrations | **~30** migrations never applied | **SCHEMA STALE** |
| Latest migration in repo | `0072_qsl_findings_review_states.sql` | Code expectation |
| Missing tables (known) | `issue_inbox_archives` (and potentially others) | Server log 500 errors |

**Impact:** The database schema is approximately 30 migrations behind the current repository code. Running the current server code against this database produces `500` errors for features expecting newer tables (e.g., `issue_inbox_archives`).

### 1.3 Companies

| Company ID | Inferred Name | Status | Evidence |
|------------|---------------|--------|----------|
| `839bfea4-f16b-448b-9b1a-d040aededb90` | **QSL** (Quantum Shield Labs) | Active historically | Log shows `/QSL/agents/ceo/dashboard`, `/api/qsl/findings`, goals, routines, projects |
| `11dc08e7-2135-4c0f-a605-034285555d8e` | **Directory Factory** (inferred) | Active historically | Log shows agents, routines, projects, dashboard, in-progress issues |

**Note:** Both companies have historical activity but the server has been down since 2026-06-22.

### 1.4 Database Size & Health

| Metric | Value |
|--------|-------|
| Approximate DB size | ~56 MB (per backup size) |
| Backup count | 4+ observed in retention window |
| Last backup | `paperclip-20260622-114344.sql.gz` (56.19 MB) |
| Log file size | 174,897,593 bytes (`server.log`) |
| Log span | 2026-03-27 through 2026-06-22 |

---

## 2. Data Directory Structure — `.paperclip/instances/default`

```
C:\Users\mikeb\.paperclip\instances\default\
├── .env                          # PAPERCLIP_AGENT_JWT_SECRET only
├── config.json                   # Instance configuration (see §3)
├── config.json.backup            # Backup of config
├── companies\
│   ├── 11dc08e7-2135-4c0f-a605-034285555d8e\
│   │   └── claude-prompt-cache\  # Cached prompts
│   └── 839bfea4-f16b-448b-9b1a-d040aededb90\
│       └── claude-prompt-cache\  # Cached prompts
├── data\
│   ├── backups\                  # Automated SQL dumps (daily/weekly/monthly)
│   ├── run-logs\                 # Run log artifacts
│   └── storage\                   # Uploaded files
│       └── 839bfea4-f16b-448b-9b1a-d040aededb90\
│           └── assets\
│               └── companies\      # Company asset uploads
├── db\                           # Embedded PostgreSQL data dir
│   ├── base\                     # PG base directory
│   ├── pg_wal\                   # Write-ahead logs
│   ├── postmaster.pid             # Lock file (PID 87504)
│   └── ... (standard PG internals)
├── logs\
│   └── server.log                 # 174 MB server log
├── projects\                     # Project worktrees
│   ├── 11dc08e7-2135-4c0f-a605-034285555d8e\
│   └── 839bfea4-f16b-448b-9b1a-d040aededb90\
├── secrets\
│   └── master.key                 # Encrypted secrets master key
├── telemetry\
│   └── state.json                 # Telemetry state (installId, firstSeenVersion)
└── workspaces\                   # 12 agent workspaces
    ├── 035e05af-551c-4bdf-9977-cdb48170088e
    ├── 0a6e95c3-bdfa-487b-bff0-4c1700d852af
    ├── 1d62eeb0-8fec-478a-a9d5-d44dcc0b8c2c
    ├── 2731be18-4f54-454f-aadb-b9fe4b7d8476
    ├── 3c03fead-70e3-42d8-bd46-ed894305b5c1  (contains life/, memory/)
    ├── 73c8c13d-f78a-4cce-b9dd-f2e9dfff3abe
    ├── 74009544-0d7f-4522-8a1a-7292e607432b
    ├── b47ac8bf-64a2-4c31-be35-2a35ac4ab756
    ├── b5495be0-1843-4169-9629-24cad83e2dac
    ├── cb09ca53-87e0-42b3-bc27-79984a0f047e
    ├── d10b2494-df70-4cab-b5aa-9e497bdb3cfa
    ├── e1ca6965-0495-402d-a49d-2a16e584335f
    └── e60f4c00-fe74-45ee-9895-bf8c97dc148e
```

---

## 3. Configuration Files

### 3.1 `C:\Users\mikeb\.paperclip\instances\default\config.json`

| Key | Value | Interpretation |
|-----|-------|----------------|
| `database.mode` | `embedded-postgres` | Self-managed PostgreSQL |
| `database.embeddedPostgresDataDir` | `C:\Users\mikeb\.paperclip\instances\default\db` | Data directory |
| `database.embeddedPostgresPort` | **54329** | Actual port |
| `server.deploymentMode` | `local_trusted` | Local development |
| `server.exposure` | `private` | Localhost only |
| `server.host` | `127.0.0.1` | Bind address |
| `server.port` | **3100** | Server port |
| `server.serveUi` | `True` | Serves built UI |
| `auth.baseUrlMode` | `auto` | Auto-detect base URL |
| `auth.disableSignUp` | `False` | Sign-up enabled |
| `storage.provider` | `local_disk` | Local file storage |
| `secrets.provider` | `local_encrypted` | Local encrypted secrets |
| `secrets.strictMode` | `False` | Non-strict secrets |

### 3.2 `C:\Users\mikeb\paperclip\.env` (Repository `.env`)

| Key | Value | Conflict? |
|-----|-------|-----------|
| `DATABASE_URL` | `postgres://paperclip:paperclip@localhost:5432/paperclip` | **YES** — points to port 5432, but DB is on **54329** |
| `PORT` | `3100` | Consistent |
| `SERVE_UI` | `false` | **YES** — `config.json` says `serveUi: True` |
| `BETTER_AUTH_SECRET` | `[REDACTED]` | Secret present |
| `QSL_BRIDGE_PATH` | `C:/Users/mikeb/quantumshield-core/bridge/output` | QSL-specific integration path |

### 3.3 `C:\Users\mikeb\.paperclip\instances\default\.env`

| Key | Value |
|-----|-------|
| `PAPERCLIP_AGENT_JWT_SECRET` | `[REDACTED]` |

---

## 4. Backups

| Backup File | Date | Size | Retention Status |
|-------------|------|------|------------------|
| `paperclip-20260622-114344.sql.gz` | 2026-06-22 | 56.19 MB | Current daily |
| `paperclip-20260615-065219.sql.gz` | 2026-06-15 | 56.19 MB | Weekly |
| `paperclip-20260614-235219.sql.gz` | 2026-06-14 | 56.19 MB | Daily |
| `paperclip-20260607-234809.sql.gz` | 2026-06-07 | 56.19 MB | Weekly |

**Backup configuration:**
- Interval: 60 minutes
- Retention: daily 7 days, weekly 4 weeks, monthly 1 month
- Automatic pruning: 114 old backups were pruned on 2026-06-22

---

## 5. Alternate / Potential Databases

| Location | Type | Status | Assessment |
|----------|------|--------|------------|
| `C:\Users\mikeb\paperclip\data\pglite` | PGlite (dev) | **Does not exist** | Dev database never initialized in repo |
| `localhost:5432` | Standard PostgreSQL | **No listener** | `.env` points here, but nothing is listening |
| Docker volumes | Postgres | None found | No Docker postgres volumes |
| WSL PostgreSQL | System PG | **WSL stopped** | Not accessible |
| Cloud-hosted (Supabase, RDS, etc.) | Unknown | Not discovered | No cloud DB URLs in local `.env` files |

---

## 6. Data Classification

| Data Store | Classification | Reason |
|------------|----------------|--------|
| Embedded PostgreSQL on 54329 | **ACTIVE CONFLICT** | Live DB with stale schema; `.env` mismatch makes it unreachable by `pnpm dev` |
| `server.log` (174 MB) | **LEGACY — PRESERVE** | Complete runtime history; forensic value |
| Automated SQL backups | **LEGACY — PRESERVE** | Restorable snapshots of the 2026-Q2 operational state |
| Company prompt caches | **LEGACY — PRESERVE** | QSL and Directory Factory Claude prompt caches |
| Workspace directories (12) | **LEGACY — PRESERVE** | Agent workspace states; potential uncommitted work |
| `secrets/master.key` | **ACTIVE CONFLICT** | Encrypted secrets key for the legacy instance |
| Telemetry state | **INACTIVE / ISOLATED** | First-seen version 0.3.1; no privacy concern |
| `.paperclip.zip` backups | **LEGACY — PRESERVE** | Historical archives |

---

## 7. Unsupported Assumptions

1. Assumed that `.env` password `paperclip` is the actual embedded DB password (standard embedded default).
2. Assumed no other `.env` files exist outside the discovered paths (search was depth-limited).
3. Assumed the `bittensor-qsl\paperclip` directory contains no hidden Paperclip runtime data (it is `quantumshield-api`).
