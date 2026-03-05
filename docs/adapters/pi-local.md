---
title: Pi Local
summary: pi CLI local adapter setup and configuration
---

The `pi_local` adapter runs the [pi coding agent CLI](https://github.com/mariozechner/pi-coding-agent) locally in non-interactive JSON mode.

## Prerequisites

- pi CLI installed (`pi` command available)
- At least one provider credential configured for the model you plan to use (for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `instructionsFilePath` | string | No | Absolute path to AGENTS.md-style instructions prepended to each run prompt |
| `promptTemplate` | string | No | Prompt template used for each run |
| `command` | string | No | CLI command (default: `pi`) |
| `extraArgs` | string[] | No | Additional CLI args appended before the prompt |
| `provider` | string | No | Passed as `--provider` |
| `model` | string | No | Passed as `--model` |
| `thinking` | string | No | Thinking level passed as `--thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |
| `tools` | string[] | No | Explicit tools list passed as `--tools` |
| `noTools` | boolean | No | Disable tools via `--no-tools` |
| `sessionDir` | string | No | Override where adapter-managed session files are created |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |

## Session Persistence

The adapter stores a stable `--session` file and reuses it across heartbeats for the same task/session context.

## Environment Test

The environment test checks:

- pi CLI is installed and executable
- Working directory is absolute and available (auto-created if missing and permitted)
- Basic provider credential signal
- A live hello probe (`pi --mode json --print --no-session "Respond with hello."`)
