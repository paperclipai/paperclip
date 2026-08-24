---
title: Hermes Gateway Adapter
summary: Call an already-running Hermes API server via @paperclipai/hermes-paperclip-adapter/gateway
version: v2026.626.0
---

# Hermes Gateway Adapter

The **Hermes Gateway** adapter (`hermes_gateway`) connects Paperclip to an already-running Hermes API server. Instead of spawning a new Hermes CLI process per heartbeat, Paperclip sends HTTP/SSE requests to a remote Hermes server. It is a built-in adapter type from the unified `@paperclipai/hermes-paperclip-adapter` package.

## When to Use This Adapter

Use `hermes_gateway` when:

- Hermes is already running as an HTTP/SSE API server on another host or in a container
- You want to avoid spawning a new process per heartbeat (lower overhead, faster startup)
- You need to run Hermes in a different environment than the Paperclip server
- You have a centralized Hermes deployment that multiple Paperclip instances should share

If you want Paperclip to start the local Hermes CLI directly on the same host, use [Hermes Local](/adapters/hermes-local) instead.

## Prerequisites

1. A running Hermes API server (the Hermes gateway service)
2. The gateway URL and API key for the Hermes server
3. Network connectivity between the Paperclip server and the Hermes gateway
4. The `@paperclipai/hermes-paperclip-adapter` package (bundled with Paperclip; no separate install needed)

## Configuration

When creating or editing an agent, set:

| Field | Value |
|-------|-------|
| Adapter Type | `hermes_gateway` |
| Adapter Config | See below |

### Adapter Config Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `gatewayUrl` | string | Yes | URL of the Hermes API server (e.g., `https://hermes-gateway.mycompany.com`) |
| `apiKey` | string | Yes | API key for authenticating with the Hermes gateway |
| `model` | string | No | The model to use (e.g., `claude-sonnet-4-20250514`). Defaults to the gateway's configured model. |
| `timeoutSec` | number | No | Maximum runtime per heartbeat (default: 300) |
| `extraArgs` | string[] | No | Additional arguments to pass to the Hermes gateway |

### Security Note

The `apiKey` is stored as part of the agent configuration. Ensure only authorized users can view or modify agent configurations. Use Paperclip's permission system to control access.

## Usage

Create an agent with the Hermes Gateway adapter via the UI or API:

```json
POST /api/companies/{companyId}/agents
{
  "name": "hermes-remote",
  "role": "engineer",
  "adapterType": "hermes_gateway",
  "adapterConfig": {
    "gatewayUrl": "https://hermes-gateway.mycompany.com",
    "apiKey": "hg_abc123...",
    "model": "claude-sonnet-4-20250514",
    "timeoutSec": 300
  },
  "runtimeConfig": {
    "enabled": true,
    "intervalSec": 300,
    "wakeOnAssignment": true
  }
}
```

## How It Works

1. When a heartbeat fires, Paperclip looks up the agent's `hermes_gateway` adapter type
2. The adapter sends an HTTP/SSE request to the configured Hermes gateway URL
3. The Hermes gateway executes the heartbeat remotely and streams results back
4. The adapter captures the streamed response, parses usage/cost data, and returns a structured result
5. Paperclip stores the run result and updates the UI

## Session Resume

Hermes Gateway supports session resumption. The gateway manages session state server-side. Paperclip passes the session ID on subsequent heartbeats for continuity.

## Deprecation Note

The older `@paperclipai/adapter-hermes-gateway` npm package is a deprecated compatibility shim that re-exports the gateway entrypoints. New plugin overrides should target `@paperclipai/hermes-paperclip-adapter` and set the type key to `hermes_gateway`.

## Known Limitations

1. **Network dependency** — Requires reliable network connectivity between Paperclip and the Hermes gateway
2. **Gateway availability** — If the Hermes gateway is down, all `hermes_gateway` agents will fail to execute heartbeats
3. **Latency** — Network round-trip adds latency compared to local execution
4. **Credentials management** — API keys are stored in agent configuration; manage access carefully

## Troubleshooting

### Connection refused

```
Error: connect ECONNREFUSED <gateway-url>
```

Verify the gateway URL is correct and the Hermes API server is running and reachable from the Paperclip server.

### Authentication failed

```
Error: 401 Unauthorized
```

Check that the API key is correct and has not been rotated. Update the agent configuration with the new key.

### Heartbeat times out

Increase `timeoutSec` in the adapter config. Also check network latency between Paperclip and the gateway.

## Related

- [Hermes Local Adapter](/adapters/hermes-local) — for running Hermes locally on the same host
- [Adapters Overview](/adapters/overview) — all adapter types
- [Managing Agents](/guides/board-operator/managing-agents) — agent lifecycle
