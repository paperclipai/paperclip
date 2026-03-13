---
title: Remote Node
summary: Run agents on registered remote machines
---

The `remote_node` adapter executes agents on external machines instead of the server host. A registered node runs the `paperclipai node run` daemon, which polls the server for queued runs, spawns the configured local adapter (e.g. Claude Code), and reports results back.

## When to Use

- Agent needs to run on a specific machine (Mac with browser, GPU box, private network)
- You want to keep agent execution off the server host
- The remote machine has tools or access the server doesn't

## When Not to Use

- Agent can run on the server host — use `claude_local` or `codex_local` directly
- Fire-and-forget external service — use `http`

## How It Works

```
Paperclip Server                          Remote Node
┌──────────────────────────┐             ┌──────────────────────────┐
│  Heartbeat queues run    │             │  paperclipai node run    │
│  remote_node adapter     │◄────────────│    POST /heartbeat (30s) │
│  waits for completion    │             │    POST /claim           │
│                          │─────────────│    spawn claude --print  │
│  POST /log (streaming)   │◄────────────│    stream stdout/stderr  │
│  POST /report (done)     │◄────────────│    POST /report          │
│                          │             │                          │
│  Waiter resolves → done  │             │  Process exits           │
└──────────────────────────┘             └──────────────────────────┘
```

1. A heartbeat fires and the `remote_node` adapter's `execute()` registers a deferred Promise keyed by run ID
2. The runner daemon on the remote node claims the run via `POST /nodes/:nodeId/claim`
3. The runner spawns the local adapter (default: `claude`) with the agent's config
4. Stdout/stderr stream back to the server via `POST /nodes/:nodeId/runs/:runId/log`
5. On completion, the runner sends results via `POST /nodes/:nodeId/runs/:runId/report`
6. The report resolves the deferred Promise and the adapter returns the result

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nodeId` | string | Yes | UUID of the registered remote node |
| `localAdapterType` | string | No | Adapter to run on the node (`claude_local`, `codex_local`, `opencode_local`, `pi_local`, `cursor`). Defaults to `claude_local` |
| `localAdapterConfig` | object | No | Config passed to the local adapter on the node |
| `timeoutSec` | number | No | Max seconds to wait for completion (60–86400, default 3600) |

### `localAdapterConfig` Fields

| Field | Type | Description |
|-------|------|-------------|
| `cwd` | string | Working directory on the remote machine |
| `model` | string | Model to use (e.g. `claude-sonnet-4-5-20250514`) |
| `chrome` | boolean | Enable browser access |
| `dangerouslySkipPermissions` | boolean | Skip permission prompts |
| `instructionsFilePath` | string | Path to instructions file on the node |

### Example

```json
{
  "nodeId": "132d5716-f975-4c95-839f-8df4e44669e2",
  "localAdapterType": "claude_local",
  "localAdapterConfig": {
    "cwd": "/Users/me/projects/myapp",
    "model": "claude-sonnet-4-5-20250514",
    "chrome": true
  },
  "timeoutSec": 3600
}
```

## Environment Test

The adapter validates that `nodeId` is set in the agent's adapter config. The node itself is checked via heartbeats — a node is considered online if its last heartbeat was within 90 seconds.

## Session Persistence

The adapter uses the same session codec as `claude_local`. Session IDs pass through between heartbeats so the remote agent retains conversation context across runs.

## Orphan Run Handling

Remote runs have separate reaping logic:

- **Never claimed** and older than 10 minutes — reaped
- **Claimed** but no updates for 10 minutes AND node is offline (>90s since last heartbeat) — reaped

## Cancellation

When a run is cancelled from the UI, the server emits a `node.run.cancelled` event. The runner detects cancellation on its next log POST (receives `409`) and sends `SIGTERM` to the local process.
