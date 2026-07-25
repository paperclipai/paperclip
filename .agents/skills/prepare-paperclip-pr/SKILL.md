---
name: prepare-paperclip-pr
description: Prepare a Paperclip branch for PR with commits, template body, and checks.
---
# Prepare Paperclip PR

The standard Paperclip procedure for turning branch work into a reviewed,
green pull request against `paperclipai/paperclip` master. Apply it once per
PR (if a task splits a branch into several PRs, run the whole procedure for
each one).

## 0. Preconditions — worktree safety

* Do all PR work in a **git worktree** on a dedicated branch. The main
  `~/paperclip` checkout typically runs the live Paperclip server — never
  check out branches there. If you are already on a worktree/branch, verify it
  (`git rev-parse --git-dir`, `git branch --show-current`) and proceed.
* If the main checkout is unexpectedly off `master`, fix that first without
  losing work (usually: move that branch's work into a worktree).
* Confirm which remote/ref you are targeting (normally `master` on the
  `paperclipai/paperclip` repo; the task may name a specific remote such as
  `origin` or `public-gh`).

## 1. Commit everything — lose no work

* Make **logical commits** of all uncommitted changes before anything else.
  Do not stash and forget; do not leave files behind. If commits are missing,
  make them.
* Commit messages must end with exactly:
  `Co-Authored-By: Paperclip <noreply@paperclip.ing>`

## 2. Get changes cleanly on top of master

* Fetch the target remote and rebase (or otherwise replay) your branch on top
  of the target master so the PR has no merge conflicts.
* Re-verify after rebase: build/tests relevant to the change still pass at
  whatever depth the task warrants.

## 3. Guardrails checklist (every PR)

* **Never commit `pnpm-lock.yaml`** — the repo has actions that manage it.
  If it is already in a commit, rewrite/drop that change before pushing.
* **Never change `.github/workflows/*`** unless the underlying commit was
  explicitly about that and the task calls it out.
* **No design screenshots / wireframe images** committed to the repo unless
  they are genuinely part of the work product.
* **Migrations**: numbered incrementally with no conflicts against master. If
  master moved and took your number, renumber on top. Make migrations
  **idempotent** so users who already applied the old number are safe.
* **Greptile file limit**: keep each PR under **100 changed files**; if a PR
  exceeds that, split it into two.

## 4. Open the PR

* Follow `CONTRIBUTING.md` (repo root,
  https://github.com/paperclipai/paperclip/blob/master/CONTRIBUTING.md) for
  the PR title, message format, and issue description.
* Push the branch and open the PR with `gh`.
* Record the PR URL immediately — every report must include URLs to every PR.

## 5. Review loops

* Run the **/greploop** company skill: trigger Greptile review, address its
  comments, push, and repeat until Greptile gives **5/5 with zero unresolved
  comments** (max 20 turns). Do not stop early while turns remain.
* Then run the **/prcheckloop** company skill and address any verification /
  CI failures you can.
* RUN GREPTILE UNTIL IT GETS TO 5/5 - DO NOT STOP UNTIL GREPTILE IS 5/5, all
  tests pass, all verification checks pass, and there are no merge conflicts.

## 6. Report back and hand off

* Comment on the driving task: what you did, the PR URL(s), the worktree path
  (use `~` for home), Greptile score, and check status.
* Create a `pull_request` work product for each opened PR (plus `branch` /
  `commit` work products where the branch or a commit is itself the handoff).
* If the task requires follow-up per PR (e.g. sub-issues per PR), create them
  as the task directs and link them.

## Hard rules

* **YOU DO NOT MERGE THE PR YOURSELF. NEVER MERGE THE PR YOURSELF.**
* Never lose work: no orphaned stashes, no dropped files, no force-pushes
  that discard commits.
* Always post the URLs to every pull request you created.
