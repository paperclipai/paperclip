# PR #5636 — Scope-Creep Split Plan

**Author**: Claude Sonnet (internal senior-engineer review)  
**Date**: 2026-05-10  
**Status**: Awaiting maintainer execution  
**Related review**: [`.claude/reviews/pr-5636-phase-f.md`](.claude/reviews/pr-5636-phase-f.md)

---

## Prerequisite — DO NOT execute against current `origin/master`

**Status (2026-05-10)**: This plan is **deferred**. Empirical execution against current `origin/master` produced a ~5251-line diff instead of the planned ~230 lines.

**Why**: The plan's `git checkout -b ... origin/master` step assumes `origin/master` already contains the BBA foundation (Phase A-D server code from PR #5595, plus Phase A schema from PR #5583). Currently those PRs are still open. So when the plan checks out the 4 ride-along files at `b8eaf441` onto a master that lacks the foundation, those files appear as multi-thousand-line additions (the full file contents at b8eaf441), not the small Phase F delta.

**Required state before re-attempting the split**:
- PR #5583 (`feat/bba-memory-phase-a`) merged to `paperclipai/paperclip:master`
- PR #5595 (`feat/bba-memory-phase-b-to-e`) merged to `paperclipai/paperclip:master`
- `git fetch origin` so local `origin/master` reflects the new tip

**Then**: the documented Step 1 / Step 2 / Step 3 commands execute as originally written and produce the expected ~230-line extraction PR + cleaned ~200-line #5636.

**Until then**: PR #5636 carries a Scope notice in its description (added 2026-05-10) flagging the in-scope vs ride-along split for the maintainer.

## Problem Statement

PR #5636 (`feat(bba-memory): Phase F — server-side idempotency, safeParseMetaJson, UI hardening`) mixes two distinct workstreams in a single commit (`b8eaf441`):

**In-scope (Phase F spec):**
- `idempotency_keys` SQLite table + `getIdempotencyKey`/`putIdempotencyKey`
- `safeParseMetaJson` defensive wrapper
- `Idempotency-Key` header wiring in `/execute` route
- Five UI follow-ups (F-1 through F-5) in `BbaMemoryExecuteBetPanel`
- Export additions to `bba-memory/index.ts`

**Out-of-scope (accumulated from prior sessions, swept into Phase F commit):**
- CDP (Chrome DevTools Protocol) launch mode for Casa Pariurilor pre-authenticated sessions
- `shouldUseCdpPersistentProfile` export + test
- Migration statement idempotency check (`migrationStatementAlreadyApplied`)
- 64-line test file for migration idempotency

These two workstreams have zero functional coupling. The CDP code makes the commit 427 lines instead of ~150, widens rollback blast radius, and prevents clean isolation review of the Phase F idempotency logic.

The code itself is correct in both cases. The problem is packaging, not quality.

---

## Files to Extract

| File | Lines added | What it is | Target PR |
|------|-------------|-----------|-----------|
| `server/src/services/betting-browser-automation.ts` | +146 | CDP launch mode: `LaunchedBrowserSession` type, `shouldUseCdpPersistentProfile`, `resolveChromiumExecutable`, `connectChromiumProfileOverCdp` | `chore/extract-cdp-and-migration-idempotency` |
| `server/src/__tests__/betting-browser-automation.test.ts` | +18 | Test for `shouldUseCdpPersistentProfile` | `chore/extract-cdp-and-migration-idempotency` |
| `packages/db/src/client.ts` | +6 | `migrationStatementAlreadyApplied` call in migration runner | `chore/extract-cdp-and-migration-idempotency` |
| `packages/db/src/client.test.ts` | +64 | Tests for migration statement idempotency | `chore/extract-cdp-and-migration-idempotency` |

Files to **keep** in #5636 (not extracted):
- `server/src/services/bba-memory/schema.sql`
- `server/src/services/bba-memory/repository.ts`
- `server/src/services/bba-memory/index.ts`
- `server/src/routes/betting-browser-automation.ts`
- `server/src/routes/bba-memory.ts`
- `ui/src/api/bbaMemory.ts`
- `ui/src/components/bba-memory/BbaMemoryExecuteBetPanel.tsx`

---

## Situation: Single Commit, Cannot Cherry-Pick

All changes landed in one commit (`b8eaf441`). The four out-of-scope files are not in their own commit — they cannot be cleanly cherry-picked. Instead, we use **selective file restoration**:

1. On the new extraction branch: bring the four files at their Phase F state (`b8eaf441`) on top of master.
2. On the #5636 branch: restore those same four files to their pre-Phase-F state (commit `43016fb1`, the Component 2 tip, which is the parent of `b8eaf441`).

This is safe because the four out-of-scope files have no functional dependency on the in-scope idempotency/safeParseMetaJson changes.

---

## Exact Git Commands

### Step 1 — Create the extraction PR

```bash
# From repo root, clean working tree
git fetch origin

# Create new branch from master
git checkout -b chore/extract-cdp-and-migration-idempotency origin/master

# Bring the four out-of-scope files at their Phase F state
git checkout b8eaf441 -- \
  server/src/services/betting-browser-automation.ts \
  server/src/__tests__/betting-browser-automation.test.ts \
  packages/db/src/client.ts \
  packages/db/src/client.test.ts

# Verify diff looks correct (only the 4 files, ~230 lines)
git diff --stat HEAD

# Commit and push
git commit -m "chore: extract CDP launch mode + migration idempotency from PR #5636

These changes landed in the Phase F commit (b8eaf441) but are out of
scope for Phase F. Extracted to a dedicated PR for clean review.

CDP launch mode:
- LaunchedBrowserSession type, shouldUseCdpPersistentProfile
- resolveChromiumExecutable, connectChromiumProfileOverCdp
- Test: shouldUseCdpPersistentProfile (betting-browser-automation.test.ts)

Migration idempotency:
- migrationStatementAlreadyApplied in packages/db migration runner
- 64-line test coverage for the above"

git push -u origin chore/extract-cdp-and-migration-idempotency

# Open draft PR
gh pr create --draft \
  --repo paperclipai/paperclip \
  --base master \
  --head theproject1-glitch:chore/extract-cdp-and-migration-idempotency \
  --title "chore(bba): extract CDP launch mode + migration idempotency (split from PR #5636)" \
  --body "Extracted from PR #5636 to allow clean review of Phase F idempotency changes.
See docs/bba-memory-pr-5636-split-plan.md for rationale.

Changes:
- CDP persistent-profile launch mode for Casa Pariurilor (betting-browser-automation.ts)
- shouldUseCdpPersistentProfile export + test
- Migration statement idempotency check (packages/db/src/client.ts + test)"
```

### Step 2 — Clean up PR #5636

```bash
# Switch to the Phase F hardening branch
git checkout feat/bba-memory-phase-f-hardening

# Restore the four files to their pre-Phase-F state
# (43016fb1 = Component 2 commit = parent of the Phase F commit)
git checkout 43016fb1 -- \
  server/src/services/betting-browser-automation.ts \
  server/src/__tests__/betting-browser-automation.test.ts \
  packages/db/src/client.ts \
  packages/db/src/client.test.ts

# Verify the remaining diff is only Phase F idempotency + UI changes (~200 lines)
git diff --stat HEAD~1

# Commit the cleanup
git commit -m "revert: extract CDP + migration idempotency to dedicated PR

Removes out-of-scope changes that landed in the Phase F commit.
Those changes live at: chore/extract-cdp-and-migration-idempotency.
PR #5636 now contains only the Phase F specification changes."

# Push — force-with-lease is required since this rewrites branch history
git push --force-with-lease origin feat/bba-memory-phase-f-hardening
```

### Step 3 — Verify

After both pushes:

```bash
# PR #5636 diff should now be ~200 lines across 7 files (no packages/db, no betting-browser-automation.ts)
gh pr diff 5636 --repo paperclipai/paperclip | wc -l  # expect ~220

# Extraction PR diff should be ~230 lines across 4 files
gh pr diff <new-PR-number> --repo paperclipai/paperclip | wc -l  # expect ~230
```

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| `43016fb1` restoration conflicts with intermediate work | Low | `43016fb1` is the direct parent of `b8eaf441`; no intermediate commits exist on the Phase F branch that touch these 4 files |
| PR #5641 diff grows after #5636 cleanup (since it stacks on #5636) | Medium | #5641 does not modify any of the 4 extracted files; its diff will not change |
| Extraction branch conflicts with master if master has since updated betting-browser-automation.ts | Medium | Run `git diff origin/master -- server/src/services/betting-browser-automation.ts` before Step 1; resolve conflicts manually if any |
| Team members have already reviewed the un-cleaned #5636 diff | Low | Post a comment on #5636 explaining the rewrite before pushing `--force-with-lease` |
| `shouldUseCdpPersistentProfile` is imported from the extraction branch but not yet merged | None | The function is currently unexported from the module index; no consumer references it in the main codebase |

---

## Recommended Sequencing

```
1. Write comment on PR #5636 warning of upcoming force-push (before Step 2).
2. Execute Step 1 (extraction branch) → open draft PR.
3. Get extraction draft reviewed (simple, focused — reviewer can approve in 5 min).
4. Execute Step 2 (clean up #5636) → force-push.
5. Merge extraction PR first (into master directly — no stack dependency).
6. Continue with normal #5636 → #5641 → Phase F backend merge sequence.
```

This order ensures:
- The CDP + migration code is never "missing" (extraction PR exists before cleanup removes it from #5636).
- Phase F reviewers see a focused, 7-file diff after Step 2.
- The extraction PR can merge ahead of the BBA stack if needed.

---

## What NOT to Do

- **Do not `git revert b8eaf441` entirely** — that would also remove the Phase F idempotency changes.
- **Do not squash and re-commit everything** — loses authorship metadata and breaks `git bisect` references.
- **Do not wait until after #5636 merges** — once #5636 is on master, splitting requires a follow-up revert PR on master which is much harder to review cleanly.
