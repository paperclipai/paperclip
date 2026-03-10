---
title: Pi Local
summary: Pi local adapter setup and configuration
---

The `pi_local` adapter runs [Pi](https://github.com/gnosisguild/pi) locally as the agent runtime. It supports session persistence, skills injection, provider/model routing, and structured output parsing via Pi's RPC mode.

## Prerequisites

- Pi CLI installed (`pi` command available)
- At least one provider configured and authenticated (e.g. `ANTHROPIC_API_KEY`, `XAI_API_KEY`)
- A model ID available in `pi --list-models` format (`provider/model`)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Pi model in `provider/model` format (e.g. `xai/grok-4`, `anthropic/claude-opus-4-6`). Use `pi --list-models` to list options. |
| `cwd` | string | No | Default working directory for the agent process (absolute path; created if missing when possible) |
| `instructionsFilePath` | string | No | Absolute path to a markdown file (e.g. `AGENTS.md`) appended to Pi's system prompt at runtime |
| `promptTemplate` | string | No | User prompt template passed to Pi. Supports `{{variable}}` substitution. |
| `thinking` | string | No | Pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `command` | string | No | Pi CLI command name (defaults to `pi`; override via `PAPERCLIP_PI_COMMAND` env var) |
| `env` | object | No | Environment variables injected at runtime (supports secret refs) |
| `timeoutSec` | number | No | Process timeout in seconds (0 = no timeout) |
| `graceSec` | number | No | SIGTERM grace period before force-kill (default: 20s) |
| `extraArgs` | string[] | No | Additional CLI arguments appended to the Pi command |

## Prompt Templates

Templates support `{{variable}}` substitution:

| Variable | Value |
|----------|-------|
| `{{agentId}}` | Agent's ID |
| `{{companyId}}` | Company ID |
| `{{runId}}` | Current run ID |
| `{{agent.name}}` | Agent's name |
| `{{company.name}}` | Company name |

Default template: `You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.`

## Session Persistence

The adapter persists Pi sessions between heartbeats using session files stored in `~/.pi/paperclips/`. On the next wake, the adapter resumes the existing session so the agent retains full conversation context.

Session resume is cwd-aware: if the working directory changed since the last run, a fresh session starts automatically.

If a resume attempt fails with an unknown session error, the adapter retries with a fresh session and clears the stale session reference.

## Skills Injection

The adapter symlinks Paperclip skills from the package `skills/` directory into Pi's global skills directory (`~/.pi/agent/skills/`). Existing user skills are never overwritten; only missing entries are created.

## Agent Instructions

If `instructionsFilePath` is set, the file contents are appended to Pi's system prompt via `--append-system-prompt`. Relative file references in the instructions file are resolved from the instructions file's directory.

If the file cannot be read (e.g. path does not exist), the adapter falls back to the `promptTemplate` and logs a warning.

## Model Configuration

Pi requires an explicit `model` value in `provider/model` format. Before each run, the adapter validates that the configured model is available via `pi --list-models`. If the model is not found, the run fails with a clear error message listing available options.

To see available models, run:

```sh
pi --list-models
```

Example model IDs: `xai/grok-4`, `anthropic/claude-opus-4-6`, `openai/gpt-4o`.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Working directory is absolute and accessible (auto-created if missing and permitted)
- Pi CLI is installed and accessible at the configured command path
- Pi can discover models via `pi --list-models`
- Configured model is present in the discovered model list
- A live hello probe (`pi --mode json -p "Respond with hello."`) to verify CLI and provider auth readiness

## Invocation Mode

The adapter invokes Pi using `--mode rpc` and writes the user prompt as a JSON `{"type":"prompt","message":"..."}` command to stdin. All tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) are enabled by default.
