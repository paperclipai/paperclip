---
name: engineering-delivery-flow
description: Enforce the Planner → Executor → Reviewer software delivery loop: isolated git worktree, reviewable PR, private preview URL, and QA evidence before merge.
key: paperclipai/bundled/software-development/engineering-delivery-flow
recommendedForRoles:
  - manager
  - engineer
  - qa
tags:
  - software-development
  - worktrees
  - pull-requests
  - preview
  - qa
---

# Engineering Delivery Flow

Use this skill whenever a Paperclip issue will modify code, data pipelines, dashboards, UI, infra, dev tooling, or any repository-managed artifact. The default delivery shape is:

```text
Planner defines workspace + acceptance → Executor works only in the worktree and opens a PR → Reviewer/QA verifies the PR and preview → Board/user reviews before merge.
```

The goal is to stop agents from quietly editing the canonical checkout, shipping unreviewed changes, or claiming success without a running artifact the user can inspect.

## Non-negotiables

1. **Never edit the canonical repo checkout for feature work.** Use an execution workspace / git worktree on a task branch.
2. **Never push directly to the base branch.** Code changes must land through a PR unless the board explicitly waives it.
3. **Never mark user-visible work done without a preview or evidence fallback.** UI, dashboard, report, and data-review changes need a private preview URL when practical. If a preview cannot be created, explain why and attach screenshot/export evidence instead.
4. **Never merge your own unreviewed work.** The reviewer/QA verdict and the board/user review gate are separate from the implementer's completion claim.

## Planner / CEO contract

Before delegating implementation, the Planner must put a **Workspace + Review Contract** in the parent plan or child issue description.

Required fields:

- **Repository:** canonical repo name/path and GitHub remote.
- **Base branch:** usually `master` or `main`.
- **Worktree / execution workspace:** where the executor must work. Prefer Paperclip execution workspace settings when available; otherwise name the expected local worktree path.
- **Task branch:** descriptive branch name with no internal/private ticket ids if the branch may be pushed publicly.
- **PR required:** yes/no. Default yes for code.
- **Preview required:** yes/no and why. Default yes for UI, dashboards, reports, data review, and anything the board should visually inspect.
- **Preview command:** exact dev/build command, env notes, and the loopback port if known.
- **Preview URL:** desired private URL or hostname. Use project-specific names when known, e.g. an HMA accounting Evidence app may use an `evidence.dev`-style private preview hostname.
- **Reviewer/QA owner:** who must verify the result.
- **Acceptance evidence:** commands, screenshots, data checks, or browser paths needed for sign-off.

If the canonical repo is already dirty, stale, or has uncommitted agent work, do **not** continue in place. Create a cleanup/migration issue first: inventory `git status`, preserve the dirty diff, move the useful patch onto a proper branch/worktree, then resume normal delivery.

## Executor contract

Before editing files, run and report:

```sh
git status --short --branch
git rev-parse --show-toplevel
git worktree list
```

Stop and ask the Planner/CTO to fix the workspace if any of these are true:

- `git rev-parse --show-toplevel` points at the canonical shared checkout instead of the assigned worktree.
- the current branch is the base branch (`main`, `master`, `develop`) rather than the task branch.
- the tree is dirty before you start and the dirty files are not explicitly part of your assigned continuation.
- there is no way to produce the required PR or preview.

When implementation is complete:

1. Commit coherent changes on the task branch.
2. Push the branch.
3. Open/update a PR using the repo PR template.
4. Include verification commands and results in the PR body.
5. If preview is required, start the managed runtime/dev server, expose it through the approved private preview route, and comment the URL.
6. Move the issue to `in_review` with PR URL, preview URL, and remaining QA steps. Do not mark `done` just because the branch exists.

## Reviewer / QA contract

QA must verify the branch from the PR/worktree and the running preview, not a stale local server.

Minimum verdict format:

```md
## QA verdict
- PR: <url>
- Preview: <url or N/A with reason>
- Commit/branch checked: <sha or branch>

### Pass
- <criterion> — evidence: <screenshot/log/command/browser path>

### Fail
- <criterion> — repro: <steps and observed result>

### Blocked
- <criterion> — blocker owner/action
```

For data apps and dashboards, QA must include at least one data-specific check (source row count, sample record, fixture, query output, or screenshot of the relevant table/chart). A pretty page with unverified data is not accepted.

## Preview rules

- Bind app servers to loopback unless the board explicitly approves wider exposure.
- Use existing Paperclip workspace runtime controls or the project's documented preview stack before starting unmanaged daemons.
- Private preview URLs are for review, not publication. Do not post them publicly or put secrets in query strings.
- The Planner owns reverse-proxy / hostname requirements; the Executor owns making the app run; QA owns proving the URL shows the intended state.

## Handoff checklist

- [ ] Planner contract exists before implementation starts.
- [ ] Executor confirmed worktree + branch before editing.
- [ ] PR exists and uses the repository template.
- [ ] Required tests/checks were run or explicitly blocked.
- [ ] Preview URL exists for user-visible work, or an evidence fallback is attached with a reason.
- [ ] Reviewer/QA posted pass/fail evidence.
- [ ] Board/user has the PR + preview for review before merge.
