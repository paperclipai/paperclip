---
title: Adapters Overview
summary: What adapters are and how they connect agents to Paperclip
---

Adapters are the bridge between Paperclip's orchestration layer and agent runtimes. Each adapter knows how to invoke a specific type of AI agent and capture its results.

## How Adapters Work

When a heartbeat fires, Paperclip:

1. Looks up the agent's `adapterType` and `adapterConfig`
2. Calls the adapter's `execute()` function with the execution context
3. The adapter spawns or calls the agent runtime
4. The adapter captures stdout, parses usage/cost data, and returns a structured result

## Built-in Adapters

| Adapter | Type Key | Description |
|---------|----------|-------------|
| [Claude Local](/adapters/claude-local) | `claude_local` | Runs Claude Code CLI locally |
| [Codex Local](/adapters/codex-local) | `codex_local` | Runs OpenAI Codex CLI locally |
| [Process](/adapters/process) | `process` | Executes arbitrary shell commands |
| [HTTP](/adapters/http) | `http` | Sends webhooks to external agents |

## Adapter Architecture

Each adapter is a package with three modules:

```
packages/adapters/<name>/
  src/
    index.ts            # Shared metadata (type, label, models)
    server/
      execute.ts        # Core execution logic
      parse.ts          # Output parsing
      test.ts           # Environment diagnostics
    ui/
      parse-stdout.ts   # Stdout -> transcript entries for run viewer
      build-config.ts   # Form values -> adapterConfig JSON
    cli/
      format-event.ts   # Terminal output for `paperclipai run --watch`
```

Three registries consume these modules:

| Registry | What it does |
|----------|-------------|
| **Server** | Executes agents, captures results |
| **UI** | Renders run transcripts, provides config forms |
| **CLI** | Formats terminal output for live watching |

## Choosing an Adapter

- **Need a coding agent?** Use `claude_local` or `codex_local`
- **Need to run a script or command?** Use `process`
- **Need to call an external service?** Use `http`
- **Need something custom?** [Create your own adapter](/adapters/creating-an-adapter)
