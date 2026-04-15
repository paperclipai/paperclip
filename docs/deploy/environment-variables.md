---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `PAPERCLIP_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `PAPERCLIP_BIND_HOST` | (unset) | Required when `PAPERCLIP_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `PAPERCLIP_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `PAPERCLIP_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |

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
| `PAPERCLIP_API_URL` | Paperclip API base URL (inherits the server-level value; see Server Configuration above) |
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
| `OPENROUTER_API_KEY` | OpenRouter API key — auto-maps to `OPENAI_API_KEY` + `OPENAI_BASE_URL` for OpenAI-compatible adapters (Codex, Cursor, Pi, OpenCode, Process) |
| `OPENAI_BASE_URL` | Override the OpenAI-compatible base URL (e.g. `https://openrouter.ai/api/v1`) |
| `OPENAI_API_BASE` | Alternate base-URL env used by some tools; Paperclip reads it for OpenRouter billing detection when set |
| `OPENAI_API_BASE_URL` | Same as `OPENAI_API_BASE` — alternate spelling; included in OpenRouter billing detection |
| `OPENROUTER_API_BASE` | Optional OpenRouter-native base URL (some stacks use this instead of `OPENAI_*`); included in OpenRouter billing detection and in `OPENROUTER_API_KEY` → `OPENAI_*` mapping |

## Using OpenRouter

[OpenRouter](https://openrouter.ai) provides unified API access to hundreds of models (GPT-4o, Claude, Gemini, Llama, etc.) through a single OpenAI-compatible endpoint.

Set in the agent's **env** config (or as agent-level environment variables):

```
OPENROUTER_API_KEY=sk-or-v1-…
```

Paperclip automatically:
- Maps `OPENROUTER_API_KEY` → `OPENAI_API_KEY` for the child process
- Sets `OPENAI_BASE_URL=https://openrouter.ai/api/v1` for the child process (unless you already set a base URL via `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `OPENAI_API_BASE_URL`, or `OPENROUTER_API_BASE`)
- Tags all usage in the billing ledger as `openrouter`

Billing inference also treats a base URL as OpenRouter when **any** of `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `OPENAI_API_BASE_URL`, or `OPENROUTER_API_BASE` points at `openrouter.ai` (for example some CLIs only export `OPENAI_API_BASE`).

If `OPENAI_BASE_URL` is unset or whitespace-only but `OPENAI_API_BASE`, `OPENAI_API_BASE_URL`, or `OPENROUTER_API_BASE` is set, Paperclip copies that value into `OPENAI_BASE_URL` for child processes that read only that variable.

Alternatively you can set the variables explicitly, which takes precedence:

```
OPENAI_API_KEY=sk-or-v1-…
OPENAI_BASE_URL=https://openrouter.ai/api/v1
```

To use a specific model, set the `model` field in the adapter config (e.g. `openai/gpt-4o`, `anthropic/claude-3-5-sonnet`, `google/gemini-2.0-flash`). See the [OpenRouter model list](https://openrouter.ai/models) for available models.

