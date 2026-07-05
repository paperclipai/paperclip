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
| [Claude Code](/adapters/claude-local) | `claude_local` | Runs Claude Code CLI locally |
| [Codex](/adapters/codex-local) | `codex_local` | Runs OpenAI Codex CLI locally |
| ACPX Local | `acpx_local` | Runs Claude, Codex, or a custom ACP agent through ACPX with live structured event streaming |
| [Gemini CLI](/adapters/gemini-local) | `gemini_local` | Runs Gemini CLI locally (experimental — adapter package exists, not yet in stable type enum) |
| OpenCode | `opencode_local` | Runs OpenCode CLI locally (multi-provider `provider/model`) |
| Cursor | `cursor` | Runs Cursor in background mode |
| Pi | `pi_local` | Runs an embedded Pi agent locally |
| Hermes | `hermes_local` | Runs the local Hermes CLI through `@paperclipai/hermes-paperclip-adapter` |
| Hermes Gateway | `hermes_gateway` | Calls an already-running Hermes API server through `@paperclipai/hermes-paperclip-adapter/gateway` |
| OpenClaw Gateway | `openclaw_gateway` | Connects to an OpenClaw gateway endpoint |
| [Process](/adapters/process) | `process` | Executes arbitrary shell commands |
| [HTTP](/adapters/http) | `http` | Sends webhooks to external agents |

### Hermes local vs gateway

Use `hermes_local` when Paperclip should start the local `hermes` CLI on the
same host for each heartbeat. Use `hermes_gateway` when Hermes is already
running as an HTTP/SSE API server and Paperclip should call that server instead
of spawning a process. Both type keys are stable built-ins.

The unified Hermes package owns both built-in adapters. The older
`@paperclipai/adapter-hermes-gateway` package remains only as a deprecated
compatibility shim that re-exports the gateway entrypoints for one release.
New plugin overrides should target `@paperclipai/hermes-paperclip-adapter` and
set the desired type key (`hermes_local` or `hermes_gateway`).

### External (plugin) adapters

These adapters ship as standalone npm packages and are installed via the plugin system:

| Adapter | Package | Type Key | Description |
|---------|---------|----------|-------------|
| Droid | `@henkey/droid-paperclip-adapter` | `droid_local` | Runs Factory Droid locally |

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

- **Need a coding agent?** Use `claude_local`, `codex_local`, `acpx_local`, `opencode_local`, `hermes_local`, or install `droid_local` as an external plugin
- **Need the richest live run feedback (especially for sandbox workers)?** Use `acpx_local` — see [Feedback granularity](#feedback-granularity)
- **Need Hermes on another host or already running as a service?** Use `hermes_gateway`
- **Need to run a script or command?** Use `process`
- **Need to call a custom external service?** Use `http`
- **Need something custom?** [Create your own adapter](/adapters/creating-an-adapter) or [build an external adapter plugin](/adapters/external-adapters)

## Feedback Granularity

Adapter choice determines how much structured, live detail a run's transcript can show while the agent is still working. Every adapter's stdout is streamed to the run log and rendered live in the UI — including runs on sandbox execution targets, whose logs are tailed and delivered incrementally — but the *granularity* of what you see depends on the event stream the adapter emits.

Rough tiers, richest first:

1. **`acpx_local` — full structured event stream.** ACPX emits a JSONL event per meaningful runtime moment: `acpx.session` (agent, mode, session identity), `acpx.status` (progress text plus context-window usage), `acpx.text_delta` (assistant/thinking token deltas), `acpx.tool_call` (tool title, call id, and status updates as the call progresses), `acpx.result` (stop reason summary), and `acpx.error` (code, message, retryability). The transcript renders these as live-updating message, thinking, tool, and status blocks, and repeated `acpx.tool_call` status updates fold into a single tool card instead of stacking duplicates.
2. **CLI wrappers (`claude_local`, `codex_local`, `cursor`, `opencode_local`, …).** These parse each CLI's own streaming JSON output. You get assistant text, tool calls/results, and a final usage/cost summary, but granularity is limited to what the CLI prints — some emit tool progress, others only call/finish pairs.
3. **Generic adapters (`process`, `http`).** Plain stdout/stderr lines with no structured transcript — you see raw output only.

**Recommendation:** for sandbox workers, prefer `acpx_local`. Sandbox run logs are streamed live, so the richer the event stream, the more useful the live transcript and status line are while a remote run is in flight. ACPX's status events (including context usage) and incremental tool-call updates give the closest thing to watching the agent work locally.

## UI Parser Contract

External adapters can ship a self-contained UI parser that tells the Paperclip web UI how to render their stdout. Without it, the UI uses a generic shell parser. See the [UI Parser Contract](/adapters/adapter-ui-parser) for details.
