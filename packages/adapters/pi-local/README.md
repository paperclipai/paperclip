# @paperclipai/adapter-pi-local

Paperclip adapter for [Pi](https://github.com/getpi/pi) running locally. Spawns the
`pi` CLI as a subprocess, streams JSONL output back to the Paperclip control plane,
and resumes sessions across heartbeats via `--session`.

Pi is an AI coding agent with a focused tool set: `read`, `bash`, `edit`, `write`,
`grep`, `find`, `ls`.

## Runtime Requirements

- `pi` CLI must be in `PATH`
- The provider and model must be configured and accessible (API keys, etc.)

## Models

Models are discovered dynamically via `pi --list-models` at runtime. There is no static
fallback list. **A `model` value is required** in the agent configuration.

Use `pi --list-models` to list available options in `provider/model` format.

## Configuration Fields

Set these in the agent's configuration object in Paperclip.

### Core

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | **required** | Model in `provider/model` format (e.g. `xai/grok-4`) |
| `cwd` | string | optional | Default working directory for the agent process |
| `thinking` | string | optional | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `instructionsFilePath` | string | optional | Absolute path to a markdown instructions file appended to system prompt via `--append-system-prompt` |
| `promptTemplate` | string | optional | User prompt template passed via `-p` flag |
| `command` | string | optional | CLI binary name (default: `"pi"`) |
| `env` | object | optional | Extra environment variables (`KEY=VALUE`) |

### Operational

| Field | Type | Description |
|---|---|---|
| `timeoutSec` | number | Run timeout in seconds |
| `graceSec` | number | SIGTERM grace period in seconds |

## Notes

- Sessions are stored in `~/.pi/paperclips/` and resumed with `--session`.
- All tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) are enabled by default.
- Agent instructions are appended to Pi's system prompt via `--append-system-prompt`;
  the user task prompt is sent via `-p`.
- Paperclip requires an explicit `model` value — there is no default.
