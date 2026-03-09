# NanoClaw Gateway Adapter — Onboarding

## Prerequisites

1. **NanoClaw running** — The NanoClaw WhatsApp-to-Claude bridge must be active with its MCP server listening (default: `http://127.0.0.1:18790`).
2. **Agent containers** — At least one NanoClaw agent (Dozer, Scout, Myco, or Sally) must be registered and available in Docker.
3. **Paperclip agent IDs mapped** — Each NanoClaw group that should receive Paperclip tasks needs a `paperclipAgentId` set in its registration.

## Quick Start

1. In Paperclip, create a new agent and select **NanoClaw Gateway** as the adapter type.
2. Set the **NanoClaw URL** (default: `http://127.0.0.1:18790`).
3. Choose the **Agent Name** from the dropdown (Dozer, Scout, Myco, Sally) or enter a custom name.
4. Save and run a test to verify connectivity.

## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | `http://127.0.0.1:18790` | NanoClaw MCP server HTTP base URL |
| `agentName` | string | `dozer` | NanoClaw agent to route to (dozer, scout, myco, sally, or custom) |
| `agentId` | string | — | Override Paperclip agent ID (defaults to agentName) |
| `timeoutMs` | number | `30000` | HTTP request timeout in milliseconds |

## How It Works

NanoClaw's integration is **fire-and-forget**:

1. Paperclip POSTs to `{url}/paperclip/wakeup` with `{ agentId, runId, context }`
2. NanoClaw maps `agentId` to a registered group via the `paperclipAgentId` field
3. A Docker container is spawned running Claude Agent SDK
4. The agent processes the request and delivers output via **WhatsApp** (not back to Paperclip)
5. NanoClaw reports cost data back to Paperclip via `reportCostToPaperclip()`

This means Paperclip issues are dispatched to agents, but responses arrive in WhatsApp — not in the Paperclip UI transcript.

## Agent Mapping

Map your Paperclip agents to NanoClaw agents based on their specialization:

| NanoClaw Agent | Role | Specialization |
|----------------|------|----------------|
| **Dozer** | Main agent | General-purpose, primary NanoClaw agent |
| **Scout** | SEO/Marketing | Content strategy, GSC reporting, SEO audits |
| **Myco** | E-commerce | Shopify content, product management |
| **Sally** | UI/UX | Atomic Design, CRO optimization, web components |

Example adapter config:

```json
{
  "url": "http://127.0.0.1:18790",
  "agentName": "scout",
  "timeoutMs": 30000
}
```

## Smoke Test

### 1. Connectivity Test

From the Paperclip agent settings, click **Test Environment**. Expected result:
- NanoClaw MCP Server: pass — Reachable at http://127.0.0.1:18790

### 2. Agent Wakeup Test

Assign a simple issue to the NanoClaw-backed agent. Verify:
- The run completes with exit code 0
- The agent response appears in WhatsApp
- Log shows: `[nanoclaw-gateway] wakeup accepted`

### 3. Agent Routing Test

Create two Paperclip agents backed by different NanoClaw agents (e.g., Dozer and Scout). Assign each an issue. Verify:
- Each issue reaches the correct agent in WhatsApp
- Responses reflect the agent's specialization

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "Cannot reach http://127.0.0.1:18790" | NanoClaw not running | Check launchd service: `launchctl list com.nanoclaw` |
| HTTP 400 on wakeup | Unknown agentId | Verify the NanoClaw group has `paperclipAgentId` set matching the adapter's `agentName` |
| HTTP 404 | Wrong URL or port | Confirm NanoClaw MCP server is on port 18790, not 18789 (that's OpenClaw) |
| Timeout | NanoClaw server slow to respond | Increase `timeoutMs` in adapter config |
| No response in WhatsApp | Container not starting | Check `docker ps` for nanoclaw-agent containers; check `logs/nanoclaw.log` |
| Port 18790 in use but server down | Stale process | `kill $(lsof -ti :18790)` then restart NanoClaw service |
