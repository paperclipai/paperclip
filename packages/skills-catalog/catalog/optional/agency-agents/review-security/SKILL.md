---
name: "review-security"
description: "Review code changes with Security Review subagent."
key: "paperclipai/optional/agency-agents/review-security"
recommendedForRoles:
  - "engineer"
  - "security"
tags:
  - "agency-agents"
  - "engineer"
  - "security"
  - "review"
defaultInstall: false
---
# Review Security

Use this skill when the user asks to run `/review-security`.

Launch exactly one `security-review` subagent with:

- `readonly: true`
- `run_in_background: false` unless explicitly asked to run in background
- `description: "Security Review"`
- `subagent_type: "security-review"`

The review subagent computes the local diff from the repository path, so do not compute the diff yourself before launching it. The repository path should be the active workspace or repository root for the code the user wants reviewed.

By default, the review subagent infers the repository's actual base branch, such as `main`, when computing `branch changes`. In most cases, do not provide `Base Branch`. Only provide it if you know the current branch or PR should be compared against a specific branch other than the repository's default base branch, such as when you created the current branch from another branch.

Special case: if the user explicitly asks to review a specific PR or branch, make sure that target is checked out before launching the subagent:
- Examples include `github.com/... /review`, `review {link}`, or `review {branch-name}`.
- Resolve the provided PR link, PR number, or branch name to the PR head branch or named branch.
- Check whether the target branch is already the currently checked out local branch. If it is, continue.
- If a different branch is currently checked out, try to switch to the target branch.
- If Git refuses to switch because local files would be overwritten, conflicts need resolution, or another checkout blocker occurs, explain the blocker and ask whether the user wants to stash local changes before retrying.
- Only stash after the user confirms. If the stash succeeds, retry switching to the target branch.
- Launch the review subagent only after the target branch is checked out locally.

Use this exact prompt shape:

```text
Full Repository Path: <absolute repository path>
Diff: <one of: "branch changes", "uncommitted changes">
Base Branch: <only include this line when reviewing branch changes against a known specific base branch>
Custom Instructions: <only include this line when the user gave specific review instructions>
```

Default to `branch changes`, which reviews branch changes against the merge-base with the default/base branch, including committed, staged, and unstaged changes. If the user asks to review only uncommitted, local working tree, dirty, or not-yet-committed changes, use `uncommitted changes`.

If the review subagent fails before producing findings, inspect the failure text.

- If the failure is caused by calling the subagent incorrectly, such as a missing `Full Repository Path`, missing `Diff`, wrong prompt shape, or wrong subagent type, correct the invocation and retry it once immediately.
- For any other subagent failure, retry once with the same prompt shape.
- If the same failure persists after the retry, stop. Briefly tell the user that the review subagent could not complete and include the short error or blocker. Do not keep retrying.

After the subagent finishes, summarize the result:

- If it reports that no diff was found or the diff is empty, tell the user in one sentence that there was no diff to review.
- If it found no issues, give a one-line status such as "Security review found 2 findings / Security review found no issues".
- If it found issues, print a compact markdown table with one row per finding, sorted by severity (highest first), using exactly these columns: Severity, Location (file:line), Finding. Put the file and line in the location column as `file:line`.

Do not fix findings or rerun review unless the user explicitly asks for that next step.
