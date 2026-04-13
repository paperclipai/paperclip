---
title: Cursor Local
summary: Cursor Agent CLI adapter setup and configuration
---

The `cursor` adapter runs Cursor's Agent CLI (`agent`) locally with streamed JSON output. It supports session resume via `--resume`, skills injection into the Cursor skills directory, and the same OpenRouter env mapping as other OpenAI-compatible local adapters.

## Prerequisites

- Cursor Agent CLI installed (`agent` command on `PATH`)
- Authentication for runs: one of
  - `CURSOR_API_KEY` in the environment or agent config
  - Interactive login via `agent login` (reads `~/.cursor/cli-config.json`)
  - OpenAI-compatible API keys — `OPENAI_API_KEY` or `OPENROUTER_API_KEY` (see [OpenRouter](#using-openrouter))

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Cursor model id (default: `auto`) |
| `promptTemplate` | string | No | Prompt template for all runs |
| `instructionsFilePath` | string | No | Absolute path to a markdown file prepended to each run prompt |
| `mode` | string | No | `plan` or `ask` — passed as `--mode` when set |
| `command` | string | No | CLI to invoke (default: `agent`) |
| `extraArgs` / `args` | string[] | No | Additional arguments appended to the CLI |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |

## Using OpenRouter

[OpenRouter](https://openrouter.ai) provides access to GPT-4o, Claude, Gemini, Llama, and hundreds of other models through a single OpenAI-compatible endpoint.

Set only `OPENROUTER_API_KEY` in the agent's `env` config:

```json
{
  "model": "openai/gpt-4o",
  "env": {
    "OPENROUTER_API_KEY": "sk-or-v1-…"
  }
}
```

Paperclip automatically maps `OPENROUTER_API_KEY` → `OPENAI_API_KEY` and sets `OPENAI_BASE_URL=https://openrouter.ai/api/v1` for the Cursor child process. Usage is tagged as `openrouter` in the billing ledger.

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
  "env": {
    "OPENAI_API_KEY": "sk-or-v1-…",
    "OPENAI_API_BASE": "https://openrouter.ai/api/v1"
  }
}
```

See the [OpenRouter model list](https://openrouter.ai/models) for all available models. Model IDs use the `provider/model-name` format (e.g. `openai/gpt-4o`, `anthropic/claude-opus-4-5`, `google/gemini-2.0-flash`).

## Session Persistence

When a previous run stored a session for the same resolved `cwd`, the adapter passes `--resume` so Cursor continues the same chat. If the saved session's cwd does not match, a new session starts and a log line explains why resume was skipped.

## Skills Injection

The adapter symlinks Paperclip skills into the Cursor global skills directory (`~/.cursor/skills`). Existing user skills are not overwritten.

## Instructions Resolution

If `instructionsFilePath` is configured, Paperclip reads that file and prepends it to the stdin prompt sent to `agent` on every run, with a short note that relative paths resolve from the instructions file's directory.

## Environment Test

The environment test checks:

- The configured command is executable
- Working directory is absolute and available (auto-created if missing and permitted)
- Authentication signal: `CURSOR_API_KEY` (adapter `env` or server environment) or native Cursor CLI login (`agent login`)
- When the command is `agent`, a live hello probe (`agent -p --mode ask --output-format json …`) to verify the CLI can run

The probe passes through only the adapter `env` object (not full process env). Real runs merge process env and apply [OpenRouter](#using-openrouter) mapping before spawning `agent`, so OpenRouter-only configs can still work in production even when the probe expects Cursor or explicit OpenAI keys.
