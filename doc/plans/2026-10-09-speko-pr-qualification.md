# Speko review qualification — 2026-10-09

Status: experimental. Deterministic checks and real-provider acceptance are separate gates.

## Review stack

- Runtime and task/session authority: PR #15727.
- Production UI and deterministic Storybook fixtures: PR #15728.
- This qualification PR adds integrated tests, protocol proof tools, visual/a11y coverage, and the E01–E16 runbook.

## Current evidence

107 targeted migration, provider, protocol, and session-store tests passed after integrating current master. Fresh installation, pre-Speko upgrade, and repeated migration application passed. Full repository typecheck and build passed on the master-integrated feature before the review repairs. The full local test run hit timeouts in workspace snapshot, runtime, runner API, and native-session suites on a heavily loaded host (load average exceeded 80); it was stopped after those failures. This is not a passing full local test result. Latest-head CI must pass independently. The final stack includes runtime 82a96b128d; UI 43be85d01 was fully green before inheriting this test-only fixture change. The final original-feature checkpoint is 720379c17.

Fresh review-repair evidence:

| Gate | Result | Tested source / evidence |
| --- | --- | --- |
| Durable session, authority, reply, question and admission regressions | Passed: 75 tests | Runtime 99fa4a2e85; `/tmp/speko-pr-admission-tests-current.log` |
| UI call recovery, controller and readable history after errors | Passed: 35 tests | UI dadb0f106 plus test-only TypeScript signature correction; `/tmp/speko-pr-ui-history-tests.log` |
| UI typecheck after repairs | Passed | UI 2caea58bad; `/tmp/speko-pr-ui-history-typecheck-final.log` |
| Post-master migration upgrade/replay and heartbeat scheduling/preparation | Passed: 27 tests | Runtime bf1ead3772; `/tmp/speko-pr-post-master-tests.log` |
| Server typecheck after master integration | Passed | Runtime bf1ead3772; `/tmp/speko-pr-post-master-typecheck.log` |
| Heartbeat preparation and communication guidance | Passed: 15 tests | Runtime 174d08bc64; `/tmp/speko-pr-guidance-tests.log` |
| Proof protocol and initial report redaction | Passed: 9 tests | `/tmp/speko-pr-proof-tests.log` |
| Cleanup-failure report redaction | Passed: 2 tests | `/tmp/speko-pr-proof-redaction-final.log` |
| Token gates | Passed | Combined feature review repairs; `/tmp/speko-pr-token-final.log` |
| Storybook build / interaction / accessibility / responsive capture | Passed: 148 stories, 592 checks | Light/dark, 390/1200 width, reduced motion; `/tmp/speko-pr-storybook-checks.log` |
| Added history-error stories and affected pages | Passed: 188 checks | Fresh 150-story build; `/tmp/speko-pr-storybook-affected.log`; two secondary-error stories included |
| Task voice request error/retry and active-control preservation | Passed: 3 regressions, UI typecheck and token gates | UI 845e622b06; `/tmp/speko-pr-task-launcher-tests.log`, `/tmp/speko-pr-task-launcher-typecheck.log`, `/tmp/speko-pr-task-token.log` |
| Bounded notification fetch and request coalescing recovery | Passed: 13 API tests | UI 38057142bb; `/tmp/speko-pr-notification-timeout-tests.log` |
| Multipart answer delivery, ordering and Backlog admission | Passed: 78 persistence tests and server typecheck | Runtime 04a69ea6a; `/tmp/speko-pr-ordered-persistence-final.log`, `/tmp/speko-pr-runtime-exact-final-typecheck.log` |
| Final UI request recovery and footer | Passed: 6 regressions, typecheck, token gates; 2 focus assertions rerun | `/tmp/speko-pr-ui-review-final-tests.log`, `/tmp/speko-pr-ui-review-final-typecheck.log`, `/tmp/speko-pr-ui-review-token-final.log`, `/tmp/speko-pr-incoming-focus-tests.log` |
| Final setup, task launcher and incoming-call recovery stories | Passed: 153-story build, 220 affected checks | UI 43be85d01 with runtime 04a69ea6a; `/tmp/speko-pr-storybook-all-review-final.log`, `/tmp/speko-pr-storybook-all-review-checks.log`; no unrelated baseline updates |
| Authenticated E03/E14 isolation and revocation | Passed: 1 journey | Feature f121270c8; `/tmp/speko-pr-authenticated-final.log` |
| Integrated browser/phone journeys | Two passed; main journey failed in latest retry | `/tmp/speko-pr-integrated-startup-budget-final.log`; initial browser transcript did not retrieve saved answers. Execution and publication success do not supersede the visible delivery failure. Earlier successful portions are historical. |
| Frozen SDK dependency installation | Prepared update passes; uncommitted | UI SDK needs a 95-line root-lockfile update; repository skill exception awaits user authorization |

The master-integrated combined source is preserved in feature commit 134d5b67c (origin/master 98e3cec78e); the successful authenticated run used the prior feature commit f121270c8. Speko migrations are now 0323–0329 after master added 0322. Earlier integrated attempts ran the preceding feature commit with the review patches applied. Reports do not promote those runs to exact-head acceptance.

The integrated test exposed a Slack-only communication-guidance join introduced by the master refactor. The runtime repair now delivers connection guidance to Speko and retains Slack-only command hints. The post-master fixture completed the benchmark in 66.9 seconds and saved approved replies; its browser trace showed the last notification GET stayed in flight until the assertion expired. UI 38057142bb adds a ten-second fetch deadline, with an abort-and-next-poll recovery test. A subsequent fresh run retrieved delayed browser answers, resumed work, answered structured questions, recovered across restart and invoked the assigned outbound-call tool; its inbound execution assertion failed because the fixture selected a Backlog task, which the execution gate correctly refused. The fixture now selects a Todo task, and submit_request immediately rejects Backlog work with an actionable message. The next fresh run retrieved browser replies but failed its 60-second restart-evidence assertion; the new app later served both shorter journeys, which passed (`/tmp/speko-pr-integrated-reviewed-final.log`). Restart now uses the same 120-second startup budget as initial fixture boot, retaining the process-ID and recovery assertions. The final fresh retry failed earlier at the initial browser-answer assertion (100 seconds); both shorter journeys passed (`/tmp/speko-pr-integrated-startup-budget-final.log`). Its synthetic runtime persisted two approved replies, but neither was retrieved in the browser. The request trace shows notification requests returning null, followed by a request at 21:45:57 UTC that remained unfinished through failure; the loaded production bundle contains the ten-second fetch deadline. This remains an unresolved integration failure; host contention alone is not a demonstrated cause. No inbound-push or restart qualification is claimed for this attempt. A local 600-second overall budget is used on this contended host; the repository 360-second default remains unchanged. Healthy-provider timing targets remain independently unqualified. A further retry reused the previous provider fixture and failed setup, so it is not acceptance evidence. Temporary test services were shut down without changing the saved user instance.

The new long-answer repair splits provider messages at 16,000 UTF-16 code units without cutting surrogate pairs, persists each part receipt, resumes known rate-limit failures, and blocks polling from replaying an accepted prefix. The 77-test persistence suite initially hit its explicit 30-second database startup hook before any assertions ran on the loaded host. It now uses the repository’s documented embedded-Postgres test startup budget. All 77 tests passed on runtime a7002737b, including multipart rate-limit/restart and unknown-outcome regressions and protection against polling replay of an accepted prefix (`/tmp/speko-pr-multipart-persistence-final.log`). Server typecheck passed (`/tmp/speko-pr-multipart-final-typecheck.log`).

Runtime 04a69ea6a received Greptile 5/5 with no unresolved review threads, and its CI typecheck/build passed. A chat-retry browser shard failed its authorization-denial feedback assertion twice on runtime 04a69ea6a. Runtime 82a96b128d begins that fixture directly on the canonical agent route, preserving authority and visible-error assertions. Its three-repeat local verification was blocked before tests ran by the 120-second server startup timeout (`/tmp/speko-pr-chat-retry-canonical.log`); fresh CI is pending. UI 43be85d01 passed its ordinary CI tests/build/Canary and received Greptile 5/5; its SDK frozen-lockfile finding remains open. Pending checks are not passes. The SDK frozen-lockfile review finding remains open pending user authorization for the repository-skill exception.

A real OpenCode/OpenRouter DeepSeek task executed in the configured Daytona sandbox, preserved low_trust_review, ran df -h, and persisted its initial update and final answer. Its 10 GB root overlay had about 9.9 GB available. The ephemeral sandbox cleanup succeeded.

The initial task update took 33.3 seconds, the final answer 44.3 seconds, and run completion 80.5 seconds from task start. These are cold sandbox timings, not speech latency. They do not meet the two-second live acknowledgment target.

## Outstanding failures and unverified behavior

The remote run succeeded but task settlement retained in_progress: its completion claim used bare comment UUIDs as evidence and supplied no durable verification reference. The status arbiter rejected that evidence. This is a runtime completion-evidence issue, not an answer or sandbox startup success.

The original call had ended before that board retry. There was no new voice reply or publication for the retry. Provider push acceptance and spoken playback were not proven. Older publication records belong to the earlier failed call and must not be used to qualify this retry.

Browser voice, inbound telephone, outbound callback, Safari/mobile playback, and 60-second delayed-result delivery need the real-provider acceptance matrix. Test fixtures do not substitute for actual audio. No new phone call, speech input, recording download, or participant audio capture is part of PR preparation.

## Evidence handling

Private call logs, provider account IDs, credentials, and transcripts remain outside these public PRs. The test harness writes new evidence to local report directories. Only consented, redacted results should be shared. Historical development reports are retained in the original feature worktree; they are not current-head proof.

See [the E2E runbook](2026-09-11-speko-voice-e2e-runbook.md) and [the component/story inventory](2026-09-11-speko-storybook-inventory.md). Keep Speko behind the existing experimental chat-connector setting until all supported real-provider journeys pass.
