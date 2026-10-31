## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work.
> - Contributors need predictable CI feedback.
> - Test shards use historical per-file costs to distribute their work.
> - New and changed tests make those costs stale.
> - This automated PR refreshes the costs from successful protected-master runs.
> - The refresh changes placement, while preserving test inventory and runner authorization.

## Linked Issues or Issue Description

**What happened?**

Test costs changed after the last timing refresh. Each manifest records the source runs and measurement coverage.

**Expected behavior**

Parallel test jobs should have similar workloads. Timing metadata must never authorize skipping tests.

**Steps to reproduce**

Run `node scripts/ci/refresh-test-durations.mjs` with GitHub Actions read access and a full master checkout.

## What Changed

- Refresh general-server and serialized timing weights from recent successful master verification runs.

## Verification

- The collector validates repository, workflow, branch, event, attempt, successful jobs, commit ancestry and measurement coverage.
- Timing validation and full shard coverage tests pass before this branch is pushed.
- Review the source run links and coverage recorded in both manifests.
- Required PR checks and review must pass before merge. GitHub may require approval to start checks for a PR created with `GITHUB_TOKEN`.

## Risks

- Runner load can distort measurements. Medians reduce this noise. Missing measurements retain previous weights.
- The changes affect balance, not which tests execute. There is no automatic merge or AWS authorization change.

## Model Used

- No model ran this refresh. The generator was authored with OpenAI Codex (GPT-6); exact deployment ID and context window were not exposed. It uses code execution and repository inspection.

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work (routine CI timing maintenance)
- [x] I have searched GitHub for duplicate or related PRs (the workflow pauses while a refresh PR is open)
- [x] I have described the issue in-PR following the bug issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links
- [x] My branch name describes the change and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run the relevant timing and shard tests and they pass
- [x] I have added or updated tests where applicable (existing timing and shard tests cover these generated values)
- [x] I have updated relevant documentation (the manifests record source runs and coverage)
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [x] I will address all Greptile and reviewer comments before requesting merge
