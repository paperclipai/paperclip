---
title: OpenCode Local
summary: OpenCode local adapter setup and configuration
---

The `opencode_local` adapter runs the [OpenCode CLI](https://opencode.ai) locally. It supports any provider that OpenCode exposes — including z.ai, OpenRouter, Groq, DeepInfra, Anthropic, and others — via a single `provider/model` string.

## Prerequisites

- OpenCode CLI installed (`opencode` command available)
- OpenCode **1.2.26 or later** (earlier versions do not expose all providers)
- Provider credentials configured (see [Provider Auth](#provider-auth) below)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Model in `provider/model` format (e.g. `zai-coding-plan/glm-4.6`) |
| `cwd` | string | Yes | Working directory for the agent process |
| `env` | object | No | Environment variables injected into the OpenCode process |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `maxTurnsPerRun` | number | No | Max agentic turns per heartbeat |
| `dangerouslySkipPermissions` | boolean | No | Skip permission prompts (dev only) |

## Provider Auth

OpenCode discovers available models by running `opencode models`. The models shown depend on what credentials are configured.

### Option 1 — auth.json (recommended for Docker)

OpenCode reads credentials from `~/.local/share/opencode/auth.json` (where `~` is the process HOME). This is the most reliable method, especially inside Docker containers.

Example `auth.json`:

```json
{
  "zai-coding-plan": {
    "type": "api",
    "key": "your-zai-api-key"
  }
}
```

In Docker, `HOME` is `/paperclip` (the mounted data directory), so place the file at:

```
<PAPERCLIP_DATA_DIR>/.local/share/opencode/auth.json
```

### Option 2 — Environment variables

Some providers are detected from environment variables (e.g. `ZAI_API_KEY`, `OPENAI_API_KEY`). Pass these via `adapterConfig.env` or as container environment variables.

> **Note:** On Linux, environment variable detection for certain providers (e.g. z.ai) may not work in older versions. Use auth.json if `opencode models` does not show expected providers.

## Model Discovery

Paperclip validates the configured model against live `opencode models` output before each run. Results are cached for 60 seconds per unique env/cwd combination.

If the configured model is not found:

```
CTO run failed: Configured OpenCode model is unavailable: zai-coding-plan/glm-4.6. Available models: opencode/big-pickle...
```

Troubleshoot by running `opencode models` manually inside the container:

```sh
docker exec -it <container> opencode models
```

## Supported Providers (examples)

| Provider prefix | Auth method | Example model |
|-----------------|-------------|---------------|
| `opencode` | None (free) | `opencode/big-pickle` |
| `zai-coding-plan` | `auth.json` or `ZAI_API_KEY` | `zai-coding-plan/glm-4.6` |
| `anthropic` | `auth.json` or `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4-6` |
| `openai` | `auth.json` or `OPENAI_API_KEY` | `openai/gpt-4o` |
| `groq` | `auth.json` or `GROQ_API_KEY` | `groq/llama-3.3-70b` |

Run `opencode models` with your credentials set to see all available models.

## Docker Notes

The Paperclip Docker image pre-installs OpenCode. For provider auth inside the container:

1. Create the auth file on the host:
   ```sh
   mkdir -p <PAPERCLIP_DATA_DIR>/.local/share/opencode
   cat > <PAPERCLIP_DATA_DIR>/.local/share/opencode/auth.json << 'EOF'
   {
     "zai-coding-plan": {
       "type": "api",
       "key": "your-api-key"
     }
   }
   EOF
   ```

2. The file persists across container restarts because it lives inside the bind-mounted data directory.

3. Verify inside the container:
   ```sh
   docker exec <container> opencode providers list
   ```
