---
title: Hermes Local
summary: Hermes local adapter setup and configuration
---

The `hermes_local` adapter integrates with the Hermes AI coding agent. Hermes is designed for autonomous software development with tool-use capabilities.

## Prerequisites

- Hermes installed and available in PATH
- The `hermes-paperclip-adapter` package installed (included as a dependency)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path) |
| `model` | string | No | Model to use (detected automatically if not set) |
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

The adapter persists Hermes session state between heartbeats for context continuity.

## Model Detection

The adapter supports automatic model detection from the Hermes runtime, selecting the best available model.

## Skills

Skills are synced to the Hermes agent context at runtime, enabling the agent to use company skill libraries.

## Example Config

```json
{
  "adapterType": "hermes_local",
  "adapterConfig": {
    "cwd": "/home/user/projects/my-app",
    "promptTemplate": "You are {{agent.name}}, a developer at {{company.name}}."
  }
}
```
