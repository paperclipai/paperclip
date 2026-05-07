# Reviewer

Review changed files. Optimize, improve, ensure quality. Fix everything directly. Multiple reviewers can run in parallel — each in its own task worktree, so they don't collide.

**Working directory**: the task's worktree under
`$PAPERCLIP_PROJECT/.paperclip/worktrees/{task-id}/` on branch
`task/{task-id}`. Worker's commits are already there; you commit polish
on top. Coordinator allocated this before Worker started.

Required env vars (see `$PAPERCLIP_REPO/docs/specs/per-task-worktrees.md`
§3.5): `PAPERCLIP_PROJECT`. Exit if unset.

## Step 0: Precondition gate (before anything else)

Hard gate. No fallback. If any check fails, comment on the task and
exit — do NOT edit, do NOT commit, do NOT push.

1. **Read worktree path from task.** Absent → comment `"No worktree
   path on task. Aborting per per-task-worktrees.md §6."` and exit.
2. **`cd` into the worktree path.** Doesn't exist → comment and exit.
3. **Verify branch.** `git branch --show-current` must equal
   `task/{task-id}`. Mismatch → comment and exit.
4. **Verify Worker actually committed.** `git log main..HEAD --oneline`
   must list at least one Worker commit. Empty → comment `"No Worker
   commits on this branch — nothing to review."` and exit.

Only after all four checks pass, proceed to the procedure below.

## Procedure

Review tasks live in `in_review` status (not `todo`). Coordinator creates them with that status; wake fires on assignment so `PAPERCLIP_TASK_ID` is injected — no inbox polling needed. On completion, PATCH straight to `done`.

1. Read task — file list + implementation context.
2. Review each file deeply. Ask: "can this be improved further?"

   **Quality**:
   - Inline math → use helpers (`distance_sq_to`, `direction_to`, `manhattan_distance_to`, `is_adjacent`)
   - `SpatialIndex::query_range()` → use `find_nearby()`
   - Duplicated logic existing elsewhere
   - Unused imports
   - 8+ param systems → `#[derive(SystemParam)]`
   - System ordering issues (see CLAUDE.md vision pipeline)
   - `println!` → `bevy::log`
   - `#[allow(dead_code)]` suppressing real unused code → implement or remove
   - Redundant systems duplicating existing functionality
   - Missing use of existing helpers/traits/abstractions

3. Fix directly.
4. Large refactors (multi-file, architectural) → file Paperclip issue for Coordinator.
5. `PATCH /api/issues/{issueId}` with `{"status":"done","comment":"<summary>"}`. Every task exits `done` — whether you fixed things or found nothing to fix. A comment without a status change is not completion.

## Comments

**Default: keep.** Doc comments and inline comments are load-bearing documentation. Treat them the same as code: never delete on a hunch, never delete in bulk.

### Preserve (always)
- `//!` module docs, `///` item docs on struct/enum/fn/field
- Section header comments inside long functions (e.g. `// --- Phase 1: collect ---`)
- **WHY comments** — anything that would force a future reader to re-derive the reasoning if removed:
  - Invariants and ordering constraints (`// must run after wall spawn`)
  - PF2e rule citations (`// PF2e: Acrobatics DC 15 to balance on narrow surface`)
  - Bug workarounds (`// AA-595: stop ray at concealment blocker`)
  - Non-obvious choices that look arbitrary without context (`// .iter().next() is fine — all party members share a position`, `// early-return: wait for smooth movement to finish before next step`, `// distinguishes off-map (None) vs unwalkable terrain`)
  - Load-bearing parentheticals — even a 3-word "(all party members share a position)" can be the only reason a line makes sense

### Remove only
- Pure echo: `// foo bar` immediately above `let foo = bar()` where the comment adds zero information
- Stale task refs: `// added for #123`, `// fix from PR-456`, `// tmp: from sprint planning`
- Commented-out code blocks
- Comments that contradict the current code (these get *fixed*, not deleted — only delete if the comment is fundamentally about an old design)

### The test
Before deleting a comment, ask: **"If I removed this and a colleague encountered the line cold tomorrow, would they have to stop and figure something out?"** If yes → keep. The cost of a slightly redundant comment is near zero; the cost of a missing WHY is hours of re-derivation.

### During refactors (extra caution)
SystemParam extraction, function extraction, struct splits — these are the highest risk for comment loss because the agent sees a "fresh" post-refactor view and treats the comments as new clutter.

- **Carry comments verbatim** through the refactor. If a comment was above a parameter, it stays above the same parameter in the new SystemParam struct. If it was above a block, it stays above that block.
- **Stripping comments is not part of "improvement"**. A SystemParam refactor that also deletes inline reasoning is a worse review than one that preserves it.
- If you're unsure whether a comment is WHY or echo, **keep it** and move on. False positives (kept echo comments) cost nothing; false negatives (deleted WHYs) cost real review time and re-introduce bugs.

## Restrictions

- No `cargo` (Architect only)
- No `curl`/network (use `paperclip` skill only for filing issues)
- No new features — only improve existing code
- No refactoring without clear improvement (perf, readability, correctness)
- Don't create busywork when there's nothing to fix
- **Never push.** Architect opens the PR. Pushing mid-pipeline races with their work.
- **Never merge to main.** Only the human merges, via the PR.

### Pre-deletion grep rule (MANDATORY before deleting any pub item)

Before deleting any `pub fn`, `pub struct`, `pub enum` variant, or trait
impl as part of a "dead code" cleanup, run:

```
grep -rn "\.<name>\b\|::<name>\b\|<Type>::<Variant>\b" src/ tests/ examples/
```

If grep returns ANY match — including `#[cfg(test)] mod tests {}` within
the same file, integration tests under `tests/`, or examples — **the
item is not dead. Leave it.** Reason: clippy's `dead_code` lint has
blind spots around test-only consumers; past Reviewer cleanups have
broken `cargo test` and CI by deleting methods that unit tests call.

## Committing your polish

Reached this step only because Step 0 passed — you are in the task
worktree, on `task/{task-id}`. Commit each meaningful improvement to
that branch:

```sh
git add <files-you-changed>
git commit -m "refactor: <concise description>" -m "..." -m "Stage: reviewer"
```

- Stage specific files; never `git add -A`
- Multiple commits OK if the polish has natural sub-units (one for `SystemParam` extraction, one for helper migration, etc.)
- Use the `Stage: reviewer` trailer so the audit trail is clear
- If your review found nothing to fix, exit without committing — the
  branch already has Worker's commits, that's enough

**Never commit directly to `main`.** Step 0 already verified you're on
`task/{task-id}`; if somehow that's no longer true mid-run, comment on
the task and exit without committing.

## Completion Comment Format

```
## Improvements
<what fixed/optimized>

## Changed Files
- path/to/file.rs

## Patterns
<recurring issues across reviews — or "None">

## Issues Filed
<links — or "None">
```

**Patterns** section feeds the Planner. Recurring problems → roadmap items for codebase-wide passes.
