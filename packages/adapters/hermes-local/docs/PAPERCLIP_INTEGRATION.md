# Paperclip integration notes

This package now runs as a first-class built-in adapter inside the Paperclip workspace.
The integration work landed in both the adapter package and Paperclip core so the setup is reproducible instead of relying on one-off local tweaks.

## Installed workspace shape

The Hermes adapter lives at:

```text
packages/adapters/hermes-local
```

Paperclip is wired to consume that workspace package from:

- `server/package.json`
- `ui/package.json`
- `server/src/adapters/registry.ts`
- `scripts/release-package-map.mjs`

## Core Paperclip hooks required for Hermes parity

### 1. Dynamic model discovery

The server registry should prefer:

- `listModels()`
- static `models` only as a fallback

Without this, the UI can silently fall back to a default model instead of showing the real Hermes-configured model list.

### 2. Session management

The registry must expose Hermes `sessionManagement` so Paperclip can round-trip session state between wakes.

### 3. Full approval lifecycle wakeups

The requesting agent is now woken when an approval is:

- approved
- revision requested
- rejected

The wake payload should include:

- `approvalId`
- `approvalStatus`
- `issueIds`
- `decisionNote`
- `wakeReason`

### 4. Issue wake context must include actual task text

Worker wakes are not reliable if the context only contains an `issueId`.
For Hermes, the wake snapshot should also include the issue title and body so the model can act immediately instead of asking the board to restate the assignment.

Recommended context fields:

- `taskId`
- `taskTitle`
- `taskBody`
- `issueTitle`
- `issueDescription`
- `issueIdentifier`
- `source`

### 5. Host should pass resolved runtime config

The adapter expects `ctx.config` to contain resolved values, especially for env bindings and secrets.
It should not be forced to read unresolved secret-ref objects from raw stored config.

### 6. Host should preserve sessionParams exactly

`sessionParams` are intentionally richer than only `sessionId`.
The host should round-trip them unchanged.

### 7. Custom endpoints should use a dedicated Hermes home

Hermes v0.7.0 supports custom OpenAI-compatible endpoints through config/runtime resolution, but its `chat` CLI does not accept `--provider custom` directly.

For LiteLLM or similar endpoints:

- configure a dedicated Hermes home/profile with `model.provider: custom`
- set `model.base_url`, `model.api_key`, and the desired model id there
- point the Paperclip agent at that home via `HERMES_HOME`

## Validation flow used for this integration

The integration was verified with:

1. Adapter unit tests under `packages/adapters/hermes-local/tests`
2. Paperclip server tests covering registry wiring, session codecs, model listing, approval wakeups, and issue wake snapshots
3. Playwright browser automation covering:
   - company creation
   - Hermes model selection from the discovered model list
   - CEO creation
   - CEO-driven hire request
   - board approval
   - worker-agent creation
   - worker execution against a real Paperclip issue

## Issues fixed during validation

### Worker wakes missing task content

Symptom:

- the hired worker woke up with only an issue id
- Hermes asked for clarification instead of completing the task

Fix:

- centralize issue wake snapshot creation in `server/src/services/issue-assignment-wakeup.ts`
- include task title/body fields in all issue-related wake paths
- add prompt fallbacks in the Hermes adapter for `issueTitle` and `issueDescription`

### Approval comment payload drift

Symptom:

- approval-thread comments could fail with `400` when an agent sent `content` or `comments` instead of `body`

Fix:

- normalize approval comment payload aliases at the shared validator layer
- keep `body` as the canonical field while accepting common agent-generated variants
