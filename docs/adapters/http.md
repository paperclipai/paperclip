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
| `runtimeProfile` | enum | No | Runtime profile: `custom-http`, `http+crewai`, `http+langgraph` |
| `timeoutMs` | number | No | Request timeout in milliseconds |

### CrewAI Visibility in Dashboard

If your HTTP agent is backed by CrewAI, Paperclip can display `CrewAI (HTTP)` in dashboard lists.

Preferred configuration:

```json
{
  "url": "http://127.0.0.1:8000/webhook",
  "runtimeProfile": "http+crewai",
  "headers": {
    "x-agent-runtime": "CrewAI"
  }
}
```

Alternative hints also work:

1. Add a runtime header (`x-agent-runtime: CrewAI`).
2. Include `crewai` in the webhook URL hostname/path.
3. Include `CrewAI` in the agent `capabilities` text.

The runtime label appears in:

- `Agents` list view
- `Org Chart` cards

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

## How to test CrewAI from the dashboard

1. Create or edit an agent with adapter type `http`.
2. Set URL + runtime profile `http+crewai` (header defaults to `x-agent-runtime: CrewAI`).
3. Save and go to `Agents` page: label should show `CrewAI (HTTP)`.
4. Click `Invoke` in the agent detail to trigger a heartbeat.
5. Verify run logs for successful HTTP invocation and callback.

## Local operator preset

For local bridge setups, use:

- `CREWAI_WEBHOOK_URL=http://127.0.0.1:8000/webhook`

and run:

```bash
cd server
CREWAI_WEBHOOK_URL="http://127.0.0.1:8000/webhook" pnpm phase1:crewai-smoke
```
