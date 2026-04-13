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
| [Gemini Local](/adapters/gemini-local) | `gemini_local` | Runs Google's Gemini CLI locally (experimental — adapter package exists, not yet in stable type enum) |
| [OpenCode Local](/adapters/opencode-local) | `opencode_local` | Runs OpenCode CLI locally (multi-provider `provider/model`) |
| [Cursor Local](/adapters/cursor-local) | `cursor` | Runs Cursor Agent CLI locally (`agent`) |
| [Pi Local](/adapters/pi-local) | `pi_local` | Runs an embedded Pi agent locally |
| Hermes Local | `hermes_local` | Runs Hermes CLI locally (`hermes-paperclip-adapter`) |
| OpenClaw Gateway | `openclaw_gateway` | Connects to an OpenClaw gateway endpoint |
| [Process](/adapters/process) | `process` | Executes arbitrary shell commands |
| [HTTP](/adapters/http) | `http` | Sends webhooks to external agents |

### External (plugin) adapters

These adapters ship as standalone npm packages and are installed via the plugin system:

| Adapter | Package | Type Key | Description |
|---------|---------|----------|-------------|
| Droid Local | `@henkey/droid-paperclip-adapter` | `droid_local` | Runs Factory Droid locally |

## External Adapters

You can build and distribute adapters as standalone packages — no changes to Paperclip's source code required. External adapters are loaded at startup via the plugin system.

```sh
# Install from npm via API
curl -X POST http://localhost:3102/api/adapters \
  -d '{"packageName": "my-paperclip-adapter"}'

# Or link from a local directory
curl -X POST http://localhost:3102/api/adapters \
  -d '{"localPath": "/home/user/my-adapter"}'
```

See [External Adapters](/adapters/external-adapters) for the full guide.

## Adapter Architecture

Each adapter is a package with modules consumed by three registries:

```
my-adapter/
  src/
    index.ts            # Shared metadata (type, label, models)
    server/
      execute.ts        # Core execution logic
      parse.ts          # Output parsing
      test.ts           # Environment diagnostics
    ui-parser.ts        # Self-contained UI transcript parser (for external adapters)
    cli/
      format-event.ts   # Terminal output for `paperclipai run --watch`
```

| Registry | What it does | Source |
|----------|-------------|--------|
| **Server** | Executes agents, captures results | `createServerAdapter()` from package root |
| **UI** | Renders run transcripts, provides config forms | `ui-parser.js` (dynamic) or static import (built-in) |
| **CLI** | Formats terminal output for live watching | Static import |

## Choosing an Adapter

- **Need a coding agent?** Use `claude_local`, `codex_local`, `opencode_local`, `hermes_local`, or install `droid_local` as an external plugin
- **Need to run a script or command?** Use `process`
- **Need to call an external service?** Use `http`
- **Need something custom?** [Create your own adapter](/adapters/creating-an-adapter) or [build an external adapter plugin](/adapters/external-adapters)

## OpenRouter (OpenAI-compatible CLIs)

[OpenRouter](https://openrouter.ai) exposes many models behind a single OpenAI-compatible HTTPS API. Paperclip can map `OPENROUTER_API_KEY` into `OPENAI_API_KEY` + `OPENAI_BASE_URL` for runtimes that speak the OpenAI client protocol, and tag billing as `openrouter` when that mapping (or an explicit OpenRouter base URL) is in effect.

Built-in adapters with this behavior (each page has a **Using OpenRouter** section):

- [Codex Local](/adapters/codex-local)
- [Cursor Local](/adapters/cursor-local)
- [OpenCode Local](/adapters/opencode-local)
- [Pi Local](/adapters/pi-local)
- [Process](/adapters/process) (custom commands — same env mapping before spawn)

Adapter **environment tests** (the automatic “hello” / model probes in the Board UI) apply the same `OPENROUTER_API_KEY` → OpenAI-compatible mapping before spawning those child processes, matching real runs.

`claude_local` uses the Anthropic Claude Code CLI and native Anthropic auth — it does **not** use the OpenRouter OpenAI mapping. `gemini_local` uses the Gemini CLI and Google/Gemini credentials — use `GEMINI_API_KEY` / `GOOGLE_API_KEY` or OAuth as documented on [Gemini Local](/adapters/gemini-local).

For deploy-time env tables and edge cases (alternate base-URL keys), see [Environment variables](/deploy/environment-variables). For implementing the same pattern in a custom or external adapter, see [Creating an Adapter](/adapters/creating-an-adapter) and [External Adapters](/adapters/external-adapters).

## UI Parser Contract

External adapters can ship a self-contained UI parser that tells the Paperclip web UI how to render their stdout. Without it, the UI uses a generic shell parser. See the [UI Parser Contract](/adapters/adapter-ui-parser) for details.
