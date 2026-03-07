# @paperclipai/adapter-cursor-local

Paperclip adapter for [Cursor Agent CLI](https://cursor.sh) running locally. Spawns
the `agent` CLI as a subprocess, pipes prompts via stdin, and streams JSON output back
to the Paperclip control plane. Sessions are resumed across heartbeats via `--resume`.

## Runtime Requirements

- Cursor Agent CLI (`agent`) must be in `PATH`
- Must be authenticated with Cursor

## Models

The adapter ships a static fallback list of known model IDs (`auto`, `composer-1.5`,
`gpt-5.3-codex`, various Claude/Gemini/Grok models, etc.) and also discovers available
models dynamically at runtime. Default model is `auto`.

Use the Paperclip UI to browse the full list or set any model ID supported by your Cursor
subscription.

## Configuration Fields

Set these in the agent's configuration object in Paperclip.

### Core

| Field | Type | Description |
|---|---|---|
| `cwd` | string | Default working directory for the agent process |
| `model` | string | Cursor model ID (default: `"auto"`) |
| `mode` | string | Execution mode: `plan` or `ask` (omit for normal autonomous runs) |
| `instructionsFilePath` | string | Absolute path to a markdown instructions file prepended to the run prompt |
| `promptTemplate` | string | Run prompt template |
| `command` | string | CLI binary name (default: `"agent"`) |
| `extraArgs` | string[] | Additional CLI arguments |
| `env` | object | Extra environment variables (`KEY=VALUE`) |

### Operational

| Field | Type | Description |
|---|---|---|
| `timeoutSec` | number | Run timeout in seconds |
| `graceSec` | number | SIGTERM grace period in seconds |

## Notes

- Runs execute with: `agent -p --output-format stream-json ...`
- Prompts are piped to Cursor via stdin.
- Sessions are resumed with `--resume` when the stored session `cwd` matches the current `cwd`.
- Paperclip auto-injects local skills into `~/.cursor/skills` so Cursor can discover
  `$paperclip` and related skills on local runs.
- Paperclip auto-adds `--yolo` unless `--trust`, `--yolo`, or `-f` is already in `extraArgs`.
