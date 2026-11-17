# Google Workspace REST tools

Paperclip's own implementation of the tools that Google's hosted Workspace MCP
servers expose (for example `https://gmailmcp.googleapis.com/mcp/v1`), backed
by Google's generally available REST APIs.

This release has three Gmail tools: `get_message`, `search_threads` and
`create_draft`. There is no send tool, and none may be added.

## Why this exists, and why it is temporary

Google's Workspace MCP servers are a Developer Preview and cannot be offered to
the public. On 2026-11-17 the owner decided that Paperclip will launch on its
own tools over the REST APIs. The tools are built so Paperclip can switch to
Google's MCP servers later without a rewrite, and they live in this one folder
so they can be deleted cleanly when that happens.

## Boundary rules

- **Same tools as Google's MCP servers.** Same tool names, same input fields,
  same result shape. Names, field names, types and enums come from Google's
  published reference (Gmail:
  <https://developers.google.com/workspace/gmail/api/reference/mcp>, recorded
  2026-11-17). Where REST cannot match, the difference is listed below.
- **Public surface is MCP only.** `src/index.ts` exports tool definitions
  (`Tool`), results (`CallToolResult`), an MCP server, and the MCP error thrown
  for token problems. No Google REST type is exported.
- **Knows nothing about Paperclip.** No company, connection, grant, policy,
  audit, approval or screening code, and no imports from `server/` or `ui/`.
  Input is a service, a tool name, arguments and an access token. Output is an
  MCP result. Authorization, scope checks, approval, audit and injection
  screening stay with their current owners in the gateway. The only Paperclip
  import is in `src/allowlist.test.ts`, a test-only dev dependency.
- **Stores nothing.** No tokens, no content, no cache. The access token is used
  for one call and dropped.
- **One file calls Google.** `src/google-http.ts` is the only place that calls
  `googleapis.com`. It sets the bearer header, allows only listed hosts,
  bounds each request (20 s deadline, 20 MB response, including the body
  read), maps Google errors, and retries a read (GET) once after a network
  error or HTTP 502/503/504. **It never retries a write.** A write that fails
  after it was sent (network error, dropped connection, timeout, caller
  cancellation or HTTP 5xx) says that the change may or may not have been made.
- **One tool, one file.** Each tool in `src/gmail/` is a set of pure functions
  (arguments to REST request, REST response to MCP result) plus a short `run`
  that sequences them. The pure functions are unit tested without network.
- **`src/server.ts` is thin MCP wiring:** `tools/list` and `tools/call`.
- **The allowlist stays where it is.** `toolScopes` in
  `packages/shared/src/google-workspace-connectors.ts` is the single list of
  allowed Google tools. `src/allowlist.test.ts` fails if this package
  implements a tool that is not on it, or if a tool's read-only hint disagrees
  with the allowlist's write flag.

### Errors

| Google answer | Result |
| --- | --- |
| 401 | Throws `GoogleWorkspaceAuthError` (`reason: "unauthenticated"`, JSON-RPC `data: { code: "unauthenticated", httpStatus: 401 }`) |
| 403 with insufficient scope (`ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `insufficientPermissions`, or `WWW-Authenticate: error="insufficient_scope"`) | Throws `GoogleWorkspaceAuthError` (`reason: "insufficient_scope"`, `data.code: "insufficient_scope"`, the value the gateway already recognizes) |
| 403 API not enabled (`SERVICE_DISABLED`, `accessNotConfigured`) | Tool error result, without the project number |
| Other 403, 404, 400, 429, 5xx, timeout, network failure | Tool error result (`isError: true`) with a short message |
| Invalid arguments | Tool error result, no request sent |
| Unknown tool | Throws `McpError` `InvalidParams` |

Token problems are thrown, not returned, so a caller can refresh the token or
ask the user to reconnect exactly as it does for Google's MCP servers.

## How it plugs in (seam trace)

Traced on `origin/master` at `ca34aca777`.

### Today's dispatch path

1. **Tool name to target.** `googleWorkspaceToolTarget(name)` in
   `packages/shared/src/google-workspace-connectors.ts` turns `gmail__get_message`
   into `{ service, upstreamName, leaf, serverUrl, appSlug, requiredScopes, write }`.
   `serverUrl` comes from the closed `SERVICE_PROFILES` registry.
2. **Discovery (`tools/list`).** `remoteTools()` in
   `server/src/services/tool-access/catalog/discovery.ts` (Google branch near
   line 130) lists each granted service by calling itself with
   `profile.serverUrl`, prefixes names with `googleWorkspaceToolName(service, …)`,
   and filters by the granted scopes. It speaks MCP over HTTP through
   `requestRemoteHttpEndpoint`, negotiating a protocol era per endpoint
   (`mcpEraKey`, saved on the connection by `saveMcpNegotiation` in
   `server/src/services/tool-access/mcp-protocol-config.ts`).
3. **Call (`tools/call`).** `executeRemoteHttpTool()` in
   `server/src/services/tool-gateway.ts` (near line 7784) computes
   `workspaceTarget`, refuses a tool whose scopes are not granted
   (`oauth_insufficient_scope`), sets `endpoint = workspaceTarget.serverUrl`,
   builds headers with the user's `Authorization: Bearer <token>` from
   `resolveCredentialHeaders`, rechecks the grant before every dispatch, and
   posts JSON-RPC through `guardedRemoteHttpFetch`
   (`server/src/services/remote-http-fetch.ts`, behind
   `server/src/services/tool-access/remote-http.ts`). A 401 forces a token
   refresh and asks for an explicit retry; `isInsufficientConnectionScope`
   (`server/src/services/connection-permission-errors.ts`) maps a scope
   failure. The MCP result goes through `completeRemoteMcpCall` →
   `normalizeMcpToolResult`. Prompt-injection screening, audit and invocation
   records happen in the caller of `executeRemoteHttpTool`, so they apply to any
   result it returns.
4. **MCP Tasks.** The background task path (near line 7578) also reads
   `workspaceTarget.serverUrl`. It only runs for calls a remote server turned
   into a task; REST calls never do.

The gateway speaks MCP `2026-07-28` (stateless) first, then the legacy
handshake versions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`
(`server/src/services/mcp-http.ts`). The MCP SDK this package uses (1.31)
speaks the legacy versions only, so over HTTP every new session would pay a
failed modern probe plus an `initialize` round trip.

### Precedent

The gateway already runs REST-backed tool sets in process:
`restConnectorFor` (`server/src/services/connectors/rest-registry.ts`) and
`nativeProviderCatalogFor` (`server/src/services/native-provider-catalogs.ts`).
Both are selected by a small registry, receive the resolved credential headers
and an egress-guarded `request` function, and return their result into the
same post-processing. Discovery returns their static tool list after a probe.

### Recommendation: in-process handler

Call this package as a library inside the gateway, not over a loopback or
hosted HTTP MCP endpoint.

- **Speed.** Measured locally: about 13 µs of package overhead per call with a
  stubbed fetch, and 50 to 90 ms to import the built package once (most of it
  the MCP SDK and zod, which the server already loads). An HTTP hop adds a
  connection, JSON-RPC framing, the protocol probe and handshake above, and on
  a hosted endpoint a network round trip, to every call. `tools/list` becomes a
  static list: no network, no token.
- **Token handling.** The token stays in the server process and goes only to
  Google. Over HTTP it would cross one more hop, and a hosted endpoint would see
  every user's Google token.
- **Self-hosted and Cloud run the same code.** Nothing to deploy, configure or
  keep alive. A loopback endpoint does not work for authenticated public
  deployments: `allowPrivateRemoteEndpoints()` refuses private and loopback
  addresses there, so Cloud stacks would need a hosted service and an exception
  to the egress guard.
- **Egress stays guarded.** The gateway passes its `guardedRemoteHttpFetch` as
  this package's `fetch`, so calls to Google go through the same egress policy
  as today.
- **Swap-back is unchanged.** Tool names, inputs and results are Google's, so
  the catalog, policies, approvals and audit records written under
  `paperclip_rest` stay valid under `google_mcp`.

`createGoogleWorkspaceRestServer()` (a standard MCP server) remains available
for an HTTP or stdio deployment if one is ever needed; it reads the token from
the transport's auth info.

### The switch (follow-up PR, not this one)

One per-service setting in `packages/shared/src/google-workspace-connectors.ts`:

```ts
export const GOOGLE_WORKSPACE_TOOL_TRANSPORT: Record<GoogleWorkspaceService, "google_mcp" | "paperclip_rest"> = {
  gmail: "paperclip_rest", drive: "google_mcp", /* … */
};
```

`googleWorkspaceToolTarget()` returns it as `transport`. Files the follow-up
touches:

- `packages/shared/src/google-workspace-connectors.ts`: the setting above, and
  `transport` on the target.
- `server/package.json`: depend on `@paperclipai/google-workspace-rest-tools`.
- One new server adapter, for example
  `server/src/services/google-workspace-rest-dispatch.ts`: strips `Bearer ` from
  the resolved `Authorization` header, passes the guarded fetch and the call's
  deadline signal, and maps `GoogleWorkspaceAuthError` to the gateway's existing
  outcomes (`unauthenticated` to the forced refresh plus
  `oauth_refreshed_retry_required`; `insufficient_scope` to
  `oauth_insufficient_scope`).
- `server/src/services/tool-gateway.ts`, `executeRemoteHttpTool`: after the
  grant checks and before `endpoint` is chosen, when
  `workspaceTarget.transport === "paperclip_rest"`, recheck the grant (as
  `dispatchRemote` does), call the adapter, and return through
  `normalizeMcpToolResult(result, "mcp_http", false, sourceTemplateKey)`.
- `server/src/services/tool-access/catalog/discovery.ts`, the Google branch of
  `remoteTools`: for a `paperclip_rest` service, use
  `listGoogleWorkspaceRestTools(service)` instead of an HTTP `tools/list`.
- `Dockerfile` already copies this package's `package.json`.

Everything else (picker, scopes, grant checks, allowlist, approval, audit,
injection screening, risk classification in `catalog/descriptors.ts`) only
knows tool names and scopes and needs no change.

## Known differences from Google's MCP tools

- **Descriptions** are our own wording; names, fields, types, enums, required
  fields and annotations follow Google's reference. A contract test against a
  recorded `tools/list` from Google's servers is planned once a listing is
  recorded on the enrolled internal account.
- **Result envelope.** Results carry the object both as `structuredContent`
  and as JSON text. Google's exact envelope has not been recorded yet.
- **`date`** is the UTC calendar date of Gmail's `internalDate`. Google does
  not say which time zone it uses.
- **`sender` and recipients** are plain addresses parsed from the headers;
  display names are dropped. Bodies are decoded as UTF-8.
- **Large bodies.** Gmail can store a body part separately and return only
  its `attachmentId`. With `FULL_CONTENT`, `get_message` reads those bytes
  (`users.messages.attachments.get`) before it answers. The first `text/plain`
  and first `text/html` body parts are found depth first through nested
  multiparts. If a body part cannot be read, the call returns a tool error that
  starts with "Could not read the full body of this message"; it never returns
  a result without the body. Google's reference does not say what its tool
  does here.
- **Address comments** such as `(work)` are removed before the address is
  taken.
- **`labelIds`** keeps user labels and the system labels Google lists (INBOX,
  SPAM, TRASH, UNREAD, STARRED, IMPORTANT, SENT, DRAFT, CHAT); category labels
  are dropped.
- **`search_threads`** makes one `threads.list` call and then one
  `threads.get` per thread (10 at a time), so a 50-thread page is 51 requests.
  Drafts are excluded by adding `-in:draft` unless the query itself uses
  `in:draft`, `is:draft` or `in:anywhere` outside quoted text;
  `includeTrash` uses `includeSpamTrash` plus `-in:spam`, with the same rule
  for `in:spam`. When terms are added, the caller's query is wrapped in
  parentheses first. Google's reference documents the default exclusions but
  not how its tool applies them. A thread deleted
  between the two calls is left out. `pageSize` above 50 is capped at 50.
- **`create_draft`**: for a reply, the draft is threaded (`threadId`,
  `In-Reply-To`, `References`) and an empty subject becomes `Re: <original>`,
  but the original message is not quoted under the new body as Google's tool
  does, and recipients are not filled in from the original: pass `to`. The result is built from the request and Google's `drafts.create`
  answer, without a second read; `date` is the creation date (UTC).
  Attachments are refused, as Google's tool currently does. Long subjects and
  recipient lists are folded onto continuation lines (RFC 5322); non-ASCII
  subjects and single words longer than 900 characters become RFC 2047
  encoded-words. Google's reference sets no length limits.
- **Errors** for Google failures are tool error results with our own short
  messages, not Google's raw error text (except for 400 and 403 messages,
  trimmed to one line).

## Open questions

- The Gmail allowlist in `toolScopes` names `get_draft`, `list_threads` and
  `search_messages`, which Google's published Gmail MCP reference does not list
  (it lists `create_draft`, `get_message`, `get_thread`, `label_message`,
  `label_thread`, `list_drafts`, `list_labels`, `search_threads`,
  `unlabel_message` and `unlabel_thread`). Those three have no Google schema to
  copy, so they would not survive a switch back to `google_mcp`.
- Whether an OAuth client marked as an AI-powered agent may call the REST APIs.
- Each Google Cloud project behind a connection needs the REST APIs enabled
  (Gmail now; Drive, Docs, Sheets, Slides and Calendar as their tools land).
  Without that, calls return the `api_disabled` tool error.
- With `paperclip_rest`, `tools/list` no longer proves the token works. A live
  health check needs a cheap REST probe (for example Gmail `users.getProfile`).

## Removal procedure

1. Set every service in `GOOGLE_WORKSPACE_TOOL_TRANSPORT` to `google_mcp`.
2. Delete `packages/google-workspace-rest-tools/`.
3. Remove its registration: the dependency in `server/package.json`, the server
   adapter file and its two call sites (gateway and discovery), the project in
   the root `vitest.config.ts`, its entry in `nonServerProjects` in
   `scripts/run-vitest-stable.mjs`, its `tsconfig.test.json` in `PROGRAMS` in
   `scripts/typecheck-test-programs.mjs`, and the `COPY` line in `Dockerfile`.
4. Check that the build, typecheck and tests pass, then delete the setting
   itself if nothing else uses it.

## Development

```sh
pnpm --filter @paperclipai/google-workspace-rest-tools test
pnpm --filter @paperclipai/google-workspace-rest-tools typecheck
```

Test fixtures in `src/**/fixtures/` are synthetic, in the shape of Google's REST
responses. They contain no real mail, addresses or IDs.
