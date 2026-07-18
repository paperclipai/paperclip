# Paperclip Isolation Execution — 2026-07-16

**Sprint:** 5B — Reversible Paperclip Runtime Isolation  
**Date:** 2026-07-16  
**Status:** Isolation partially complete with critical correction discovered mid-execution

---

## 1. Sprint 5A Evidence Preservation

All five investigation documents from Sprint 5A were confirmed present and readable before any runtime changes:

| Document | SHA256 | Size |
|----------|--------|------|
| `PAPERCLIP_INSTANCE_INVENTORY.md` | `3E5407F90094C1CE389B7E2E7CE244D760F113925C37958B4CE2F57F6FF00479` | 4,574 bytes |
| `PAPERCLIP_RUNTIME_MAP.md` | `368764B071E16C4CCB7C45604AE6F2063CBA2AA4D6616C1468DBF97A9AB2F896` | 6,962 bytes |
| `PAPERCLIP_DATA_AND_DATABASE_MAP.md` | `3D094696794F55D772A12BB02260B52456AACE8C51628B54DB4BF36A8204E103` | 9,055 bytes |
| `PAPERCLIP_CONFLICT_RISK_ASSESSMENT.md` | `8B234FA996434F94F90A086C9DA50BA2750AEF69A17B8BD768A628D96B7A864E` | 9,595 bytes |
| `PAPERCLIP_CANONICAL_INSTANCE_RECOMMENDATION.md` | `B69248F5DFE6797B490B8165DFC2B937CCB66CE8841285E8D7861E2072B3FF34` | 13,574 bytes |

---

## 2. Timestamped Legacy Backup

A complete directory-level backup was created using `robocopy` (the most reliable method for live PostgreSQL data on Windows) before any process was stopped.

| Attribute | Value |
|-----------|-------|
| **Source** | `C:\Users\mikeb\.paperclip\instances\default` |
| **Backup path** | `C:\Users\mikeb\.paperclip\instances\default-backup-20260716-104332` |
| **Timestamp** | 2026-07-16 10:43:32 UTC |
| **Files** | 25,066 |
| **Directories** | 260 |
| **Total size** | 1,268.65 MB (1,330,278,866 bytes) |
| **Robocopy exit code** | 1 (success; codes 0–7 are OK) |
| **Manifest hash** | `8C3388651B6E9482100FF381A4D003627B6A4879A18129F1A2185D0A538B0E6A` |

Representative files verified in backup:
- `db/postmaster.pid` (stale)
- `db/PG_VERSION` (18)
- `db/postgresql.conf`
- `db/pg_hba.conf`
- `logs/server.log`
- `data/backups/paperclip-20260622-114344.sql.gz`
- `config.json`
- `secrets/master.key`

**Backup remains intact and verified as of end of Sprint 5B.**

---

## 3. Legacy Runtime State Capture

A state capture file was written to `C:\Users\mikeb\paperclip\LEGACY_POSTGRES_STATE_2026-07-16.txt`.

**Key findings from state capture:**

| Attribute | Value |
|-----------|-------|
| **PID** | 87504 (recorded in stale `postmaster.pid`) |
| **Port** | 54329 |
| **Data directory** | `C:\Users\mikeb\.paperclip\instances\default\db` |
| **Status at time of capture** | **Already stopped** — process did not exist |
| **Port 54329 at capture** | **FREE** — no listener |

**Critical discovery:** The PostgreSQL process was already dead before any stop command was issued. The `postmaster.pid` file was stale (left behind from a prior crash or abrupt termination). The database had been down since at least before Sprint 5B began, despite the stale lock file suggesting it was running.

---

## 4. Legacy PostgreSQL Process Stop

Because the process was already dead, no process termination was required. The stale `postmaster.pid` lock file was renamed to `postmaster.pid.stale-2026-07-16` to prevent confusion.

**Verification after stop:**
- Port 54329: **FREE** (verified via `Get-NetTCPConnection` and TCP connect test)
- No `postgres` processes on system: **CONFIRMED**
- Legacy data directory intact: **CONFIRMED**
- No unrelated PostgreSQL processes affected: **CONFIRMED** (none existed)

---

## 5. Legacy Environment File Isolation

The repository `.env` file was renamed to preserve it and prevent accidental loading.

| Action | Result |
|--------|--------|
| Original `.env` | `C:\Users\mikeb\paperclip\.env` → **no longer exists** |
| Preserved file | `C:\Users\mikeb\paperclip\.env.legacy` → **exists and verified** |
| Recorded variable names (no values) | `DATABASE_URL`, `PORT`, `SERVE_UI`, `BETTER_AUTH_SECRET`, `QSL_BRIDGE_PATH` |

---

## 6. Clean-Runtime Prerequisites (Verified)

| Check | Result |
|-------|--------|
| Branch | `docs/paperclip-operational-audit-2026` ✓ |
| HEAD | `e6da760d15fbed89480b952dd74531460986a40e` ✓ |
| `DATABASE_URL` env var | **unset** ✓ |
| Port 3100 | **FREE** ✓ |
| Port 3101 | **FREE** ✓ |
| No Paperclip processes | **CONFIRMED** ✓ |
| No `data/pglite` directory | **CONFIRMED** ✓ |
| Node.js | v22.14.0 ✓ |
| pnpm | 9.15.4 ✓ |

---

## 7. Critical Correction — Attempted Clean Startup Failed

**Command executed:** `pnpm dev:server` (from repo root, `DATABASE_URL` unset)

**Expected behavior:** Create a clean PGlite database in `data/pglite`.

**Actual behavior:** The server connected to the **legacy embedded PostgreSQL** database at `C:\Users\mikeb\.paperclip\instances\default\db` on port 54329.

**Server output excerpt:**
```
[10:55:35] INFO: Using embedded PostgreSQL because no DATABASE_URL set
  (dataDir=C:\Users\mikeb\.paperclip\instances\default\db, port=54329)
[10:55:35] INFO: Embedded PostgreSQL cluster already exists; skipping init
[10:55:36] INFO: Embedded PostgreSQL ready
[10:55:37] INFO: Server listening on 127.0.0.1:3100
```

**This was a contamination event.** The legacy database was touched by this startup.

---

## 8. Legacy Database Contamination Assessment

After the attempted startup, 13 files in the legacy database directory had new modification timestamps (between 10:55:35 and 10:55:50 on 2026-07-16).

**Files modified (all PostgreSQL internal runtime files):**
- `postmaster.opts`
- `postmaster.pid` (later renamed stale)
- `base/16384/pg_internal.init`
- `base/5/pg_internal.init`
- `global/config_exec_params`
- `global/pg_control`
- `global/pg_internal.init`
- `pg_logical/replorigin_checkpoint`
- `pg_multixact/members/0001`
- `pg_multixact/offsets/0000`
- `pg_subtrans/000D`
- `pg_wal/00000001000000010000003B` (WAL segment)
- `pg_xact/0000`

**Critical finding:** **NO schema migrations were applied.** The server log shows "Migrations already applied" and no `__drizzle_migrations` modifications were detected. The modifications are purely PostgreSQL internal files updated during server startup/shutdown. **No application data was altered.**

However, the backup (`default-backup-20260716-104332`) is now the **authoritative pre-contamination state** of the legacy database.

---

## 9. Root Cause — Why the Startup Used the Legacy Database

A read-only code investigation revealed the truth:

### 9.1 PGlite Is NOT a Separate Database Mode

The `DatabaseMode` type in `server/src/config.ts` only supports two values:
```typescript
type DatabaseMode = "embedded-postgres" | "postgres";
```

PGlite references in the codebase (`packages/db/src/runtime-config.ts`, `cli/src/config/store.ts`) are **legacy migration aliases** that map `pglite` config properties to `embedded-postgres` equivalents. They do not create a separate runtime mode.

### 9.2 Unset DATABASE_URL Always Selects Embedded PostgreSQL

The `resolveDatabaseTarget()` function in `packages/db/src/runtime-config.ts` (lines 220–266) has this logic:
1. If `DATABASE_URL` env var is set → use external PostgreSQL
2. If `DATABASE_URL` in `.paperclip` env file is set → use external PostgreSQL
3. If `config.json` specifies `database.mode === "postgres"` and has a connection string → use external PostgreSQL
4. **Otherwise → ALWAYS use `embedded-postgres` mode**

There is **no PGlite branch** in this function.

### 9.3 The Embedded PostgreSQL Data Directory Is Controlled by PAPERCLIP_INSTANCE_ID

`server/src/home-paths.ts` (lines 21–38):
```typescript
export function resolvePaperclipInstanceId(): string {
  const raw = process.env.PAPERCLIP_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID; // "default"
  return raw;
}
export function resolveDefaultEmbeddedPostgresDir(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "db");
}
```

Without `PAPERCLIP_INSTANCE_ID` set, the data directory defaults to `~/.paperclip/instances/default/db` — exactly the legacy database.

### 9.4 AGENTS.md Documentation Is Misleading for This Version

The instruction `rm -rf data/pglite` in `AGENTS.md` implies PGlite is used for dev. **It is not.** The correct dev database mechanism for this codebase is **embedded PostgreSQL** via `embedded-postgres`, not PGlite.

---

## 10. Corrected Clean Runtime Design

To create a genuinely isolated clean runtime, the server must be launched with a **new `PAPERCLIP_INSTANCE_ID`** that points to a completely separate instance directory.

### 10.1 Design Parameters

| Parameter | Legacy Instance | Clean Instance |
|-----------|---------------|----------------|
| **Instance ID** | `default` | `sprint5-clean` |
| **Instance root** | `~/.paperclip/instances/default` | `~/.paperclip/instances/sprint5-clean` |
| **Database directory** | `~/.paperclip/instances/default/db` | `~/.paperclip/instances/sprint5-clean/db` |
| **Database port** | 54329 | **54330** (explicitly different) |
| **HTTP server port** | 3100 | 3100 (auto-detect if taken) |
| **Config file** | `~/.paperclip/instances/default/config.json` | `~/.paperclip/instances/sprint5-clean/config.json` |
| **Logs** | `~/.paperclip/instances/default/logs` | `~/.paperclip/instances/sprint5-clean/logs` |
| **Storage** | `~/.paperclip/instances/default/data/storage` | `~/.paperclip/instances/sprint5-clean/data/storage` |
| **Workspaces** | `~/.paperclip/instances/default/workspaces` | `~/.paperclip/instances/sprint5-clean/workspaces` |

### 10.2 Why This Is Isolated

- The instance directory is determined by `PAPERCLIP_INSTANCE_ID`, which is separate.
- The config file path is derived from the instance directory.
- The database data directory is derived from the instance directory.
- No `.env` file exists in the repo root, so `DATABASE_URL` is not set.
- The new database directory does not exist, so PostgreSQL will initialize it from scratch.
- Migrations will apply cleanly to the fresh database.

---

## 11. Recommended Next Command (Requires Approval)

**Do NOT run `pnpm dev` or `pnpm dev:server` without setting `PAPERCLIP_INSTANCE_ID` first.**

### Step 1: Create the clean instance directory and config

```powershell
$instanceId = "sprint5-clean"
$instanceDir = "$env:USERPROFILE\.paperclip\instances\$instanceId"
New-Item -ItemType Directory -Path $instanceDir -Force | Out-Null

$configJson = @'
{
  "$meta": {
    "version": 1,
    "updatedAt": "2026-07-16T00:00:00.000Z",
    "source": "configure"
  },
  "database": {
    "mode": "embedded-postgres",
    "embeddedPostgresPort": 54330
  }
}
'@

Set-Content -Path "$instanceDir\config.json" -Value $configJson -Encoding UTF8
```

### Step 2: Launch the clean server

```powershell
Set-Location -LiteralPath "C:\Users\mikeb\paperclip"
$env:PAPERCLIP_INSTANCE_ID = "sprint5-clean"
$env:DATABASE_URL = $null
pnpm dev:server
```

This will create a fresh embedded PostgreSQL database at `~/.paperclip/instances/sprint5-clean/db` on port 54330, completely separated from the legacy instance.

---

## 12. Rollback Notes

- The legacy `.env` is preserved as `.env.legacy`; rename it back to `.env` to restore.
- The legacy database backup at `default-backup-20260716-104332` is the authoritative pre-contamination state.
- Stale `postmaster.pid` was renamed to `postmaster.pid.stale-2026-07-16`; if restarting the legacy database, PostgreSQL will create a new `postmaster.pid` automatically.
- No data was deleted or migrated.
- No schema changes were applied to the legacy database.

---

## 13. Remaining Unknowns

1. Whether the `quantumshield-api` repo (`bittensor-qsl/paperclip`) has any hidden dependency on the legacy database or port 54329.
2. Whether the Hostinger VPS still hosts a live Paperclip deployment.
3. Whether the `BETTER_AUTH_SECRET` in the legacy `.env` is still valid.
4. Whether any of the 12 workspace directories contain uncommitted agent work.
5. Whether `paperclip.quantumshieldlabs.dev` resolves to a live host.

---

## 14. Classification of All Instances (Updated)

| Instance | Classification | Reason |
|----------|----------------|--------|
| `C:\Users\mikeb\paperclip` (audit branch) | **CANONICAL CANDIDATE** | Only Paperclip repo. Contains 2026 audit. |
| `C:\Users\mikeb\.paperclip\instances\default` | **LEGACY — PRESERVE** | Contains QSL/Directory Factory data. **Touched by contamination event.** Backup is authoritative. |
| `C:\Users\mikeb\.paperclip\instances\default-backup-20260716-104332` | **LEGACY — PRESERVE** | Authoritative pre-contamination snapshot. |
| PostgreSQL on port 54329 | **INACTIVE / ISOLATED** | Process was already dead. Stale PID file renamed. |
| `C:\Users\mikeb\paperclip\.env.legacy` | **LEGACY — PRESERVE** | Original `.env`; no longer loaded. |
| `C:\Users\mikeb\bittensor-qsl\paperclip` | **INACTIVE / ISOLATED** | Not Paperclip. |
| `.paperclip.zip` backups | **LEGACY — PRESERVE** | Historical archives. |
| **Proposed clean instance** (`sprint5-clean`) | **CANONICAL CANDIDATE (pending)** | Not yet created. Will become the canonical runtime once approved and initialized. |

---

**End of document. No further runtime changes were made after the contamination discovery.**
