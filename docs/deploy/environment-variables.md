---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `HOST` | `127.0.0.1` | Server host binding |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | Agent's unique ID |
| `PAPERCLIP_COMPANY_ID` | Company ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL |
| `PAPERCLIP_API_KEY` | Short-lived JWT for API auth |
| `PAPERCLIP_RUN_ID` | Current heartbeat run ID |
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake |
| `PAPERCLIP_WAKE_REASON` | Wake trigger reason |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `PAPERCLIP_APPROVAL_ID` | Resolved approval ID |
| `PAPERCLIP_APPROVAL_STATUS` | Approval decision |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local / Cursor adapters) |
| `OPENROUTER_API_KEY` | OpenRouter API key — auto-maps to `OPENAI_API_KEY` + `OPENAI_BASE_URL` for OpenAI-compatible adapters (Codex, Cursor, Pi, OpenCode) |
| `OPENAI_BASE_URL` | Override the OpenAI-compatible base URL (e.g. `https://openrouter.ai/api/v1`) |
| `OPENAI_API_BASE` | Alternate base-URL env used by some tools; Paperclip reads it for OpenRouter billing detection when set |
| `OPENAI_API_BASE_URL` | Same as `OPENAI_API_BASE` — alternate spelling; included in OpenRouter billing detection |

## Using OpenRouter

[OpenRouter](https://openrouter.ai) provides unified API access to hundreds of models (GPT-4o, Claude, Gemini, Llama, etc.) through a single OpenAI-compatible endpoint.

Set in the agent's **env** config (or as agent-level environment variables):

```
OPENROUTER_API_KEY=sk-or-v1-…
```

Paperclip automatically:
- Maps `OPENROUTER_API_KEY` → `OPENAI_API_KEY` for the child process
- Sets `OPENAI_BASE_URL=https://openrouter.ai/api/v1` for the child process (unless you already set a base URL via `OPENAI_BASE_URL`, `OPENAI_API_BASE`, or `OPENAI_API_BASE_URL`)
- Tags all usage in the billing ledger as `openrouter`

Billing inference also treats a base URL as OpenRouter when **any** of `OPENAI_BASE_URL`, `OPENAI_API_BASE`, or `OPENAI_API_BASE_URL` points at `openrouter.ai` (for example some CLIs only export `OPENAI_API_BASE`).

Alternatively you can set the variables explicitly, which takes precedence:

```
OPENAI_API_KEY=sk-or-v1-…
OPENAI_BASE_URL=https://openrouter.ai/api/v1
```

To use a specific model, set the `model` field in the adapter config (e.g. `openai/gpt-4o`, `anthropic/claude-3-5-sonnet`, `google/gemini-2.0-flash`). See the [OpenRouter model list](https://openrouter.ai/models) for available models.

