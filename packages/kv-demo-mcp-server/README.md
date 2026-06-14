# KV Demo MCP Server

A standalone, self-contained MCP server for demos. One process exposes four
key/value MCP tools **and** a tiny web UI that shows the values those tools
changed — so you can call a tool from an agent and watch the value appear in a
browser.

This is intentionally a demo/fixture: state lives in an in-memory
`Map<string, string>` for the lifetime of the process. There is no database and
no persistence. Restart the process and the store is empty again.

## Local startup

From the repo root:

```sh
pnpm --filter @paperclipai/kv-demo-mcp-server build
pnpm --filter @paperclipai/kv-demo-mcp-server start
```

Or run the source directly during development:

```sh
cd packages/kv-demo-mcp-server
node --experimental-strip-types src/main.ts   # Node 22+/24
```

By default it listens on `http://127.0.0.1:8848`:

- **MCP endpoint** — `POST http://127.0.0.1:8848/mcp` (Streamable HTTP transport)
- **Values UI** — `GET http://127.0.0.1:8848/` (HTML table, auto-refreshes every 2s)
- **JSON state** — `GET http://127.0.0.1:8848/api/state`

Open the Values UI in a browser, then call `kv_set` from your MCP client — the
new row appears within ~2 seconds because the tools and the UI share the same
process state.

### Configuration

All configuration is via environment variables:

- `PORT` (or `KV_DEMO_PORT`) — listen port. Default `8848`. Use `0` for a random
  free port.
- `KV_DEMO_HOST` — bind host. Default `127.0.0.1`.
- `KV_DEMO_TOKEN` — optional shared secret (see below).

## Tools

- `kv_set` (write) — set a key to a string value.
- `kv_get` (read) — get the current value for a key.
- `kv_list` (read) — list all keys/values, optionally filtered by key `prefix`.
- `kv_delete` (destructive) — delete a key.

## Optional token behavior

For local development the server is unauthenticated by default — anything that
can reach the port can call the tools and read the values.

Set `KV_DEMO_TOKEN` to require a shared secret on **every** route (`/mcp`,
`/api/state`, and `/`). Requests must present it either as:

- an `Authorization: Bearer <token>` header, or
- a `?token=<token>` query parameter.

```sh
KV_DEMO_TOKEN=my-demo-secret pnpm --filter @paperclipai/kv-demo-mcp-server start
```

To view the UI in a browser when a token is set, append it to the URL —
`http://127.0.0.1:8848/?token=my-demo-secret`. The page forwards that token to
its `/api/state` polling requests. This token is a convenience guard for local
demos, not a hardened auth scheme; don't expose this server to untrusted
networks.

## State lifetime

State is held entirely in memory for the life of the process:

- No file or database is written.
- The store starts empty on every launch.
- Stopping or restarting the process clears all values.

## Connecting from Paperclip

Run this server, then add it in Paperclip via Apps → Advanced ("run your own")
as a remote HTTP MCP server pointing at `http://127.0.0.1:8848/mcp` (include the
token header if `KV_DEMO_TOKEN` is set). Keep the Values UI open in a browser tab
to watch tool calls land in real time.
