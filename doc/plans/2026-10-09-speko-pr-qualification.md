# Speko review qualification — 2026-10-09

Status: experimental. Deterministic checks and real-provider acceptance are separate gates.

## Review stack

- Runtime and task/session authority: PR #15727.
- Production UI and deterministic Storybook fixtures: PR #15728.
- This qualification PR adds integrated tests, protocol proof tools, visual/a11y coverage, and the E01–E16 runbook.

## Current evidence

107 targeted migration, provider, protocol, and session-store tests passed after integrating current master. Fresh installation, pre-Speko upgrade, and repeated migration application passed. Full typecheck, test, build, browser, and Storybook gates are being rerun for the prepared stack; pending checks are not passes.

A real OpenCode/OpenRouter DeepSeek task executed in the configured Daytona sandbox, preserved low_trust_review, ran df -h, and persisted its initial update and final answer. Its 10 GB root overlay had about 9.9 GB available. The ephemeral sandbox cleanup succeeded.

The initial task update took 33.3 seconds, the final answer 44.3 seconds, and run completion 80.5 seconds from task start. These are cold sandbox timings, not speech latency. They do not meet the two-second live acknowledgment target.

## Outstanding failures and unverified behavior

The remote run succeeded but task settlement retained in_progress: its completion claim used bare comment UUIDs as evidence and supplied no durable verification reference. The status arbiter rejected that evidence. This is a runtime completion-evidence issue, not an answer or sandbox startup success.

The original call had ended before that board retry. There was no new voice reply or publication for the retry. Provider push acceptance and spoken playback were not proven. Older publication records belong to the earlier failed call and must not be used to qualify this retry.

Browser voice, inbound telephone, outbound callback, Safari/mobile playback, and 60-second delayed-result delivery need the real-provider acceptance matrix. Test fixtures do not substitute for actual audio. No new phone call, speech input, recording download, or participant audio capture is part of PR preparation.

## Evidence handling

Private call logs, provider account IDs, credentials, and transcripts remain outside these public PRs. The test harness writes new evidence to local report directories. Only consented, redacted results should be shared. Historical development reports are retained in the original feature worktree; they are not current-head proof.

See [the E2E runbook](2026-09-11-speko-voice-e2e-runbook.md) and [the component/story inventory](2026-09-11-speko-storybook-inventory.md). Keep Speko behind the existing experimental chat-connector setting until all supported real-provider journeys pass.
