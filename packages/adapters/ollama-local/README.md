# @paperclipai/adapter-ollama-local

First-class Ollama adapter for [Paperclip](https://github.com/paperclipai/paperclip). Adapter type: `ollama_local`.

Unlike `codex_local` / `opencode_local` (which wrap external coding-agent CLIs), this adapter implements its own agent loop directly against Ollama's [`/api/chat`](https://docs.ollama.com/api/introduction) endpoint with native tool calling. No external CLI needed — only a running Ollama server.

## Status

**Experimental — v0.1.** Functional for single-task runs with built-in tools. The following are not yet implemented and will land in follow-up versions:

- Session resume across heartbeats
- Remote execution targets (SSH / managed-home)
- Paperclip skill bundle injection
- Streaming token events
- Cost / billing metadata

For production agent runs today, prefer `codex_local` or `opencode_local` configured against Ollama's OpenAI-compatible endpoint.

## Configuration

```json
{
  "type": "ollama_local",
  "config": {
    "model": "qwen2.5-coder:14b",
    "host": "http://localhost:11434",
    "cwd": "/path/to/workspace",
    "instructionsFilePath": "/path/to/AGENTS.md",
    "maxIterations": 25,
    "timeoutSec": 600
  }
}
```

### Fields

- `model` (required): an Ollama model tag (e.g. `qwen2.5-coder:14b`, `llama3.2`, `gpt-oss:20b`). Run `ollama pull <tag>` first.
- `host` (optional): Ollama server URL. Defaults to `OLLAMA_HOST` env var, then `http://localhost:11434`.
- `cwd` (optional): working directory for tool execution.
- `instructionsFilePath` (optional): markdown file prepended to the system prompt.
- `maxIterations` (optional, default `25`): maximum tool-call rounds before bailing.
- `timeoutSec` (optional, default `600`): wall-clock timeout for the entire run.
- `extraTools` (optional, default `[]`): reserved.

## Built-in tools

| Tool        | Description                                               |
| ----------- | --------------------------------------------------------- |
| `read_file` | Read a UTF-8 file relative to cwd.                        |
| `write_file`| Write/overwrite a UTF-8 file relative to cwd.             |
| `list_dir`  | List entries in a directory relative to cwd.              |
| `run_bash`  | Run a shell command in cwd. Output is truncated at 64 KB. |

## Tested with

- `qwen2.5-coder:14b` (recommended)
- `gpt-oss:20b`
- `llama3.2:latest` (limited tool-calling reliability)

Models without robust tool-calling support will not work well — pick a model the Ollama team flags as supporting `tools` in `ollama show`.
