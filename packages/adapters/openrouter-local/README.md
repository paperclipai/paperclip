# @paperclipai/adapter-openrouter-local

Tool-aware Paperclip adapter for OpenRouter (and any OpenAI Chat
Completions-compatible endpoint). Runs an OpenAI function-calling loop
locally on the Paperclip host: built-in workspace tools (`read_file`,
`write_file`, `list_directory`, `run_command`, `apply_patch`) are exposed
to the model and dispatched here on the Paperclip side.

Supersedes the chat-only `@marcpbailey/paperclip-adapter-openai`
(`openrouter-external`) smoke-test wrapper, which lacked a function-calling
loop and therefore could not drive a Paperclip turn end-to-end.

## Configuration

Adapter type: `openrouter_local`.

Required config:

- `baseUrl` — OpenAI-compatible endpoint (default
  `https://openrouter.ai/api/v1`)
- `model` — provider/model slug (e.g. `anthropic/claude-sonnet-4`)

Required env input (one of):

- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`

Optional config:

- `cwd` — absolute working directory the tools execute against. When
  unset, falls back to `PAPERCLIP_WORKSPACE_PATH` and finally
  `process.cwd()`.
- `instructionsFilePath` — absolute path to a markdown instructions file
  prepended to the system prompt.
- `promptTemplate` — Mustache-style template rendered with
  `{ agentId, agentName, companyId, runId, taskId, taskTitle }`.
- `maxIterations` — cap on tool-call rounds per run (default `25`).
- `maxRunCommandTimeoutSec` — per-tool-call timeout for `run_command`
  (default `120`).
- `extraHeaders` — record of additional request headers (merged with
  OpenRouter `HTTP-Referer` / `X-Title` defaults).
- `disabledTools` — string array of tool names to omit from the request.

## Workspace and instruction discovery

On every run the adapter loads, in order:

1. `instructionsFilePath` (if configured)
2. `AGENTS.md` from `cwd`
3. `HEARTBEAT.md` from `cwd`

Discovered files are concatenated into the system prompt, separated by
`---` rules. Missing files are silently skipped.

## Output protocol

The adapter writes structured JSONL events to stdout. Each line is a
`TranscriptEntry` (see `@paperclipai/adapter-utils`). The `ui-parser`
subpath echoes lines back as transcript entries for the Paperclip UI.

## Spec

See [`doc/experimental/openrouter-local-adapter_spec.md`](../../../doc/experimental/openrouter-local-adapter_spec.md)
for the full design and gap analysis vs `openrouter-external`.
