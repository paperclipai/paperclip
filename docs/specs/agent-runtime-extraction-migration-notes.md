# AGE-224 Migration Notes: runtime extraction and provider adapter layer

Date: 2026-05-24
Owner: Backend Engineer 2

## What changed in this repo

- Added runtime-focused provider abstraction module at `packages/adapters/opencode-local/src/runtime/provider-adapters.ts`.
- Standardized provider/model normalization and alias mapping (`oai -> openai`, `google -> gemini`, `xai -> grok`).
- Added provider capability negotiation helpers so runtime provider behavior is data-driven.
- Added runtime contract version marker: `agentos-agents/v1`.
- Updated OpenCode execution metadata path to use runtime provider resolver instead of ad-hoc parsing in executor.
- Added model configuration resolution helper to keep baseline Azure fallback path stable.

## Backend integration points (stable contract expectations)

Backend and downstream gateway code should treat these fields as the stable runtime-facing contract from OpenCode execution results:

- `provider` (normalized provider id)
- `model` (normalized `provider/model` id)
- `biller` (provider-compatible billing source)
- `resultJson.runtimeContractVersion` (`agentos-agents/v1`)
- `resultJson.providerCapabilities` (capabilities confirmed for selected provider)
- `resultJson.missingProviderCapabilities` (required-but-missing capabilities)

This keeps backend logic provider-neutral: runtime emits normalized metadata and capability negotiation outcomes; backend consumes them as plain data.

## Future split guidance (`agentos-agents`)

The following files are extraction-ready and can move into `agentos-agents` with minimal coupling risk:

- `packages/adapters/opencode-local/src/runtime/provider-adapters.ts`
- `packages/adapters/opencode-local/src/server/models.ts` (model config/model discovery normalization helpers)
- OpenCode server module exports from `packages/adapters/opencode-local/src/server/index.ts`

During split, keep `agentos-agents/v1` contract version semantics unchanged unless backend gateway compatibility layer is updated in lockstep.
