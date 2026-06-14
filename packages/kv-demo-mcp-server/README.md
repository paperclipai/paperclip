# KV Demo MCP Server

A standalone, self-contained MCP server for demos. One process exposes four
key/value MCP tools **and** a tiny web UI that renders the values those tools
mutate — so you can call a tool from a Paperclip agent and watch the value
appear in a browser tab.

The shared in-memory store is the whole point: the same `Map<string, string>`
backs every tool call and every UI render. There is no database, no file, no
persistence. Restart the process and the store is empty again. That makes this
the right fixture for showing what Paperclip stores versus what the demo
package stores — the package stores the values, Paperclip stores the
connection, the profile/policy decisions, and the audit log.

This package pairs with the operator guide in
[doc/MCP-ACCESS-GOVERNANCE.md](../../doc/MCP-ACCESS-GOVERNANCE.md) and the
recorded walkthrough in [doc/MCP-DEMO-SCRIPT.md](../../doc/MCP-DEMO-SCRIPT.md).

## What you get

- Four MCP tools (over the Streamable HTTP transport):
  - `kv_list` (read) — list every key/value, optionally filtered by `prefix`.
  - `kv_get` (read) — read one key.
  - `kv_set` (write) — set one key to a string value.
  - `kv_delete` (destructive) — delete a key. Carries `destructiveHint: true`
    so Paperclip's catalog quarantines it on first sight.
- A Values UI at `/` — an auto-refreshing HTML table over the same store.
- A JSON state route at `/api/state` — what the UI polls.

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

By default it listens on `http://127.0.0.1:8848` and prints three URLs to
stderr on startup:

- **MCP endpoint** — `POST http://127.0.0.1:8848/mcp` (Streamable HTTP)
- **Values UI** — `GET http://127.0.0.1:8848/` (auto-refreshes every 2s)
- **JSON state** — `GET http://127.0.0.1:8848/api/state`

Open the Values UI in a browser tab and keep it visible. Every successful
`kv_set` / `kv_delete` lands in that table within ~2 seconds.

### Configuration

All configuration is via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` (or `KV_DEMO_PORT`) | `8848` | Listen port. Use `0` for a random free port. |
| `KV_DEMO_HOST` | `127.0.0.1` | Bind host. Use `0.0.0.0` to accept connections from another machine on the LAN. |
| `KV_DEMO_TOKEN` | unset | Optional shared secret. When set, every route requires it. |

When `KV_DEMO_TOKEN` is set, present it either as `Authorization: Bearer
<token>` or as `?token=<token>` on the URL. The token is a convenience guard
for local demos, not a hardened auth scheme; do not expose this server to
untrusted networks.

## Connecting from Paperclip

The KV demo is meant for the `remote_http` connection path. The server speaks
Streamable HTTP at `/mcp`, runs in a single process so the Values UI and the
MCP tools share state, and listens on a fixed loopback port. Paperclip's
remote-HTTP gateway proxies every call through policy and audit while leaving
process supervision to you (just `Ctrl+C` the server when you are done).

### Via the Connect-an-app wizard (recommended)

1. Open the company's Tools UI at `/<prefix>/companies/<companyId>/tools`.
2. Go to **Connect an app** and pick **Connect with a link**.
3. Paste `http://127.0.0.1:8848/mcp` and give it a name (e.g. "KV demo").
4. If you launched the server with `KV_DEMO_TOKEN`, paste the token in the
   **App key** field. The wizard stores it as an `Authorization: Bearer …`
   header secret.
5. Pick the profile defaults (read/write/destructive) and finish. Paperclip
   imports the four tools and quarantines `kv_delete`.

The wizard hits this API under the hood:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/apps/connect" \
  -d '{
    "link": "http://127.0.0.1:8848/mcp",
    "name": "KV demo"
  }'
```

If a token is set, add the `credentialValues` block:

```json
{
  "link": "http://127.0.0.1:8848/mcp",
  "name": "KV demo",
  "credentialValues": {
    "credentials.authorization": "my-demo-secret"
  }
}
```

### Transport tradeoffs

- **`remote_http` (recommended for this demo)** — required if you want the
  Values UI to reflect what the agent just did. The KV demo intentionally
  holds state in one process and exposes both the MCP endpoint and the UI
  from that process. Paperclip's `remote_http` gateway forwards every call to
  the same loopback URL, so the UI always sees the same store the tools
  mutated.
- **`local_stdio` (not used here)** — runs MCP servers as supervised child
  processes inside Paperclip's runtime slots. Reserved for *trusted local
  deployments* (developer laptop, `local_trusted` or
  `authenticated/private` with `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` set on a
  single trusted worker). Each runtime slot has its own process, which would
  give each slot its own in-memory store — you would lose the shared-state
  property that makes this demo work. Use the approved stdio templates that
  ship in the Paperclip build when you need stdio; do not try to shoehorn
  this server into a local-stdio template.

For the full transport policy across deployment modes, see
[MCP-ACCESS-GOVERNANCE.md → Local trusted deployment](../../doc/MCP-ACCESS-GOVERNANCE.md#local-trusted-deployment).

## What you should see in Paperclip

After the wizard finishes, expect:

- **Catalog** — four tools imported from this connection. `kv_list` and
  `kv_get` are tagged `read`; `kv_set` is tagged `write`; `kv_delete` is
  tagged `destructive` and starts in `quarantined` status.
- **Tools panel** on an agent — `kv_list`, `kv_get`, and (with the default
  ask-first policy) `kv_set`. `kv_delete` is not listed until you take it
  out of quarantine.
- **Audit feed** — one row per call. Reads show
  `tool_gateway.call_completed` with `decision: allow`. Writes that hit the
  default ask-first policy show `tool_gateway.approval_requested` followed
  by `tool_gateway.call_allowed` and `tool_gateway.call_completed` once you
  approve. Calls to `kv_delete` show `tool_gateway.call_denied` with
  `reasonCode: quarantined_catalog_entry`.

The recorded walkthrough in [doc/MCP-DEMO-SCRIPT.md](../../doc/MCP-DEMO-SCRIPT.md)
runs all three cases end-to-end against this package and matches the audit
rows above.

## What lives where

| Concern | Stored in this package | Stored in Paperclip |
| --- | --- | --- |
| Key/value entries (`kv_*` data) | In-memory `Map`, lost on restart. | Not stored. Paperclip never sees the values directly; the gateway only sees the MCP request/response envelope and the redacted-by-policy view the audit log keeps. |
| Connection record (URL, token, transport) | Not stored. | Persisted in `tool_connections`. The optional token becomes a secret. |
| Profile / policy / binding decisions | Not stored. | Persisted under `tool_profiles`, `tool_policies`, and `tool_profile_bindings`. |
| Approval action requests | Not stored. | Persisted under `tool_action_requests`, linked to issue-thread interactions. |
| Audit rows for each call | Not stored. | Persisted under `tool_call_events`. Append-only. |

## Cleanup and reset

Resetting the demo state usually means resetting this process; Paperclip's
records stay intact unless you also archive the connection.

- **Empty the KV store** — `Ctrl+C` (or `kill`) the server and start it
  again. The new process starts with zero keys and revision `0`. There is no
  in-process reset endpoint by design; restart is the single supported
  reset.
- **Free the port** — if startup logs `EADDRINUSE`, another `kv-demo`
  process is still bound to `8848`. Find and kill it:

  ```sh
  lsof -nP -iTCP:8848 -sTCP:LISTEN
  kill <pid>
  ```
- **Quiesce the Paperclip side** — disable the connection so the gateway
  stops trying to reach the now-stopped server:

  ```sh
  curl -fsS -X PATCH \
    -H "Authorization: Bearer $BOARD_API_KEY" \
    -H "Content-Type: application/json" \
    "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID" \
    -d '{ "enabled": false, "status": "disabled" }'
  ```
- **Archive the application** when you are fully done. Audit history is
  retained, but no new calls can land:

  ```sh
  curl -fsS -X PATCH \
    -H "Authorization: Bearer $BOARD_API_KEY" \
    -H "Content-Type: application/json" \
    "$PAPERCLIP_URL/api/tool-applications/$APPLICATION_ID" \
    -d '{ "status": "archived" }'
  ```

The KV demo is a fixture, not a piece of infrastructure. Treat each session
as disposable: start it, run the demo, kill it.
