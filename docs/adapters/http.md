---
title: HTTP Adapter
summary: HTTP webhook adapter
---

The `http` adapter sends a webhook request to an external agent service. The agent runs externally and Paperclip just triggers it.

## When to Use

- Agent runs as an external service (cloud function, dedicated server)
- Fire-and-forget invocation model
- Integration with third-party agent platforms

## When Not to Use

- If the agent runs locally on the same machine (use `process`, `claude_local`, or `codex_local`)
- If you need stdout capture and real-time run viewing

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Webhook URL to POST to |
| `headers` | object | No | Additional HTTP headers |
| `timeoutSec` | number | No | Request timeout |

## How It Works

1. Paperclip sends a POST request to the configured URL
2. The request body includes the execution context (agent ID, task info, wake reason)
3. The external agent processes the request and calls back to the Paperclip API
4. Response from the webhook is captured as the run result

## Request Body

The webhook receives a JSON payload with:

```json
{
  "runId": "...",
  "agentId": "...",
  "companyId": "...",
  "context": {
    "taskId": "...",
    "wakeReason": "...",
    "commentId": "..."
  }
}
```

The external agent uses `PAPERCLIP_API_URL` and an API key to call back to Paperclip.

## Heartbeat Interval

For persistent HTTP-adapter agents, `runtimeConfig.heartbeat.intervalSec` is a liveness probe only — the adapter's webhook handles real-time work delivery (assignments, comments, mentions) via push. Timer wakes that arrive while the queue is empty are no-op roundtrips.

New HTTP-adapter agents therefore default to `intervalSec: 1200` (20 minutes) instead of the 300s default used for `claude_local`/`codex_local`. This is still frequent enough to catch liveness drift (a dead channel MCP, a crashed `claude+` that tmux missed) while avoiding the ~90 unnecessary wakes/24h that 300s produces for a well-plumbed channel agent.

Agents that genuinely benefit from a shorter cadence can override via `PATCH /agents/{id}` with an explicit `runtimeConfig.heartbeat.intervalSec`.

