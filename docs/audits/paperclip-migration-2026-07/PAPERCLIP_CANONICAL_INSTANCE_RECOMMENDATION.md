# Paperclip Canonical Instance Recommendation

**Sprint:** 5A — Runtime Isolation and Canonical Instance Determination  
**Date:** 2026-07-16  
**Decision:** Which Paperclip installation, repository, database, and runtime is canonical for Sprint 5B (Governed Decision Loop Implementation)

---

## 1. Canonical Instance Determination

### 1.1 The Audited Repository is Canonical

| Attribute | Value |
|-----------|-------|
| **Canonical Repository** | `C:\Users\mikeb\paperclip` |
| **Canonical Branch** | `docs/paperclip-operational-audit-2026` |
| **Canonical Commit** | `e6da760d1` (HEAD) |
| **Tag** | `audit-paperclip-baseline-2026-07-15` (on parent `eb38b6d97`) |
| **Rationale** | This is the only Paperclip source tree on the machine. It contains the completed 2026 operational audit artifacts (constitution, governance principles, architecture baseline). It is 4 commits ahead of `master` and contains only documentation changes — no runtime or schema modifications. |

### 1.2 The Legacy Runtime is NOT Canonical

| Attribute | Value |
|-----------|-------|
| **Legacy Runtime** | `C:\Users\mikeb\.paperclip\instances\default` |
| **Legacy Database** | Embedded PostgreSQL on port 54329 |
| **Why NOT Canonical** | Schema is 30+ migrations stale; `.env` mismatched; server not running; last active 2026-06-22; contains historical QSL and Directory Factory data that must be preserved but not used for new development. |

### 1.3 Classification of All Discovered Instances

| # | Instance | Classification | Rationale |
|---|----------|----------------|-----------|
| 1 | `C:\Users\mikeb\paperclip` (branch `docs/paperclip-operational-audit-2026`) | **CANONICAL CANDIDATE** | Only Paperclip repo. Hosts the 2026 audit. Clean code state. |
| 2 | `C:\Users\mikeb\.paperclip\instances\default` (embedded PG + data) | **LEGACY — PRESERVE** | Contains QSL and Directory Factory historical data. Must not be deleted or migrated. |
| 3 | PostgreSQL on `localhost:54329` | **ACTIVE CONFLICT** | Running but stale. Must be stopped and isolated to prevent accidental reuse. |
| 4 | `C:\Users\mikeb\paperclip\.env` (repo file) | **ACTIVE CONFLICT** | Port mismatch (5432 vs 54329). Would break `pnpm dev`. Must be neutralized. |
| 5 | `C:\Users\mikeb\bittensor-qsl\paperclip` (actually `quantumshield-api`) | **INACTIVE / ISOLATED** | Not Paperclip. No overlap. |
| 6 | `.paperclip.zip` / `paperclip.zip` (2026-04-16) | **LEGACY — PRESERVE** | Historical backups. Do not modify. |
| 7 | PM2 daemon (no managed processes) | **INACTIVE / ISOLATED** | Running but empty. Low risk. |
| 8 | MCP servers (Playwright, Context7, DevTools) | **INACTIVE / ISOLATED** | Unrelated tooling. |

---

## 2. Recommended Path

### 2.1 Selected Path: **C** — with **B** elements

> **C. A clean runtime must be created from the audited repository while preserving legacy systems read-only.**

**Why C, not B:**
- The existing runtime is not merely "needing minor isolation." The database schema is fundamentally incompatible with the current code (30 migrations behind, confirmed 500 errors).
- Attempting to "fix" the legacy runtime in-place (migrating the old DB, reconciling `.env`) would risk mutating the only copy of QSL/Directory Factory data and could introduce unpredictable state.
- The safest engineering path is to **treat the legacy embedded PostgreSQL as a read-only artifact** and **create a fresh dev runtime** using PGlite (the standard Paperclip dev mode).

**Why not A:** The runtime is not isolated and safe. Port 54329 is occupied, `.env` is mismatched, and schema is stale.

**Why not D:** No blocking ambiguity remains. The conflicts are well-characterized.

---

## 3. Can Implementation Safely Begin?

### 3.1 Answer: **NO — not yet.**

Before Sprint 5B (Governed Decision Loop Implementation) can begin, the following isolation gates must be passed:

| # | Gate | Status | Blocker |
|---|------|--------|---------|
| G1 | Legacy PostgreSQL on 54329 is stopped | **NOT DONE** | Active process PID 87504 |
| G2 | Legacy `.paperclip/instances/default` directory is preserved read-only | **NOT DONE** | Directory is currently writable |
| G3 | `.env` mismatch is neutralized so `pnpm dev` creates a clean PGlite DB | **NOT DONE** | `.env` points to dead port 5432 |
| G4 | `data/pglite` does not exist (or is confirmed empty) before first dev run | **NOT DONE** | Not yet verified |
| G5 | Port 3100 is free for clean server start | **DONE** | No listener on 3100 |
| G6 | `pnpm install` / lockfile is current | **UNKNOWN** | Not verified in this sprint |

**Once G1–G4 are satisfied, implementation can begin.**

---

## 4. Proposed Reversible Isolation Procedure

This procedure is designed to be fully reversible. No data is deleted. No databases are dropped. No environment files are overwritten.

### Phase 1: Preserve Evidence (Read-Only)

1. **Create a timestamped snapshot of the legacy instance directory.**
2. **Record the current process state.**
3. **Verify backup integrity.**

### Phase 2: Stop the Active Conflict (Reversible)

4. **Gracefully stop the embedded PostgreSQL on port 54329.**
   - Preferred: send SIGINT via `pg_ctl stop` if available.
   - Fallback: terminate PID 87504 via task manager or `Stop-Process`.
   - The data directory remains intact; only the process is stopped.
5. **Verify port 54329 is freed.**

### Phase 3: Neutralize the `.env` Mismatch (Reversible)

6. **Rename `.env` → `.env.legacy` (or create `.env.local` that overrides it).**
   - Renaming is fully reversible: `Rename-Item .env.legacy .env` restores it.
   - Goal: Unset `DATABASE_URL` so `pnpm dev` falls back to embedded PGlite (`data/pglite`).
7. **Verify that with `.env` neutralized, `pnpm dev` would use PGlite.**
   - Confirm no `data/pglite` directory exists yet.
   - If it exists and is non-empty, archive it before proceeding.

### Phase 4: Verify Clean Runtime (Non-Destructive)

8. **Run `pnpm -r typecheck`** to confirm the repo compiles.
9. **Run `pnpm test`** (Vitest suite) to confirm baseline tests pass.
10. **Start `pnpm dev` and confirm:**
    - Server starts on port 3100 (or auto-detects).
    - `data/pglite` is created automatically.
    - Migrations apply cleanly to the new PGlite database.
    - Health endpoint `GET /api/health` returns 200.
    - The Companies list is empty (clean slate).

### Phase 5: Legacy Preservation Verification

11. **Confirm `.paperclip/instances/default` is untouched.**
12. **Confirm `.paperclip/instances/default/db/postmaster.pid` is gone** (because the process stopped, not because the directory was deleted).
13. **Confirm automated backups in `.paperclip/instances/default/data/backups` are intact.**

---

## 5. Exact Commands for the Next Approved Step

**Prerequisite:** Approval from the operator to execute the isolation procedure.

**Command set (PowerShell, reversible):**

```powershell
# === PHASE 1: Preserve Evidence ===
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item -LiteralPath "C:\Users\mikeb\.paperclip\instances\default" -Destination "C:\Users\mikeb\.paperclip\instances\default-backup-$timestamp" -Recurse -Force
Get-Process -Id 87504 -ErrorAction SilentlyContinue | Select-Object ProcessId, Name, StartTime | Out-File -FilePath "C:\Users\mikeb\.paperclip\instances\default-backup-$timestamp\process-snapshot.txt"

# === PHASE 2: Stop Active Conflict (embedded PostgreSQL) ===
# Attempt graceful stop via pg_ctl if available in the embedded bin directory
$pgCtl = Get-ChildItem -Path "C:\Users\mikeb\.paperclip\instances\default\db" -Recurse -Filter "pg_ctl.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 FullName
if ($pgCtl) {
    & $pgCtl.FullName stop -D "C:\Users\mikeb\.paperclip\instances\default\db" -m fast
} else {
    # Fallback: direct process termination (data remains safe)
    Stop-Process -Id 87504 -Force -ErrorAction SilentlyContinue
}

# Verify port is freed
Get-NetTCPConnection -LocalPort 54329 -ErrorAction SilentlyContinue

# === PHASE 3: Neutralize .env (reversible rename) ===
Rename-Item -Path "C:\Users\mikeb\paperclip\.env" -NewName ".env.legacy"

# Verify rename succeeded
Test-Path -LiteralPath "C:\Users\mikeb\paperclip\.env.legacy"
Test-Path -LiteralPath "C:\Users\mikeb\paperclip\.env"   # should be False

# === PHASE 4: Verify clean runtime readiness ===
Set-Location -LiteralPath "C:\Users\mikeb\paperclip"
pnpm -r typecheck
pnpm test

# If typecheck and tests pass, the next step would be:
# pnpm dev
# Then verify http://localhost:3100/api/health
```

---

## 6. Rollback Procedure

If anything goes wrong, the entire isolation can be reversed in under 60 seconds:

```powershell
# === ROLLBACK: Restore .env ===
Set-Location -LiteralPath "C:\Users\mikeb\paperclip"
if (Test-Path ".env.legacy") {
    if (Test-Path ".env") { Rename-Item -Path ".env" -NewName ".env.clean-override" }
    Rename-Item -Path ".env.legacy" -NewName ".env"
}

# === ROLLBACK: Restart legacy embedded PostgreSQL ===
# If pg_ctl was used to stop it, restart with:
$pgCtl = Get-ChildItem -Path "C:\Users\mikeb\.paperclip\instances\default\db" -Recurse -Filter "pg_ctl.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 FullName
if ($pgCtl) {
    & $pgCtl.FullName start -D "C:\Users\mikeb\.paperclip\instances\default\db"
} else {
    Write-Warning "pg_ctl not found; manual restart via Paperclip CLI may be required"
}

# Verify port is re-bound
Get-NetTCPConnection -LocalPort 54329 -ErrorAction SilentlyContinue

# === ROLLBACK: Remove clean dev artifacts if created ===
if (Test-Path "C:\Users\mikeb\paperclip\data\pglite") {
    # Rename rather than delete for safety
    Rename-Item -Path "C:\Users\mikeb\paperclip\data\pglite" -NewName "data/pglite-clean-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
}
```

**Rollback guarantees:**
- `.env` is restored to original state.
- Legacy database is restarted on 54329.
- Any accidentally created `data/pglite` is archived, not deleted.
- The legacy instance backup remains in place.

---

## 7. List of Unknowns and Unsupported Assumptions

| # | Unknown / Assumption | Impact | Recommended Follow-Up |
|---|----------------------|--------|----------------------|
| U1 | Whether the Hostinger VPS (`147.93.42.105:65002`) ever hosted a Paperclip deployment | Could reveal an additional active runtime or database | SSH into VPS and check for running Node/Postgres processes |
| U2 | Whether `paperclip.quantumshieldlabs.dev` resolves to the Hostinger VPS or another host | Could reveal a live public deployment | DNS lookup and port scan |
| U3 | The exact reason the server stopped on 2026-06-22 (crash vs reboot vs manual kill) | Helps assess stability risk for future restarts | Check Windows Event Log for PID 87504 or application crashes |
| U4 | Whether any of the 12 workspace directories contain uncommitted agent work | Potential data loss if instance is moved | Inventory `.paperclip/instances/default/workspaces/*/git-repo` status |
| U5 | Whether the `.env` secrets (BETTER_AUTH_SECRET, PAPERCLIP_AGENT_JWT_SECRET) are still valid | Authentication may break if secrets are rotated | Do not rotate unless necessary; treat as legacy |
| U6 | Whether `pnpm install` / lockfile is current and `pnpm -r typecheck` passes today | Blocks dev start if dependency drift exists | Run `pnpm install` and `pnpm -r typecheck` before Phase 4 |
| U7 | Whether a `data/pglite` directory was ever created and then deleted in the repo | Could leave stale migration state | Check git history for `data/pglite` |
| U8 | Whether the Paperclip CLI / desktop app is installed and could auto-launch | Could resurrect the legacy runtime unexpectedly | Check `npm list -g`, Start Menu, and registry for Paperclip app |
| U9 | The actual password for the embedded PostgreSQL on 54329 | Assumed `paperclip` (default) | If custom password was set, PGlite dev mode may need different config |
| U10 | Whether the `quantumshield-api` repo has any hidden Paperclip dependency or shared database connection string | Could be a hidden consumer of port 54329 | Search `quantumshield-api` code for `54329` or `paperclip` |

---

## 8. Smallest Next Action

**Before any code changes or server starts:**

> **Operator approval to execute the reversible isolation procedure (Phases 1–3).**
>
> Specifically:
> 1. Create a timestamped backup of `.paperclip/instances/default`.
> 2. Stop the embedded PostgreSQL process on port 54329.
> 3. Rename `C:\Users\mikeb\paperclip\.env` to `.env.legacy`.
>
> **These three actions are read-only with respect to production data and are fully reversible.**

**After approval and isolation:**

> Run `pnpm -r typecheck` and `pnpm test` to verify the canonical repo is healthy.
>
> Then, and only then, begin Sprint 5B implementation.

---

## 9. Final Answer Summary

| Question | Answer |
|----------|--------|
| **Which instance should become canonical?** | `C:\Users\mikeb\paperclip` on branch `docs/paperclip-operational-audit-2026` (commit `e6da760d1`). |
| **Which legacy instances must be preserved?** | `C:\Users\mikeb\.paperclip\instances\default` (embedded PG, backups, workspaces, company data). The 2026-04-16 zip backups. The `server.log` forensic artifact. |
| **Can implementation safely begin?** | **NO.** Three isolation gates remain open: (1) PostgreSQL on 54329 is still running, (2) `.env` mismatch is active, (3) clean PGlite runtime is not yet verified. |
| **Smallest next action?** | **Request operator approval** to execute the reversible 3-step isolation: backup legacy instance, stop PostgreSQL on 54329, rename `.env` to `.env.legacy`. |
