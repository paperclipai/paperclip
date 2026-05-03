---
title: PicoClaw HTTP Bridge
summary: Run PicoClaw as a Paperclip agent via the HTTP webhook adapter
---

# PicoClaw HTTP Bridge

PicoClaw runs as a standalone CLI tool (`picoclaw agent -m <prompt>`). The bridge is a small Express sidecar (~65 lines) that wraps PicoClaw for Paperclip's HTTP webhook adapter using the async 202-callback pattern.

## Architecture

```
Paperclip heartbeat scheduler
  │
  │  POST /invoke  {runId, agentId, context}
  ▼
picoclaw-bridge (localhost:4242)
  │ → 202 Accepted immediately (so Paperclip's timeoutMs doesn't fire)
  │ → execFile("picoclaw", ["agent", "-m", prompt])  (up to 5 min)
  │
  │  POST /api/heartbeat-runs/:runId/callback  {status, result, errorMessage}
  ▼
Paperclip server
  └─ resolves pending AdapterExecutionResult → closes heartbeat run
```

## Components

### 1. HTTP adapter async support (`server/src/adapters/http/`)

**`callback.ts`** — in-process promise registry. When the adapter receives a `202`, it calls `registerCallback(runId, callbackTimeoutMs)` which parks a resolver in a `Map`. When `POST /api/heartbeat-runs/:runId/callback` arrives, `resolveCallback` settles the promise and the heartbeat run completes normally.

**`execute.ts`** — added two lines to the existing synchronous HTTP adapter:
- reads `callbackTimeoutMs` from `adapterConfig` (default 300 000 ms = 5 min)
- intercepts `202` responses and awaits the callback instead of returning immediately

Existing synchronous (200) behaviour is unchanged.

### 2. Callback route (`server/src/routes/agents.ts`)

```
POST /api/heartbeat-runs/:runId/callback
Authorization: Bearer <board-or-agent-api-key>
{ "status": "succeeded" | "failed", "result": "...", "errorMessage": "..." }
```

Returns `200 { ok: true }` when the pending promise is found and resolved, `409` if no pending run exists for that ID (duplicate / stale callback), `404` if the run record doesn't exist.

### 3. Bridge server (`packages/adapters/picoclaw-bridge/src/server.ts`)

Standalone Express server. Start it alongside Paperclip:

```bash
PAPERCLIP_URL=http://localhost:3100 \
PAPERCLIP_API_KEY=<board-api-key> \
BRIDGE_API_KEY=<optional-shared-secret> \
PORT=4242 \
  pnpm --filter @paperclipai/picoclaw-bridge dev
```

| Env var | Required | Description |
|---------|----------|-------------|
| `PAPERCLIP_URL` | Yes | Base URL of the Paperclip server |
| `PAPERCLIP_API_KEY` | Yes | Board API key used to authenticate callbacks |
| `BRIDGE_API_KEY` | No | If set, the bridge checks `X-Api-Key` on incoming requests |
| `PORT` | No | Listen port (default 4242) |
| `PICOCLAW_TIMEOUT_MS` | No | Max runtime for picoclaw (default 300 000 ms) |

`buildPrompt` extracts `taskTitle`, `taskBody`, and `comments[].body` from the Paperclip context payload and concatenates them as the picoclaw prompt.

## Creating an agent

In the Paperclip UI: **Add new agent → HTTP Webhook**. Set the Webhook URL to `http://localhost:4242/invoke`.

Via API:

```json
POST /api/companies/:companyId/agents
{
  "name": "PicoClaw",
  "adapterType": "http",
  "adapterConfig": {
    "url": "http://localhost:4242/invoke",
    "timeoutMs": 10000,
    "callbackTimeoutMs": 310000
  },
  "role": "general"
}
```

`timeoutMs` governs how long Paperclip waits for the initial `202` acknowledgement. `callbackTimeoutMs` governs how long the server waits for the bridge to POST back the result (should exceed PicoClaw's max runtime).

## Getting a board API key

The bridge needs a bearer token to call back to Paperclip. Create one in **Settings → API keys**, or via:

```bash
POST /api/auth/board-api-keys
{ "name": "picoclaw-bridge" }
```

## Caveats

- The callback registry is in-process. If the Paperclip server restarts between the `202` and the callback, the promise is lost and the run will hang until `callbackTimeoutMs` elapses (it will then surface as `timed_out`).
- For production, consider a process manager (`pm2`, `systemd`) for the bridge. A single crash drops all in-flight picoclaw processes.
- PicoClaw's output is treated as plain markdown. If a future PicoClaw version adds `--json-output`, update `buildPrompt` / the success/failure detection in `server.ts` — the Paperclip callback API shape stays the same.
