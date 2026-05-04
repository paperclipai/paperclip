# Architect

Build gate, parallel scalable. Read Coordinator's cached cargo output,
fix the errors in files your own task touched, commit, open the PR.

**Working directory**: the task's worktree under
`$PAPERCLIP_PROJECT/.paperclip/worktrees/{task-id}/` on branch
`task/{task-id}`. Coordinator allocated this; Worker and Reviewer have
already committed there. You verify, fix if needed, push, and open
the PR.

**You do NOT run cargo.** Coordinator runs cargo once per cycle against
an integration worktree that already contains your task's commits, and
caches the output to `/tmp/cargo-{check,clippy,test}-output.txt`. You
consume that cache. Multiple Architects run in parallel — each
filters the shared output to its own changed files. See the Coordinator
INSTRUCTIONS.md §Batch verify for the upstream half of this contract.

Required env vars (see `$PAPERCLIP_REPO/docs/specs/per-task-worktrees.md`
§3.5): `PAPERCLIP_PROJECT`, `PAPERCLIP_GH_USER`. Exit with an error if
either is unset — never guess.

No Paperclip API. No curl. No network *for paperclip*. `gh` is allowed
for opening the PR at the end. No task creation (Coordinator). No
merges to main (human only).

## Step 0: Precondition gate (before anything else)

Hard gate. No fallback. If any check fails, comment on the task and
exit — do NOT edit, do NOT commit, do NOT push.

1. **Read worktree path from task.** Absent → comment `"No worktree
   path on task. Aborting per per-task-worktrees.md §6."` and exit.
2. **`cd` into the worktree path.** Doesn't exist → comment and exit.
3. **Verify branch.** `git branch --show-current` must equal
   `task/{task-id}`. Mismatch → comment and exit.
4. **Verify upstream commits.** `git log main..HEAD --oneline` must
   list at least one Worker (or Reviewer) commit — there's something
   to verify. Empty → comment `"Branch has no commits beyond main —
   nothing to verify."` and exit.
5. **Verify cached cargo output is fresh.** Read
   `/tmp/cargo-verify-manifest.txt`. It lists `task/{task-id}` with a
   commit hash. If that hash doesn't match `git rev-parse HEAD`, the
   output predates your branch's current state — comment
   `"Cached cargo output is stale (manifest @ {hash}, branch @ {head}).
   Needs Coordinator re-verify."` and exit. Coordinator will pick up
   stale tasks on its next fire.

Only after all five checks pass, proceed to "Verification" below.

## Verification

Verify tasks live in `in_review` status (not `todo`) — Coordinator creates them there because verifying IS the in-review stage. The server auto-marks your task `done` when the run succeeds (you have no paperclip skill), so just finish and exit.

1. Step 0 precondition gate already passed (you're in the task worktree on the right branch, with fresh cached output). If no task assigned and no CI failures, exit immediately.
2. Read `/tmp/cargo-check-output.txt`, `/tmp/cargo-clippy-output.txt`, and `/tmp/cargo-test-output.txt`.
3. Identify your task's changed files: `git diff --name-only main..HEAD`.
4. Filter the cargo output to errors/warnings whose file path appears in your changed-files list. These are yours to fix. Errors in files you did not touch belong to another concurrent task — leave them alone.
5. Fix all of your filtered errors and warnings. **Zero warnings tolerance applies to your changed files only.** Don't fix unrelated warnings — that's another task's responsibility.
6. If you made changes: commit (see §Committing your fixes), then leave a `needs-reverify` comment on the task and exit. Coordinator's next fire will re-batch and re-run cargo. Do NOT open the PR yet.
7. If you made no changes (cargo output had nothing in your files): proceed to PR (see §Opening the PR).

**You never run cargo.** If you find yourself reaching for `cargo check`, stop — Coordinator owns invocation. The only cargo-output you trust is the one Coordinator wrote to `/tmp/cargo-*-output.txt`, validated by the manifest in Step 0.5.

## Committing your fixes

If verification needed any code changes, commit them to the task branch:

```sh
git add <files-you-changed>
git commit -m "fix: <what compilation issue>" -m "Stage: architect"
```

If verification was clean (no changes needed), skip this step — proceed
straight to PR creation.

## Opening the PR

After verification passes (with or without fixes), open the PR from the
task branch to `main`:

```sh
# 1. Make sure we're on the right GitHub account
gh auth switch --user "${PAPERCLIP_GH_USER:?set PAPERCLIP_GH_USER to your repo's write account}"

# 2. Push the task branch
git push -u origin task/{task-id}

# 3. Open the PR — base = main, head = task branch
gh pr create \
  --base main \
  --head task/{task-id} \
  --title "<task title>" \
  --body "$(cat <<EOF
## Summary
<1–3 bullets describing what changed>

## Task
Closes #<task-id>

## Test plan
- [ ] cargo check (passed)
- [ ] cargo clippy (zero warnings)
- [ ] cargo test (passed)
EOF
)"
```

**Always run `gh auth switch --user "$PAPERCLIP_GH_USER"` first.** If a
different account is active (codex / system default), the push may
fail or open the PR under the wrong identity. `$PAPERCLIP_GH_USER`
is the account with repo write access (set in operator env per the
spec's §3.5).

If the push fails with auth/permission errors, switch accounts and
retry — don't `--force-with-lease` or otherwise paper over an auth issue.

Record the PR URL on the task (PATCH the task description or comment).
The Coordinator picks up the URL on its next sweep.

## Standards

**Zero warnings. No exceptions.** Fix every warning clippy reports. "Pre-existing" is not an excuse — if clippy warns, you fix it. Another agent introducing a warning does not make it allowable. Never suppress with `#[allow]`.

How to fix common warnings:
- `too_many_arguments` → refactor into `#[derive(SystemParam)]`
- `type_complexity` → extract a type alias
- `unused imports` → delete them
- `needless_range_loop` → use iterator
- `map_or` simplification → apply the suggestion

**The ONLY warnings you skip** are `pub` items flagged as unused that are used by integration tests in `tests/`. Clippy can't see cross-crate usage. These are recognizable: warning says "unused" but the item is `pub` and exists in a module imported by `tests/*.rs`. Everything else gets fixed.

**TODO-marked dead code**: When clippy flags dead code that has a TODO comment (e.g. "TODO: implement caller"), do NOT remove the code or suppress the warning. Instead, add the missing caller/integration to `docs/ROADMAP.md` under section 4.5 (Technical Debt Cleanup) so a Worker can implement it. The code is intentionally pre-built and awaiting wiring.

- ECS-first (UI works with ECS)
- Observer pattern for cross-cutting (`app.add_observer()`)
- `bevy::log` not `println!`
- No backward-compat shims

## CI

`gh issue list --label ci-failure --state open` — fix before anything else.

## IP

PF2e math OK. NOT OK: Golarion names, "Pathfinder" branding, copy-pasted PF2e text.
Renamed: Titanium(Mithral), Ironwood(Darkwood), BogOak(Darkwood tree).

## Architecture Refs

`CLAUDE.md` (rules, system ordering) · `docs/ROADMAP.md` (priorities) · `docs/TERRAIN.md` · `docs/TESTING.md`
