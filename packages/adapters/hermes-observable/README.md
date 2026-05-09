# Hermes Observable Adapter

`@paperclipai/adapter-hermes-observable` runs Hermes through the Hermes gateway
API instead of scraping CLI stdout. That makes Paperclip progress durable and
observable without patching Hermes internals, Paperclip UI internals, or TTY
formatting.

## Why This Is More Stable Than CLI Parsing

- The adapter consumes structured SSE events from Hermes instead of inferring
  state from quiet-mode terminal output.
- Tool lifecycle correlation uses tool call ids when Hermes provides them.
- Assistant text deltas stream directly into Paperclip transcript events.
- Unknown SSE events are ignored safely and can be surfaced in debug mode.
- A watchdog line is emitted while a run is active so Paperclip no longer looks
  frozen during long tool execution.

## Registration

This branch already registers the adapter as a built-in Paperclip adapter:

- Server: `server/src/adapters/registry.ts`
- UI: `ui/src/adapters/registry.ts`

If you need to wire it manually in another Paperclip checkout, add:

```ts
import {
  execute,
  testEnvironment,
  sessionCodec,
  listSkills,
  syncSkills,
  detectModel,
  getConfigSchema,
} from "@paperclipai/adapter-hermes-observable/server";
import {
  agentConfigurationDoc,
  models,
} from "@paperclipai/adapter-hermes-observable";
```

and register `hermes_observable` in the server adapter registry plus the UI
adapter registry.

## Example Agent Config

```json
{
  "adapterType": "hermes_observable",
  "adapterConfig": {
    "hermesApiBaseUrl": "http://127.0.0.1:8000",
    "endpointMode": "responses",
    "model": "anthropic/claude-sonnet-4",
    "provider": "auto",
    "timeoutSec": 300,
    "heartbeatSec": 30,
    "debugEvents": false,
    "allowCliFallback": false
  }
}
```

## Setup

The adapter expects a Hermes gateway API server at `hermesApiBaseUrl`.

Minimum local setup:

```bash
pip install hermes-agent
API_SERVER_ENABLED=1 API_SERVER_PORT=8000 hermes gateway
curl -s http://127.0.0.1:8000/health
curl -s http://127.0.0.1:8000/v1/capabilities
```

## Stream Harness

Use the small harness to watch raw gateway events and the parsed event names:

```bash
pnpm exec tsx packages/adapters/hermes-observable/scripts/stream-harness.ts \
  --base-url http://127.0.0.1:8000 \
  --mode responses \
  --input "Summarize the current workspace status."
```
