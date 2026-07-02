# Cursor Cloud Adapter

This document describes how `@paperclipai/adapter-cursor-cloud` runs Paperclip heartbeats through the [Cursor Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints).

## Overview

- Each Paperclip heartbeat maps to a Cursor run on a durable cloud agent.
- Wake context is rendered into the agent prompt via `renderPaperclipWakePrompt()`.
- Paperclip remains the source of truth for issue/task state; Cursor provides the remote execution surface.

## Environment variables

The Cursor Cloud API enforces strict limits on `cloud.envVars`:

- **4096 bytes** per value (UTF-8)
- **50 keys** maximum per agent

This adapter injects operator secrets from `adapterConfig.env` and essential `PAPERCLIP_*` runtime vars (`PAPERCLIP_RUN_ID`, `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_API_KEY`, `PAPERCLIP_API_URL`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, workspace keys when present, and related metadata).

**`PAPERCLIP_WAKE_PAYLOAD_JSON` is not sent via cloud envVars.** Local adapters receive the full wake payload as a process env var; the cloud path does not. Wake context (issue, comments, plan review) is already in the agent prompt. Agents that need structured wake data should read the prompt or call the Paperclip API (e.g. `GET /api/issues/{id}/heartbeat-context`).

Operator secrets in `adapterConfig.env` must each stay under **4096 bytes**. Values that exceed the limit are truncated defensively by `clampEnvVarsForCloud()` with a `[truncated: cursor_cloud envVars limit]` suffix and a run-log warning.

`CURSOR_API_KEY` is never forwarded to cloud envVars — it is used only for Cursor SDK authentication on the Paperclip side.

## Cost reporting

After a run finishes (`status === "finished"`), the adapter fetches token usage from:

```
GET /v1/agents/{agentId}/usage?runId={runId}
```

Usage fields (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`) are mapped into the `AdapterExecutionResult.usage` shape and recorded in Paperclip **cost-events** when token counts are present.

**`costUsd` may be `null`** until the Paperclip pricing catalog has a matching Cursor model entry. Token usage is still persisted; cost can be estimated later via the existing pricing fallback (same pattern as other metered adapters).

Costs on the Cursor account are **separate** from Paperclip budget controls. Paperclip budget/hard-stop does not limit spend on the Cursor billing account.

## Session strategy

Paperclip reuses the durable Cursor agent across heartbeats when the repo/runtime identity still matches. Each heartbeat creates a new Cursor run on that agent.

## No-remote-git contract

Like every Paperclip adapter, this one must treat the local execution-workspace cwd as the only persistence boundary across runs — no `git push` from runtime code, no assuming a `git remote` exists. See [`packages/adapters/AUTHORING.md`](../AUTHORING.md#no-remote-git-contract-cross-run-persistence).
