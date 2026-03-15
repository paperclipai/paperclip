---
title: Codex Local
summary: OpenAI Codex local adapter setup and configuration
---

The `codex_local` adapter runs OpenAI's Codex CLI locally. It supports session persistence via `previous_response_id` chaining and skills injection through the global Codex skills directory.

## Prerequisites

- Codex CLI installed (`codex` command available)
- `OPENAI_API_KEY` set in the environment or agent config

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Model to use |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | No | Skip safety checks (dev only) |
| `costApi` | object | No | External quota API for real cost tracking (see below) |

## Cost Tracking via External Quota API

By default, `codex_local` reports `costUsd: null` because OpenAI Codex subscription plans do not return per-request cost data. If you use an OpenAI-compatible proxy (such as [The Claw Bay](https://theclawbay.com)) that tracks usage costs, you can configure `costApi` to enable real cost tracking in Paperclip's budget enforcement and cost dashboard.

### How it works

The adapter takes one quota snapshot **before** the run and one **after** (covering retries), computes the delta, and reports it as `costUsd`. Paperclip's existing heartbeat pipeline then converts this to cents, inserts a `cost_events` row, and updates `spent_monthly_cents` — budget auto-pause works as normal.

### `costApi` fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | string | Yes | — | GET endpoint that returns a JSON quota object |
| `key` | string | Yes | — | Bearer token for `Authorization` header |
| `field` | string | Yes | — | Dot-path to the cumulative cost number in the response (e.g. `usage.fiveHour.estimatedCostUsdUsed`) |
| `timeoutMs` | number | No | `5000` | Per-fetch timeout in milliseconds |
| `attributionMode` | string | No | `strict_dedicated_key` | Attribution semantics (see below) |

### Attribution modes

| Mode | Suitable for enforcement? | Description |
|------|--------------------------|-------------|
| `strict_dedicated_key` | ✅ Yes | One dedicated proxy API key per agent. Delta reliably attributes only that agent's usage. **Required for budget enforcement.** |
| `best_effort_shared_key` | ⚠️ No | API key is shared between agents or other processes. Delta is approximate telemetry. Should not be used for budget enforcement decisions. |

### Example: The Claw Bay

```json
{
  "costApi": {
    "url": "https://theclawbay.com/api/codex-auth/v1/quota",
    "key": "ca_v1.YOUR_KEY_HERE",
    "field": "usage.fiveHour.estimatedCostUsdUsed",
    "attributionMode": "strict_dedicated_key"
  }
}
```

### Fail-open behavior

Cost API errors never fail the agent run. If the quota endpoint is unreachable, returns an error, times out, or returns unexpected data, a warning is logged to stderr and `costUsd: null` is returned — identical to the default behavior without `costApi` configured.

## Session Persistence

Codex uses `previous_response_id` for session continuity. The adapter serializes and restores this across heartbeats, allowing the agent to maintain conversation context.

## Skills Injection

The adapter symlinks Paperclip skills into the global Codex skills directory (`~/.codex/skills`). Existing user skills are not overwritten.

When Paperclip is running inside a managed worktree instance (`PAPERCLIP_IN_WORKTREE=true`), the adapter instead uses a worktree-isolated `CODEX_HOME` under the Paperclip instance so Codex skills, sessions, logs, and other runtime state do not leak across checkouts. It seeds that isolated home from the user's main Codex home for shared auth/config continuity.

For manual local CLI usage outside heartbeat runs (for example running as `codexcoder` directly), use:

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
```

This installs any missing skills, creates an agent API key, and prints shell exports to run as that agent.

## Environment Test

The environment test checks:

- Codex CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- Authentication signal (`OPENAI_API_KEY` presence)
- A live hello probe (`codex exec --json -` with prompt `Respond with hello.`) to verify the CLI can actually run
