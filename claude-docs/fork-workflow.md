# Fork Workflow — staying in sync with upstream

How this clone is wired so you can keep pulling updates from the public Paperclip
repo while keeping your own changes on your fork.

## Remotes

```
upstream  →  https://github.com/paperclipai/paperclip.git   (read-only — you pull updates)
origin    →  https://github.com/Moyal17/paperclip.git        (your fork — your master + branches)
```

- `master` tracks `origin/master` and is kept as a **clean mirror** of `upstream/master`.
- You never commit directly on `master`. All work happens on branches.
- Your changes reach `master` only by merging a branch in — so `master` stays
  fast-forwardable from upstream forever.

Check the wiring anytime:

```bash
git remote -v
git branch -vv
```

## Pull Paperclip updates into your master

Run this regularly (e.g. before starting new work):

```bash
git checkout master
git fetch upstream
git merge --ff-only upstream/master   # clean mirror → always fast-forwards
git push origin master                # update your fork
```

If `--ff-only` ever fails, it means a commit landed directly on `master`. Don't
force it — move that commit onto a branch instead:

```bash
git branch my-stray-work        # save the commit on a branch
git reset --hard upstream/master # restore master to a clean mirror (local only)
git push origin master
```

## Start new work

Branch off an up-to-date `master`:

```bash
git checkout master
git checkout -b feat/my-thing
# ...work, commit...
git push -u origin feat/my-thing
```

## Bring upstream updates into an active branch

When `master` has moved ahead (after a sync) and you want those updates in a
feature branch:

```bash
git checkout feat/my-thing
git rebase master        # linear history (preferred), OR:
git merge master         # keeps merge commits
```

After a rebase, the branch's history is rewritten, so the next push needs a
force — safe on your own fork branch:

```bash
git push --force-with-lease origin feat/my-thing
```

`--force-with-lease` (not plain `--force`) refuses to overwrite if someone else
pushed in the meantime.

## Land your changes on your master (optional)

If you want a feature merged into your own `master`:

```bash
git checkout master
git merge --no-ff feat/my-thing
git push origin master
```

Your `master` is now `upstream + your merged work`. It will still fast-forward on
the next upstream sync **as long as the merge sits on top of upstream history** —
keep syncing master before merging so it never diverges.

## Quick reference

| Goal | Command |
|------|---------|
| Sync master with upstream | `git checkout master && git fetch upstream && git merge --ff-only upstream/master && git push origin master` |
| New branch | `git checkout master && git checkout -b feat/x` |
| Update branch with upstream | `git checkout feat/x && git rebase master` |
| Push a rebased branch | `git push --force-with-lease origin feat/x` |
| See remotes / tracking | `git remote -v` · `git branch -vv` |
