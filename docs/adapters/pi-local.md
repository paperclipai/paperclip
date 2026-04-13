---
title: Pi Local
summary: Pi agent local adapter setup and configuration
---

The `pi_local` adapter runs Pi (embedded AI coding agent) locally with JSONL output. It uses `provider/model` ids, session files under `~/.pi/paperclips/`, skills under `~/.pi/agent/skills`, and the same OpenRouter env mapping as Codex, Cursor, and OpenCode.

## Prerequisites

- Pi CLI installed (`pi` on `PATH`)
- A configured `model` in `provider/model` format (Paperclip validates availability when `pi --list-models` works)
- Provider credentials — typically via provider-specific env vars or `OPENROUTER_API_KEY` (see [OpenRouter](#using-openrouter))

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No\* | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | Yes | Model id in `provider/model` form (for example `xai/grok-4`) |
| `thinking` | string | No | Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |
| `instructionsFilePath` | string | No | Absolute path to markdown appended to the system prompt via `--append-system-prompt` |
| `promptTemplate` | string | No | User prompt template |
| `command` | string | No | CLI to invoke (default: `pi`) |
| `extraArgs` | string[] | No | Additional arguments for the CLI |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |

\*Recommended: set an absolute path. If omitted, the adapter falls back to workspace cwd context when available.

## Using OpenRouter

[OpenRouter](https://openrouter.ai) provides access to GPT-4o, Claude, Gemini, Llama, and hundreds of other models through a single OpenAI-compatible endpoint.

Set only `OPENROUTER_API_KEY` in the agent's `env` config (and set `model` to the OpenRouter model id you want):

```json
{
  "model": "openai/gpt-4o",
  "env": {
    "OPENROUTER_API_KEY": "sk-or-v1-…"
  }
}
```

Paperclip automatically maps `OPENROUTER_API_KEY` → `OPENAI_API_KEY` and sets `OPENAI_BASE_URL=https://openrouter.ai/api/v1` for the Pi child process. Usage is tagged as `openrouter` in the billing ledger.

Billing inference also treats the upstream as OpenRouter when **any** of `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `OPENAI_API_BASE_URL`, or `OPENROUTER_API_BASE` points at `openrouter.ai` (some CLIs only export the alternate keys). See the [deploy environment variables reference](../deploy/environment-variables.md) for the full table.

You can also set the variables explicitly (this takes precedence over the auto-mapping):

```json
{
  "model": "anthropic/claude-3-5-sonnet",
  "env": {
    "OPENAI_API_KEY": "sk-or-v1-…",
    "OPENAI_BASE_URL": "https://openrouter.ai/api/v1"
  }
}
```

If your environment only provides an alternate base-URL key, use `OPENAI_API_BASE` or `OPENAI_API_BASE_URL` instead of `OPENAI_BASE_URL`:

```json
{
  "model": "google/gemini-2.0-flash",
  "env": {
    "OPENAI_API_KEY": "sk-or-v1-…",
    "OPENAI_API_BASE": "https://openrouter.ai/api/v1"
  }
}
```

See the [OpenRouter model list](https://openrouter.ai/models) for all available models. Model IDs use the `provider/model-name` format (e.g. `openai/gpt-4o`, `anthropic/claude-opus-4-5`, `google/gemini-2.0-flash`).

## Session Persistence

Sessions are stored under `~/.pi/paperclips/` and resumed with `--session` when the stored cwd matches the current run.

## Skills Injection

The adapter symlinks Paperclip skills into `~/.pi/agent/skills`. Maintainer-only skills are removed when Paperclip manages the symlink set.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Pi CLI is installed and resolvable
- Working directory is absolute and available
- Model is set and appears in `pi --list-models` when discovery succeeds
- Authentication signals (including OpenRouter / OpenAI-compatible keys from `env`)
- A short live probe to confirm the CLI can run
