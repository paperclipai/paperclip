# Speko review qualification — 2026-10-09

Status: experimental. Deterministic checks and real-provider acceptance are separate gates.

## Review stack

- Runtime and task/session authority: PR #15727.
- Production UI and deterministic Storybook fixtures: PR #15728.
- This qualification PR adds integrated tests, protocol proof tools, visual/a11y coverage, and the E01–E16 runbook.

## Current evidence

107 targeted migration, provider, protocol, and session-store tests passed after integrating current master. Fresh installation, pre-Speko upgrade, and repeated migration application passed. Full repository typecheck and build passed on the master-integrated feature before the review repairs. The full local test run hit timeouts in workspace snapshot, runtime, runner API, and native-session suites on a heavily loaded host (load average exceeded 80); it was stopped after those failures. This is not a passing full local test result. Latest-head CI must pass independently.

Fresh review-repair evidence:

| Gate | Result | Tested source / evidence |
| --- | --- | --- |
| Durable session, authority, reply, question and admission regressions | Passed: 75 tests | Runtime 99fa4a2e85; `/tmp/speko-pr-admission-tests-current.log` |
| UI call recovery, controller and readable history after errors | Passed: 35 tests | UI dadb0f106 plus test-only TypeScript signature correction; `/tmp/speko-pr-ui-history-tests.log` |
| UI typecheck after repairs | Passed | UI 2caea58bad; `/tmp/speko-pr-ui-history-typecheck-final.log` |
| Heartbeat preparation and communication guidance | Passed: 15 tests | Runtime 174d08bc64; `/tmp/speko-pr-guidance-tests.log` |
| Proof protocol and initial report redaction | Passed: 9 tests | `/tmp/speko-pr-proof-tests.log` |
| Cleanup-failure report redaction | Passed: 2 tests | `/tmp/speko-pr-proof-redaction-final.log` |
| Token gates | Passed | Combined feature review repairs; `/tmp/speko-pr-token-final.log` |
| Storybook build / interaction / accessibility / responsive capture | Passed: 148 stories, 592 checks | Light/dark, 390/1200 width, reduced motion; `/tmp/speko-pr-storybook-checks.log` |
| Added history-error stories and affected pages | Pending fresh build and checks | Two extra stories; existing snapshots are not blanket updated |
| Integrated browser and authenticated server journeys | Retrying; pending | Real server/DB/permissions/queues/publications; only Speko and execution provider are stubbed |
| Frozen SDK dependency installation | Prepared update passes; uncommitted | UI SDK needs a 95-line root-lockfile update; repository skill exception awaits user authorization |

The combined source is preserved in feature commit f121270c8; fresh authenticated/Storybook runs use that source. Earlier integrated attempts ran the preceding feature commit with the review patches applied. Reports do not promote those runs to exact-head acceptance.

The integrated test exposed a Slack-only communication-guidance join introduced by the master refactor. The runtime repair now delivers connection guidance to Speko and retains Slack-only command hints. Browser work completed and persisted the answer during one failed attempt, but notification retrieval exceeded its test window under heavy load; the retry is tracked separately.

Latest-head PR reviews and CI are still in progress. Pending checks are not passes.

A real OpenCode/OpenRouter DeepSeek task executed in the configured Daytona sandbox, preserved low_trust_review, ran df -h, and persisted its initial update and final answer. Its 10 GB root overlay had about 9.9 GB available. The ephemeral sandbox cleanup succeeded.

The initial task update took 33.3 seconds, the final answer 44.3 seconds, and run completion 80.5 seconds from task start. These are cold sandbox timings, not speech latency. They do not meet the two-second live acknowledgment target.

## Outstanding failures and unverified behavior

The remote run succeeded but task settlement retained in_progress: its completion claim used bare comment UUIDs as evidence and supplied no durable verification reference. The status arbiter rejected that evidence. This is a runtime completion-evidence issue, not an answer or sandbox startup success.

The original call had ended before that board retry. There was no new voice reply or publication for the retry. Provider push acceptance and spoken playback were not proven. Older publication records belong to the earlier failed call and must not be used to qualify this retry.

Browser voice, inbound telephone, outbound callback, Safari/mobile playback, and 60-second delayed-result delivery need the real-provider acceptance matrix. Test fixtures do not substitute for actual audio. No new phone call, speech input, recording download, or participant audio capture is part of PR preparation.

## Evidence handling

Private call logs, provider account IDs, credentials, and transcripts remain outside these public PRs. The test harness writes new evidence to local report directories. Only consented, redacted results should be shared. Historical development reports are retained in the original feature worktree; they are not current-head proof.

See [the E2E runbook](2026-09-11-speko-voice-e2e-runbook.md) and [the component/story inventory](2026-09-11-speko-storybook-inventory.md). Keep Speko behind the existing experimental chat-connector setting until all supported real-provider journeys pass.
