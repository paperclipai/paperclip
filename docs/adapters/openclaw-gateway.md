---
title: OpenClaw Gateway
summary: OpenClaw gateway adapter for remote agent execution
---

The `openclaw_gateway` adapter connects to an OpenClaw instance, enabling remote agent execution through the OpenClaw API. This is ideal for running agents on dedicated servers or cloud infrastructure.

## Prerequisites

- A running OpenClaw instance with API access
- Network connectivity between the OhMyCompany server and the OpenClaw endpoint

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `gatewayUrl` | string | Yes | URL of the OpenClaw gateway endpoint |
| `model` | string | No | Model to use on the OpenClaw instance |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables passed to the remote agent |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |

## Prompt Templates

Templates support `{{variable}}` substitution:

| Variable | Value |
|----------|-------|
| `{{agentId}}` | Agent's ID |
| `{{companyId}}` | Company ID |
| `{{runId}}` | Current run ID |
| `{{agent.name}}` | Agent's name |
| `{{company.name}}` | Company name |

## How It Works

Unlike local adapters that spawn a CLI process, the OpenClaw Gateway adapter communicates over HTTP with a remote OpenClaw server. This allows:

- Running agents on more powerful remote machines
- Centralized compute management
- Agents running in different environments or cloud regions

## Example Config

```json
{
  "adapterType": "openclaw_gateway",
  "adapterConfig": {
    "gatewayUrl": "https://openclaw.example.com/api",
    "model": "claude-opus-4-6",
    "promptTemplate": "You are {{agent.name}}, a {{agent.title}} at {{company.name}}."
  }
}
```
