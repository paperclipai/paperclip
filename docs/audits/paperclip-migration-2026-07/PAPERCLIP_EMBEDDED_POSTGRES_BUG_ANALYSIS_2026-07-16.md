# Paperclip Sprint 5B — Root Cause Analysis: Embedded PostgreSQL Startup Bug

**Sprint:** 5B — Reversible Paperclip Runtime Isolation  
**Date:** 2026-07-16  
**Issue:** `pnpm dev:server` fails with `Error: Cannot access 'process' before initialization`  
**Location:** `packages/db/src/embedded-postgres-error.ts:88` (caught), originating from `embedded-postgres` module initialization  

---

## 1. Summary of Attempted Startup

Two attempts to start the clean `sprint5-clean` instance were made:

1. **Attempt 1 (incomplete config):** Config.json with only `$meta` and `database` sections. Server fell back to port 54329 (legacy port) because the schema-incomplete config was rejected, returning `null` from `readConfigFile()`.
2. **Attempt 2 (complete config):** Config.json with all required sections (`$meta`, `database`, `logging`, `server`). Server correctly identified `dataDir=C:\Users\mikeb\.paperclip\instances\sprint5-clean\db` and `port=54330`, but crashed during `embeddedPostgres.initialise()`.

**Result:** Both attempts failed. The second attempt hit a code-level bug in the `embedded-postgres` package (v18.1.0-beta.16).

---

## 2. Error Stack Trace

```
Error: Cannot access 'process' before initialization
    at formatEmbeddedPostgresError (packages/db/src/embedded-postgres-error.ts:88:10)
    at startServer (server/src/index.ts:398:19)
```

**Important:** Line 88 in `embedded-postgres-error.ts` is `return new Error(parts.join(" "));`. This line does **not** access `process`. The error is actually originating from the `embedded-postgres` module's `.initialise()` method, and `formatEmbeddedPostgresError` is merely wrapping it in a new Error object with additional context. The stack trace shows `formatEmbeddedPostgresError` because that is where the new Error is constructed.

---

## 3. Root Cause Tracing

### 3.1 The Error Origin

The error is thrown from `embeddedPostgres.initialise()` at `server/src/index.ts:395`:

```typescript
// server/src/index.ts (lines 393-402)
if (!clusterAlreadyInitialized) {
  try {
    await embeddedPostgres.initialise();
  } catch (err) {
    logEmbeddedPostgresFailure("initialise", err);
    throw formatEmbeddedPostgresError(err, {
      fallbackMessage: `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${port}`,
      recentLogs: logBuffer.getRecentLogs(),
    });
  }
}
```

The `err` object passed to `formatEmbeddedPostgresError` already has the message `"Cannot access 'process' before initialization"`. This means the `embedded-postgres` package itself is throwing this error during its initialization.

### 3.2 The Embedded-Postgres Package

Package details:
- **Name:** `embedded-postgres`
- **Version:** `18.1.0-beta.16` (beta version)
- **Location:** `node_modules/.pnpm/node_modules/embedded-postgres/`
- **Entry point:** `dist/index.js` (ESM module with `import` syntax)

The `dist/index.js` file contains:
```javascript
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { platform, tmpdir, userInfo } from 'os';
import { spawn, exec } from 'child_process';
import pg from 'pg';
import AsyncExitHook from 'async-exit-hook';
import getBinaries from './binary.js';
```

### 3.3 The "Cannot access 'process' before initialization" Error

This is a **Node.js/V8 ReferenceError** that occurs specifically in ESM (ECMAScript Modules) contexts when:
1. A module tries to access the `process` global object during module initialization (top-level execution).
2. A circular dependency exists between ESM modules, causing one module to try to access `process` before the execution context has fully bound it.

In the `embedded-postgres` package:
- The module is written as ESM (`import` syntax) but is being dynamically imported inside a CJS/TSX transpilation context.
- The `async-exit-hook` dependency (which is loaded synchronously at module top-level) accesses `process.nextTick`, `process.exit`, `process.stdout`, and `process.stderr` during its initialization.
- The `pg` module (PostgreSQL client for Node.js) also has complex module initialization logic.

The combination of:
- ESM `embedded-postgres` module
- Being dynamically imported via `import()` in a TSX/CJS context
- `async-exit-hook` accessing `process` during top-level initialization
- Node.js v22.14.0 (which has stricter ESM initialization semantics)

...creates a race condition where `process` is not yet fully bound when `async-exit-hook` tries to access it.

### 3.4 Why It's Happening Now

The `embedded-postgres` package is a **beta version** (`18.1.0-beta.16`). Beta versions often have module-loading edge cases. The issue likely manifests because:
1. The server uses `dynamic import()` to load `embedded-postgres` (line 284-287 in `server/src/index.ts`):
   ```typescript
   const moduleName = "embedded-postgres";
   let EmbeddedPostgres: EmbeddedPostgresCtor;
   try {
     const mod = await import(moduleName);
     EmbeddedPostgres = mod.default ?? mod.EmbeddedPostgres ?? mod;
   }
   ```
2. Dynamic import of an ESM module inside a CJS/TSX context triggers a different module initialization path than static import.
3. Node.js 22 has stricter ESM initialization semantics than earlier versions.

---

## 4. Proposed Fixes (Awaiting Approval)

### Fix A: Upgrade `embedded-postgres` Package (Recommended)

**Description:** Upgrade `embedded-postgres` from `18.1.0-beta.16` to a stable version or a newer beta that fixes the module initialization issue.

**Command:**
```bash
pnpm update embedded-postgres
# or
pnpm add embedded-postgres@latest
```

**Pros:** Non-invasive, fixes the root cause, no Paperclip code changes needed.  
**Cons:** May introduce other compatibility issues if the API changed between versions.  
**Files affected:** `pnpm-lock.yaml`, `package.json` (server or db package).  
**Regression test:** After upgrade, run `pnpm dev:server` with `PAPERCLIP_INSTANCE_ID=sprint5-clean` and verify successful startup.

---

### Fix B: Patch `async-exit-hook` or `embedded-postgres` Module Loading

**Description:** Force `embedded-postgres` to load in a context where `process` is guaranteed to be available by pre-importing it before the dynamic import.

**Proposed patch in `server/src/index.ts` (around line 284):**
```typescript
// Before the dynamic import, ensure process is fully available
const moduleName = "embedded-postgres";
let EmbeddedPostgres: EmbeddedPostgresCtor;
try {
  // Pre-load async-exit-hook to ensure process binding is complete
  await import("async-exit-hook");
  const mod = await import(moduleName);
  EmbeddedPostgres = mod.default ?? mod.EmbeddedPostgres ?? mod;
} catch (err) {
  throw new Error("Embedded PostgreSQL mode requires the `embedded-postgres` package");
}
```

**Pros:** Targeted fix, no external dependency changes.  
**Cons:** Hacky, may not work if the issue is deeper in `pg` module.  
**Files affected:** `server/src/index.ts`  
**Regression test:** Same as Fix A.

---

### Fix C: Use Native PostgreSQL Instead of Embedded PostgreSQL

**Description:** Set `DATABASE_URL` to a locally installed PostgreSQL server (e.g., from Docker or system install) instead of using the embedded PostgreSQL package.

**Command:**
```powershell
$env:DATABASE_URL = "postgres://paperclip:paperclip@localhost:5432/paperclip"
# Start a local PostgreSQL server on port 5432, then:
pnpm dev:server
```

**Pros:** Bypasses the `embedded-postgres` bug entirely.  
**Cons:** Requires installing PostgreSQL separately; dev environment is no longer self-contained.  
**Files affected:** None (runtime configuration only).  
**Regression test:** Verify health endpoint and migration count.

---

### Fix D: Downgrade Node.js to v20 LTS

**Description:** The issue may be specific to Node.js 22's stricter ESM semantics. Downgrading to Node.js 20 LTS might resolve it.

**Pros:** No code changes needed.  
**Cons:** Downgrading Node.js is a major environment change; may affect other packages.  
**Files affected:** None.  
**Regression test:** Full test suite (`pnpm test`).

---

## 5. Recommended Fix

**Fix A (Upgrade `embedded-postgres`)** is the safest and most correct approach. It addresses the root cause (a beta-version module initialization bug) without modifying Paperclip source code. The embedded PostgreSQL feature is a core dependency for dev mode, and keeping it on a stable version is the right engineering decision.

**If Fix A fails, Fix C (Use Native PostgreSQL)** is the fallback for unblocking Sprint 5C.

---

## 6. Files Affected by Proposed Fix A

| File | Change |
|------|--------|
| `pnpm-lock.yaml` | Lockfile update for `embedded-postgres` version |
| `server/package.json` or root `package.json` | Version bump of `embedded-postgres` dependency |
| `node_modules/embedded-postgres/` | Replaced with new version |

No Paperclip application code changes are needed.

---

## 7. Rollback Plan for Fix A

If upgrading `embedded-postgres` causes regressions:

1. Revert the version in `package.json` to `18.1.0-beta.16`.
2. Run `pnpm install` to restore the old lockfile state.
3. Re-test with `pnpm dev:server`.
4. If the original bug persists, switch to Fix C (Native PostgreSQL) as fallback.

---

## 8. Regression Test Required

After any fix is applied:

```powershell
# Clean environment
$env:PAPERCLIP_INSTANCE_ID = "sprint5-clean"
$env:DATABASE_URL = $null

# Start server
pnpm dev:server

# Verify (in separate terminal)
Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/health" -Method GET
Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/companies" -Method GET
```

Expected: Health returns 200, companies list is empty (no legacy data), no `500` errors.

---

**End of analysis. No code changes have been applied. Awaiting operator approval for the proposed fix.**
