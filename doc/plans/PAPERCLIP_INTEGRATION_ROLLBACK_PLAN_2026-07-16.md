# Paperclip Integration Rollback Plan

Date: 2026-07-16
Applies to: Upstream integration strategy for `C:\Users\mikeb\paperclip`

---

## 1. Rollback Philosophy

Every action in the integration plan must be reversible without data loss. The golden rule:

> **The old fork and its runtime backup must remain untouched until the new upstream-based branch is fully validated and the operator explicitly approves deprecation.**

---

## 2. Pre-Integration State Snapshot

Before any integration work begins, the following are already true and must be preserved:

| Asset | Current State | Protection |
|-------|--------------|------------|
| Local fork repo | `docs/paperclip-operational-audit-2026` @ `e6da760d1` | Do not force-push, do not delete branches |
| `master` branch | `bb5f60ef2` | Do not reset, do not rebase |
| Legacy runtime | `C:\Users\mikeb\.paperclip\instances\default` — stopped | Do not start, do not migrate |
| Verified backup | `C:\Users\mikeb\.paperclip\instances\default-backup-20260716-104332` | Preserve read-only |
| Upstream test worktree | `C:\Users\mikeb\paperclip-upstream-test` @ `6ec059ab4` | Disposable, but do not delete until operator approves |

---

## 3. Rollback by Phase

### Phase 1 Rollback: Upstream Branch Creation Fails

**Trigger:** `pnpm install` fails, `pnpm dev` fails, or `/api/health` returns error on new branch.

**Rollback steps:**
1. `git checkout docs/paperclip-operational-audit-2026`
2. `git branch -D feat/qsl-upstream-integration` (delete failed branch)
3. No other state is modified.

**Time to rollback:** < 1 minute.

### Phase 2 Rollback: Database Schema Port Fails

**Trigger:** `pnpm db:generate` fails, `pnpm -r typecheck` fails, or migration numbering conflicts occur.

**Rollback steps:**
1. `git checkout docs/paperclip-operational-audit-2026`
2. `git branch -D feat/qsl-upstream-integration`
3. Remove any generated `data/pglite` directory if partially initialized.
4. No legacy data is touched.

**Time to rollback:** < 2 minutes.

### Phase 3 Rollback: Server Service Port Fails

**Trigger:** Ported QSL services fail tests, conflict with upstream auth, or cause runtime errors.

**Rollback steps:**
1. `git checkout docs/paperclip-operational-audit-2026`
2. Optional: `git stash` any WIP on the new branch before deleting, in case partial work is salvageable later.
3. `git branch -D feat/qsl-upstream-integration`

**Alternative ( surgical ):**
- Instead of deleting the branch, `git reset --hard upstream/master` to return the branch to clean upstream state, then re-attempt porting with a different strategy.

**Time to rollback:** < 2 minutes.

### Phase 4 Rollback: UI Port Fails

**Trigger:** UI build fails, QSL Review page crashes, or upstream routing changes break navigation.

**Rollback steps:**
1. `git checkout docs/paperclip-operational-audit-2026`
2. `git branch -D feat/qsl-upstream-integration`
3. No runtime data is affected (UI is stateless).

**Time to rollback:** < 1 minute.

### Phase 5 Rollback: Full Validation Failure

**Trigger:** `pnpm test:run` fails, `pnpm build` fails, or end-to-end QSL workflow is broken.

**Rollback steps:**
1. `git checkout docs/paperclip-operational-audit-2026`
2. Preserve the broken branch for post-mortem: `git branch archive/feat/qsl-upstream-integration-failed-$(Get-Date -Format yyyyMMdd)`
3. `git checkout -b feat/qsl-upstream-integration upstream/master` to start fresh.

**Time to rollback:** < 3 minutes.

---

## 4. Catastrophic Rollback: New Branch Corrupts Legacy State

**Scenario (extremely unlikely):** A command accidentally targets the legacy runtime or modifies the master branch.

**Mitigations in place:**
- Legacy runtime path (`C:\Users\mikeb\.paperclip\instances\default`) is outside the repo working tree.
- Legacy DB is stopped and no migration commands will be issued against it.
- `master` branch will not be checked out during integration work.

**Recovery if it happens:**
1. Restore `master` from remote: `git reset --hard origin/master`
2. Restore legacy runtime from verified backup:
   ```powershell
   Remove-Item -Recurse -Force C:\Users\mikeb\.paperclip\instances\default
   Copy-Item -Recurse C:\Users\mikeb\.paperclip\instances\default-backup-20260716-104332 C:\Users\mikeb\.paperclip\instances\default
   ```

---

## 5. Post-Success Transition (Irreversible Actions)

The following actions are **only** taken after full validation and explicit operator approval:

| Action | Condition |
|--------|-----------|
| Delete `paperclip-upstream-test` worktree | Operator confirms new branch is working |
| Mark old `master` as deprecated | Operator approves new branch as canonical |
| Archive `default-backup-20260716-104332` to cold storage | Operator confirms new runtime has replaced legacy |
| Re-point `origin/master` or open PR to merge new branch | Operator decides on long-term branch strategy |

---

## 6. Rollback Testing

Before claiming Phase 1 complete, perform this drill:
1. Create `feat/qsl-upstream-integration`.
2. Verify `pnpm dev` works.
3. **Rollback drill:** `git checkout docs/paperclip-operational-audit-2026`, delete the branch, confirm working tree is clean.
4. Re-create the branch and continue.

This confirms the rollback path is sound.

---

## 7. Communication

If any phase fails and rollback is executed:
1. Record the failure mode in a session log.
2. Update the integration plan with the blocker before re-attempting.
3. Do not proceed to the next phase until the current phase is green.

---
*Rollback plan generated 2026-07-16. No mutations performed.*
