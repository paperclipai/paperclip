# Live console: Run the Protocol Demo Server

## What this is

This tutorial runs the Live console server layer. It has no browser UI yet. You can
use `curl` to act like the browser.

The server starts Codex. Codex login data stays on the server. The JSON replies
must not contain a Paperclip key, an OpenAI key, or a bearer value.

## Step 1: Run deterministic checks

From the repository root, run:

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/drivers/codex/codex-app-server-driver.test.ts \
  src/mock-core/live-console-demo-server.test.ts
```

Expected result: both files pass. The tests cover requests, goals, lineage,
steering, interrupt races, reconnect, replay, and redaction.

## Step 2: Start the server

Use an empty directory outside your Codex home:

```sh
liveConsole_workspace="$(mktemp -d)"
pnpm --filter @paperclipai/paperclip-runner demo:live-console -- \
  --host 127.0.0.1 \
  --port 4174 \
  --working-directory "$liveConsole_workspace"
```

Keep this terminal open. The first output line is JSON. It names the host,
port, and server-owned working directory. It also says
`"credentialsExposed":false`.

## Step 3: Check the boundary

In a second terminal, run:

```sh
curl -s http://127.0.0.1:4174/api/liveConsole/health \
  -H 'Origin: http://127.0.0.1:4174' \
  -H 'Sec-Fetch-Site: same-origin' | jq
```

Expected facts:

- `status` is `ok`;
- `boundary` is `package-local-mock-core`;
- `providerAuthentication` is `server-side`; and
- `credentialsExposed` is `false`.

## Step 4: Start one safe session

```sh
curl -s -X POST http://127.0.0.1:4174/api/liveConsole/sessions \
  -H 'Origin: http://127.0.0.1:4174' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'content-type: application/json' \
  --data '{"objective":"Create demo.txt with exactly: liveConsole demo","message":"Complete and verify the exact file task."}' \
  | tee "$liveConsole_workspace/session.json" | jq
```

Copy `sessionId` and `activeTurnId` from the reply. The server ignores a
browser-supplied working directory and rejects browser-supplied credential
fields.

## Step 5: Read live or replayed events

```sh
session_id="$(jq -r .sessionId "$liveConsole_workspace/session.json")"
curl -s "http://127.0.0.1:4174/api/liveConsole/sessions/$session_id/events?after=0" \
  -H 'Origin: http://127.0.0.1:4174' \
  -H 'Sec-Fetch-Site: same-origin' | jq
```

The reply contains canonical PRP events and a cursor. A later request can pass
that cursor as `after`. The same events go through the same reducer during live
view and replay.

For a live stream, run:

```sh
curl -N "http://127.0.0.1:4174/api/liveConsole/sessions/$session_id/stream?after=0" \
  -H 'Origin: http://127.0.0.1:4174' \
  -H 'Sec-Fetch-Site: same-origin'
```

## Step 6: Reconnect the same session

```sh
curl -s -X POST \
  "http://127.0.0.1:4174/api/liveConsole/sessions/$session_id/reconnect" \
  -H 'Origin: http://127.0.0.1:4174' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'content-type: application/json' --data '{}' | jq
```

Confirm that `runId`, `normalizedSessionId`, `driverSessionId`, and
`providerSessionId` did not change. The new events include `session.resumed`.

The repeated browser headers are intentional admission evidence. DNS-rebinding
Hosts, cross-origin or missing Fetch Metadata, wildcard binds, and simple
`text/plain` mutations are rejected. This protects the browser boundary, but
untrusted local processes can still make loopback requests; Codex sandbox and
approval policy remain the final execution boundary.
