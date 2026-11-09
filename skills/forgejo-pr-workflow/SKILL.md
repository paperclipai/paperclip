---
name: forgejo-pr-workflow
description: Work against self-hosted Forgejo (forgejo.big.netlobo.com) with the fj CLI — authenticate, clone, commit, push, open and merge PRs, and comment on issues and reviews. Use when a task touches Forgejo repos, issues, or PRs. Not for GitHub.
---

# Forgejo Pull Request Workflow (fj)

Ship changes to the self-hosted Forgejo instance (`forgejo.big.netlobo.com`) using the `fj` CLI. `fj` is the Forgejo equivalent of `gh` — it handles issues, pull requests, comments, repos, orgs, and releases, and works alongside plain `git` (it does not replace `git` for committing or pushing).

## Authentication

The Forgejo application token is injected into the run environment as `FJ_TOKEN`. Authenticate `fj` before any API call:

```bash
fj auth add-token "$FJ_TOKEN"
```

- `add-key` is an alias for `add-token`.
- `fj` infers the host from the current repo's git remote. If the directory has no Forgejo remote, pass it explicitly: `fj -H forgejo.big.netlobo.com auth add-token "$FJ_TOKEN"`.
- Verify with `fj auth list`. If the token is missing, stop and ask the operator to bind `FJ_TOKEN` (backed by the `FORGEJO_TOKEN` company secret).

## Cloning

`fj repo clone` authenticates the clone through the fj token, or clone with plain `git`:

```bash
fj repo clone owner/repo path/to/checkout          # via fj token
git clone https://forgejo.big.netlobo.com/owner/repo.git
```

For plain `git` against private repos, make `git` use the token (no token in argv or URLs):

```bash
git config credential.https://forgejo.big.netlobo.com.helper \
  '!f() { echo "username=$FORGEJO_USER"; echo "password=$FJ_TOKEN"; }; f'
```

`FORGEJO_USER` is your Forgejo login. If it is not bound, use `oauth2` as the username for an OAuth2 grant token, or ask the operator to bind `FORGEJO_USER` alongside `FJ_TOKEN`.

## Branch hygiene before opening a PR

- Rebase or merge from the target base so the diff is current.
- Squash WIP commits into reviewable units. Prefer one commit per logical change; do not force one-commit-per-PR if the work is genuinely multi-step.
- Confirm tests, typecheck, and lint pass locally. Note any deliberate skips in the PR body.
- Remove debug prints, commented-out code, and tracked `TODO` markers that are not part of the change.

## Commit and push

```bash
git add -A
git commit -m "Imperative subject under 70 chars"
git push -u origin HEAD
```

## Opening a pull request

```bash
fj pr create --base main --head "$(git branch --show-current)" \
  --title "Allow CSV export from reports table" \
  --body-file pr-body.md
```

- `--base` is the target branch; `--head` is your working branch.
- `-A`/`--autofill` derives title/body from the branch and commits when you have nothing richer.
- For a fork-less AGit pull request, add `--agit` (pushes the ref and opens the PR without a fork).
- `--web` opens the compose page in a browser instead of submitting inline.

## PR title

- Imperative mood, under 70 characters.
- Lead with the user-visible change, not the file touched.
- Follow the repo's issue prefix convention if one exists.
- No trailing period.

## PR body

Use this structure:

```md
## Summary
- 1–3 bullets describing what changed and why.

## Implementation notes
- Anything non-obvious in the diff: trade-offs, dropped alternatives, gotchas.
- Migration or config implications.

## Verification
- The exact commands or steps you ran.
- Screenshots or short clips for UI changes (required if pixels moved).
- Edge cases you exercised by hand.

## Risk and rollback
- What breaks if this is reverted, and how to revert cleanly.
```

Skip `Risk and rollback` only for clearly trivial PRs.

## Issues

```bash
fj issue create "Title of the issue" --body "Description..."        # or --body-file
fj issue create "Title" -r owner/repo --milestone "v1.2"            # target a specific repo
fj issue comment 123 --body "Working on this now."                  # or --body-file
fj issue close 123 -m "Fixed by PR #456"
fj issue view 123
fj issue search "segfault" -r owner/repo --state open
```

## Replying to review comments

- Reply on every comment, even with just "fixed in <commit-sha>".
- Push fixes as new commits while review is active; do not amend during review unless the reviewer agrees.
- Disagree in one sentence of rationale and let the reviewer decide. Do not escalate over comments.

```bash
fj pr comment 456 --body "Fixed in $(git rev-parse --short HEAD)."   # or --body-file
fj pr review 456                                                  # approve / comment / request changes
```

## Merge

```bash
fj pr merge 456 -M squash --delete     # method: merge | squash | rebase | rebase-merge | fast-forward-only
```

## Merge checklist

- All required checks green (inspect them with the `forgejo-actions` skill / `fj-ex`).
- All review comments resolved.
- PR title/body still accurate if scope changed mid-review.
- Linked issue moves to the appropriate state.
- Delete the branch after merge unless it is a long-lived integration branch.

## Anti-patterns

- PR description that says "see commits".
- Mixing refactor and behavior change with no separation in the body.
- "Address feedback" commits that bundle unrelated edits.
- Force-pushing during active review without telling the reviewer.
