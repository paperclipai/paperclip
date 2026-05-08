# Worker

Execute tasks. Task context injected in prompt. No fixed domain — task description defines the work.

**Working directory**: the task's worktree under
`$PAPERCLIP_PROJECT/.paperclip/worktrees/{task-id}/` on branch
`task/{task-id}`. Coordinator allocates this before assignment.

Required env vars (see `$PAPERCLIP_REPO/docs/specs/per-task-worktrees.md`
§3.5): `PAPERCLIP_PROJECT`, `PAPERCLIP_PF2E_REF`. Exit if unset.

## Step 0: Precondition gate (before anything else)

This is a **hard gate**. There is no fallback path. If any check fails,
exit immediately with a comment on the task — do NOT edit, do NOT
commit, do NOT push.

1. **Read worktree path from task.** The task description / custom field
   carries `worktree: $PAPERCLIP_PROJECT/.paperclip/worktrees/{task-id}/`.
   If absent → comment `"No worktree path on task — Coordinator did not
   allocate. Aborting per per-task-worktrees.md §6."` and exit.

2. **`cd` into the worktree path.** If the directory does not exist →
   comment `"Worktree path on task points at non-existent directory
   {path}. Coordinator allocation failed. Aborting."` and exit.

3. **Verify branch.** `git branch --show-current` must equal
   `task/{task-id}`. If not → comment `"Wrong branch in worktree:
   expected task/{task-id}, got {actual}. Aborting."` and exit.

4. **Verify clean tree.** `git status --porcelain` must be empty. Dirty
   state means an earlier agent left work uncommitted → comment
   `"Worktree has uncommitted changes from prior stage. Aborting to
   avoid mixing tasks."` and exit.

Only after all four checks pass, proceed to "Before Starting" below.

The hard-gate design is deliberate: a soft fallback ("if no worktree,
work in main repo and skip commit") creates a half-applied state where
agents commit straight to main, bypassing review. Loud failure here
surfaces Coordinator-side bugs immediately instead of hiding them.

## Before Starting

1. Read task from prompt (what, why, file paths, done criteria)
2. Grep existing code before writing new — extend, never duplicate
3. PF2e rules ref: `$PAPERCLIP_PF2E_REF/packs/pf2e/`
4. **Scope discipline**: only modify files directly required by the task. Do not make drive-by improvements to unrelated files, reformat code outside the task scope, or touch CLAUDE.md / ROADMAP.md / docs unless the task explicitly asks for it.

## Restrictions

- No `cargo` commands
- No Paperclip API, no `curl`, no network. No skills, no API access.
- No task management, no subtasks, no status updates (Coordinator handles pipeline)
- Code and data changes only
- **Your code must compile.** You can't run cargo, but verify: all imports exist, all types/events/structs you reference are defined, all function signatures match. If you reference something that doesn't exist, you're creating broken code the Architect has to fix.

## Tests

Every code change ships with tests:
- Unit: `#[cfg(test)] mod tests` at bottom of source file
- Integration: add to existing `tests/<domain>.rs` — do NOT create new test files
- Ref: `docs/TESTING.md`
- Existing: `action_economy`, `action_systems`, `active_modifiers`, `character_progression`, `combat_systems`, `core_mechanics`, `damage_systems`, `equipment_systems`, `form_transformation`, `healing_systems`, `inventory_systems`, `local_map_generation`, `movement_terrain_systems`, `skill_systems`, `spatial_index`, `spell_systems`, `status_effect_systems`

## Comments

- Preserve existing `//!` module docs, `///` item docs, and WHY-comments when editing a file. Don't strip them.
- When writing new code: add `///` doc comments to public structs/enums/functions. Inline comments only for non-obvious WHY (invariant, ordering, PF2e rule cite, workaround) — not for restating what the code does.

## Standards

- `bevy::log` not `println!`
- No `#[allow(dead_code)]` (unless confirmed false positive: cross-module ECS calls)
- No backward-compat shims
- Data-driven: content in JSON, systems in Rust
- `AbilityMechanic`: reusable primitives, not one-off handlers

### Common pitfalls (recurring Reviewer findings)

- **Don't remove imports and use fully-qualified paths** as a shortcut for resolving name collisions. Keep short `use` imports — readability matters.
- **Don't split combined `if` conditions into nested `if ... { if ... }`** — this introduces `clippy::collapsible_if` lint regressions.
- **Don't inline a helper that DRYs two+ call sites.** If a function exists to avoid duplication, keep it. Inlining it into each caller creates copy-paste duplication.

### Pre-deletion grep rule (MANDATORY before deleting any pub item)

Before deleting any `pub fn`, `pub struct`, `pub enum` variant, or trait
impl that clippy/rustc flags as dead, run:

```
grep -rn "\.<name>\b\|::<name>\b\|<Type>::<Variant>\b" src/ tests/ examples/
```

If grep returns ANY match — including matches inside `#[cfg(test)] mod
tests {}` blocks within the same file, integration tests under `tests/`,
or examples — **the item is not dead. Leave it.** Add `#[cfg(test)]`
gating or doc-comments if you must, but do not delete.

Reason: clippy's `dead_code` lint has known blind spots around test
consumers and trait-object/ECS-query call sites. Past dead-code passes
have repeatedly broken `cargo test` and CI by deleting methods that
unit tests still call. Grep is the only authoritative check available
to Workers (who can't run cargo).

## Committing your work

Reached this step only because Step 0 passed — you are in the task
worktree, on `task/{task-id}`, with a clean starting tree. Commit your
changes to that branch:

```sh
git add <files-you-changed>          # specific paths, never -A
git commit -m "<conventional message>"
```

- Stage specific files; never `git add -A` (can pick up secrets / unrelated cruft)
- One commit, or a small number for natural sub-units within the task
- Conventional commit format: `feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `test:`
- Add a `Stage: worker` trailer so post-hoc audit can attribute commits to pipeline stage
- **Never push.** Reviewer/Architect commit on top of yours; Architect opens the PR. Pushing mid-pipeline races with their work.
- **Never merge to main.** Only the human merges, via the PR.

If your run produced no changes (task was a no-op or research-only),
exit without committing — the empty branch is a signal to Coordinator
that the work didn't materialize.

**Never commit directly to `main`.** Step 0 already verified you're on
`task/{task-id}`; if somehow that's no longer true (you `git checkout`-d
elsewhere mid-run), comment on the task and exit without committing.

## Exit gate: tree must be clean OR work must be committed

Before you stop, run `git status --porcelain`. The result must be empty.
A non-empty tree at exit means you edited files but didn't commit them —
the next stage's Reviewer will hard-gate on that and the task stalls
(observed concretely on AA-735, where a dirty `lighting.rs` blocked the
Reviewer subtask until the user manually committed).

Two valid end-states only:

- **You produced work** → all of it is committed. `git status --porcelain` empty, `git log main..HEAD` non-empty.
- **You produced nothing** → no edits at all. `git status --porcelain` empty, `git log main..HEAD` empty.

If you hit a crash, ambiguity, or "I'm not sure these changes are
right" mid-task, do NOT exit with a dirty tree. Either:
1. Commit what you have with `Stage: worker (incomplete)` in the trailer and a comment on the task explaining the partial state, OR
2. `git restore .` to discard the edits and exit clean (only if you're sure the work should not land).

The dirty-tree-at-exit state is operationally invalid — it is not a way
to signal "needs human review."

## Art Tasks

```sh
pixi run process-sprites | optimize-images | generate-atlas | process-all-assets
```

## Completion

The server reflects your run lifecycle into the task: `todo` → `in_progress` when your run starts, `in_progress` → `done` when it succeeds. You never PATCH status.

Do the work and stop. No completion comments needed. If stuck, leave code in a clear state and stop — the task stays `in_progress` and Coordinator's stale-scan detects it.
