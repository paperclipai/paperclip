---
phase: 2
title: Adapter core (execute / parse / runtime-config)
status: completed
priority: P1
effort: 2d
dependencies:
  - 1
---

# Phase 2: Adapter core

## Overview

Implement the runtime: spawn `qwen-code` CLI with vLLM-targeted env, parse its JSON event stream, surface paperclip adapter events, attach quota.

## Requirements

- Functional:
  - `execute()` matches `AdapterExecutionContext` → `AdapterExecutionResult` shape used by other adapters.
  - Injects `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, plus any qwen-code-required vars.
  - Streams events back to caller; supports cancellation/SIGTERM with `graceSec`.
  - Reports prompt + completion token counts via `inferOpenAiCompatibleBiller` (already used by opencode-local).
- Non-functional:
  - Each file ≤ 200 LOC (modularize per CLAUDE.md).
  - No secrets in logs; redact `OPENAI_API_KEY` value when echoing the invocation env.

## Architecture

Three modules mirror opencode-local:

1. `runtime-config.ts` — pure: build `{ env, notes, cleanup }` from agent config + execution target. Resolves `baseUrl`, `apiKey`, `model`, `variant`, `extraArgs`. Treats `dangerouslySkipPermissions` as opt-out flag for any qwen-code interactive prompts (verify exact mechanism in qwen-code docs at impl time).
2. `parse.ts` — pure stream parser. Convert qwen-code stdout (likely JSONL events; confirm via `qwen --format json` smoke test) → normalized adapter events. Helpers: `parseQwenJsonl`, `isQwenUnknownSessionError` (mirror opencode `isOpenCodeUnknownSessionError`).
3. `execute.ts` — orchestration. Resolves execution target via `adapter-utils/execution-target`, ensures CLI installed, spawns `qwen "<prompt>" -o stream-json --auth-type openai -m <model> -y --channel SDK --bare` (positional prompt; OpenAI base URL + API key passed via env, never CLI flags, to avoid leaking the secret in process listings), pipes stdout into parser, awaits completion, returns `AdapterExecutionResult` with token usage.

Streaming, session resume, remote-target plumbing all reuse `@paperclipai/adapter-utils` — copy the patterns wholesale from `packages/adapters/opencode-local/src/server/execute.ts`. Do **not** rewrite execution-target logic.

## Related Code Files

- Create:
  - `packages/adapters/qwen-local/src/server/runtime-config.ts`
  - `packages/adapters/qwen-local/src/server/parse.ts`
  - `packages/adapters/qwen-local/src/server/execute.ts`
  - `packages/adapters/qwen-local/src/server/index.ts` (export `execute`, `testEnvironment`, `sessionCodec`, `getConfigSchema`)
- Read for context:
  - `packages/adapters/opencode-local/src/server/execute.ts`
  - `packages/adapters/opencode-local/src/server/parse.ts`
  - `packages/adapters/opencode-local/src/server/runtime-config.ts`

## Implementation Steps

1. **runtime-config.ts**: Read `config.baseUrl` (required), `config.apiKey` (required, redact), `config.model` (default `DEFAULT_QWEN_LOCAL_MODEL`), `config.variant` (optional). Return `{ env: { ...input.env, OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL }, notes, cleanup: noop }`. If qwen-code requires a config file (verify), follow opencode-local's tmpdir pattern.
2. **parse.ts**: Implement `parseQwenJsonl(line: string)` returning a discriminated union of event types. Cover: text deltas, tool-call start/result, usage event (prompt/completion tokens), error, session-id. Mirror `parseOpenCodeJsonl` shape so server-side consumers don't branch.
3. **execute.ts**: Skeleton from opencode-local. Replace OpenCode-specific calls with Qwen equivalents. Spawn `qwen run --format json` with prompt, instructions, cwd, env. Use `runAdapterExecutionTargetProcess`. Wire stdout parser. On completion, call `inferOpenAiCompatibleBiller(usage, model)` to populate `result.cost` (cost can be 0 — biller still records tokens).
4. **Cancellation**: respect `timeoutSec` (default 600) + `graceSec` (default 10) — already provided by `runAdapterExecutionTargetProcess`.
5. **Logging**: build invocation log via `buildInvocationEnvForLogs` with `OPENAI_API_KEY` masked.

## Success Criteria

- [x] `pnpm -F @paperclipai/adapter-qwen-local build` green.
- [x] Local smoke: with vLLM stub running, `execute()` returns success result with token usage.
- [x] No secrets present in JSON-stringified invocation log.
- [x] All files < 200 LOC.

## Risk Assessment

- Risk: qwen-code's CLI surface differs from opencode (`qwen` vs `opencode run …`, different flags). Mitigation: hands-on `qwen --help` walkthrough at start of phase; pin version after confirming.
- Risk: tool-call event schema not OpenAI-compatible. Mitigation: parser tolerates unknown event types (warn + skip), only fails on protocol-fatal errors.
- Risk: vLLM `usage` shape varies under streaming. Mitigation: handle both end-of-stream `usage` chunk and per-chunk increments; sum if needed.
