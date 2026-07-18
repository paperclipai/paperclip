# Paperclip Upstream Integration Plan

Date: 2026-07-16
Status: PLANNING — awaiting operator approval

---

## Executive Summary

The local Paperclip fork has diverged 44 commits ahead and **798 commits behind** upstream. The local codebase fails embedded PostgreSQL initialization, while upstream boots cleanly. The safest, smallest integration strategy is to **create a new branch from current upstream master and selectively port local QSL work**, leaving the existing fork untouched for rollback.

---

## 1. Recommended Integration Strategy

**Strategy C: Create a new branch from current upstream and selectively port local work.**

### Why not the others?

| Strategy | Rejection Reason |
|----------|-----------------|
| **A. Rebase** | 798 upstream commits to replay 44 local commits onto. Extremely high conflict burden in heartbeat, recovery, adapters, and UI. High risk of silently losing local changes during conflict resolution. |
| **B. Merge upstream into fork** | Same 798-commit delta means massive merge conflicts. The local fork's runtime is already broken (embedded PG fails). Merging does not fix the foundational runtime issue. |
| **D. New canonical repository** | Unnecessary boundary change. The existing remotes, CI config, and GitHub issues are tied to the current repo. A new repo adds migration overhead without safety benefit. |
| **E. Other** | No evidence-supported alternative is safer or simpler than Strategy C. |

### Why Strategy C wins

| Criterion | Strategy C Performance |
|-----------|----------------------|
| Lowest contamination risk | Start from verified-working upstream commit. No broken code carried forward. |
| Lowest merge-conflict burden | Port changes incrementally rather than resolving 798 commits of divergence at once. |
| Strongest rollback | Old fork remains intact on `master` and `docs/paperclip-operational-audit-2026`. Simply `git checkout master` to revert. |
| Easiest future upstream sync | New branch tracks `upstream/master` directly. `git pull upstream master` stays clean. |
| Best QSL IP preservation | Assets are ported deliberately; none are lost in merge-conflict noise. |
| Fastest route to working UI | Upstream UI builds and runs. Port QSL review page and navigation changes as discrete patches. |

---

## 2. Exact Local Assets to Preserve (Active Porting)

These assets will be brought forward to the new upstream-based branch:

### 2.1 Database Schema
- `qsl_findings` table schema (from `packages/db/src/schema/qsl_findings.ts`)
- Migrations renumbered to follow upstream's 172 migration baseline (currently `0071`, `0072`)

### 2.2 Server-Side QSL Services
- `server/src/services/qsl-review.ts` — review state-machine
- `server/src/routes/qsl-bridge.ts` — bridge endpoints
- `server/src/services/board-export.ts` — board intelligence export
- `server/src/routes/board-export.ts` — export API routes
- `server/scripts/generate-board-export.ts` — CLI export script

### 2.3 UI QSL Integration
- `ui/src/pages/QslReview.tsx` — review page
- `ui/src/api/qsl.ts` — API client
- `ui/src/App.tsx` — route registration (adapt to upstream routing)
- `ui/src/components/Sidebar.tsx` — navigation entry
- `ui/src/lib/company-routes.ts` — route mapping
- `ui/src/lib/queryKeys.ts` — query keys

### 2.4 Python Guardian Scripts
All standalone scripts under `scripts/`:
- `governance_checkpoint.py`
- `runtime_export.py`
- `runtime_guardian.py`
- `runtime_history.py`
- `runtime_remediator.py`
- `runtime_rotation.py`
- `runtime_topology_report.py`

### 2.5 QSL Agent Context
- `templates/QSL_PAPERCLIP_CONTEXT.md`

### 2.6 Constitutional Documents
- `docs/constitution/*.md` (currently untracked; add to new branch)

---

## 3. Exact Assets That Should Remain Archived Only

These assets stay in the old fork or backup. They are not carried forward as active code:

### 3.1 Legacy Runtime Data
- `C:\Users\mikeb\.paperclip\instances\default` — stopped, read-only
- `C:\Users\mikeb\.paperclip\instances\default-backup-20260716-104332` — verified backup, preserve indefinitely

### 3.2 Session Artifacts & Transient Logs
- All `PAPERCLIP_*.md` analysis reports in repo root
- `clean-server-*.log`, `dev-server-*.log/err`
- `LEGACY_POSTGRES_STATE_2026-07-16.txt`

### 3.3 Legacy Environment Files
- `.env.legacy` — contains secrets; do not forward

---

## 4. Build the Upstream UI First? YES

**Recommendation: Build the upstream UI before porting custom UI work.**

Rationale:
1. **Verify upstream viability end-to-end.** The upstream test so far was API-only (`paperclip-upstream-test` did not build the UI distribution). Building the UI proves Vite, React, and the full asset pipeline work on this machine.
2. **Establish a clean baseline.** Once `pnpm build` succeeds from upstream source, we have a known-good UI artifact.
3. **Port QSL UI changes as discrete diffs.** With a working upstream UI, porting `QslReview.tsx` and route changes becomes additive and testable.
4. **Identify upstream UI evolution.** The upstream UI may have changed component APIs, routing, or state management since divergence. Building first surfaces these changes before we attempt to port.

Per the fork's AGENTS.md: `npx vite build` hangs on NTFS — use `node node_modules/vite/bin/vite.js build` instead. This machine-specific quirk must be validated against upstream.

---

## 5. Step-by-Step Integration Procedure

### Phase 0: Pre-Flight (No Code Changes)
1. **Operator approval** of this plan.
2. Verify `C:\Users\mikeb\.paperclip\instances\default-backup-20260716-104332` exists and is readable.
3. Ensure no Paperclip processes are running (`pkill -f "paperclip"; pkill -f "tsx.*index.ts"` per AGENTS.md).

### Phase 1: Establish Upstream Branch
1. From `C:\Users\mikeb\paperclip`, fetch latest upstream:
   ```
   git fetch upstream
   ```
2. Create new integration branch from upstream master:
   ```
   git checkout -b feat/qsl-upstream-integration upstream/master
   ```
3. Run `pnpm install`.
4. Build the UI:
   ```
   node node_modules/vite/bin/vite.js build
   ```
   (or `pnpm build` if it works; use the NTFS-safe command if not).
5. Start the server:
   ```
   pnpm dev
   ```
6. Verify health:
   ```
   curl http://localhost:3100/api/health
   ```

### Phase 2: Port Database Schema
1. Copy `packages/db/src/schema/qsl_findings.ts` into new branch.
2. Export it from `packages/db/src/schema/index.ts`.
3. Create new migration(s) for `qsl_findings` table, using Drizzle's current numbering:
   ```
   pnpm db:generate
   ```
4. Validate compile:
   ```
   pnpm -r typecheck
   ```

### Phase 3: Port Server Services & Routes
1. Port `qsl-review.ts`, `qsl-bridge.ts`, `board-export.ts`, `board-export-routes.ts`, `generate-board-export.ts`.
2. Wire routes in `server/src/app.ts`.
3. Run server tests for ported modules:
   ```
   pnpm test
   ```
4. Address any test failures caused by upstream API changes.

### Phase 4: Port UI Changes
1. Port `ui/src/pages/QslReview.tsx`, `ui/src/api/qsl.ts`.
2. Add routes and navigation in `ui/src/App.tsx`, `Sidebar.tsx`, `company-routes.ts`, `queryKeys.ts`.
3. Build UI:
   ```
   node node_modules/vite/bin/vite.js build
   ```
4. Verify QSL Review page loads and functions.

### Phase 5: Port Standalone Scripts & Documentation
1. Copy `scripts/*.py` into new branch (low coupling, typically copy-as-is).
2. Copy `templates/QSL_PAPERCLIP_CONTEXT.md`.
3. Copy `docs/constitution/*.md`.
4. Copy audit docs to `docs/audits/` (documentation only).

### Phase 6: Evaluate UNKNOWN Assets
For each asset marked **UNKNOWN — REVIEW REQUIRED** in the preservation matrix:
1. Diff the file against upstream's current version.
2. Determine if upstream has superseded the local change.
3. If still valuable, port as a discrete commit.
4. If redundant, document the decision and drop.

### Phase 7: Validation
1. Full typecheck:
   ```
   pnpm -r typecheck
   ```
2. Full test suite:
   ```
   pnpm test:run
   ```
3. Build:
   ```
   pnpm build
   ```
4. Create a fresh embedded PG instance and verify QSL review workflow end-to-end.

---

## 6. Smallest Next Approved Action

**Phase 1, Step 1-2: Create `feat/qsl-upstream-integration` branch from `upstream/master` and verify `pnpm install` + `pnpm dev` boots cleanly.**

This is the smallest action that:
- Establishes the new foundation
- Carries zero porting risk
- Provides immediate rollback (just `git checkout docs/paperclip-operational-audit-2026`)
- Takes minutes, not hours

---

## 7. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Upstream UI build fails on NTFS | Medium | Blocks Phase 1 | Use `node node_modules/vite/bin/vite.js build` per fork AGENTS.md. If still failing, investigate Vite/cache issues. |
| Ported QSL service conflicts with upstream auth changes | Medium | Runtime errors | Run tests after each service port. Upstream has evolved authZ; board-export and qsl-bridge routes must enforce company boundaries. |
| Migration numbering conflict | Low | DB init failure | Use `pnpm db:generate` on upstream baseline; do not hardcode migration numbers. |
| Upstream has removed orchanged APIs that QSL UI depends on | Medium | UI compilation errors | Build upstream UI first (Phase 1). Port UI changes incrementally and compile after each. |
| Loss of historical company data | Low | High (irreplaceable) | Legacy backup is read-only and verified. New branch uses fresh embedded PG. Do not attempt to migrate legacy DB. |
| Operator changes mind mid-port | N/A | N/A | Old fork branches remain untouched. Any phase can be abandoned by switching back. |

---

## 8. Can Implementation Safely Begin?

**YES — with operator approval.**

The plan:
- Makes no modifications to the existing fork branches
- Makes no modifications to the legacy runtime backup
- Uses the already-verified upstream commit that boots cleanly
- Proceeds in small, reversible phases
- Stops before any irreversible action

---
*Plan generated 2026-07-16. No mutations performed.*
