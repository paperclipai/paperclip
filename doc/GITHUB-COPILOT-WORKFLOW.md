# GitHub Copilot Delegation Workflow

This workflow is for piloting GitHub Copilot as a bounded GitHub-native accelerator. Use it for small, clear implementation issues and review-thread fixes. Do not use it as an autonomous merge path.

## When To Assign Copilot

Use Copilot when:

- The work is already captured in a GitHub issue or PR review thread.
- The scope is small and local, such as docs, tests, contained bug fixes, or simple UI/API adjustments.
- The expected output is a pull request with a clear validation path.
- The task benefits from GitHub-native context or review-thread iteration.

Use Paperclip agents instead when work needs company context, goal decomposition, issue dependencies, approvals, cross-agent delegation, local operational context, product judgment, architecture changes, schema/API contract changes, auth/security work, release changes, or budget/governance decisions.

## Implementation Prompt Template

```md
Objective: [one concrete change]

Repository context:
- Read `AGENTS.md`, `CONTRIBUTING.md`, and `.github/PULL_REQUEST_TEMPLATE.md` first.
- Preserve company scoping, API contracts, activity logging, and existing test patterns.
- Keep the change small; do not refactor unrelated code.

Scope:
- Change only: [files/modules or behavior boundary]
- Do not change: [explicit exclusions]

Acceptance criteria:
- [observable behavior]
- [tests/docs expected]
- [compatibility or security constraint]

Verification:
- Run the smallest relevant command first: `[command]`.
- If broader confidence is needed, run `[command]`.
- Include exact commands and results in the PR body.

PR requirements:
- Use `.github/PULL_REQUEST_TEMPLATE.md` completely.
- Fill Model Used with GitHub Copilot cloud agent and selected model.
- Request Copilot code review only as advisory feedback.
- Do not merge until human/Paperclip review and required checks pass.
```

## Review-Thread Fix Prompt

```md
@copilot Please address the review feedback in this thread only.

Constraints:
- Keep the fix minimal and local to the reviewed issue.
- Do not address unrelated comments or perform broad cleanup.
- Preserve existing behavior unless the review explicitly asks for a behavior change.
- After changes, run `[targeted verification]` and report the result.
- If the requested fix conflicts with repo instructions or requires product/architecture judgment, stop and explain the blocker instead of guessing.
```

## Quality Gates

Before merge, every Copilot-authored PR must have:

- `.github/PULL_REQUEST_TEMPLATE.md` filled in completely, including Model Used.
- Targeted verification recorded with exact commands and results.
- Required CI green.
- Greptile score 5/5 with all Greptile comments addressed.
- Review from a human maintainer or Paperclip reviewer.
- Extra maintainer scrutiny for `.github/**`, workflow, dependency, auth, secrets, database, release, Docker, and permission changes.

Copilot code review is advisory. It does not satisfy required approval rules.

For Copilot-authored PRs that touch workflow files, inspect the diff before approving any GitHub Actions run. Treat any request for secrets, credentials, privileged settings, organization policy changes, dependency upgrades, or broad refactors as an escalation to the CTO or repository admin.

## Follow-Up Comments

Use `@copilot` follow-up comments only when the requested change is local to a specific issue or review thread. Include the verification command in the comment. Do not ask Copilot to resolve multiple unrelated review comments in one prompt.

If Copilot cannot run verification, gets a failing result it cannot resolve locally, or proposes work outside the prompt scope, take the PR back to a Paperclip engineer or maintainer.

## Repository Setup Notes

- Repository-wide Copilot instructions live in `.github/copilot-instructions.md`.
- Path-specific instructions live in `.github/instructions/*.instructions.md` and should stay focused on high-risk areas.
- The constrained Paperclip engineering profile lives in `.github/agents/paperclip-engineer.agent.md`.
- Keep Copilot Actions runs manually reviewed during the pilot, especially for workflow changes that could access privileged secrets.

Reference docs:

- [Adding repository custom instructions for GitHub Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)
- [Creating custom agents for Copilot cloud agent](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents)
- [Custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [Using GitHub Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)
