# PR Publication Handoff

Use this process whenever one agent reviews or prepares changes and another agent is asked to publish the branch or open the PR.

## Required Handoff Fields

The handoff comment or task description must include:

- Source workspace path or branch name.
- Intended PR base branch and base commit.
- Intended head branch name.
- Exact files expected in the PR.
- Whether the change depends on unmerged commits or another PR.
- Verification commands already run, with pass/fail status.
- Any files that are intentionally workspace-only and why.

If any field is missing, the publisher must ask for it or reconstruct it before pushing.

## Publisher Procedure

1. Start from a clean branch or clean git worktree based on the intended base.
2. Apply only the reviewed diff and any explicitly named prerequisite commits.
3. Run:

```sh
scripts/check-pr-publication-readiness.sh --base <base-ref>
```

4. Confirm the output shows only intended commits and files.
5. Read `.github/PULL_REQUEST_TEMPLATE.md`, `CONTRIBUTING.md`, and `.github/workflows/pr.yml`.
6. Create the PR using the repository PR template.

## Dependency Rules

- If the reviewed change depends on an unmerged commit, create a stacked PR or publish the prerequisite first.
- Do not silently include unrelated local commits to make the diff apply.
- If the dependency is unclear, stop and post the exact missing base/dependency information to the issue.

## Never Do This

- Do not push directly from a shared dirty checkout.
- Do not include root-level agent scratch files in a PR.
- Do not mix production deployment work into a non-production publication handoff.
- Do not create a deployment issue unless the source task explicitly asks for deployment.

## Evidence to Post Back

Before marking the publication task done, post:

- PR URL.
- Base branch and head branch.
- `git log --oneline <base>..HEAD` summary.
- `git diff --name-only <base>...HEAD` summary.
- Verification commands run after creating the clean branch.
