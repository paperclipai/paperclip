# MCP Protocol Versions in Paperclip's MCP Client

Audience: engineers changing how Paperclip calls providers' remote (Streamable
HTTP) and local (stdio) MCP servers.

Paperclip's MCP client speaks the stateless revision **2026-07-28** and stays
compatible with handshake-based servers on **2025-11-25**, **2025-06-18**, and
older. Paperclip's own public MCP server is covered separately in
`server/src/routes/public-mcp.ts`.

Code: `server/src/services/mcp-http.ts` (protocol helpers),
`server/src/services/tool-access/catalog/discovery.ts` (catalog `tools/list`),
and `server/src/services/tool-gateway.ts` (`tools/call`, context reads, stdio).

## Two eras

| | Modern (2026-07-28+) | Legacy (2025-11-25 and earlier) |
| --- | --- | --- |
| Setup | none | `initialize` + `notifications/initialized` |
| Session | none, never sends `Mcp-Session-Id` | `Mcp-Session-Id` when the server issues one |
| Version and capabilities | in every request's `params._meta` | once, in `initialize` |
| HTTP headers | `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*` | `MCP-Protocol-Version` (after the handshake), `Mcp-Method`, `Mcp-Name` |
| Server asks for input | `resultType: "input_required"` result (MRTR) | `elicitation/create` request on the SSE stream, or error `-32042` |

Every modern request carries:

```json
"_meta": {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {
    "elicitation": { "url": {} },
    "extensions": { "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } }
  },
  "io.modelcontextprotocol/clientInfo": { "name": "paperclip", "version": "1" }
}
```

The MCP Apps extension (`io.modelcontextprotocol/ui`) is also in the legacy
`initialize` capabilities, so both eras learn that Paperclip renders MCP Apps
views (see [MCP-APPS.md](./MCP-APPS.md)). Only modern requests declare URL
elicitation, because only that era has a retry path for it (below).

## Negotiation

1. **Probe once per server.** `negotiateMcpProtocolVersion` sends
   `server/discover` with the preferred modern version in `_meta`.
   - A `DiscoverResult` gives `supportedVersions`; Paperclip picks the newest
     version it also supports (`selectMcpProtocolVersion`).
   - A modern error (`-32020`, `-32021`, `-32022`) also identifies a modern
     server. `-32022` lists `supported` versions to choose from.
   - Anything else (another error, an empty `202`, a non-JSON body, a network
     error) identifies a legacy server, which gets the `initialize` handshake.
   - `401`/`403` is returned to the caller unchanged, so OAuth discovery still
     sees the `WWW-Authenticate` challenge.
2. **Remember the answer.** The result is cached in memory per connection and
   endpoint (`mcpEraKey`) for 24 hours and saved on the connection as
   `config.mcpProtocolVersion` by catalog refresh. For a legacy server the
   saved value is the version Paperclip requests in `initialize`
   (`MCP_PROTOCOL_VERSION`), not the version the server answered with.
3. **Tool calls never probe.** `tools/call` and context reads use the saved
   version. A stateless server is called directly, so a tool call is one HTTP
   request with no handshake. This keeps agent boot and time to first token
   unchanged.
4. **Re-probe only on failure.** The saved era is checked again when a request
   built from it is refused:
   - A modern rejection (`400` with `-32020`/`-32021`/`-32022`) of a request
     Paperclip sent in legacy shape: the server is probed and the request is
     sent once more in modern shape. The server rejected it before running
     anything, so the retry cannot repeat a side effect.
   - `-32022` on a modern request: retried once with a version from the
     server's `supported` list, using the handshake when that version is older.
   - A plain `400` to a stateless `tools/call`: the server is probed and the
     saved version is repaired (handshake, session required), but the call is
     not sent again, because a plain `400` does not prove the tool never ran.
     The next explicit call uses the handshake. Context reads, which are
     read-only, are sent again.
   - A remembered legacy server that now refuses `initialize` (`400`/`404`/`405`):
     probed again before the call fails.
   - Catalog refresh that gets `400` with a saved version: probed again and
     listed once more (listing is read-only).

**stdio** follows the stdio backward-compatibility rule: send `server/discover`
first; a `DiscoverResult` or modern error means modern, anything else or no
answer within 2 seconds means legacy. A server that exits on the unknown method
is started again for the handshake. The result is remembered per connection and
template, because Paperclip starts a process for each call. A remembered
handshake server that refuses `initialize` (for example after an upgrade to
stateless MCP) is probed again once.

## Results

- A result without `resultType` is `"complete"` (all legacy results).
- `"input_required"` on `tools/call`:
  - URL elicitation requests: shown as the provider link
    (`provider_interaction_required`, the same flow as legacy URL elicitation,
    up to 8 links). Paperclip never answers them on the person's behalf: no
    person action is recorded, so sending `accept` would claim consent nobody
    gave. The next call goes out fresh, and the server, which tracks the
    out-of-band step itself, completes it or asks again.
  - Only `requestState` (for example load shedding): kept in memory for 30
    minutes and sent on the next identical call (same connection, grant,
    agent, tool, and arguments) with a new JSON-RPC id. It survives an attempt
    the server rejected (for example a `401` before a token refresh). The call
    stops with `provider_retry_requested` so the agent retries.
  - Form requests only, on a call that belongs to a task: a question card in
    the task chat; the repeated call sends `inputResponses` and the exact
    `requestState`. See [MCP-ELICITATION.md](./MCP-ELICITATION.md). Form
    beside a URL request: the link goes first.
  - Sampling or roots requests, form requests outside a task, or more than 8
    links: the call stops with `provider_input_required` and the message
    "This app needs information Paperclip can't collect yet." Paperclip
    declares form only on task calls and never declares sampling or roots,
    so compliant servers should not send them.
- `"input_required"` on a context read (`resources/read`, `prompts/get`) or a
  stdio call stops with `provider_input_required`.
- Resource not found is `-32602` from modern servers and `-32002` from legacy
  ones. Both surface as `remote_mcp_error` with the code in the details.

## Caching

`tools/list`, `resources/list`, `resources/read`, `resources/templates/list`,
and `prompts/list` results with `ttlMs > 0` are reused while fresh, capped at
10 minutes. `cacheScope: "private"` results are keyed by the credential that
read them; `"public"` results are shared by every credential on the same
connection, never across connections. Results of retries that carried
`inputResponses` or `requestState` are never cached. Results without `ttlMs`
(every legacy server) are not cached, so legacy behavior is unchanged.

Catalog refresh returns a fresh cached tool list without contacting the server.
Health checks always list live, so an outage or a revoked credential is never
hidden by a cached list. Catalog refresh saves the version its last successful
request actually used, including after a credential refresh.
Nothing is fetched ahead of time, so caching never adds work before an agent's
first token.

## `x-mcp-header`

A tool whose `inputSchema` marks properties with `x-mcp-header` gets those
argument values mirrored into `Mcp-Param-{Name}` headers on `tools/call`.
Values that are not plain ASCII, have leading or trailing spaces, or look like
the sentinel are sent as `=?base64?…?=`. Catalog refresh drops (and logs) a tool
whose annotations break the rules: not on a `properties` path, not a string,
integer, or boolean, not an HTTP token, or not unique.

## OAuth (2026-07-28 authorization changes)

- **RFC 9207 `iss`.** The issuer from validated metadata is recorded when
  sign-in starts (`expectedIssuer`). A returned `iss` must match it, on success
  and on error responses; a provider error with a mismatched `iss` is not acted
  on or shown. When the authorization server advertises
  `authorization_response_iss_parameter_supported`, a callback without `iss`
  is refused (`oauth_issuer_missing`).
- **Client registration order.** Preconfigured client, then Client ID Metadata
  Document when the server advertises `client_id_metadata_document_supported`,
  then Dynamic Client Registration (deprecated in 2026-07-28, kept for older
  servers).
- **`application_type`.** Sent in DCR and in the metadata document: `web` for
  Paperclip's HTTPS callback, `native` for a local install's localhost callback.
- **Issuer binding.** Registered client material is bound to the issuer,
  resource, callback, and company, and a different issuer registers again.

## Not yet supported

Tracked as follow-ups:

- Recording that a person finished a provider URL step, so Paperclip can
  answer it with `accept` and the provider's `requestState`.
- Retrying a `requestState`-only result automatically instead of asking the
  agent to retry.
- `subscriptions/listen` change notifications (cache invalidation relies on
  `ttlMs`).
- The Tasks extension, Skills over MCP, progress and cancellation, icons, and
  enterprise-managed authorization.
