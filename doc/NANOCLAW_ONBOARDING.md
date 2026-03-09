# NanoClaw Gateway Adapter — Onboarding

## Prerequisites

1. **NanoClaw running** — The NanoClaw WhatsApp-to-Claude bridge must be active with its gateway accessible.
2. **OpenClaw Gateway** — NanoClaw runs on top of OpenClaw. The gateway must be listening (default: `ws://127.0.0.1:18789`).
3. **Gateway token** — Obtain your OpenClaw gateway auth token for authenticated access.
4. **Agent containers** — At least one NanoClaw agent (Dozer, Scout, Myco, or Sally) must be running in Docker.

## Quick Start

1. In Paperclip, create a new agent and select **NanoClaw Gateway** as the adapter type.
2. Set the **Gateway URL** (default: `ws://127.0.0.1:18789`).
3. Choose the **Agent Name** from the dropdown (Dozer, Scout, Myco, Sally) or enter a custom name.
4. Save and run a test heartbeat to verify connectivity.

## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | `ws://127.0.0.1:18789` | OpenClaw gateway WebSocket URL |
| `agentName` | string | *(required)* | NanoClaw agent to route to (dozer, scout, myco, sally, or custom) |
| `authToken` | string | — | Gateway auth token (can also be set via `headers.x-openclaw-token`) |
| `timeoutSec` | number | `300` | Adapter timeout in seconds (longer default for Docker agents) |
| `waitTimeoutMs` | number | `300000` | Agent wait timeout in milliseconds |
| `sessionKeyStrategy` | string | `issue` | Session routing: `issue`, `fixed`, or `run` |
| `sessionKey` | string | `paperclip` | Fixed session key (only used when strategy is `fixed`) |
| `role` | string | `operator` | Gateway role |
| `scopes` | string[] | `["operator.admin"]` | Gateway scopes |
| `payloadTemplate` | object | — | Additional fields merged into gateway agent params |

All OpenClaw gateway fields (`headers`, `password`, `clientId`, `clientMode`, etc.) are also supported as pass-through.

## Agent Mapping

Map your Paperclip agents to NanoClaw agents based on their specialization:

| NanoClaw Agent | Role | Specialization |
|----------------|------|----------------|
| **Dozer** | Main agent | General-purpose, primary NanoClaw agent |
| **Scout** | SEO/Marketing | Content strategy, GSC reporting, SEO audits |
| **Myco** | E-commerce | Shopify content, product management |
| **Sally** | UI/UX | Atomic Design, CRO optimization, web components |

In `adapterConfig`, set `agentName` to the lowercase agent name:

```json
{
  "url": "ws://127.0.0.1:18789",
  "agentName": "scout",
  "timeoutSec": 300
}
```

## Smoke Test

Run these three tests after setup to verify the adapter works:

### 1. Connectivity Test

From the Paperclip agent settings, click **Test Environment**. Expected result:
- Gateway URL valid (info)
- Gateway probe succeeded (info)

### 2. Agent Wake Test

Assign a simple issue to the NanoClaw-backed agent (e.g., "Respond with OK"). Verify:
- The heartbeat run starts and completes
- The agent response appears in the run transcript
- Exit code is 0

### 3. Agent Routing Test

Create two Paperclip agents backed by different NanoClaw agents (e.g., Dozer and Scout). Assign each an issue. Verify:
- Each issue is handled by the correct NanoClaw agent
- Responses reflect the agent's specialization

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "Gateway probe failed" | Gateway not running | Start NanoClaw: check `launchctl` service or run `openclaw gateway start` |
| "Connect probe rejected" | Bad auth token | Verify `authToken` or `headers.x-openclaw-token` matches gateway config |
| "Pairing required" | Device not approved | Run `openclaw devices list --json` and approve pending device |
| Timeout on agent run | Agent container not running | Check `docker ps` for the NanoClaw agent container |
| Wrong agent responds | `agentName` misconfigured | Verify `agentName` in `adapterConfig` matches the NanoClaw agent name exactly |
| Port 18789 in use but gateway down | Stale process | Kill stale process: `kill $(lsof -ti :18789)` then restart gateway |
