# Google Workspace REST tools

Paperclip's own implementation of the tools that Google's hosted Workspace MCP
servers expose (for example `https://gmailmcp.googleapis.com/mcp/v1`), backed
by Google's generally available REST APIs.

It lives in this one folder, `server/src/google-workspace-rest-tools/`, inside
the server package. It is not a separate npm package, so nothing new is
published.

This release has three Gmail tools: `get_message`, `search_threads` and
`create_draft`. There is no send tool, and none may be added.

## Why this exists, and why it is temporary

Google's Workspace MCP servers are a Developer Preview and cannot be offered to
the public. On 2026-11-17 the owner decided that Paperclip will launch on its
own tools over the REST APIs. The tools are built so Paperclip can switch to
Google's MCP servers later without a rewrite, and they live in this one folder
so they can be deleted cleanly when that happens.

## Boundary rules

- **One entry point.** Other server code may import only `index.ts`.
- **Isolated imports, enforced by `boundary.test.ts`.** Source files import
  only files in this folder, Node built-ins, `@modelcontextprotocol/sdk` and
  `zod` (both existing server dependencies). Test files and `fixtures/` may
  also import `vitest` and `@paperclipai/shared`. Nothing in this folder
  imports other server code. The only server file that imports this folder
  is the gateway adapter `server/src/services/google-workspace-rest-dispatch.ts`,
  through `index.ts`; the test checks that too.
- **Same tools as Google's MCP servers.** Same tool names, same input fields,
  same result shape. Names, field names, types and enums come from Google's
  published reference (Gmail:
  <https://developers.google.com/workspace/gmail/api/reference/mcp>, recorded
  2026-11-17). Where REST cannot match, the difference is listed below.
- **Public surface is MCP only.** `index.ts` exports tool definitions (`Tool`),
  results (`CallToolResult`), an MCP server, and the MCP error thrown for token
  problems. No Google REST type is exported.
- **Knows nothing about Paperclip.** No company, connection, grant, policy,
  audit, approval or screening code. Input is a service, a tool name,
  arguments and an access token. Output is an MCP result. Authorization, scope
  checks, approval, audit and injection screening stay with their current
  owners in the gateway.
- **Stores nothing.** No tokens, no content, no cache. The access token is used
  for one call and dropped.
- **One file calls Google.** `google-http.ts` is the only place that calls
  `googleapis.com`. It sets the bearer header, allows only listed hosts,
  bounds each request (20 s deadline, 20 MB response, including the body
  read), maps Google errors, and retries a read (GET) once after a network
  error or HTTP 502/503/504. **It never retries a write.** A write that fails
  after it was sent (network error, dropped connection, timeout, caller
  cancellation, HTTP 5xx, or a success answer that is too large or not JSON)
  says that the change may or may not have been made.
- **One tool, one file.** Each tool in `gmail/` is a set of pure functions
  (arguments to REST request, REST response to MCP result) plus a short `run`
  that sequences them. The pure functions are unit tested without network.
- **`server.ts` is thin MCP wiring:** `tools/list` and `tools/call`.
- **The allowlist stays where it is.** `toolScopes` in
  `packages/shared/src/google-workspace-connectors.ts` is the single list of
  allowed Google tools. `allowlist.test.ts` fails if this folder implements a
  tool that is not on it, if a tool's read-only hint disagrees with the
  allowlist's write flag, or if a description names a tool this folder does
  not list.

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

## How it plugs in

The gateway calls this folder in process. There is no loopback or hosted MCP
endpoint. `createGoogleWorkspaceRestServer()` (a standard MCP server that reads
the token from the transport's auth info) stays available if an HTTP or stdio
deployment is ever needed; the gateway does not use it.

### The switch

One setting per service, `GOOGLE_WORKSPACE_TOOL_TRANSPORT` in
`packages/shared/src/google-workspace-connectors.ts`:

- `google_mcp` (every service today): calls go to Google's hosted MCP server
  for that service, exactly as before this folder existed.
- `paperclip_rest`: calls go to this folder.

`googleWorkspaceToolTarget(name)` returns the setting as `transport`. It is a
plain constant: no environment variable, instance setting or database row.

### Where the gateway branches

- **Adapter.** `server/src/services/google-workspace-rest-dispatch.ts` is the
  only server file that imports this folder. It takes the gateway's resolved
  credential headers (it keeps only the bearer token), the call's cancellation
  signal and the gateway's egress-guarded fetch, and returns either the MCP
  result or a token problem (`unauthenticated` or `insufficient_scope`).
- **Calls.** `executeRemoteHttpTool()` in `server/src/services/tool-gateway.ts`.
  The REST branch runs after everything the MCP path runs first: the
  experimental-feature gate, per-caller grant selection, the allowlist and
  grant scope check. It then rechecks the current grant, calls the adapter with
  the call's deadline (and the run's stop signal when there is one), and
  returns through the same result handling as an MCP result. Approval, audit,
  invocation records and prompt-injection screening run in the callers of
  `executeRemoteHttpTool`, so they apply unchanged. Token problems map to the
  MCP path's outcomes: `insufficient_scope` to `oauth_insufficient_scope`;
  `unauthenticated` to a forced token refresh and `oauth_refreshed_retry_required`
  (never an automatic replay), or `mcp_remote_status` when the connection cannot
  refresh. This folder turns a cancelled or timed-out request into a tool
  error result; the gateway checks its own signal after the call and reports
  `tool_timeout`, as on the MCP path. The audit record names the protocol
  `Google Workspace REST`.
- **Discovery and health.** The Google branch of `remoteTools()` in
  `server/src/services/tool-access/catalog/discovery.ts`. For a
  `paperclip_rest` service it runs this folder's probe with the caller's token
  (`probeGoogleWorkspaceRestService`; Gmail reads `users.getProfile`), then
  lists this folder's tools under the same `service__tool` names, filtered by
  the granted scopes. The probe replaces Google's `tools/list` as the proof
  that the token works. A 401 refreshes the token and probes once more; a
  second 401 on a managed grant marks it `needs_reauthorization`, as the MCP
  path does. Any other probe failure makes that one service unavailable while
  the others stay usable. Health checks use the same branch.

MCP Tasks, MCP resources and elicitation only exist on the `google_mcp` path.

Measured with a stubbed fetch, the adapter adds about 15 µs per call. A full
`gmail__get_message` through `executeTool` (policy, records, screening) took a
median of 18.2 ms on either transport.

### Flipping a service

1. Implement every tool in that service's allowlist (`toolScopes` in the
   shared file) in this folder, plus a probe in `probe.ts` and the service's
   API host in `google-http.ts`.
2. Set the service to `paperclip_rest` in `GOOGLE_WORKSPACE_TOOL_TRANSPORT`.

`googleWorkspaceRestTransportGaps()` in the adapter, run by
`google-workspace-rest-dispatch.test.ts`, fails while any service set to
`paperclip_rest` is missing an allowlisted tool, so a partial flip cannot ship.

## Known differences from Google's MCP tools

- **Descriptions** are our own wording; names, fields, types, enums, required
  fields and annotations follow Google's reference. Until a tool lands here,
  descriptions do not mention it: Google's text points to `get_thread` and
  `list_labels`, ours points to `get_message` and does not name a label tool.
  A contract test against a recorded `tools/list` from Google's servers is
  planned once a listing is recorded on the enrolled internal account.
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
- **Addresses** come from `gmail/address.ts`, a small single-pass tokenizer
  over RFC 5322 address lists. It tracks quoted strings with escapes, nested
  comments, angle brackets and square-bracket domain literals (so
  `ops@[IPv6:2001:db8::1]` stays whole), drops comments and display names,
  returns the members of groups without the group name, and returns nothing
  for an empty group such as `undisclosed-recipients:;`. Malformed input gives
  a best-effort list and never throws. Google's reference does not say how its
  tools parse these headers.
- **`labelIds`** keeps user labels and the system labels Google lists (INBOX,
  SPAM, TRASH, UNREAD, STARRED, IMPORTANT, SENT, DRAFT, CHAT); category labels
  are dropped.
- **`search_threads`** makes one `threads.list` call and then one
  `threads.get` per thread (10 at a time), so a 50-thread page is 51 requests.
  A thread deleted between the two calls is left out. `pageSize` above 50 is
  capped at 50. Drafts are excluded by adding `-in:draft` unless the query
  itself uses `in:draft`, `is:draft` or `in:anywhere` outside quoted text;
  `includeTrash` uses `includeSpamTrash` plus `-in:spam`, with the same rule
  for `in:spam`. When terms are added, the caller's query is wrapped in
  parentheses first. Google's reference documents the default exclusions but
  not how its tool applies them.
- **`create_draft`**: for a reply, the draft is threaded (`threadId`,
  `In-Reply-To`, `References`) and an empty subject becomes `Re: <original>`,
  but the original message is not quoted under the new body as Google's tool
  does, and recipients are not filled in from the original: pass `to`. The
  result is built from the request and Google's `drafts.create` answer,
  without a second read; `date` is the creation date (UTC). Attachments are
  refused, as Google's tool currently does. Long subjects and recipient lists
  are folded onto continuation lines (RFC 5322); non-ASCII subjects and single
  words longer than 900 characters become RFC 2047 encoded-words. Google's
  reference sets no length limits.
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

## Removal procedure

1. Set every service in `GOOGLE_WORKSPACE_TOOL_TRANSPORT` to `google_mcp`.
2. Delete this folder, `server/src/google-workspace-rest-tools/`.
3. Delete `server/src/services/google-workspace-rest-dispatch.ts` and its
   test, and the two call sites: the `paperclip_rest` branch in
   `executeRemoteHttpTool` (`server/src/services/tool-gateway.ts`) and
   `googleWorkspaceRestTools` in
   `server/src/services/tool-access/catalog/discovery.ts`. Delete
   `server/src/__tests__/google-workspace-rest-transport.test.ts`.
4. Check that the build, typecheck and tests pass, then delete the setting
   and `transport` itself if nothing else uses them.

## Development

```sh
cd server && npx vitest run src/google-workspace-rest-tools
```

Test fixtures in `fixtures/` and `gmail/fixtures/` are synthetic, in the shape
of Google's REST responses. They contain no real mail, addresses or IDs.
