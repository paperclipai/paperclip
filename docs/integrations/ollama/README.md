# Ollama integration

Paperclip supports Ollama as a first-class agent runtime via the `ollama_local`
adapter (package `@paperclipai/adapter-ollama-local`).

This page covers two complementary surfaces:

1. **Inside Paperclip** — how `ollama_local` agents work, how to install/switch
   models, local vs cloud hosts.
2. **Inside Ollama** — the proposed `ollama launch paperclip` integration that
   spawns Paperclip pre-wired to a local Ollama daemon. See
   [`launch-paperclip.go.md`](./launch-paperclip.go.md) for the reference
   implementation we're proposing upstream.

## Inside Paperclip

### Local Ollama (default)

```sh
ollama serve            # if it isn't already running
ollama pull qwen2.5-coder:14b
```

Then create an agent in Paperclip with adapter `ollama_local` and config:

```json
{
  "model": "qwen2.5-coder:14b",
  "host": "http://localhost:11434"
}
```

`host` defaults to `OLLAMA_HOST` env, then `http://localhost:11434`.

### Ollama Cloud

```sh
# Create a key at https://ollama.com/settings/keys
export OLLAMA_API_KEY=...
```

Agent config:

```json
{
  "model": "gpt-oss:120b",
  "host": "https://ollama.com"
}
```

The adapter detects `*.ollama.com` hosts and adds an `Authorization: Bearer
$OLLAMA_API_KEY` header automatically. `testEnvironment` returns a clear error
if the cloud host is set without a key.

### Installing & switching models

The adapter exports server-side helpers your tooling can call:

| Export                | Description                                      |
| --------------------- | ------------------------------------------------ |
| `listOllamaModels`    | `GET /api/tags` — all installed models           |
| `pullOllamaModel`     | `POST /api/pull` (streaming) — install a model   |
| `deleteOllamaModel`   | `DELETE /api/delete` — remove a model            |
| `showOllamaModel`     | `POST /api/show` — capabilities, modelfile, etc. |
| `modelSupportsTools`  | True if `/api/show` capabilities include `tools` |

To switch a running agent's model, PATCH its `adapterConfig.model` to a tag the
host has installed. The adapter reads `config.model` on every `execute()` call —
no restart needed. The Paperclip UI's model picker calls `listOllamaModels` to
populate the dropdown.

### Pick a model that supports tool calling

`ollama_local` drives a tool-calling agent loop — a model that doesn't emit
`tool_calls` will exit on turn 1 with a plain text response and never use the
filesystem tools. Verify with `ollama show <model>` (look for `tools` in
capabilities) or call `modelSupportsTools(host, name)` programmatically.

Models we've validated the contract against:

- `qwen2.5-coder:14b` — recommended for local
- `qwen2.5-coder:32b` — better, slower
- `gpt-oss:20b`
- Cloud `gpt-oss:120b` etc.

`llama3.2:latest` works for chat but tool-calling is unreliable.

## Inside Ollama

We're proposing `ollama launch paperclip` mirroring the existing `codex` /
`opencode` / `droid` integrations. See
[`launch-paperclip.go.md`](./launch-paperclip.go.md) for the proposed file
content and registry entry.

Tracking: [ollama/ollama#15976](https://github.com/ollama/ollama/issues/15976)
