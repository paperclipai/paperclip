# @paperclipai/adapter-codex-local

Paperclip adapter for [OpenAI Codex](https://github.com/openai/codex) running locally.
Spawns the `codex` CLI as a subprocess, pipes prompts via stdin, and streams JSONL output
back to the Paperclip control plane.

## Runtime Requirements

- `codex` CLI must be in `PATH` (install: `npm install -g @openai/codex`)
- OpenAI API key must be configured (set `OPENAI_API_KEY` or configure via `codex` auth)

## Models

| ID | Label |
|---|---|
| `gpt-5.4` | gpt-5.4 |
| `gpt-5.3-codex` | gpt-5.3-codex (default) |
| `gpt-5.3-codex-spark` | gpt-5.3-codex-spark |
| `gpt-5` | gpt-5 |
| `o3` | o3 |
| `o4-mini` | o4-mini |
| `gpt-5-mini` | gpt-5-mini |
| `gpt-5-nano` | gpt-5-nano |
| `o3-mini` | o3-mini |
| `codex-mini-latest` | Codex Mini |

## Configuration Fields

Set these in the agent's configuration object in Paperclip.

### Core

| Field | Type | Description |
|---|---|---|
| `cwd` | string | Default working directory for the agent process |
| `model` | string | Codex model ID (see table above) |
| `modelReasoningEffort` | string | Reasoning effort: `minimal`, `low`, `medium`, `high` |
| `instructionsFilePath` | string | Absolute path to a markdown instructions file prepended to the prompt |
| `promptTemplate` | string | Run prompt template |
| `search` | boolean | Run codex with `--search` |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | Run with sandbox bypass flag |
| `command` | string | CLI binary name (default: `"codex"`) |
| `extraArgs` | string[] | Additional CLI arguments |
| `env` | object | Extra environment variables (`KEY=VALUE`) |

### Operational

| Field | Type | Description |
|---|---|---|
| `timeoutSec` | number | Run timeout in seconds |
| `graceSec` | number | SIGTERM grace period in seconds |

## Notes

- Prompts are piped via stdin (Codex receives `"-"` as the prompt argument).
- Paperclip auto-injects local skills into Codex's personal skills directory
  (`$CODEX_HOME/skills` or `~/.codex/skills`) so Codex can discover `$paperclip`
  and related skills without manual setup.
- Some model/tool combinations reject certain effort levels (e.g. `minimal` with web search).
