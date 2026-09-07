# Worktree Development Policy

This document is the canonical policy for how code changes reach `master` in
this repository. It is the contract followed by humans, AI agents, and CI when
working from the production checkout.

## Why this policy exists

The local `master` checkout is a **production instance**: `pnpm dev` runs on it
with hot-reload enabled, and the Paperclip server (plus the linked Hermes
gateway) is the live deployment. Direct writes to that checkout — a
`checkout`, `rebase`, `merge`, or `commit` on `master`, a fast-forward, or a
rebuild — can tear down running agents and the gateway. Nothing dirty, brained,
or speculative ever touches `master` directly.

## Non-negotiable rules

1. **Never commit directly to `master`.** No direct `git commit`, `git merge`,
   `git rebase`, or `git checkout` of branches onto the production checkout.
2. **Never run `git pull` or `--fast-forward` on `master`.** `master` only
   advances by PR merges against the upstream `paperclipai/paperclip`
   repository, brought down deliberately and only after those merges.
3. **No rebuilds or restarts without a scheduled window.** A rebuild of the
   server restarts the gateway and drops active agent runs. Rebuilds happen
   only in a window agreed with a human operator. Until then, "rebuild
   pending" is the normal resting state.
4. **Never force-push to a shared branch**, and never rewrite a branch that is
   already the head of an open PR (use stacked PRs or a new branch instead).

## The lifecycle of a change

Work on a change via a git worktree, never on `master`.

### 1. Create the worktree from the issue

```sh
# From the production checkout root (read-only here — this never writes master):
git worktree add ../PAPERCLIP-SERVER-wt-<slug> -b plv-<id>-<slug> origin/master
```

- `<slug>` is a short kebab-case description of the change.
- `<id>` is the Paperclip issue id.
- Base the branch on `origin/master` (the upstream source of truth), **not**
  on the local `master` (which is the running production state and may carry
  unmerged work).

### 2. Do the work entirely inside the worktree

- Edit, commit, and test inside the worktree. A worktree has its own
  `.git/private` and working files, so it cannot disturb the running instance.
- Never `pnpm dev` against the production instance's database from a worktree;
  use `paperclipai worktree init` for an isolated instance when a dev server is
  needed (see `doc/DEVELOPING.md` → "Worktree-local Instances").

### 3. Open a pull request

```sh
# From the worktree:
git push -u origin plv-<id>-<slug>        # or your fork
gh pr create --base master
```

- Follow the PR template in `.github/PULL_REQUEST_TEMPLATE.md` fully.
- PR CI runs the validation gates; merge only after the checks pass.

### 4. Merge through GitHub

- Merge the PR on upstream GitHub. `master` is never merged locally.
- After the PR is merged upstream, `origin/master` advances. The production
  checkout's `master` is brought up to date **only** by a deliberate
  `git fetch origin` + `git merge --ff-only origin/master` performed in a
  scheduled maintenance window — never as part of routine work and never while
  agent runs are active.

## Dirty work

Uncommitted work on the production `master` is the one exception to
"never touch master", and it has a strict deadline:

- **Same day.** Any dirty change in the production checkout is captured into a
  worktree the same day it appears: `git diff > patch`, apply the patch in the
  worktree, commit, open the PR. Dirty work does not accumulate.
- Never commit the dirty `master` state itself.

## Untracked data

Data files (databases, dumps, generated artifacts) are not PR material:

- Add data paths to `.git/info/exclude` in the production checkout so they stay
  out of `git status` and out of history.
- Do not `git add` untracked data into a worktree branch or include it in a PR.

## Rebuilds

A change to server or gateway code is not "done" until it is deployed, and
deployment means a rebuild:

- Rebuilds happen only in an agreed window with a human operator.
- Before a rebuild, record which PR merges are riding the next deploy so the
  operator can confirm scope.
- When work lands without a scheduled rebuild, the resting state is
  **"rebuild pending"** — the code is merged but not yet running in the
  production instance.

## Definition of done

A change is done when:

1. It is committed on a worktree branch, pushed, and merged into upstream
   `master` via a green PR.
2. The production checkout's `master` has not been written to directly.
3. Data paths are excluded, and dirty work either is merged or is captured in a
   worktree.
4. If a rebuild was required but no window was agreed, the state is recorded as
   "rebuild pending".