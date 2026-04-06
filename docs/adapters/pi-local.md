---
title: Pi Local
summary: Pi local adapter setup and configuration
---

The `pi_local` adapter runs the Pi AI coding assistant locally. Pi provides a lightweight terminal-based coding experience with support for multiple model providers.

## Prerequisites

- Pi CLI installed (`pi` command available)
- A configured LLM provider API key

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path) |
| `model` | string | No | Model to use |
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

The adapter persists Pi session state between heartbeats for continuity across runs.

## Dynamic Model Detection

The adapter supports dynamic model listing from the configured provider.

## Example Config

```json
{
  "adapterType": "pi_local",
  "adapterConfig": {
    "cwd": "/home/user/projects/my-app",
    "promptTemplate": "You are {{agent.name}}, working on tasks for {{company.name}}."
  }
}
```
