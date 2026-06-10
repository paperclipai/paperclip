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

Core rule: use the repository's PR contract first. If `.github/PULL_REQUEST_TEMPLATE.md` exists, it is the required PR body structure. Do not replace it with the fallback structure below.

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
- Inspect `git status --short` and `git diff --stat`. Do not include unrelated dirty files, local env files, generated bundles, or lockfile churn unless the repository explicitly wants them.
- Confirm no secrets, tokens, passwords, customer data, or machine-local paths are introduced in commits or screenshots.
- Compare the planned PR title and body against `git diff --name-only` and `git diff --stat`. The title/body must describe the actual diff, not a previous run, an intended follow-up, or a copied CI fix.
- Repository lint wins over stylistic task wording. If a task asks for section comments such as `// AAA: Arrange`, but the repo linter flags them as commented-out code, keep the test intent in names/docstrings/table cases instead of adding lint-rejected comments.

## PR title

- Imperative mood, under 70 characters.
- Lead with the user-visible change, not the file touched. `Allow CSV export from reports table` beats `Update reports.tsx`.
- If the repo uses an issue prefix convention (`PAP-1234:`, `[security]`), follow it.
- No trailing period.

## PR body

### Repository template mode

If the repository contains `.github/PULL_REQUEST_TEMPLATE.md`:

1. Read `.github/PULL_REQUEST_TEMPLATE.md` before drafting the PR.
2. Read `CONTRIBUTING.md` and `AGENTS.md` when they exist.
3. If `.github/workflows/` exists, inspect the relevant PR/CI workflow names so the verification section matches real gates.
4. Copy the template's section headings exactly.
5. Fill every required section with concrete content. Do not leave placeholders, empty bullets, or unchecked items that should be checked.
6. Never recycle a title or PR body from another branch. Every mentioned file, workflow, status, and risk must exist in the current diff or be explicitly marked out of scope.
7. Keep state assertions literal: if the PR body says `DRAFT`, the PR must actually be draft; if a checkbox says a gate passed, the command or CI check must have actually passed and be named.

For Paperclip repositories, the required sections are:

- `## Thinking Path`
- `## What Changed`
- `## Verification`
- `## Risks`
- `## Model Used`
- `## Checklist`

### Fallback mode

Use this fallback only when the repository has no PR template:

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
- Never fabricate test results, screenshots, benchmark numbers, review approvals, compliance evidence, or live verification. If a command was not run, say it was not run and why.
- For local UI changes, include the exact URL and viewport(s) used for manual verification when possible.

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

## Anti-patterns

- PR description that says "see commits". Reviewers should not need to read the log.
- Mixing refactor and behavior change in the same PR with no separation in the body.
- "Address feedback" commits that bundle unrelated edits. One commit per round of feedback is fine; one commit for everything in flight is not.
- Force-pushing during active review without telling the reviewer.
