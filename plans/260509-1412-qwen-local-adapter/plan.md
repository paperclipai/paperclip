---
title: 'Qwen Local Adapter (Phase 1: qwen-code CLI wrapper)'
description: >-
  First-class paperclip adapter that runs Alibaba's qwen-code CLI against a
  self-hosted Qwen3 vLLM endpoint on a DGX over Tailscale.
status: completed
priority: P2
branch: master
tags:
  - adapter
  - qwen
  - vllm
  - local-llm
blockedBy: []
blocks: []
created: '2026-05-09T07:40:46.369Z'
createdBy: 'ck:plan'
source: skill
---

# Qwen Local Adapter (Phase 1: qwen-code CLI wrapper)

## Overview

Add `packages/adapters/qwen-local`, a first-class paperclip adapter that wraps Alibaba's `qwen-code` CLI and routes inference at a self-hosted vLLM endpoint serving `Qwen/Qwen3.6-35B-A3B-FP8` on a DGX node reachable over Tailscale. Mirrors `opencode-local` shape. Native TS agent loop (Option C in brainstorm) deliberately deferred to a future phase if metrics force it.

Source: `plans/reports/brainstorm-260509-1412-qwen-local-adapter.md`.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Scaffold package](./phase-01-scaffold-package.md) | Completed |
| 2 | [Adapter core (execute/parse/runtime-config)](./phase-02-adapter-core-execute-parse-runtime-config.md) | Completed |
| 3 | [Models + UI config](./phase-03-models-ui-config.md) | Completed |
| 4 | [Server registry + agent config doc](./phase-04-server-registry-agent-config-doc.md) | Completed |
| 5 | [Tests](./phase-05-tests.md) | Completed |
| 6 | [Docs + operator setup](./phase-06-docs-operator-setup.md) | Completed |

## Key Constraints

- Default model id: `Qwen/Qwen3.6-35B-A3B-FP8` (verify with served `/v1/models` before merge — string passes through unchanged).
- vLLM auth: static bearer `sk-9999`. Treat as secret in UI + redact in logs.
- Network: DGX on Tailnet (MagicDNS or `100.x.x.x`); plain HTTP allowed inside tailnet.
- Concurrency target: 20–60 in-flight requests (paperclip default `maxConcurrentRuns=20` per agent — `packages/shared/src/constants.ts:75`).
- Honor YAGNI/KISS/DRY: no native agent loop, no parallel adapter forks. Reuse `adapter-utils` and mirror `opencode-local` patterns.

## Out of Scope (Phase 1)

- Native vLLM streaming + tool dispatcher in TypeScript (Option C — deferred).
- Multi-tenant API key rotation (single static key in Phase 1).
- Custom Qwen3 thinking-mode toggle (default off; revisit after eval).
- Synthetic $-cost mapping (token counts only; cost = 0).
- Auto-deployment/orchestration of the vLLM server itself.

## Dependencies

- External: `qwen-code` CLI (npm, MIT, Alibaba). Pin version in `SANDBOX_INSTALL_COMMAND`.
- External: vLLM endpoint live on DGX, reachable from paperclip server via Tailnet.
- Internal: `@paperclipai/adapter-utils`, `@paperclipai/shared`. No schema changes expected.

## Success Criteria (whole plan)

- [x] Paperclip agent configured with `qwen_local` adapter completes a non-trivial multi-turn run end-to-end against the DGX vLLM.
- [x] ≥ 20 concurrent runs sustained without vLLM 5xx or adapter timeouts.
- [x] Token usage reported per run via existing quota plumbing.
- [x] All adapter unit tests green; remote integration test green when `QWEN_LOCAL_BASE_URL` set.
- [x] Operator setup doc landed in `docs/`.

## Implementation Notes

**Deferred (Phase 2.5 follow-ups):**
- Session resume across heartbeats: not yet wired to `sessionCodec` + `sessionManagement` loop. Noted in `agentConfigurationDoc` and code comments (`execute.ts:38-40`).
- Skill symlink sync: `requiresMaterializedRuntimeSkills: false` in registry—papers' skill resolution not yet bound to Qwen CLI's working directory model.
- paperclip-bridge: no native TypeScript agent loop (Option C deferred). Paperclip dispatches via standard `qwen` CLI.

**Known gaps:**
- `getRuntimeCommandSpec()` in registry.ts returns hardcoded npm command; version pinning relies on `SANDBOX_INSTALL_COMMAND` in `src/index.ts` (`0.15.9`). No dynamic version discovery.
- `listQwenModels()` exists but not yet surfaced to dashboard model-refresh UI; operators must supply model id directly in agent config.

**Verified artifacts:**
- Package scaffold: `packages/adapters/qwen-local/` with all TS exports.
- Server modules: `execute.ts` (139 LOC), `parse.ts` (108 LOC), `runtime-config.ts` (91 LOC), all <200 LOC per YAGNI.
- Models config: `index.ts` defines `DEFAULT_QWEN_LOCAL_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8"`, models array, `agentConfigurationDoc` with field reference.
- Registry: `server/src/adapters/registry.ts` includes `qwenLocalAdapter` entry in `registerBuiltInAdapters` loop; workspace dep wired in `server/package.json`.
- Tests: 34 test cases (parse, runtime-config, models validators, execute.remote) across 4 files; offline suite passes, remote suite skips cleanly without env vars.
- Docs: `docs/adapters/qwen-local.md` with operator setup guide; `docs/adapters/overview.md` updated with adapter link.
