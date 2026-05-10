# Pipeline state bitflags on issues

**Status**: proposal, not implemented
**Filed**: 2026-05-10
**Origin**: AA-676 incident — Architect did Reviewer's job because Reviewer's queue was wedged

## Problem

The current pipeline models each stage as a separate Paperclip issue:

| Stage | Issue | Assignee |
|---|---|---|
| Worker codes | AA-676 | Worker |
| Reviewer reviews | AA-825 | Reviewer |
| Architect verifies | AA-827 | Architect |

When a stage is lost (queue stall, worktree cleanup, branch deletion) the
sibling issues can't tell what's been done. Coordinator's recovery path is to
create a *new* issue that bundles the missing work — e.g. AA-827 was titled
"Verify**+Review**: AA-676" because Reviewer was unavailable. Architect ran
that task, did both jobs, pushed PR #69, and AA-825 (the real Reviewer task)
woke 26h later with no worktree to look at.

The pipeline contract says Worker → Reviewer → Architect. The operational
reality on AA-676 was Worker → Architect-doing-review-too. State spread across
three issue records means no agent has a single source of truth for "what has
the work item finished."

## Proposal

Add a `pipeline_state` bitflag column to `issues` representing what stages have
completed for that work item:

```sql
-- migration
ALTER TABLE issues ADD COLUMN pipeline_state INTEGER NOT NULL DEFAULT 0;
```

Flag values (Rust-style for clarity, stored as int):

```ts
const PipelineFlag = {
  WorkerDone:     1 << 0,  // Worker committed code
  Reviewed:       1 << 1,  // Reviewer signed off (or short-circuited as data-only)
  Verified:       1 << 2,  // Architect cargo-clean
  Pushed:         1 << 3,  // PR opened
  Merged:         1 << 4,  // PR merged to main
};
```

One canonical issue per work item carries this flag through its lifecycle. No
more sibling-task chains for the per-stage work.

## Coordinator routing logic

Replace "advance done subtasks" (current §Step 3) with "find next missing flag":

```ts
const required = label === "data-only"
  ? WorkerDone | Reviewed | Pushed | Merged
  : WorkerDone | Reviewed | Verified | Pushed | Merged;
const next = required & ~issue.pipeline_state;  // first missing bit

if (next & WorkerDone)  assignToWorker();
else if (next & Reviewed)  assignToReviewer();
else if (next & Verified)  assignToArchitect();  // verify only
else if (next & Pushed)    assignToArchitect();  // PR open
// Merged is human, no assignment
```

Each agent sets *its own flag* on completion via PATCH:

```http
PATCH /api/issues/:id { pipeline_state: prev | WorkerDone }
```

Late wakes short-circuit: `if (state & Reviewed) return done;`

## Migration of existing issues

Backfill `pipeline_state` for in-flight tasks based on existing state. Scan all
non-terminal issues and infer flags from sibling tasks + PRs:

- If parent task has a `Review:` subtask `done` → set `Reviewed`
- If parent task has a `Verify:` subtask `done` → set `Verified`
- If a PR exists → set `Pushed`
- If PR is merged → set `Merged`

Then archive the per-stage subtasks as historical record (do not delete — the
comments contain reviewer/architect reasoning that's worth keeping).

## Why bitflags, not enum

A linear `pipeline_stage` enum (`worker → reviewer → verifier → pushed`) can't
express:
- `data-only` skips `Verified` (no cargo)
- `ci-fix` skips `WorkerDone` and `Reviewed` (Architect-only emergency fix)
- Re-review after Architect rejection (state can regress on a single flag)
- Custom labels in the future may add stages (security audit, IP audit, etc.)

Bitflags handle non-linear pipelines with no schema change.

## What this does NOT solve

- The **queue stall** itself — that's the watchdog's job (already shipped in
  `070fdf3d`). Bitflags reduce the *consequences* (no redo work) but the queue
  primitive still has to actually drain.
- **Worktree state** — flags track work-stage completion, not git state. A
  cleaned-up worktree still requires the active stage to handle reconciliation
  ("commit exists at HEAD, worktree gone — diff against `git show`").

## Risks

- **Schema migration on a populated DB**. The backfill step is fiddly — easy
  to get wrong (e.g. set `Verified` for a task whose Architect ran but failed).
  Recommend a dry-run mode that prints what would be set without writing.
- **Existing per-stage subtasks** stay around. We don't want to delete them
  (history) but Coordinator must stop creating new ones — instructions edit
  required to ditch the AA-825/AA-827-style sibling pattern.
- **Concurrency**: two agents updating `pipeline_state` simultaneously could
  clobber. Use `UPDATE issues SET pipeline_state = pipeline_state | ? WHERE
  id = ?` (bitwise OR, atomic) rather than read-modify-write.

## Estimated scope

- DB migration + backfill script: 1 day
- Service layer (`issuesSvc.markStageComplete`, routing helpers): 1 day
- Coordinator INSTRUCTIONS.md rewrite to flag-based routing: 0.5 day
- Worker / Reviewer / Architect INSTRUCTIONS.md updates to set their flag: 0.5 day
- Migration of existing in-flight tasks: 0.5 day
- Tests: 1 day

Total: ~4–5 days, single developer.

## Out of scope (for this proposal)

- UI changes to display flag state per issue. Coordinator can route off the
  flag without UI; dashboards can be added later.
- Rollback path. The flag is additive — existing per-stage subtask flow
  continues to work alongside flags during the transition.
