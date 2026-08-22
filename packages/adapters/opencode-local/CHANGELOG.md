# @paperclipai/adapter-opencode-local

## Unreleased

### Minor Changes

- Add a fail-safe LocalLLM model-config freshness generator (`refresh-dev-models`).
  Polls the live Ollama `/api/tags` endpoint and rewrites only
  `provider.dev.models` in the source opencode config, preserving
  `provider.dev.options` and every non-`dev` provider. JSONC-tolerant read,
  atomic write with a timestamped `.bak`, and fail-safe on any
  fetch/parse/empty-result error (never clobbers a good config). Exposed both
  programmatically (`refreshDevModels`) and as a CLI
  (`paperclip-opencode-refresh-dev-models`). The Ollama endpoint is resolved as
  explicit flag > `OLLAMA_URL` env > config `baseURL` > `http://localhost:11434`
  default. Documented in the new package README.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

### Patch Changes

- Updated dependencies
  - @paperclipai/adapter-utils@0.3.0

## 0.2.7

### Patch Changes

- Add local OpenCode adapter package with server/UI/CLI modules.
