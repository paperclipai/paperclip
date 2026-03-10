---
title: ACPX sidecars with Docker Compose
summary: Generic ACPX sidecar patterns for Codex, Claude, Gemini, and Hermes runtimes
---

This guide shows how to run dedicated runtime containers for the `acpx_sidecar` adapter.

The working, upstream-facing pattern is:

- Paperclip uses `adapterType: "acpx_sidecar"`
- Paperclip talks to a small HTTP sidecar exposing `/health`, `/status`, and `/run`
- that sidecar shells out to `acpx`
- `acpx` then runs the target runtime

This guide intentionally documents only the currently working runtime families:

- Codex
- Claude Code
- Gemini CLI
- Hermes Agent

## Adapter config shape

```json
{
  "adapterType": "acpx_sidecar",
  "adapterConfig": {
    "url": "http://runtime-sidecar:8710",
    "agentCommand": "codex",
    "cwd": "/home/node/workspaces/agent-name",
    "timeoutSec": 600,
    "model": "gpt-5.4"
  }
}
```

Use `customAgentCommand` when the runtime is not a built-in ACPX agent command.

## Runtime image templates

The following templates are provided as starting points:

- [`codex.Dockerfile`](/docs/examples/acpx-sidecars/codex.Dockerfile)
- [`claude.Dockerfile`](/docs/examples/acpx-sidecars/claude.Dockerfile)
- [`gemini.Dockerfile`](/docs/examples/acpx-sidecars/gemini.Dockerfile)
- [`hermes.Dockerfile`](/docs/examples/acpx-sidecars/hermes.Dockerfile)

These templates are intentionally minimal:

- install `acpx`
- install the target runtime
- provide a writable `HOME`

They do not prescribe your HTTP `/run` wrapper implementation. That wrapper is deployment-specific and can live outside the Paperclip core repo.

## Why this pattern exists

This keeps provider CLIs and runtime dependencies out of the main Paperclip API container while still letting Paperclip orchestrate them through one generic adapter.
