---
name: github-pr-workflow
description: Prepare a GitHub pull request from a feature branch — branch hygiene, commit shape, title/body, verification notes, screenshots for UI work, and replies to review comments.
key: paperclipai/bundled/software-development/github-pr-workflow
recommendedForRoles:
  - engineer
tags:
  - github
  - pull-requests
  - code-review
  - release
---

# GitHub Pull Request Workflow

Ship a PR a reviewer can land without follow-up clarifying questions. The aim is high signal in the title and body, evidence the change works, and clean replies when feedback comes in.

## When to use

- You are about to open a PR for a change that is functionally complete.
- A reviewer left comments and you need to respond and push fixes.
- A PR has been open more than a day and needs to be brought back into shape (stale conflicts, missing description, missing verification).

## When not to use

- The change is not yet functionally complete. Finish the work first; draft PRs that bounce on review are noise.
- The repository uses a non-GitHub forge. Adjust to that forge's conventions; do not force GitHub-isms.

## Branch hygiene before opening

- Rebase or merge from the target base so the diff is current.
- Squash WIP commits into reviewable units. Prefer one commit per logical change; do not force one-commit-per-PR if the work is genuinely multi-step.
- Confirm tests, typecheck, and lint pass locally. Note any deliberate skips in the PR body.
- Remove debug prints, commented-out code, and `TODO` markers that are not tracked.

## PR title

- Imperative mood, under 70 characters.
- Lead with the user-visible change, not the file touched. `Allow CSV export from reports table` beats `Update reports.tsx`.
- If the repo uses an issue prefix convention (`PAP-1234:`, `[security]`), follow it.
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

Skip the `Risk and rollback` section only for clearly trivial PRs (typos, docs).

## Verification evidence

- Tests passing in CI is necessary, not sufficient. Reviewers also need to know the change behaves correctly end to end.
- For UI work, include screenshots of the golden path and one edge case. Tag dark and light mode if the project supports both.
- For migrations, include a dry-run plan and reversal steps.
- For performance changes, include a before/after measurement, not adjectives.

## Replying to review comments

- Reply on every comment, even with just "fixed in <commit-sha>" — silent fixes leave the reviewer guessing.
- Push fixes as new commits while review is active; do not amend during review unless the reviewer agrees.
- If you disagree with feedback, say so with one sentence of rationale and let the reviewer decide. Don't escalate over comments.
- Re-request review explicitly after pushing changes.

## Merge checklist

- All required checks green.
- All review comments resolved.
- PR title/body still accurate (update if scope changed mid-review).
- Linked issue moves to `in_review` or `done` per project convention.
- Delete the branch after merge unless it is a long-lived integration branch.

## Which credential to use (authoring, reviewing, merging)

You have two GitHub identities available, and which one you use decides whether
the review bot can formally review your PR:

- **Default App-installation token** — identity `app/allyblockcast[bot]`. Works
  for commits, PR creation, comments, status, and reads. This is also the
  identity the **review bot** posts as.
- **User-seat token** — mounted at `/paperclip/.secrets/github-merge-token/token`
  when provisioned. This is the **`allyblockcast` user** account, a *distinct*
  GitHub identity from the `app/allyblockcast[bot]` App.

GitHub forbids an identity from submitting a **formal review** (`APPROVE` /
`REQUEST_CHANGES`) on a PR it authored. So when a PR is authored by the App, the
review bot (also the App) can only leave a *comment* — never a formal review.
Authoring under the **user seat** makes author ≠ reviewer, so the bot can post a
real `gh pr review`.

**When the user-seat token is mounted, author your PR under it** — push the
branch and create the PR with it — and use it for the final merge too:

```sh
AUTHOR_TOKEN="$(cat /paperclip/.secrets/github-merge-token/token)"

# push the branch + open the PR as the allyblockcast USER (formally reviewable)
GH_TOKEN="$AUTHOR_TOKEN" git -c http.https://github.com/.extraheader= \
  push -u origin "$(git branch --show-current)"
GH_TOKEN="$AUTHOR_TOKEN" gh pr create --repo <org>/<repo> --title ... --body ...

# ... later, after the review checklist is satisfied:
GH_TOKEN="$AUTHOR_TOKEN" gh pr merge <number> --repo <org>/<repo> --squash
```

Rules:
- Use the **user-seat token** for the branch push, `gh pr create`, and
  `gh pr merge`/auto-merge. Use the **default App token** for everything else
  (comments, replies, status, reads) so the Paperclip↔GitHub integration keeps
  working.
- If the file does **not** exist, the user-seat lane is not provisioned for this
  repo — do not improvise a token. Author and merge under the default token as
  before; the review bot will fall back to comment-mode review, and a maintainer
  lands the merge. Note it on the issue.
- Only merge when the merge checklist above is satisfied (checks green, comments
  resolved).

## Anti-patterns

- PR description that says "see commits". Reviewers should not need to read the log.
- Mixing refactor and behavior change in the same PR with no separation in the body.
- "Address feedback" commits that bundle unrelated edits. One commit per round of feedback is fine; one commit for everything in flight is not.
- Force-pushing during active review without telling the reviewer.
