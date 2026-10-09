# Live console Protocol and Demo Server

## Scope

This is the lowest Live console layer. It extends the package-local Codex driver,
typed harness contract, deterministic fixtures, and mock-core demo server. It
does not import or change Paperclip server, UI, database, or production routes.

The browser boundary is HTTP plus server-sent events. The browser sends typed
actions to the demo server. Only the server starts `codex app-server`, reads
the existing Codex login, owns the working directory, and resumes provider
threads. No provider or Paperclip credential is serialized to browser state.

## Deterministic fixture

`protocol/fixtures/codex-driver/driver-conformance.json` records the exact Codex
0.132.0 wire shapes used by conformance tests:

- command, file, permission, user-input, and MCP elicitation requests;
- accept, accept-for-session, decline, cancel, and submitted answers;
- goal get, set, pause, resume, and clear calls;
- subagent parent/child thread source metadata;
- same-turn and stale-turn controls;
- interrupt-before-start and terminal-race outcomes;
- stable reconnect identities and source cursor; and
- hostile diagnostic strings that must be redacted.

The fixture loader rejects missing cases, duplicate request identities,
incomplete goal operations, and incomplete lineage or recovery identity.

## Browser-resolved requests

The driver no longer automatically declines supported runtime requests. It
emits `runtime_request.created`, keeps the JSON-RPC response pending, and waits
for `resolveRuntimeRequest`.

| Upstream request | Canonical kind | Allowed response shape |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | `command_approval` | accept, session accept, decline, cancel |
| `item/fileChange/requestApproval` | `file_approval` | accept, session accept, decline, cancel |
| `item/permissions/requestApproval` | `permission_approval` | empty safe permission grant for turn or session |
| `item/tool/requestUserInput` | `user_input` | typed answer map, decline, cancel |
| `mcpServer/elicitation/request` | `elicitation` | typed content, decline, cancel |

The permission response cannot widen the skillless filesystem or network
boundary. A stale turn, duplicate response, provider cleanup, terminal turn,
protocol failure, close, or reconnect settles the pending request exactly once.
Only the resolution action enters the canonical event; submitted secrets or
answers do not enter the acknowledgement payload.

## Steering and interruption

Successful same-turn steering emits a completed
`steering_acknowledgement` item. A different or child identity is rejected
with `HarnessStaleTurnError` and `stale_turn_rejected`; direct child steering
is never emulated.

An interrupt received while `turn/start` is waiting for a provider turn ID is
queued and sent as soon as the ID arrives. After a terminal fact wins the race,
further steering or interruption returns `already_terminal`. A successful
interrupt request emits an `interrupt_acknowledgement` item without replacing
the session.

## Goals and lineage

The driver probes `thread/goal/get` after create or resume. Success enables
get, set, pause, resume, and clear. A method-not-found response disables goals
and advertises the precise unsupported capability. The installed Codex 0.132.0
binary generated goal bindings but did not enable the method at runtime in the
recorded real session, so the evidence correctly shows `goals: false`.

Root and child threads use `thread.id`, `thread.sessionId`, `forkedFromId`, and
`source.subAgent.thread_spawn` to build lineage. Child start, status, and close
notifications become canonical `thread_lineage` items. Unrelated thread
notifications are ignored instead of being attached to the active session.

## Demo-server API

Start it with:

```sh
pnpm --filter @paperclipai/paperclip-runner demo:live-console -- \
  --host 127.0.0.1 --port 4174
```

The transport fails before binding unless `--host` is an explicit loopback
address. The standalone server and Vite middleware use the same admission
guard. It requires loopback local and remote sockets, the exact configured
loopback `Host` plus listening port, same-origin Fetch Metadata, a matching
browser `Origin` on mutations and streams, and `application/json` on every
mutation. Server-side automation uses a random per-launch bearer capability;
it is never returned by an API response or browser state.

Important routes:

- `GET /api/liveConsole/health`
- `POST /api/liveConsole/sessions`
- `GET /api/liveConsole/sessions/:id`
- `GET /api/liveConsole/sessions/:id/events?after=:cursor`
- `GET /api/liveConsole/sessions/:id/stream?after=:cursor`
- `POST /api/liveConsole/sessions/:id/steer`
- `POST /api/liveConsole/sessions/:id/interrupt`
- `POST /api/liveConsole/sessions/:id/requests/:requestId/resolve`
- `POST /api/liveConsole/sessions/:id/goal/:operation`
- `POST /api/liveConsole/sessions/:id/reconnect`
- `POST /api/liveConsole/sessions/:id/close`

The server chooses the working directory. A create body cannot override it.
Provider, Paperclip, cookie, and bearer credential fields in create bodies are
rejected. Runtime-request resolution must match the pending request, its turn,
and the session named by the route; stale, cross-scope, and duplicate responses
fail with `409` before reaching the driver.
Every JSON and event response passes a second bounded redaction layer. Replay
uses the same validated PRP events and reducer as the live view.

The demo keeps at most 16 active sessions and four SSE subscribers per session
by default. Call the close route (the browser does this on reset) to release a
session immediately; server shutdown closes every remaining session and
subscriber. Configuration may lower these limits and is hard-capped at 64
sessions and 16 subscribers.

Residual risk: a loopback service is still reachable by untrusted local
processes, which can reproduce browser headers. The Codex sandbox and approval
policy remain the final execution boundary; this demo transport is not a
multi-user authorization boundary.

## Verification

Run deterministic conformance first, then the real Codex boundary:

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/drivers/codex/codex-app-server-driver.test.ts \
  src/mock-core/live-console-demo-server.test.ts
```
