# Google Workspace REST tools

Paperclip's own implementation of the tools that Google's hosted Workspace MCP
servers expose (for example `https://gmailmcp.googleapis.com/mcp/v1`), backed
by Google's generally available REST APIs.

It lives in this one folder, `server/src/google-workspace-rest-tools/`, inside
the server package. It is not a separate npm package, so nothing new is
published.

Gmail has all nine allowlisted tools: `get_message`, `get_thread`,
`search_threads`, `list_threads`, `search_messages`, `get_draft`,
`list_drafts`, `list_labels` and `create_draft`. Only `create_draft` writes.
There is no send, trash, delete or label-changing tool, and none may be added.

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
  imports other server code. In this release nothing else in the server
  imports this folder; the test also checks that, and the switch PR relaxes
  that one check.
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
(`server/src/services/mcp-http.ts`). The MCP SDK the server uses (1.31) speaks
the legacy versions only, so over HTTP every new session would pay a failed
modern probe plus an `initialize` round trip.

### Recommendation: call it in process

The code already runs in the server process, so the gateway calls
`callGoogleWorkspaceRestTool()` and `listGoogleWorkspaceRestTools()` directly,
the way it already runs other REST-backed tool sets (`restConnectorFor` in
`server/src/services/connectors/rest-registry.ts` and
`nativeProviderCatalogFor` in `server/src/services/native-provider-catalogs.ts`).
No loopback or hosted MCP endpoint.

- **Speed.** Measured locally: about 13 µs of overhead per call with a stubbed
  fetch. The MCP SDK and zod are already loaded by the server, so there is no
  extra cold-start cost beyond this folder's own modules. An HTTP hop would
  add a connection, JSON-RPC framing, and the protocol probe and handshake
  above to every call. `tools/list` becomes a static list: no network, no token.
- **Token handling.** The token stays in the server process and goes only to
  Google.
- **Self-hosted and Cloud run the same code.** Nothing to deploy, configure or
  publish. A loopback endpoint would not work on authenticated public
  deployments: `allowPrivateRemoteEndpoints()` refuses loopback addresses there.
- **Egress stays guarded.** The gateway passes its `guardedRemoteHttpFetch` as
  the `fetch` option, so calls to Google go through the same egress policy as
  today.
- **Swap-back is unchanged.** Tool names, inputs and results are Google's, so
  the catalog, policies, approvals and audit records written under
  `paperclip_rest` stay valid under `google_mcp`.

`createGoogleWorkspaceRestServer()` (a standard MCP server that reads the token
from the transport's auth info) stays available if an HTTP or stdio
deployment is ever needed; the in-process path does not use it.

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
- One new server adapter outside this folder, for example
  `server/src/services/google-workspace-rest-dispatch.ts`, the only importer of
  `server/src/google-workspace-rest-tools/index.ts`. It strips `Bearer ` from
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
  `remoteTools`: for a `paperclip_rest` service, use the adapter's static tool
  list instead of an HTTP `tools/list`.
- `boundary.test.ts`: allow that one adapter as the only importer.

No dependency, workspace, Docker or release change is needed. Everything else
(picker, scopes, grant checks, allowlist, approval, audit, injection
screening, risk classification in `catalog/descriptors.ts`) only knows tool
names and scopes and needs no change.

## Known differences from Google's MCP tools

- **Descriptions** are our own wording; names, fields, types, enums, required
  fields and annotations follow Google's reference. Descriptions name only
  tools this folder implements (`allowlist.test.ts` checks this), so
  `list_labels` points to `list_threads` rather than to Google's label-changing
  tools. A contract test against a recorded `tools/list` from Google's servers
  is planned once a listing is recorded on the enrolled internal account.
- **Result envelope.** Results carry the object both as `structuredContent`
  and as JSON text. Google's exact envelope has not been recorded yet.
- **`date`** is the UTC calendar date of Gmail's `internalDate`. Google does
  not say which time zone it uses.
- **`sender` and recipients** are plain addresses parsed from the headers;
  display names are dropped. Bodies are decoded as UTF-8.
- **Same message everywhere.** `get_message`, `get_thread`, `search_threads`,
  `list_threads` and `search_messages` all map messages with `toMcpMessage` in
  `gmail/message.ts`, so one message looks the same from any of them at the
  same format. `get_draft` and `list_drafts` share `toMcpDraft`.
- **Large bodies.** Gmail can store a body part separately and return only
  its `attachmentId`. Whenever bodies are returned (`FULL_CONTENT` for
  `get_message`, `get_thread` and `search_messages`; `DRAFT_VIEW_FULL` for
  `get_draft` and `list_drafts`), the tool reads those bytes
  (`users.messages.attachments.get`, 10 at a time) before it answers. The first
  `text/plain` and first `text/html` body parts are found depth first through
  nested multiparts. If any body part cannot be read, the whole call returns a
  tool error that starts with "Could not read the full body of this message";
  it never returns a result, or a page, with a body missing. Google's reference
  does not say what its tools do here.
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
- **`get_thread`** makes one `threads.get` call (`format=full`, or summary
  headers only for `MINIMAL` and `METADATA_ONLY`), then reads separately stored
  bodies. Messages keep Gmail's order, oldest first.
- **`list_drafts`** makes one `drafts.list` call and then one `drafts.get` per
  draft (10 at a time). A draft deleted between the two calls is left out.
  The query is passed to Gmail unchanged. `pageSize` above 50 is capped at 50.
  Google's annotation `idempotentHint: false` is copied as published.
- **`list_labels`** makes one `labels.list` call. Gmail's REST list has no
  paging, so `pageSize` (default 100, maximum 500, neither set by Google) and
  `pageToken` (a position in the list sorted by name, then ID) are applied in
  this folder. `threadsTotal` and `threadsUnread` are left out: REST returns
  them only from `labels.get`, one request per label. A label with only one
  of its two colors set is returned without `color`.
- **Errors** for Google failures are tool error results with our own short
  messages, not Google's raw error text (except for 400 and 403 messages,
  trimmed to one line).

### Google requests per call

Reads that fan out run at most 10 at a time; the first failure stops new
requests. The 20 s timeout in `google-http.ts` applies to each request
attempt, not to the whole call, so a call that fans out can take longer than
20 s. Every request also stops when the caller's `signal` aborts; a caller
that needs a bound on the whole call passes a signal with that deadline (the
gateway passes its call deadline).
Each read may be retried once by `google-http.ts`, which the counts below do
not include. "Bodies" counts separately stored bodies, at most two per message
(plain and HTML) and none for most mail.

| Tool | Requests at the maximum page size |
| --- | --- |
| `get_message` | 1, plus up to 2 bodies with `FULL_CONTENT` (at most 3) |
| `get_thread` | 1, plus up to 2 bodies per message with `FULL_CONTENT` |
| `search_threads` | 1 + 50 = 51 |
| `list_threads` | 1 + 50 = 51 |
| `search_messages` | 1 + 50 = 51; with `FULL_CONTENT` up to 1 + 50 + 100 = 151 |
| `get_draft` | 1, plus up to 2 bodies with `DRAFT_VIEW_FULL` (at most 3) |
| `list_drafts` | 1 + 50 = 51; with `DRAFT_VIEW_FULL` (the default) up to 1 + 50 + 100 = 151 |
| `list_labels` | 1 |
| `create_draft` | 1, or 2 for a reply |

`get_thread` is bounded by the thread's length, which Gmail limits (it starts
a new conversation after 100 messages), so at most 201 with bodies.

### Not verified against Google's servers

The allowlist in `toolScopes` names `get_draft`, `list_threads` and
`search_messages`, but Google's published Gmail MCP reference does not list
them (it lists `create_draft`, `get_message`, `get_thread`, `label_message`,
`label_thread`, `list_drafts`, `list_labels`, `search_threads`,
`unlabel_message` and `unlabel_thread`). Their inputs and results are our
design, built from the documented sibling tools, and may not match what
Google's servers return if they ever expose tools with these names:

- **`get_draft`**: input `draftId` (required) and `view` (`DraftView` from
  `list_drafts`); result is one `Draft`, the shape `list_drafts` and
  `create_draft` return. One `drafts.get`, plus bodies.
- **`list_threads`**: input `pageSize`, `pageToken`, `includeTrash` and `view`
  as in `search_threads`, plus `labelIds` (at most 20; a thread must have all
  of them) instead of `query`; result is `search_threads`'s. Drafts are
  excluded unless `DRAFT` is among the labels; spam and trash are included
  when `SPAM` or `TRASH` is among them.
- **`search_messages`**: input as `search_threads`, with `messageFormat` from
  `get_message` instead of `view`; result is `{ messages, nextPageToken,
  resultCountEstimate }` with `get_message`'s `Message`. Unlike `get_message`,
  the default (and `MESSAGE_FORMAT_UNSPECIFIED`) is `MINIMAL`, so a search does
  not pull every body. One `messages.list`, then one `messages.get` per message,
  plus bodies with `FULL_CONTENT`.

A switch back to `google_mcp` would drop these three unless Google adds them.

## Open questions
- Whether an OAuth client marked as an AI-powered agent may call the REST APIs.
- Each Google Cloud project behind a connection needs the REST APIs enabled
  (Gmail now; Drive, Docs, Sheets, Slides and Calendar as their tools land).
  Without that, calls return the `api_disabled` tool error.
- With `paperclip_rest`, `tools/list` no longer proves the token works. A live
  health check needs a cheap REST probe (for example Gmail `users.getProfile`).

## Removal procedure

1. Set every service in `GOOGLE_WORKSPACE_TOOL_TRANSPORT` to `google_mcp`.
2. Delete this folder, `server/src/google-workspace-rest-tools/`.
3. Delete the server adapter that imports it and its two call sites (gateway
   and discovery).
4. Check that the build, typecheck and tests pass, then delete the setting
   itself if nothing else uses it.

## Development

```sh
cd server && npx vitest run src/google-workspace-rest-tools
```

Test fixtures in `fixtures/` and `gmail/fixtures/` are synthetic, in the shape
of Google's REST responses. They contain no real mail, addresses or IDs.
