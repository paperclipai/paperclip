# Claude Rate-Limit Fallback Investigation

Date: 2026-04-01
Repo: `C:\Users\User\paperclip`
Goal: when `claude_local` hits a real Claude Code rate limit, Paperclip must retry the same heartbeat with `codex_local`.

## Verified Provider Contracts

### Claude Code

- Official Anthropic docs confirm the headless contract: `claude --print` runs non-interactively, and `--output-format` supports `text`, `json`, and `stream-json`.
  - Source: https://docs.anthropic.com/zh-TW/docs/claude-code/sdk/sdk-headless
- Local CLI help confirms the exact flags Paperclip relies on:
  - `--print`
  - `--output-format <text|json|stream-json>`
  - `--resume`
  - `--model`
  - `--append-system-prompt-file`
  - `--add-dir`
- There is no verified doc that says Claude rate limits map to one stable exit code. The robust signal is therefore the output shape, not the exit code.

### Codex CLI

- Official OpenAI docs page for Codex CLI exists here:
  - https://developers.openai.com/codex/cli
- Local CLI help confirms the non-interactive entry point:
  - `codex exec`
- In this repo, the real adapter contract is stdin-based:
  - Paperclip runs `codex exec --json ... -`
  - prompt content is piped on stdin
  - success/failure is determined from JSONL plus exit status

## Verified Paperclip Facts

- Claude adapter path:
  - `packages/adapters/claude-local/src/server/execute.ts`
- Codex adapter path:
  - `packages/adapters/codex-local/src/server/execute.ts`
- Heartbeat fallback seam:
  - `server/src/services/heartbeat.ts`

### Claude rate-limit detection in Paperclip

- Paperclip now classifies Claude rate limits from:
  - JSON lines with `type: "rate_limit_event"`
  - JSON lines containing `rate_limit_info`
  - plain text such as `You're out of extra usage`
- This logic lives in `packages/adapters/claude-local/src/server/parse.ts`.

### Live Claude evidence from the failing run

Observed real output:

```text
{"type":"rate_limit_event", ...}
You're out of extra usage · resets Apr 4, 3am (Asia/Jerusalem)
```

Observed run outcome:

- final run `errorCode` was `adapter_failed`
- no `adapter.fallback` event was persisted
- no Codex invocation appeared

## What That Means

The fallback branch in `server/src/services/heartbeat.ts` only runs after the primary `adapter.execute(...)` resolves and the run reaches `shouldUseRateLimitFallback(...)`.

Given the live evidence above, the failure had to happen in one of these places:

1. `adapter.execute(...)` threw instead of returning a structured `AdapterExecutionResult`
2. a telemetry write immediately after `adapter.execute(...)` threw before fallback could start

The strongest post-return candidate is the event write for:

- `adapter.invoke`
- `adapter.fallback.decision`
- `adapter.fallback`

Those are operational telemetry, not correctness-critical control flow. Letting them throw can suppress a valid fallback.

## Working Rule For This Fix

Paperclip must treat adapter telemetry as best-effort around the fallback seam. A logging/event persistence failure must not prevent:

- rate-limit classification
- fallback decision
- Codex retry
- final run completion

## Verified Opus Root Cause

Blank Claude `adapterConfig.model` did not mean "Sonnet". It meant "do not pass --model", which let the local Claude Code installation choose its own configured default model.

In this environment, that local default resolved to Opus on at least one live run, which is why agents with no explicit Opus config still ran as Opus.

Fix applied:

- Claude runtime now defaults missing/blank model to `claude-sonnet-4-6`
- server-side agent create defaults now materialize `claude-sonnet-4-6` for `claude_local`
- new-agent / adapter-switch UI defaults now materialize `claude-sonnet-4-6` for `claude_local`

## Validation Loop

Use this exact live check:

```powershell
cd C:\Users\User\paperclip
npx paperclipai heartbeat run --agent-id afd391e7-1220-4c55-81a0-1fb04a3df504 --debug --timeout-ms 120000
```

Success criteria:

- run events include `adapter.fallback`
- fallback target is `codex_local`
- a later adapter invocation is for `codex_local`
- the validation issue gets `LIVE-FALLBACK-OK`

## Current Status

- Claude rate-limit parsing is fixed and covered by tests.
- Fallback config contamination is fixed and covered by tests.
- Fallback-seam telemetry is now best-effort instead of being allowed to abort failover.

## Live Validation Result

Validated on a clean server instance started from current source on `http://127.0.0.1:51716`.

Validation agent:

- id: `0a130a5e-1486-4829-ae50-6ea6d2763f5f`
- name: `Temp Fallback Validation`
- model: `claude-sonnet-4-6`
- fallback: `codex_local` with model `gpt-5.4`

Successful run proving `sonnet -> codex 5.4`:

- run id: `ebd3f12e-32a5-4f07-80d6-59b4661370cb`
- result: `succeeded`

Observed live sequence:

1. Claude emitted:
   - `type: "rate_limit_event"`
   - `You're out of extra usage · resets Apr 4, 3am (Asia/Jerusalem)`
2. Paperclip emitted:
   - `adapter.fallback.decision`
   - `adapter.fallback`
   - log line: `claude_local hit a rate limit; retrying this heartbeat with codex_local.`
3. Codex executed:
   - `codex exec --json --model gpt-5.4 --skip-git-repo-check -`
4. Codex returned:
   - `LIVE-FALLBACK-OK`
5. Heartbeat finished:
   - `run succeeded`

That satisfies the fallback DoD: a real Claude rate-limit in Paperclip triggered a live retry with Codex and the run completed successfully.

## Existing Agent Normalization

To stop non-explicit agents from inheriting Opus from the local Claude CLI, existing blank-model Claude agents in the shared instance were normalized to explicit Sonnet:

- `754f0eda-f5f5-4bb0-8b99-b441d51a9e0a` `Dev Agent — Plugins`
- `205a0623-5586-4b61-9ffd-4a37c952890a` `Career Monitor`
- `7f688d51-cf70-495b-806e-e672e7175da6` `Dev Agent — Open source`
- `afd391e7-1220-4c55-81a0-1fb04a3df504` `Visibility Agent`
- `99d9d47a-dd68-4070-8851-dfaa075c7e6b` `Operations Lead`

Example post-normalization evidence:

- `Visibility Agent` now has `adapterConfig.model = "claude-sonnet-4-6"` on the clean server.

## Residual Notes

- The older long-lived server on port `3100` had process/watcher ambiguity and produced inconsistent live behavior during debugging.
- The clean instance on `51716` is the run that should be treated as authoritative validation for this fix.
