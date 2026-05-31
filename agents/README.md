# Pipeline Roles

Cross-role contract reference for the bevy-rpg agent pipeline. Each role's full spec lives in `{role}/INSTRUCTIONS.md`; this file is the matrix of who does what so they can't drift.

## Pipeline

```
Operator (human; commits to main, sets direction, merges PRs)
  Planner           — daily 18:55 — owns roadmap; identifies gaps; updates docs/ROADMAP.md
    Coordinator     — daily 19:00 — promotes roadmap → tasks; allocates worktrees; advances stages; tears down on merge
      Worker        — wake on assignment — implements task; commits to task/{id}; never pushes
      Reviewer      — wake on assignment — optimizes Worker's changed files; commits polish; never pushes
      Architect     — wake on assignment — runs cargo; fixes errors; pushes; opens PR
  Facilitator       — daily 19:30 — pipeline health; blocked-task clearing; stale-branch sweep; comment-without-PATCH
```

Wake mechanism: scheduled cron for orchestrators (Planner/Coordinator/Facilitator); assignment-fire `wakeOnDemand` for Worker/Reviewer/Architect (no scheduled routine — they only run when given a task).

## Matrix — who does what

| Action | Worker | Reviewer | Architect | Coordinator | Planner | Facilitator |
|---|---|---|---|---|---|---|
| Read codebase | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Edit game code (`src/`, `assets/`) | ✓ | ✓ | ✓ | — | — | — |
| Edit `docs/ROADMAP.md` | — | — | — | — | ✓ | — |
| Edit subsystem `CLAUDE.md` | — | — | — | — | ✓ | — |
| Edit other agents' `INSTRUCTIONS.md` / `adapterConfig` | — | — | — | — | ✓ | file-only¹ |
| Run `cargo` | — | — | **✓** | — | — | — |
| `git commit` to `task/{id}` | ✓ | ✓ | ✓ | — | — | — |
| `git commit` to `main` | NEVER | NEVER | NEVER | NEVER | NEVER | NEVER |
| `git push origin task/{id}` | — | — | **✓** | — | — | — |
| `git push origin --delete task/{id}` | — | — | — | ✓ | — | ✓ ² |
| `gh pr create` | — | — | **✓** | — | — | — |
| Merge PR to `main` | NEVER | NEVER | NEVER | NEVER | NEVER | NEVER (operator only) |
| `git worktree add` | — | — | — | ✓ | — | — |
| `git worktree remove` | — | — | — | ✓ | — | — |
| Create paperclip task | — | — | — | ✓ | — | — |
| `PATCH /issues/{id}` (status / assignee) | — | own task | own task | any | own | any (when unsticking) |
| Comment on a paperclip task | own | own | own | any | any | any |
| Use `paperclip` skill (API) | NO | ✓ | NO | ✓ | ✓ | ✓ |
| `gh` for GitHub CLI | — | — | ✓ | ✓ | — | ✓ |
| Network egress | NO | NO | ✓ (gh only) | ✓ | ✓ | ✓ |

¹ Facilitator can file followup issues against any agent's config; only Planner edits the actual files.
² Facilitator deletes branches that are already-merged or empty-diff vs main (cases 1 & 2 of its stale-branch sweep); Coordinator deletes branches as part of the post-merge teardown.

## Task lifecycle

```
backlog                                    ← Coordinator promotes from ROADMAP
  → todo (Worker assigned)                 ← Coordinator promotes on capacity
  → in_progress                            ← Worker auto-advances on assignment-wake
  → done (Worker exits)                    ← server marks done on Worker exit
    → in_review subtask (Reviewer)         ← Coordinator advances stage
      → done (Reviewer exits)
        → assign Architect (needs-build)   ← Coordinator advances stage (needs-build only)
          → Architect runs cargo
          → if fixes needed: commit, re-run cargo (3-cycle hard stop)
          → push, open PR, exit
        → done (data-only label)           ← Coordinator advances stage (no Architect step)
          → Architect opens PR (no cargo)
        → operator merges PR
          → Coordinator tears down worktree + remote branch on merge
```

States: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `cancelled`, `blocked`.

## Skills + permissions

| Role | Skills | `dangerouslySkipPermissions` | `maxConcurrentRuns` (default) |
|---|---|---|---|
| Worker | none | false | 4 |
| Reviewer | `paperclip` | true | 4 |
| Architect | none | true (needs shell for cargo + gh) | **8** |
| Coordinator | `paperclip`, `paperclip-create-agent` | true | 1 |
| Planner | `paperclip` | true | 1 |
| Facilitator | `paperclip` | true | 1 |

One agent instance per role; concurrency comes from `maxConcurrentRuns`. Architect's high cap is intentional — cargo's build lock serializes the cargo step, but everything else (analyzing output, applying fixes, committing, pushing, opening PR) parallelizes, which is exactly the bottleneck-around-cargo flow you want.

Workers have no skills because the adapter injects task context directly into their prompt; agents that hit the API need the `paperclip` skill (which uses `curl`, hence skip-permissions).

## Cadence

All times America/Denver.

| Role | Daily | Weekly | On-demand |
|---|---|---|---|
| Planner | 18:55 | — | — |
| Coordinator | 19:00 | — | — |
| Facilitator | 19:30 | — | — |
| Worker | — | — | assignment-wake |
| Reviewer | — | — | assignment-wake |
| Architect | — | — | assignment-wake |

Heartbeat timers are disabled across the board; `wakeOnDemand` fires assignment wakes instantly. The one-shot-per-day cadence keeps the pipeline out of working hours — operator edits during the day land overnight.

## Hard never-do rules (any role)

- Commit directly to `main`
- Force-push to any branch
- Skip git hooks (`--no-verify`, `--no-gpg-sign`)
- Merge PRs (operator-only)
- `cargo` (Architect-only)
- Edit another agent's `INSTRUCTIONS.md` (Planner-only via files; everyone else files followups)
- `curl` against the paperclip API (use the `paperclip` skill — it handles auth, retry, run-id headers)
