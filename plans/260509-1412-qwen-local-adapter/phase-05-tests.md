---
phase: 5
title: Tests
status: completed
priority: P1
effort: 1d
dependencies:
  - 2
  - 3
  - 4
---

# Phase 5: Tests

## Overview

Vitest unit + remote integration tests covering parser, runtime-config, models validation, and a gated end-to-end run against a real DGX vLLM endpoint.

## Requirements

- Unit tests run on plain `pnpm test` (no network).
- Remote integration test gated behind env var `QWEN_LOCAL_BASE_URL` + `QWEN_LOCAL_API_KEY`; skips cleanly when unset.
- Parser tests cover happy path, malformed JSON line, unknown event types, and `usage` aggregation.
- Concurrency smoke: a test that fires 20 parallel `execute()` calls against a stub server (or live vLLM if env set) and asserts all complete.

## Architecture

Match opencode-local layout under `src/server/`. Tests colocated with the modules they cover. Use `vitest` with no extra runners.

## Related Code Files

- Create:
  - `packages/adapters/qwen-local/src/server/parse.test.ts`
  - `packages/adapters/qwen-local/src/server/runtime-config.test.ts`
  - `packages/adapters/qwen-local/src/server/models.test.ts`
  - `packages/adapters/qwen-local/src/server/execute.remote.test.ts` (gated)
  - `packages/adapters/qwen-local/src/server/test.ts` (adapter-level smoke wrapper, mirrors opencode `test.ts`)
- Read: corresponding `*.test.ts` files in opencode-local for fixture style.

## Implementation Steps

1. **parse.test.ts**: feed canned JSONL fixtures (capture from a real `qwen run --format json` once during impl). Assert event normalization. Include negative cases (truncated line, non-JSON, error event).
2. **runtime-config.test.ts**: assert env injection contains all three `OPENAI_*` keys; assert apiKey not leaked into `notes`; assert defaults for missing optional fields.
3. **models.test.ts**: `isValidQwenModelId` boundaries. `requireQwenModelId` throws on missing.
4. **execute.remote.test.ts**: skip if env unset (`it.skipIf(!process.env.QWEN_LOCAL_BASE_URL)`). Real run: send a one-shot prompt, expect text output + `usage.prompt_tokens > 0`.
5. **Concurrency smoke** (in `execute.remote.test.ts`): fire 20 `Promise.all` runs; assert all resolve within timeout; record p50/p95 latency in test log for ops baseline.
6. CI: ensure default `pnpm test` does not require remote env (gated tests skip).

## Success Criteria

- [x] `pnpm -F @paperclipai/adapter-qwen-local test` green offline.
- [x] Remote suite green when env var set against the real DGX.
- [x] Concurrency smoke passes with all 20 runs successful, no 5xx.

## Risk Assessment

- Risk: capturing stable JSONL fixtures from qwen-code is brittle if the format changes. Mitigation: pin qwen-code version (Phase 1 `SANDBOX_INSTALL_COMMAND`) and re-record fixtures on bumps.
- Risk: remote test flakes on Tailnet hiccups. Mitigation: tag test as `flaky` allow-list in CI, retry once.
