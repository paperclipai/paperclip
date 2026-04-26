# Claude Rate-Limit Fallback Investigation

Date: 2026-04-01
Repo: `C:\Users\User\paperclip`
Goal: when `claude_local` hits a real Claude Code rate limit, Paperclip must retry the same heartbeat with `codex_local`.

## Current Extension Goal

Extend the single-target Claude rate-limit fallback into an ordered fallback chain so Paperclip can try:

1. `codex_local`
2. `gemini_local` (Gemini CLI)
3. a Gemini 3.1 Pro preset for the final fallback slot

The last slot is intentionally modeled as a Gemini-family fallback, not a separate first-class Antigravity adapter, unless we verify an official headless Antigravity CLI contract.

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

### Gemini CLI

- Official Gemini CLI docs:
  - https://google-gemini.github.io/gemini-cli/
- Local CLI help confirms the headless contract Paperclip already relies on:
  - `--prompt`
  - `--model`
  - `--resume`
  - `--output-format <text|json|stream-json>`
  - `--approval-mode`
- Local environment fact on 2026-04-01:
  - `gemini --version` returned `0.35.3`
  - headless execution is installed, but the current local environment is unstable
  - `auto` currently routes to `gemini-3.1-flash-lite-preview` and returns `ModelNotFoundError`
  - explicit `gemini-3.1-pro` also returned `ModelNotFoundError`

### Antigravity

- Official Google Antigravity onboarding docs are available via Google Codelabs:
  - https://codelabs.developers.google.com/getting-started-google-antigravity
- Verified product facts from the official Codelab:
  - Antigravity is a locally installed agent-first IDE/platform
  - setup includes an optional `agy` command-line opener
  - model selection happens inside the Antigravity UI
- What we did **not** verify:
  - no official headless/non-interactive Antigravity CLI contract
  - no official `--prompt` / `--output-format` equivalent for autonomous terminal invocation
- Working rule:
  - do not invent an `antigravity_local` adapter without a documented headless contract
  - represent the requested "antigravity (gemini 3.1 pro)" slot as a Gemini-family preset unless official docs prove otherwise

### Gemini 3.1 Pro model existence

- Official Google DeepMind model cards list `Gemini 3.1 Pro` as of 2026-02-19:
  - https://deepmind.google/models/model-cards/
- That proves the model exists at the platform level.
- It does **not** prove this local Gemini CLI installation/account can invoke it successfully today.

## Verified Paperclip Facts

- Claude adapter path:
  - `packages/adapters/claude-local/src/server/execute.ts`
- Codex adapter path:
  - `packages/adapters/codex-local/src/server/execute.ts`
- Heartbeat fallback seam:
  - `server/src/services/heartbeat.ts`
- Existing Gemini local adapter:
  - `packages/adapters/gemini-local/src/server/execute.ts`
- There is no existing `antigravity` adapter or integration anywhere in this repo.

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

For the extension work:

- Fallback configuration must be ordered, not singular.
- Existing single-target `rateLimitFallback` config must remain readable for backward compatibility.
- Additional fallback slots should reuse registered adapters when possible.
- Do not ship a fake Antigravity adapter with undocumented flags.

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
- Codex now appends `--skip-git-repo-check` by default when the user did not provide it.
- Fallback adapters now support user-configurable `model`, `command`, `extra args`, `timeoutSec`, and `graceSec` from the chain editor.

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

## Real `:3100` Validation Result

The long-lived real server on `http://127.0.0.1:3100` was initially stale and failed the fallback path again.

Failed stale run:

- run id: `ee7534a5-ff49-4971-b841-d9401e0e1229`
- Claude emitted a real `rate_limit_event`
- no `adapter.fallback` event was emitted
- run finished `failed`

After killing the stale `3100` listener and restarting the real server from repo commit `9015595f`, the same live validation passed on `3100`.

Successful real-server run:

- run id: `282b1606-302d-460d-84ef-11124cae8c29`
- event stream included:
  - `adapter.fallback.decision`
  - `adapter.fallback`
  - `adapter.invoke` for `codex_local`
- Codex command:
  - `codex exec --json --model gpt-5.4 --skip-git-repo-check -`
- Codex returned:
  - `LIVE-FALLBACK-OK`
- run finished:
  - `succeeded`

That is the authoritative proof that the committed Sonnet -> Codex fallback fix is now active on the real `:3100` server.

## Additional Real `:3100` Validation

Validation agent stayed the same:

- id: `0a130a5e-1486-4829-ae50-6ea6d2763f5f`
- name: `Temp Fallback Validation`

### Proven `sonnet -> codex` on the current workspace state

Successful run:

- run id: `6607c82e-8cab-42c2-8103-bec39e7f4aac`
- result: `succeeded`

Observed live sequence:

1. Claude invoked with:
   - `--model claude-sonnet-4-6`
2. Claude emitted:
   - `type: "rate_limit_event"`
   - `You're out of extra usage · resets Apr 4, 3am (Asia/Jerusalem)`
3. Paperclip emitted:
   - `adapter.fallback.decision`
   - `adapter.fallback`
4. Codex invoked with:
   - `codex exec --json --model gpt-5.4 --skip-git-repo-check -`
5. Codex returned:
   - `LIVE-FALLBACK-OK`
6. Run finished:
   - `succeeded`

This confirms the Codex default is now safe even when the fallback config does not explicitly include `--skip-git-repo-check`.

### Proven chained fallback `sonnet -> codex failure -> gemini`

First attempt exposed a real operational lesson:

- run id: `01ed06a2-f08d-4c59-9fde-0b61f9d30298`
- Claude rate-limited
- Codex was intentionally configured as `codex-missing`
- Gemini executed and produced `LIVE-FALLBACK-OK`
- the run still finished `timed_out`

Why that happened:

- Gemini inherited a `timeoutSec: 60` budget
- the Gemini step crossed that timeout budget in this environment
- so the chain worked, but the run budget was too small

Follow-up fix and product implication:

- fallback-specific `timeoutSec` / `graceSec` must be user-configurable
- the fallback-chain editor now exposes those values

Successful chained validation after raising only the Gemini fallback timeout:

- run id: `4640f38f-8e35-45e3-9d67-2731f84776c9`
- result: `succeeded`

Observed live sequence:

1. Claude invoked with:
   - `--model claude-sonnet-4-6`
2. Claude emitted a real rate-limit event
3. Paperclip emitted:
   - `adapter.fallback.decision` for `codex_local`
   - `adapter.fallback` for `codex_local`
4. Codex was intentionally configured as:
   - `command: codex-missing`
5. Paperclip emitted:
   - `error: Command not found in PATH: "codex-missing"`
   - `adapter.fallback.decision` for `gemini_local`
   - `adapter.fallback` with message `codex_local failed; retrying with gemini_local`
6. Gemini invoked with:
   - `--output-format stream-json`
   - `--model gemini-2.5-flash`
   - `--approval-mode yolo`
   - `--sandbox=none`
   - `--prompt ""`
   - prompt content on stdin
7. Gemini returned:
   - `LIVE-FALLBACK-OK`
8. Run finished:
   - `succeeded`

That is the current authoritative proof on the real `:3100` server that:

- Claude Sonnet rate limit -> Codex fallback works
- a failed Codex fallback correctly advances to Gemini
- Gemini CLI fallback now succeeds in Paperclip

## Warning Log Root Cause And Fix

The remaining warning observed on successful Codex fallback runs was not a fallback-control-flow problem.

Observed warning text:

- `failed to load skill C:\Users\User\paperclip\skills\tradingview\SKILL.md: missing YAML frontmatter delimited by ---`

Root cause:

- `skills/tradingview/SKILL.md` was the only local skill in the Paperclip repo missing the YAML frontmatter required by the local skill loader
- Codex stderr was surfacing that skill-loader warning during fallback runs

Fix applied:

- added valid YAML frontmatter to `skills/tradingview/SKILL.md`

Live proof after the fix on the real `:3100` server:

- run id: `ebbdcb71-0abf-41ba-8547-1ed3ce862e18`
- result: `succeeded`
- Claude emitted a real rate-limit event
- Codex invoked with:
  - `codex exec --json --model gpt-5.4 --skip-git-repo-check -`
- `stderrExcerpt` was empty
- `resultJson.stderr` was empty

That proves the warning was eliminated without regressing the Codex fallback path.

## Transcript Readability Root Cause And Fix

User-visible symptom:

- fallback runs had unreadable stdout in both `pretty` and `raw` modes on the run detail page

Root cause on the run detail page:

- the UI was selecting the transcript parser from the agent's configured adapter type
- after fallback, persisted stdout was emitted by a different adapter (`codex_local` or `gemini_local`)
- the run page therefore parsed fallback output with the wrong parser
- `raw` mode was also not truly raw; it rendered already-parsed transcript entries instead of the persisted log chunks

Fix applied:

- `ui/src/pages/AgentDetail.tsx`
  - use the latest `adapter.invoke` payload for adapter detail display
  - build an adapter-invocation timeline from persisted `adapter.invoke` events
  - resolve the stdout parser per log chunk timestamp so fallback segments use the correct adapter parser
  - render true persisted `logLines` in `raw` mode instead of parsed transcript entries
- `ui/src/adapters/transcript.ts`
  - added `resolveStdoutParser(ts)` support so parsing can switch parsers across fallback boundaries
- `ui/src/adapters/transcript.test.ts`
  - added coverage for timestamp-based parser switching

Verification:

- `pnpm exec tsc --noEmit`
- `pnpm exec vitest run ui/src/adapters/transcript.test.ts ui/src/components/transcript/RunTranscriptView.test.tsx server/src/__tests__/gemini-local-execute.test.ts server/src/__tests__/heartbeat-rate-limit-fallback.test.ts server/src/__tests__/heartbeat-fallback-chain-execution.test.ts`

Important scope note:

- this transcript fix is applied to the full run detail page
- the live dashboard widgets still use `ui/src/components/transcript/useLiveRunTranscripts.ts`, which currently parses each run with a single adapter parser
- if fallback transcript readability is also broken in the live widgets, that needs a separate hardening pass

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
