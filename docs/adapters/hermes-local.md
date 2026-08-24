---
title: Hermes Local Adapter
summary: Run agents through the local Hermes CLI via @paperclipai/hermes-paperclip-adapter
version: v2026.626.0
---

# Hermes Local Adapter

The **Hermes Local** adapter (`hermes_local`) runs the local Hermes CLI on the same host as the Paperclip server. It is a built-in adapter type from the unified `@paperclipai/hermes-paperclip-adapter` package.

## When to Use This Adapter

Use `hermes_local` when:

- You want Paperclip to start the local `hermes` CLI for each heartbeat
- You run Hermes on the same machine as the Paperclip server
- You need a local agent that can interact with files and services on the host

If Hermes is already running as an API server and you want Paperclip to call that server directly (without spawning a new process per heartbeat), use [Hermes Gateway](/adapters/hermes-gateway) instead.

## Prerequisites

1. **Hermes CLI** must be installed and authenticated on the host machine
2. **Node.js** 18+ (required by the Hermes CLI)
3. The `@paperclipai/hermes-paperclip-adapter` package (bundled with Paperclip; no separate install needed)

## Configuration

When creating or editing an agent, set:

| Field | Value |
|-------|-------|
| Adapter Type | `hermes_local` |
| Adapter Config | See below |

### Adapter Config Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | No | The model to use (e.g., `claude-sonnet-4-20250514`). Defaults to the Hermes CLI's configured model. |
| `cwd` | string | Yes | Working directory for the Hermes process |
| `timeoutSec` | number | No | Maximum runtime per heartbeat (default: 300) |
| `graceSec` | number | No | Grace period before force-kill after timeout/cancel (default: 30) |
| `extraArgs` | string[] | No | Additional CLI arguments to pass to Hermes |

### Environment Variables

The Hermes CLI respects standard environment variables:

- `HERMES_API_KEY` — API key for Hermes services
- `HERMES_GATEWAY_URL` — Gateway URL override
- `ANTHROPIC_API_KEY` — API key for Claude (if using Claude models through Hermes)
- `OPENAI_API_KEY` — API key for OpenAI (if using OpenAI models through Hermes)

## Usage

Create an agent with the Hermes Local adapter via the UI or API:

```json
POST /api/companies/{companyId}/agents
{
  "name": "hermes-dev",
  "role": "engineer",
  "adapterType": "hermes_local",
  "adapterConfig": {
    "cwd": "/home/user/projects/my-app",
    "model": "claude-sonnet-4-20250514",
    "timeoutSec": 600,
    "extraArgs": ["--verbose"]
  },
  "runtimeConfig": {
    "enabled": true,
    "intervalSec": 300,
    "wakeOnAssignment": true
  }
}
```

## How It Works

1. When a heartbeat fires, Paperclip looks up the agent's `hermes_local` adapter type
2. The adapter spawns the local `hermes` CLI process with the configured arguments
3. Hermes executes the heartbeat: reads the prompt/context, performs work, and exits
4. The adapter captures stdout, parses usage/cost data, and returns a structured result
5. Paperclip stores the run result and updates the UI

## Session Resume

Hermes Local supports session resumption across heartbeats. Paperclip stores the session ID and passes `--resume <sessionId>` on subsequent heartbeats. This gives continuity across runs.

To reset a session (e.g., if the agent gets stuck or context drifts), use the session reset action from the agent detail page or API.

## Known Limitations

1. **Host-bound** — Hermes runs on the same machine as the Paperclip server. For remote execution, use `hermes_gateway`.
2. **No sandboxing** — The Hermes process runs unsandboxed on the host. Ensure the working directory and configured credentials are properly secured.
3. **CLI dependency** — Requires the `hermes` CLI to be installed and functioning. If the CLI is missing or misconfigured, heartbeats will fail.

## Troubleshooting

### Hermes not found

```
Error: spawn hermes ENOENT
```

Install the Hermes CLI and ensure it's in the system PATH.

### Heartbeat times out

Increase `timeoutSec` in the adapter config. If the agent consistently needs more time, consider splitting the work into smaller tasks.

### Session resume failure

If a resumed run fails, try resetting the session from the agent detail page. This is often caused by stale context or model state.

## Related

- [Hermes Gateway Adapter](/adapters/hermes-gateway) — for calling an already-running Hermes API server
- [Adapters Overview](/adapters/overview) — all adapter types
- [Managing Agents](/guides/board-operator/managing-agents) — agent lifecycle
