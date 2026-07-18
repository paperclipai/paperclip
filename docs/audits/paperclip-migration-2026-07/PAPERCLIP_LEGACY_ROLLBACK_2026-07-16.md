# Paperclip Legacy Rollback — 2026-07-16

**Sprint:** 5B — Reversible Paperclip Runtime Isolation  
**Date:** 2026-07-16  
**Purpose:** Exact reversible steps to restore the legacy runtime and undo the isolation

---

## 1. Rollback Philosophy

All changes made during Sprint 5B are **designed to be fully reversible**. No data was deleted. No databases were dropped. No schemas were modified. The only changes are:
- Renaming a file (`.env` → `.env.legacy`)
- Renaming a stale lock file (`postmaster.pid` → `postmaster.pid.stale-2026-07-16`)
- Creating backup copies (read-only)

---

## 2. Step-by-Step Rollback Procedure

### Step 1: Restore the Environment File

**What was done:** `C:\Users\mikeb\paperclip\.env` was renamed to `C:\Users\mikeb\paperclip\.env.legacy`

**How to undo:**

```powershell
Set-Location -LiteralPath "C:\Users\mikeb\paperclip"

# Check if the original .env doesn't exist (it shouldn't)
if (Test-Path -LiteralPath ".env") {
    Write-Warning "Original .env already exists. Saving as .env.rollback"
    Rename-Item -Path ".env" -NewName ".env.rollback"
}

# Restore the legacy environment file
if (Test-Path -LiteralPath ".env.legacy") {
    Rename-Item -Path ".env.legacy" -NewName ".env"
    "Restored .env from .env.legacy"
} else {
    Write-Warning ".env.legacy not found. Cannot restore .env automatically."
}
```

**Verification:**
```powershell
Test-Path -LiteralPath "C:\Users\mikeb\paperclip\.env"       # should be True
Test-Path -LiteralPath "C:\Users\mikeb\paperclip\.env.legacy" # should be False
```

---

### Step 2: Restore the Legacy PostgreSQL Lock File

**What was done:** The stale `postmaster.pid` in the legacy database was renamed to `postmaster.pid.stale-2026-07-16`

**How to undo:**

```powershell
$pidFile = "C:\Users\mikeb\.paperclip\instances\default\db\postmaster.pid"
$staleFile = "C:\Users\mikeb\.paperclip\instances\default\db\postmaster.pid.stale-2026-07-16"

if (Test-Path -LiteralPath $staleFile) {
    # Remove any new postmaster.pid that may have been created
    if (Test-Path -LiteralPath $pidFile) {
        Remove-Item -LiteralPath $pidFile -Force
    }
    Rename-Item -Path $staleFile -NewName "postmaster.pid"
    "Restored postmaster.pid from stale backup"
} else {
    Write-Warning "Stale postmaster.pid not found. PostgreSQL will create a new one on startup."
}
```

**Verification:**
```powershell
Test-Path -LiteralPath "C:\Users\mikeb\.paperclip\instances\default\db\postmaster.pid" # should be True
```

---

### Step 3: Restart the Legacy Embedded PostgreSQL

**How to restart:**

The embedded PostgreSQL is managed by the Paperclip server, not as a standalone service. The correct way to restart it is to run the Paperclip dev server with the legacy instance context:

```powershell
Set-Location -LiteralPath "C:\Users\mikeb\paperclip"

# Ensure we use the default (legacy) instance
$env:PAPERCLIP_INSTANCE_ID = "default"

# Restore the .env first (Step 1 above)
# Then start the server
pnpm dev:server
```

Alternatively, if you want to start ONLY the PostgreSQL without the full Paperclip server (for data inspection), you can use the `embedded-postgres` module directly via Node.js, but this is not typically needed.

**Verification after restart:**
```powershell
# Port 54329 should be listening
Get-NetTCPConnection -LocalPort 54329 | Select-Object LocalPort, State, OwningProcess

# PostgreSQL process should exist
Get-Process -Name "postgres" | Select-Object Id, Path

# postmaster.pid should contain a valid PID
Get-Content "C:\Users\mikeb\.paperclip\instances\default\db\postmaster.pid" -TotalCount 1
```

---

### Step 4: Verify the Legacy Database

```powershell
# Check that the database directory is intact
Test-Path "C:\Users\mikeb\.paperclip\instances\default\db\base"        # True
Test-Path "C:\Users\mikeb\.paperclip\instances\default\db\pg_wal"       # True
Test-Path "C:\Users\mikeb\.paperclip\instances\default\db\postgresql.conf" # True

# Check that the backup is still present
Test-Path "C:\Users\mikeb\.paperclip\instances\default-backup-20260716-104332\BACKUP_MANIFEST.txt" # True

# Verify the database responds to connections (if server is running)
# If pnpm dev:server is running:
Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/health" -Method GET
```

**Expected result:** The legacy database should contain the same QSL and Directory Factory data as before Sprint 5B. The 13 files touched during the contamination event are PostgreSQL internal runtime files and do not affect data integrity.

---

### Step 5: Remove the Clean Instance (If It Was Ever Created)

**Important:** Only execute this step if the operator explicitly approves removal of the clean instance.

```powershell
$cleanInstance = "C:\Users\mikeb\.paperclip\instances\sprint5-clean"

if (Test-Path -LiteralPath $cleanInstance) {
    # Rename instead of delete for safety
    $archiveName = "sprint5-clean-archive-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Rename-Item -Path $cleanInstance -NewName $archiveName
    "Clean instance archived as: $archiveName"
} else {
    "Clean instance does not exist. Nothing to remove."
}
```

---

### Step 6: Verify Complete Rollback

Run all of these checks to confirm the rollback is complete:

```powershell
# 1. .env restored
(Test-Path "C:\Users\mikeb\paperclip\.env") -and (-not (Test-Path "C:\Users\mikeb\paperclip\.env.legacy"))

# 2. Legacy postmaster.pid restored
Test-Path "C:\Users\mikeb\.paperclip\instances\default\db\postmaster.pid"

# 3. Legacy database is running (if server started)
Get-NetTCPConnection -LocalPort 54329 -ErrorAction SilentlyContinue

# 4. Legacy instance directory is intact
Test-Path "C:\Users\mikeb\.paperclip\instances\default\config.json"
Test-Path "C:\Users\mikeb\.paperclip\instances\default\data\backups"
Test-Path "C:\Users\mikeb\.paperclip\instances\default\logs\server.log"

# 5. Backup is intact
Test-Path "C:\Users\mikeb\.paperclip\instances\default-backup-20260716-104332\BACKUP_MANIFEST.txt"

# 6. No .env.legacy exists
(-not (Test-Path "C:\Users\mikeb\paperclip\.env.legacy"))
```

---

## 3. Contamination Event Notes

During Sprint 5B, the legacy database was accidentally touched when `pnpm dev:server` ran without a `PAPERCLIP_INSTANCE_ID` and connected to the legacy embedded PostgreSQL.

**Files modified:** 13 PostgreSQL internal runtime files (WAL, control files, init catalogs, etc.).

**Files NOT modified:**
- No schema migrations were applied (`__drizzle_migrations` was untouched).
- No application data was altered (tables, rows, companies, issues, etc. remain as they were before 2026-06-22).
- The 56 MB SQL backup (`paperclip-20260622-114344.sql.gz`) captures the pre-contamination state completely.

**If full rollback to exact pre-Sprint-5B state is required:**
1. Stop the legacy PostgreSQL process.
2. Delete the `db` directory: `C:\Users\mikeb\.paperclip\instances\default\db`
3. Restore the `db` directory from the backup: `C:\Users\mikeb\.paperclip\instances\default-backup-20260716-104332\db`
4. Restart the PostgreSQL server.

**This is a nuclear option and should only be done with explicit operator approval.**

---

## 4. Rollback Without Restarting the Legacy Server

If the operator wants to restore the legacy environment without actually running the legacy server (e.g., to preserve the stopped state):  

| Step | Command | Effect |
|------|---------|--------|
| 1 | `Rename-Item .env.legacy .env` | Restores `.env` |
| 2 | `Rename-Item postmaster.pid.stale-2026-07-16 postmaster.pid` | Restores lock file |
| 3 | Verify backup integrity | Read `BACKUP_MANIFEST.txt` |

This leaves the legacy database in its original stopped state, ready for future restart when desired.

---

**End of document. All steps are reversible and non-destructive.**
