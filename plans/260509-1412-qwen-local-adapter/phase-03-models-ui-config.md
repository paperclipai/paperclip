---
phase: 3
title: Models + UI config
status: completed
priority: P2
effort: 1d
dependencies:
  - 1
---

# Phase 3: Models + UI config

## Overview

Populate `index.ts` with the real model list, profiles, and `agentConfigurationDoc`. Build the UI config form fields so operators can wire up a Qwen agent from the paperclip dashboard.

## Requirements

- Static `models` array exposes `Qwen/Qwen3.6-35B-A3B-FP8` plus any other ids the served vLLM publishes (e.g. fine-tunes).
- Optional dynamic refresh via vLLM `GET /v1/models` (deferred unless trivial — per YAGNI; document as TODO).
- UI form fields: `baseUrl`, `apiKey` (password input), `model` (select with free-text fallback), `variant`, `extraArgs`, `timeoutSec`, `dangerouslySkipPermissions`.
- `agentConfigurationDoc` mirrors opencode-local's docstring with Qwen-specific fields and notes.

## Architecture

- `src/index.ts` exports the real arrays (replaces Phase 1 stubs).
- `src/ui/build-config.ts` declares form schema using existing `AdapterUiConfigField` pattern from opencode-local.
- `src/server/models.ts` provides validation helpers (`isValidQwenModelId`, `requireQwenModelId`) and an optional async `listQwenModels(baseUrl, apiKey)` that hits vLLM `/v1/models`.

## Related Code Files

- Modify: `packages/adapters/qwen-local/src/index.ts`
- Create:
  - `packages/adapters/qwen-local/src/server/models.ts`
  - `packages/adapters/qwen-local/src/ui/build-config.ts`
  - `packages/adapters/qwen-local/src/ui/parse-stdout.ts` (if UI surfaces a stdout view; else skip)
- Read: `packages/adapters/opencode-local/src/index.ts`, `packages/adapters/opencode-local/src/ui/build-config.ts`, `packages/adapters/opencode-local/src/server/models.ts`

## Implementation Steps

1. Fill `index.ts`:
   - `models = [{ id: DEFAULT_QWEN_LOCAL_MODEL, label: "Qwen3.6 35B-A3B FP8 (default)" }]`. Add extra entries only if user names other served models.
   - `modelProfiles`: single `cheap` profile pointing at the same model (no cheap variant in single-model deploy) — or omit profile entirely; pick at impl time after confirming what server-side requires.
   - `agentConfigurationDoc` lists every config field, marks `baseUrl` + `apiKey` required, documents Tailnet expectation.
2. `models.ts`:
   - `isValidQwenModelId(value)` — non-empty string.
   - `requireQwenModelId(config)` — throws `AdapterConfigError` if missing.
   - `listQwenModels(baseUrl, apiKey)` — `fetch('${baseUrl}/models', { headers: { Authorization: 'Bearer ${apiKey}' } })` → returns `string[]`. Used by UI dropdown refresh button (not auto-called on every render).
3. `ui/build-config.ts`:
   - Declare fields. `apiKey` field: `inputType: "password"`, `secret: true`.
   - Default `dangerouslySkipPermissions: true` (matches opencode-local default for unattended runs).
4. Wire `models.ts` exports through `src/server/index.ts`.

## Success Criteria

- [x] Operator can create a `qwen_local` agent via paperclip UI.
- [x] `apiKey` is masked in the UI and not echoed in form-state JSON.
- [x] `listQwenModels()` returns a populated array against a live vLLM (manual smoke).
- [x] `agentConfigurationDoc` lints clean (no markdown errors).

## Risk Assessment

- Risk: UI field schema changes upstream in `adapter-utils`. Mitigation: copy verbatim from opencode-local at impl time, don't fork the schema.
- Risk: free-text model id lets operator typo a model and silently fail at run time. Mitigation: when `listQwenModels()` is reachable, validate against returned set; on failure, allow but log warning.
