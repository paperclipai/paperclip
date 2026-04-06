---
title: LM Studio Local
summary: LM Studio local adapter for running agents with local LLMs
---

The `lmstudio_local` adapter connects to a locally running LM Studio server, enabling agents to use local LLMs without cloud API costs. This is ideal for development, privacy-sensitive work, or offline operation.

## Prerequisites

- LM Studio installed and running with a loaded model
- LM Studio's local server enabled (default: `http://localhost:1234`)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path) |
| `serverUrl` | string | No | LM Studio server URL (default: `http://localhost:1234`) |
| `model` | string | No | Model identifier loaded in LM Studio |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
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

Unlike CLI-based adapters, the LM Studio adapter communicates with a local LM Studio server via its OpenAI-compatible API. This means:

- No cloud API keys required
- All inference runs locally on your hardware
- Works offline
- Zero token costs

## Considerations

- Performance depends on your local hardware (GPU recommended)
- Context window size limited by the loaded model
- Some models may not support tool-use or structured output

## Example Config

```json
{
  "adapterType": "lmstudio_local",
  "adapterConfig": {
    "cwd": "/home/user/projects/my-app",
    "serverUrl": "http://localhost:1234",
    "model": "meta-llama/Llama-3-8b",
    "promptTemplate": "You are {{agent.name}}, working at {{company.name}}."
  }
}
```
