---
name: "paperclip-pr-from-branch"
description: ">"
slug: "paperclip-pr-from-branch"
metadata:
  paperclip:
    slug: "paperclip-pr-from-branch"
---

# Paperclip PR From Branch

This is the Paperclip-native port of `tac-4/.claude/commands/pull_request.md`. The tac original passed `adw_id`, `branch_name`, `issue`, and `plan_file` as positional arguments. Paperclip derives all of those from the checked-out issue, so this skill takes **no arguments**.

## When to use

- Implementation is complete on a feature / bug / chore issue.
- All `Validation Commands` in the plan have exited zero on a clean working tree.
- The branch has at least one commit beyond `main`/`master` and the branch name follows .

## When NOT to use

- The change set is empty or unpushed. Push first, or create no PR.
- The branch already has an open PR — update that PR's description instead of opening a duplicate.
- The work is a draft you do not want reviewed yet — open it as a draft PR (`gh pr create --draft`).
- The repo is not GitHub. Use the host-appropriate skill (TBD; not provided here).

## Inputs (Paperclip primitives, not files)

1. Current branch from `git branch --show-current`.
2. Issue identifier and title from `GET /api/issues/{issueId}` or heartbeat context.
3. `#document-plan` revision link (issue-document deep link).
4. Recent commits on the branch from `git log origin/main..HEAD --oneline`.
5. Validation Commands list from the plan — quoted into the PR body so a reviewer sees what was run.

You do not need a separate `adw_id`. The issue identifier and the run id together fully identify provenance.

## Push the branch

```bash
git push -u origin "$(git branch --show-current)"
```

If the upstream is already set, plain `git push` is fine. Never `--force` a published branch without an explicit human ask; if you genuinely need to amend a single un-reviewed commit, use `git push --force-with-lease` and only with prior agreement.

## PR title shape

```
<type>: <identifier> — <short subject>
```

- `<type>` is the conventional-commit prefix from  (`feat`, `fix`, `chore`, …).
- `<identifier>` is the Paperclip issue identifier (``). The PR title is one of the few human surfaces where the identifier belongs out in front.
- `<short subject>` ≤ 60 chars, imperative mood, no trailing period.

Examples:

- `fix:  — guard null assignee in inbox-lite`
- `feat:  — labels filter on issues list`
- `chore:  — bump @paperclipai/sdk to 0.42.0`

## PR body shape

Use this template (heredoc into `gh pr create --body`):

```md
## Summary

<one paragraph: what changed and why, in past/present tense>

## Plan

- Plan: #document-plan
- Issue: <identifier>
- Run: /<PFX>/agents/<agent-key>/runs/<run-id>

## Validation

The following commands from the plan's `Validation Commands` section were run on the final commit and exited zero:

- `<cmd 1>`
- `<cmd 2>`
- …

## Notes

<optional: migration steps, follow-up issues, gotchas the reviewer should know about>

Closes <issue-identifier-or-#N when GitHub-linked>
```

- "Summary" is the **why**. The diff already shows the what.
- "Plan" carries the deep links so a reviewer can move from PR ↔ issue ↔ run log without copy-paste.
- "Validation" is a literal echo of the plan's commands. If a command was not run, do not list it; if a command was added/changed during implementation, note it explicitly.
- "Closes" — use the auto-close form when the platform supports it (GitHub: `Closes #N`). For Paperclip-only auto-close, the deep link in "Plan" is enough; the issue will be transitioned via the PR-merged webhook or the issue update from `paperclip-implement-plan`.

## Emitting the PR

```bash
gh pr create \
  --title "<type>: <identifier> — <subject>" \
  --base main \
  --body "$(cat <<'EOF'
## Summary

…

## Plan

- Plan: …
- Issue: …
- Run: …

## Validation

- …

Closes #N
EOF
)"
```

Capture the returned PR URL and:

- Post a comment on the Paperclip issue (following ) with `## Changed` listing the PR link.
- `PATCH /api/issues/{id}` to `in_review` if a reviewer agent / QA exists; otherwise `done`.

## Anti-patterns

- **PR against `main` from `main`.** Always work on a feature branch named by .
- **No issue identifier in title or body.** Breaks the reverse-link from PR → issue → plan → run log.
- **`Closes` with a stale issue number.** Verify the identifier before submitting; an incorrect `Closes` can auto-close the wrong issue.
- **Draft PR left to rot.** Drafts are fine for early review; either promote or close them — they accumulate and bury active PRs.
- **Force-push after request-changes.** Squash-and-rebase loses the conversation thread. Make new commits responding to feedback.
- **Including secrets in the PR body.** PR descriptions are public on most repos. Run a final grep over the body before submitting.
