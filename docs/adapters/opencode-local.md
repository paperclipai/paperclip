---
title: OpenCode Local
summary: OpenCode local adapter setup and configuration
---

The `opencode_local` adapter runs the OpenCode CLI locally. OpenCode is an open-source terminal-based AI coding assistant that supports multiple LLM providers.

## Prerequisites

- OpenCode CLI installed (`opencode` command available)
- A supported LLM API key configured (OpenAI, Anthropic, or compatible provider)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path) |
| `model` | string | No | Model to use (provider-dependent) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |

## Prompt Templates

Templates support `{{variable}}` substitution:

| Variable | Value |
|----------|-------|
| `{{agentId}}` | Agent's ID |
| `{{companyId}}` | Company ID |
| `{{runId}}` | Current run ID |
| `{{agent.name}}` | Agent's name |
| `{{company.name}}` | Company name |

## Session Persistence

The adapter persists OpenCode session state between heartbeats for continuous context.

## Dynamic Model Detection

The adapter supports dynamic model listing from the configured provider, shown in the agent configuration UI.

## Example Config

```json
{
  "adapterType": "opencode_local",
  "adapterConfig": {
    "cwd": "/home/user/projects/my-app",
    "promptTemplate": "You are {{agent.name}}, an engineer at {{company.name}}."
  }
}
```
