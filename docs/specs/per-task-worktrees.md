# Per-Task Worktrees + Branch + PR Flow

Status: Proposal
Last updated: 2026-04-26
Audience: Paperclip pipeline contributors; bevy-rpg pipeline operator

## 1. Problem

Today every agent — Worker, Reviewer, Architect — runs in the same working directory (`$PAPERCLIP_PROJECT`). Two failure modes follow:

1. **Cross-task interference.** Two Workers running in parallel touch the same files; one stashes, resets, or overwrites the other's edits. We've seen `SAVE_FORMAT_VERSION` reintroduced three times by separate agents because each was working in isolation but committing into the same tree.
2. **Human review burden.** Because no agent commits, the human operator has to grep+diff the working tree to group changes into commits before review. With ~30+ files touched per pipeline cycle, this burns large amounts of operator (and Claude) tokens just to plan commits.

The fix is one change applied at two layers: each task runs in its own `git worktree` on its own branch, and the pipeline opens a PR at the end so the human reviews per-task instead of per-day.

## 2. Design

### 2.1 Worktree per task

Coordinator, on task creation, allocates:

- A branch: `task/{task-id}` from `main`.
- A worktree: `<repo>/.paperclip/worktrees/{task-id}/` checked out to that branch.
  (Reuses the existing `.paperclip/worktrees/` convention already recognized by `server/src/worktree-config.ts`.)

```
$PAPERCLIP_PROJECT/                       ← human's main worktree, never touched by agents
$PAPERCLIP_PROJECT/.paperclip/worktrees/
  task-001/                                         ← Worker A's task, branch task/001
  task-002/                                         ← Worker B's task, branch task/002 (parallel-safe)
```

Each agent run for the task uses `cwd = <worktree-path>`. Adapters (`claude-local`, `codex-local`, `gemini-local`, `process`) already accept a per-run `cwd` parameter — no adapter changes required.

### 2.2 Pipeline stages

| Stage | Action | Commits to | Exits on |
|---|---|---|---|
| Coordinator (create) | `git worktree add .paperclip/worktrees/{id} -b task/{id}` from main; record path on the task | — | branch + worktree exist |
| Worker | Implement task; commit work to `task/{id}` | `task/{id}` | one or more commits made |
| Reviewer | Review/polish files; commit further to `task/{id}` | `task/{id}` | review pass complete |
| Architect | Run `cargo check / clippy / test`; commit fixes; `gh pr create --base main --head task/{id}`; record PR URL on the task | `task/{id}` | PR open |
| Human | Review PR; merge (squash-merge default) | `main` | PR merged |
| Coordinator (cleanup) | On detected merge: `git worktree remove .paperclip/worktrees/{id}`; `git branch -D task/{id}` (remote auto-deleted by GitHub on merge) | — | worktree + branch gone |

### 2.3 Why this fixes the two failure modes

- **Interference**: parallel Workers literally cannot see each other's files; they're on different filesystem checkouts. Stash/reset/checkout commands scope to the calling worktree only.
- **Review burden**: the human reviews a PR (small, scoped, one task) instead of grouping diffs out of a shared working tree.

### 2.4 What flips from today

- bevy-rpg `CLAUDE.md` "No Agent Commits" → "Agents commit to per-task feature branches; only the human merges to main."
- Worker/Reviewer/Architect `INSTRUCTIONS.md` each get a "Commit your work to the task branch before exiting" rule.
- Worker `INSTRUCTIONS.md` "No git commits (board)" rule deleted.
- Architect `INSTRUCTIONS.md` gains "Open PR at end of run" step.
- Coordinator `INSTRUCTIONS.md` gains worktree creation (on task create) and worktree teardown (on merge detection) steps.
- Each agent permission set adds `git` (commit, push) and `gh` (pr create) where missing.

## 3. Open questions

### 3.1 Cargo target directory

Each worktree gets its own `target/` by default — slow because Architect's `cargo check` recompiles per task. Two options:

- **(a) Shared via `CARGO_TARGET_DIR=~/.cargo-shared-target`**: fast, but concurrent `cargo` runs need cargo's own lockfile to serialize (it does, but builds wait). Architect runs are infrequent enough that this is mostly a non-issue.
- **(b) Per-worktree `target/`**: simpler, no concurrency consideration, but every Architect run starts cold.

Recommendation: **(a)**. Architect is rarely concurrent in practice (one Architect by config), and even when it is, cargo's lock just serializes — that's correct behavior.

### 3.2 Branch naming + cleanup

- **Branch name**: `task/{task-id}` — short, predictable, sortable. Alternative: `task/{task-id}-{slugified-title}` for readability at the cost of length. Prefer the short form; PR title carries the readable name.
- **Stale worktrees**: a task abandoned mid-pipeline leaves a worktree on disk. Coordinator's existing stale-scan (currently checks `in_progress` with no activity 2+ days) extends to: list `.paperclip/worktrees/`, cross-reference active task IDs, garbage-collect orphans.

### 3.3 Multi-stage commit author

Each stage commits as itself (Worker / Reviewer / Architect) using a stage-tagged trailer (`Stage: worker`). Easier post-hoc audit than collapsing all three into one author. Keep `Co-Authored-By: Claude ...` already present in commit conventions.

### 3.4 GitHub account for `gh push` / `gh pr create`

Repo write access lives on a specific GitHub account, and the system
may default to a different one (codex, etc.). Architect runs
`gh auth switch --user "$PAPERCLIP_GH_USER"` before any push or PR
creation. If the active account is wrong, the push fails or the PR
opens under the wrong identity, and Coordinator's merge sweep won't
recognize the result. Never work around an auth failure with
`--force-with-lease` or by pushing under the wrong account.

### 3.5 Environment variables (operator setup)

Agent INSTRUCTIONS reference these env vars instead of hardcoded
paths/usernames. Set them in your shell init or in a Paperclip-level
config (e.g. `~/.paperclip/env`) before launching agents:

| Var | Purpose | Example shape |
|---|---|---|
| `PAPERCLIP_PROJECT` | Absolute path to the project repo agents work on | `/path/to/your-project` |
| `PAPERCLIP_HOME` | Absolute path to this Paperclip checkout | `/path/to/paperclip` |
| `PAPERCLIP_PF2E_REF` | Absolute path to the PF2e Foundry data reference (Worker only, project-specific) | `/path/to/pf2e` |
| `PAPERCLIP_GH_USER` | GitHub account with write access to the project repo | `<your-github-username>` |

Agents that need any of these but find them unset should exit with a
clear error rather than guessing — silent fallbacks are how dirty
state leaks across machines.

Why env vars instead of hardcoded values: this fork lives at
`github.com/<user>/paperclip` and the bevy-rpg fork at
`github.com/<user>/bevy-rpg`. Other operators forking either repo
should be able to point at their own paths and account by setting four
env vars, not by editing every INSTRUCTIONS file.

### 3.5 Failure modes during the pipeline

- **Worker exits without committing**: Coordinator detects empty branch (no commits beyond `main`'s tip) and routes back to Worker (or marks task `failed` after retry).
- **Architect's cargo verification fails repeatedly**: Architect's existing "fix or open issue" rule applies; once the branch is buildable, PR opens.
- **Merge conflict on PR**: Coordinator (or Architect on next wake) rebases `task/{id}` onto fresh `main`. If unresolvable, comments and pings the operator.

## 4. Implementation order

Split into landable pieces so we can pilot before flipping every task:

1. **Coordinator**: add worktree allocation/teardown logic in INSTRUCTIONS + implement via shell calls in agent run (or expose as a Paperclip API endpoint). Deliverable: tasks land with `worktreePath` + `branch` set.
2. **Worker**: update INSTRUCTIONS to commit to the branch. Deliverable: one piloted task lands as a branch with Worker commits, no PR yet.
3. **Reviewer / Architect**: same INSTRUCTIONS update; Architect adds the `gh pr create` step. Deliverable: a piloted task lands as a PR, end-to-end.
4. **Cleanup**: Coordinator detects merge, removes worktree + branch.
5. **Flip the project rule**: `bevy-rpg/CLAUDE.md` "No Agent Commits" → "Agents commit to task branches".
6. **Garbage collection**: Coordinator stale-scan extends to orphaned worktrees.

Steps 1–3 land in sequence; step 5 only flips after 3 is verified on at least one full task end-to-end so we don't loosen the global rule before the new flow demonstrably works.

## 5. Non-goals (for this proposal)

- Replacing GitHub PR review with an in-Paperclip review UI. PRs land in GitHub for now; Paperclip just records the URL on the task.
- Auto-merge. Human always merges.
- Worktree-per-stage (separate worktree for Worker vs Reviewer). Same worktree across stages keeps it simple; review polish lands as a follow-up commit on the same branch.
