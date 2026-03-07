# @paperclipai/adapter-claude-local

Paperclip adapter for [Claude Code](https://github.com/anthropics/claude-code) running
locally. Spawns the `claude` CLI as a subprocess and streams its JSON output back to
the Paperclip control plane.

## Runtime Requirements

- `claude` CLI must be in `PATH` (install: `npm install -g @anthropic-ai/claude-code`)
- Must be authenticated: run `claude login` before first use (or inside the container)

## Models

| ID | Label |
|---|---|
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |

## Configuration Fields

Set these in the agent's configuration object in Paperclip.

### Core

| Field | Type | Description |
|---|---|---|
| `cwd` | string | Default working directory for the agent process |
| `model` | string | Claude model ID (see table above) |
| `effort` | string | Reasoning effort: `low`, `medium`, or `high` |
| `instructionsFilePath` | string | Absolute path to a markdown instructions file injected at runtime |
| `promptTemplate` | string | Run prompt template |
| `maxTurnsPerRun` | number | Max turns for one run |
| `dangerouslySkipPermissions` | boolean | Pass `--dangerously-skip-permissions` to claude |
| `chrome` | boolean | Pass `--chrome` when running Claude |
| `command` | string | CLI binary name (default: `"claude"`) |
| `extraArgs` | string[] | Additional CLI arguments |
| `env` | object | Extra environment variables (`KEY=VALUE`) |

### Operational

| Field | Type | Description |
|---|---|---|
| `timeoutSec` | number | Run timeout in seconds |
| `graceSec` | number | SIGTERM grace period in seconds |

## Skill Injection

Paperclip injects local skills from `skills/` into the agent context at runtime. No
retraining required — skills are loaded fresh on every run.
