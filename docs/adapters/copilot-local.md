---
title: Copilot Local
summary: GitHub Copilot CLI local adapter setup and configuration
---

The `copilot_local` adapter runs the official GitHub Copilot CLI locally. It supports session persistence, skills injection, structured JSONL output parsing, and multi-model access via GitHub Copilot.

## Prerequisites

- GitHub Copilot CLI installed (`copilot` command available)
  ```bash
  npm install -g @github/copilot
  ```
- A GitHub account with an active Copilot subscription (Free, Pro, Pro+, Business, or Enterprise)
- Authenticated via `copilot login` (browser-based OAuth device flow)

## Authentication

The Copilot CLI manages its own authentication. Run `copilot login` to complete a browser-based sign-in. The token is stored in the system credential store (or `~/.copilot/` if no credential store is available).

Alternatively, set one of these environment variables in the agent's adapter config:

| Variable | Priority | Notes |
|----------|----------|-------|
| `COPILOT_GITHUB_TOKEN` | 1st | Fine-grained PAT with "Copilot Requests" permission, or OAuth token |
| `GH_TOKEN` | 2nd | OAuth token from the GitHub CLI app |
| `GITHUB_TOKEN` | 3rd | OAuth token from the GitHub CLI app |

Classic personal access tokens (`ghp_`) are **not supported** by the Copilot CLI.

A "Login with Copilot" button is available on the agent's Configuration tab in the Paperclip UI. It runs `copilot login` server-side.

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path) |
| `model` | string | No | Model to use (e.g. `claude-sonnet-4.6`, `gpt-5.2`). No provider prefix needed. |
| `command` | string | No | CLI binary name or path (defaults to `copilot`) |
| `promptTemplate` | string | No | Prompt template used for all runs |
| `instructionsFilePath` | string | No | Path to a markdown instructions file |
| `env` | object | No | Environment variables (supports secret refs) |
| `extraArgs` | string[] | No | Additional CLI arguments |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill (default: 15s) |

## Available Models

Models are specified directly without a provider prefix. Availability depends on your Copilot plan.

| Provider | Models |
|----------|--------|
| OpenAI | `gpt-4.1`, `gpt-4.1-mini`, `gpt-5-mini`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.2`, `gpt-5.4`, `gpt-5.4-mini` |
| Anthropic | `claude-sonnet-4`, `claude-sonnet-4.5`, `claude-sonnet-4.6`, `claude-haiku-4.5`, `claude-opus-4.5`, `claude-opus-4.6` |
| Google | `gemini-2.5-pro`, `gemini-3-flash`, `gemini-3-pro` |

## Environment Check

The "Test environment" button on the agent Configuration tab checks:

1. Working directory exists and is accessible
2. `copilot` command is found on PATH
3. Model configuration (info)
4. Authentication status (runs a hello probe)

If the probe fails with an auth error, the hint directs you to run `copilot login`.

## Session Persistence

Sessions are resumed automatically across heartbeats using `--resume=<sessionId>`. If the working directory has changed since the last session, a fresh session is started instead.

## Skills Injection

Paperclip skills are injected via a temporary directory passed with `--add-dir`. This makes skills available to the Copilot CLI without polluting the working directory.

## How It Works

On each heartbeat, Paperclip runs:

```
copilot -p "<prompt>" --allow-all-tools --output-format json --no-auto-update \
  --add-dir <skills-dir> --secret-env-vars=PAPERCLIP_API_KEY,COPILOT_GITHUB_TOKEN
```

The JSONL output is parsed for assistant messages, tool executions, session ID, and usage metrics (premium requests, API duration, code changes).
