---
title: Codex Local
summary: OpenAI Codex local adapter setup and configuration
---

The `codex_local` adapter runs OpenAI's Codex CLI locally. It supports session persistence via `previous_response_id` chaining and skills injection through the global Codex skills directory.

## Prerequisites

- Codex CLI installed (`codex` command available)
- Authentication configured using one of:
  - `codex login --device-auth` (subscription login, no API key), or
  - `OPENAI_API_KEY` in environment/agent config

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Model to use |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | No | Skip safety checks (dev only) |

## Session Persistence

Codex uses `previous_response_id` for session continuity. The adapter serializes and restores this across heartbeats, allowing the agent to maintain conversation context.

## Skills Injection

The adapter symlinks Paperclip skills into the global Codex skills directory (`~/.codex/skills`). Existing user skills are not overwritten.

## Subscription Login (No API Key)

If you use ChatGPT subscription auth, run once on the machine/container that executes agent heartbeats:

```sh
codex login --device-auth
```

This writes login state to `~/.codex/auth.json` (or `$CODEX_HOME/auth.json` when `CODEX_HOME` is set).

In Docker deployments, make sure that auth path is persisted across restarts (for example via the Paperclip data bind mount).

## Docker Path Notes (`instructionsFilePath`)

`instructionsFilePath` must be readable from inside the runtime environment.

If Paperclip runs in Docker and your agent points to a host path like `/home/ubuntu/myproject/AGENTS.md`, bind-mount that path into the container at the same location:

```sh
-v /home/ubuntu/myproject:/home/ubuntu/myproject
```

## Environment Test

The environment test checks:

- Codex CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- Authentication signal (`OPENAI_API_KEY` or local Codex login state)
- A live hello probe (`codex exec --json -` with prompt `Respond with hello.`) to verify the CLI can actually run
