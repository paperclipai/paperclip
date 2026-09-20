# GitHub review bot live acceptance — 2026-09-20

The user authorized unattended testing on the disposable private repository,
including a Storybook bot whose review fails unless a rendered story page says
`oogabooga`. Continue from the approved implementation; do not pause for another
design approval. Use the embedded browser for user journeys and real signed
GitHub deliveries with actual Paperclip agent runs for execution evidence.

## User stories and acceptance

1. As a member, I connect my own GitHub identity and confirm it. My requests
   identify me as the responsible person; the agent uses the bot App's governed
   tools, never my credentials for review publication.
2. I mention the bot on an issue. A real task/run is assigned to its permanent
   agent and a reply appears on GitHub. A second mention continues the task.
3. I open a PR containing a known defect. The configured event starts a normal
   task/run, publishes a justified finding and summary, and fails Paperclip Review
   on the exact head commit. I can follow links to the task and run.
4. I ask for another review by mentioning the bot again. A new run reassesses the
   current commit without creating another root conversation/task or duplicate
   inline findings. Ordinary discussion does not change the rating.
5. I push a fix with updated-commit reviews enabled. A new assessment passes and
   supersedes the old result, preserving review history.
6. I select mentions-only, or disable updated-commit events. A push does not run
   an automatic review or inherit a passing check from an older commit. An
   authorized mention still starts a review. Re-enabling the event restores
   automatic review on the next push.
7. I configure a Storybook bot with trusted instructions to generate/build
   Storybook from the PR's page components and inspect rendered story pages.
   Source comments, PR prose, story names, or instructions mentioning `oogabooga`
   are not evidence; the text must be visible in a rendered page. If absent the
   structured assessment is complete but fails; if present it passes. A build or
   verification failure is incomplete and cannot pass.
8. For that bot, absent → present → absent commits produce failing → passing →
   failing checks. Repeat mentions also recheck the PR. Generated Storybook and
   page inspection evidence are attached to the underlying task/run.
9. Draft filters, prompt changes, repository restrictions, tool denials,
   duplicate delivery, rapid pushes, stale publication, retries, and guest
   restrictions preserve their configured authority and exact-head semantics.
10. Formal approval/request-changes is rejected while disabled and accepted
    through the governed tool only when explicitly enabled; scoring 5/5 alone
    never approves a PR. Required checks are enforced on the disposable repo.
11. After local qualification, deploy matching application/migrator and Cloud
    gateway revisions to a dedicated staging tenant, and repeat the real signed
    webhook and agent workflow through its vanity hostname.

## Evidence rules

Record actual source revisions, heads, delivery IDs, task/run IDs and links to
comments, reviews, checks, and generated stories. Distinguish real runs from
fixtures and deterministic tests. Never publish a result manually and count it
as an agent run. Keep failures and repairs in the log; do not infer a live pass
from unit tests or setup verification. No production rollout or merge.

## Journey log

- Embedded browser refreshed successfully; form controls respond again.
- Existing personal GitHub flow entered from the catalog. Access limited to the
  QA agent. Approved the isolated QA instance's normal Cloud connector enrollment;
  the preserved flow resumed the GitHub sign-in step.

## Live results: basic channel and initial PR (September 20)

- Existing personal GitHub OAuth enrollment and explicit identity confirmation succeeded in the embedded browser. Linked `cryppadotta` (`34892728`) to QA member `github-review-qa-member`. Removed the personal connection's agent installation/profile binding afterward; the agent retains only the bot App GitHub tools.
- Issue [#1](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/issues/1) created ordinary task `GIT-1` (`4c5719a2-b6bd-48d7-8569-458bf46b940f`) with the assigned agent and responsible user. Initial QA model `gpt-5.4` was unsupported by the signed-in Codex account; changed the fixture agent to available `gpt-5.6-sol` through the normal agent API.
- Mention run `0ba64bf7-b186-402e-8b4a-6c4f8c37212b` succeeded and published [basic acknowledgment](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/issues/1#issuecomment-5749595583). A subsequent mention after completion ran `6005793d-73df-4ed1-986f-eea2a4eea823` on the same task.
- Opened private [PR #2](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/2) through the embedded browser. Its `opened` webhook created `GIT-2` (`5d9e3779-d003-4937-a329-cd262b4e835f`), run `fc039950-2c34-4611-9f44-0326836a7e7e`, review projection `d4542409-aed4-4051-be60-af725f8575f0`, and [Paperclip Review check](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/runs/106073096927) for exact head `76028b764e77f2491c66944a75302febebbd3bfb`.
- The agent discovered/invoked bot `read_pull_request`, `read_file`, `submit_review`, and `comment`. It independently found the seeded percentage conversion bug, scored it 3/5, and documented test limitations honestly. **Structured publication failed:** coverage listed unchanged context files; on retry, a limitation exceeded the undisclosed 256-character bound. The check correctly ended `action_required`, never passed. Plain comments do not count as successful review publication.
- Fixed tool discovery to derive the submission schema from the shared input validator, expose all bounds, document changed-file coverage, and instruct correction/retry. Invalid inputs now return actionable 400 errors and mismatched heads return 409 instead of 500. Focused policy tests: 12 passed. Server typecheck passed.
- Restarted the isolated server and saved configuration revision 3 to refresh tool discovery. Posted [retry mention](https://github.com/cryppadotta/paperclip-github-review-qa-20260919/pull/2#issuecomment-5749639940) via `gh` after embedded-browser form actions repeatedly left an unsent draft. Browser inspections still work; this specific submission is API-driven and is not claimed as a successful browser submit.
