---
title: Cursor
summary: Cursor agent adapter setup and configuration
---

The `cursor` adapter runs Cursor's AI agent locally. It supports session persistence, skills injection, and automated coding workflows.

## Prerequisites

- Cursor editor installed with CLI access (`cursor` command available)
- A valid Cursor subscription (Pro or Business)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path) |
| `model` | string | No | Model to use (e.g. `cursor-small`, `gpt-4o`) |
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

The adapter persists Cursor session IDs between heartbeats so the agent can resume context between runs.

## Skills

Skills are injected into the agent's context at runtime. The adapter supports listing and syncing skills from the company skill library.

## Example Config

```json
{
  "adapterType": "cursor",
  "adapterConfig": {
    "cwd": "/home/user/projects/my-app",
    "model": "gpt-4o",
    "promptTemplate": "You are {{agent.name}}, working at {{company.name}}."
  }
}
```
