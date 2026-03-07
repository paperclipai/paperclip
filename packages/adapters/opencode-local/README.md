# @paperclipai/adapter-opencode-local

Paperclip adapter for [OpenCode](https://opencode.ai) running locally. Spawns the
`opencode` CLI as a subprocess, streams JSONL output back to the Paperclip control plane,
and resumes sessions across heartbeats via `--session`.

## Runtime Requirements

- `opencode` CLI must be in `PATH`
- The provider and model must be configured and accessible (API keys, etc.)

## Models

Models are discovered dynamically via `opencode models` at runtime. There is no static
fallback list. **A `model` value is required** in the agent configuration.

Use `opencode models` to list available options in `provider/model` format.

## Configuration Fields

Set these in the agent's configuration object in Paperclip.

### Core

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | **required** | Model in `provider/model` format (e.g. `anthropic/claude-sonnet-4-5`) |
| `cwd` | string | optional | Default working directory for the agent process |
| `variant` | string | optional | Provider-specific model variant (e.g. `minimal`, `low`, `medium`, `high`, `max`) |
| `instructionsFilePath` | string | optional | Absolute path to a markdown instructions file prepended to the prompt |
| `promptTemplate` | string | optional | Run prompt template |
| `command` | string | optional | CLI binary name (default: `"opencode"`) |
| `extraArgs` | string[] | optional | Additional CLI arguments |
| `env` | object | optional | Extra environment variables (`KEY=VALUE`) |

### Operational

| Field | Type | Description |
|---|---|---|
| `timeoutSec` | number | Run timeout in seconds |
| `graceSec` | number | SIGTERM grace period in seconds |

## Notes

- Runs execute with: `opencode run --format json ...`
- Sessions are resumed with `--session` when the stored session `cwd` matches the current `cwd`.
- Paperclip requires an explicit `model` value — there is no default.
