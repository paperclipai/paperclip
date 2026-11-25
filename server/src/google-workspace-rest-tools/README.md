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
It also has all nine allowlisted Calendar tools (see "Calendar tools" below),
all eight allowlisted Drive tools (see "Drive tools" below), both Docs tools
and both Slides tools (see "Docs and Slides tools" below), and all six
allowlisted Sheets tools (see "Sheets tools" below).

## Why this exists, and why it is the fallback now

On 2026-11-17 Google's Workspace MCP servers were a Developer Preview and could
not be offered to the public, so the owner decided that Paperclip would launch
on its own tools over the REST APIs. All six services ran on this folder from
2026-11-23 to 2026-11-24.

On 2026-11-24 Google made its Workspace MCP servers generally available and
published the Workspace AI Tools Addendum
(<https://workspace.google.com/terms/ai-tools>): a tool that is, or is driven
by, an AI agent must use a Google MCP, not the REST APIs. The owner decided the
same day to switch all six services back to Google's MCP servers. This folder
and the switch stay in the code as the fallback; do not delete them.

`argument-guards.ts` is the one part of this folder that also runs on the
`google_mcp` path (see "Argument checks on Google's MCP path").

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
  says that the change may or may not have been made. Every method other than
  GET (POST, PATCH, PUT, DELETE) is a write; the only exception is a POST the
  request marks `readOnly` (Calendar's free/busy query). `www.googleapis.com`
  is allowed only under the prefixes `GOOGLE_API_PATH_PREFIXES` lists for it
  (`/calendar/v3/`, `/drive/v3/`, `/upload/drive/v3/`), `docs.googleapis.com`
  only under `/v1/documents/`, `slides.googleapis.com` only under
  `/v1/presentations/`, `sheets.googleapis.com` only under `/v4/spreadsheets/`
  and `gmail.googleapis.com` only under `/gmail/v1/users/me/`; every allowed host
  must have a prefix list (the type requires it, and `google-http.test.ts`
  requires an allowed and a rejected path for each). Paths are checked after URL
  normalization, so `..` and `%2e%2e` segments cannot leave them. Redirects are
  never followed: requests use `redirect: "manual"` and any 3xx is a tool error.
- **One tool, one file.** Each tool in `gmail/`, `calendar/`, `drive/`, `docs/`, `slides/` and `sheets/` is a set of pure functions
  (arguments to REST request, REST response to MCP result) plus a short `run`
  that sequences them. The pure functions are unit tested without network.
- **Every tool has a `title`.** It is a short action name in sentence case,
  such as "Read a message". The gateway shows it to people as
  "Gmail: Read a message" for both transports. `allowlist.test.ts` fails if a
  tool has no title.
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
| 403 `exportSizeLimitExceeded` (Drive) | Tool error: the file is over Google's 10 MB export limit |
| 403 `appNotAuthorizedToFile` (Drive) | Tool error saying `drive.file` covers only files this app created or opened, without the app's project number |
| Any 3xx redirect | Tool error; the redirect is not followed |
| Other 403, 404, 400, 429, 5xx, timeout, network failure | Tool error result (`isError: true`) with a short message |
| Unknown argument (see "Unknown arguments") | Tool error result that names it and lists the accepted ones, no request sent |
| Invalid arguments | Tool error result, no request sent |
| Unknown tool | Throws `McpError` `InvalidParams` |

Token problems are thrown, not returned, so a caller can refresh the token or
ask the user to reconnect exactly as it does for Google's MCP servers.

### Unknown arguments

No tool ignores an argument. `defineTool` in `tool.ts` checks the call's
arguments against the tool's advertised input schema before anything else,
for all 36 tools. An argument that is not in the schema, at the top level or
inside a structured input (for example `attendees[0]` or `writeControl`),
fails the call before any request is sent to Google:

```text
Invalid arguments for list_threads: unknown argument "q". Accepted arguments: pageSize, pageToken, query, labelIds, includeTrash, view. Nothing was sent to Google.
```

`defineTool` also sets `additionalProperties: false` on every object in the
advertised input schema that lists its `properties`, so agents see the rule.
`strict-arguments.test.ts` builds its cases from the tool list, so a new tool
is covered without a test change, and checks that the zod schema of each tool
has the same objects, at the same paths, with the same fields, types and
enums as its JSON schema. Every field the zod schema requires is also
required in the JSON schema. Only `update_doc` and `update_presentation`
require more in the JSON schema than in zod (`writeControl` and its
`requiredRevisionId`); the tool checks those itself, to give an error that
says to read the file first. The check follows only `properties` and `items`,
so `defineTool` refuses to define a tool whose input schema uses anything it
cannot follow (`anyOf`, `oneOf`, `allOf`, `$ref`, tuple `items`, an
`additionalProperties` other than `false` beside `properties`, and similar). A new schema shape
fails at startup and in tests; it can never let an argument through unchecked.

**Pass-through inputs.** These are Google's own request objects and are sent
to Google as given. Their contents are not checked for unknown fields here
(each tool still checks the request kind, see "Allowed request kinds"):

- `docs__update_doc` `requests[]` (`documents.batchUpdate` requests)
- `slides__update_presentation` `requests[]` (`presentations.batchUpdate` requests)
- `sheets__update_spreadsheet` `requests[]` (`spreadsheets.batchUpdate` requests)

The recorded Google MCP references do not say what Google's servers do with
an unknown argument, and this was not checked against Google's servers. The
decision is to refuse: an ignored filter can read data the agent did not ask
for (a staging test on 2026-11-23 called `list_threads` with `query` and got
every thread).

## How it plugs in

The gateway calls this folder in process. There is no loopback or hosted MCP
endpoint. `createGoogleWorkspaceRestServer()` (a standard MCP server that reads
the token from the transport's auth info) stays available if an HTTP or stdio
deployment is ever needed; the gateway does not use it.

### The switch

One setting per service, `GOOGLE_WORKSPACE_TOOL_TRANSPORT` in
`packages/shared/src/google-workspace-connectors.ts`:

- `google_mcp`: calls go to Google's hosted MCP server for that service.
  Every service uses it since 2026-11-24. Chat, People and Search are not
  offered for new setup.
- `paperclip_rest`: calls go to this folder. Gmail, Drive, Docs, Sheets,
  Slides and Calendar used it from 2026-11-23 to 2026-11-24. It is the
  fallback.

`googleWorkspaceToolTarget(name)` returns the setting as `transport`. It is a
plain constant: no environment variable, instance setting or database row.

### Where the gateway branches

- **Adapter.** `server/src/services/google-workspace-rest-dispatch.ts` is the
  only server file that imports this folder. It takes the gateway's resolved
  credential headers (it keeps only the bearer token), the call's cancellation
  signal, the gateway's egress-guarded fetch and the gateway's result limit
  (see "Result size"), and returns either the MCP
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
  `paperclip_rest` service it runs this folder's probe
  (`probeGoogleWorkspaceRestService`) with the caller's token and granted
  scopes, then lists this folder's tools under the same `service__tool` names,
  filtered by the granted scopes. The probe replaces Google's `tools/list` as
  the proof that the token works. `GOOGLE_WORKSPACE_REST_PROBES` in `probe.ts`
  gives each service an ordered list of cheap reads, each with the scopes that
  allow it, and the probe uses the first one the grant allows:

  | Service | Read | Allowed by |
  | --- | --- | --- |
  | Gmail | `users.getProfile` | `gmail.readonly` |
  | Calendar | one `calendarList.list` entry | `calendar.calendarlist.readonly`, `calendar.readonly` |
  | Calendar | one event of the primary calendar | `calendar.events.readonly`, `calendar.events`, `calendar.readonly` |
  | Calendar | one minute of `freeBusy.query` on the primary calendar | `calendar.events.freebusy` |
  | Drive | `about.get` with `fields=kind` | `drive.readonly`, `drive.file` |

  Docs and Slides have no probe: every read of either API needs a document or
  presentation ID, and Google does not document what a made-up ID returns, so
  a probe could wrongly mark a working grant unavailable.

  Sheets has no probe: every Sheets REST read needs a spreadsheet ID, so a
  Sheets grant is listed without one.

  A grant that allows none of them (for example compose-only Gmail) is listed
  without a probe. An insufficient-scope answer to a probe never makes a
  service unavailable. A 401 refreshes the token and probes once more; a
  second 401 on a managed grant marks it `needs_reauthorization`, as the MCP
  path does. Any other probe failure makes that one service unavailable while
  the others stay usable. Health checks use the same branch.

MCP Tasks, MCP resources and elicitation only exist on the `google_mcp` path.
Google's MCP servers ask a person to confirm some actions (MCP elicitation).
The gateway puts the question on the task's question card, as for any MCP
server (`server/src/services/mcp-elicitation.ts`); skipping the card sends
"decline". `server/src/__tests__/google-workspace-mcp-transport.test.ts`
covers this with a fake Google server, for a server that asks over a session
stream and for a stateless one.

### Argument checks on Google's MCP path

Before the gateway sends a call to Google's MCP server for Gmail, Drive,
Docs, Sheets, Slides or Calendar, it runs `googleWorkspaceArgumentRefusal`
(`argument-guards.ts`, through `googleWorkspaceMcpPreflightRefusal` in the
adapter). A refusal is a tool error that ends with "Nothing was sent to
Google.", recorded and audited like a REST refusal. It checks only what an
argument shows, with no request to Google:

- An argument that the action's saved schema does not list. The top level is
  always checked; a nested object only when its schema has
  `additionalProperties: false`. A schema with `additionalProperties` open at
  the top level, or with neither `properties` nor `additionalProperties:
  false`, is not checked.
- `fileId` and `parentId` (Drive), `documentId`, `spreadsheetId` and
  `presentationId` must each be one file ID: no link, no list.
- Docs `update_doc` and Slides `update_presentation`: each request names
  exactly one kind, and the kind is on the closed list in
  `docs/request-kinds.ts` or `slides/request-kinds.ts` (so kinds that read
  another file, and images from Drive or Docs links, are refused).

For Calendar `delete_event`, `googleWorkspaceMcpPreflightRefusal` in the
adapter first reads the event with the connection's own `calendar__get_event`
(only `calendarId` and `eventId`), through a callback the gateway passes, and
gives the answer to `googleCalendarSeriesRefusal`. The gateway only looks up
and runs that action, with the grant and scope checks, inside the delete's
own deadline. The read action's Off or Ask first setting does not apply: the
read is part of a delete that the policy already allowed, and its answer never
reaches the agent. The REST `delete_event` makes the same read. A whole recurring series is
refused, as on REST. If the read does not return the event, nothing is
deleted.

Each refusal has a stable code: `unknown_argument`, `invalid_arguments`,
`invalid_file_id`, `request_kind_refused`, `recurring_series_delete_refused`
or `delete_target_unverified`. Paperclip wrote the refusal text, so an agent
on the Paperclip Runner sees the code and the full text. For an error that
Google returns, the agent sees only a code. `googleWorkspaceMcpErrorDetails`
takes Google's HTTP status or status name and classifies it with the REST
tools' `googleError`, for example `google_permission_denied`,
`google_insufficient_scope` or `google_unavailable`, else `google_error`.
`google_rate_limited` is retryable. `google_unavailable` is retryable only for a
read action, because a write can already be applied when Google reports a
server error. Google's own text is not sent to the
agent. The failed call event records the code in
`errorCode`, and the text in `errorMessage`, which the 30-day Google Technical
Information sweep clears.

The REST tools' other checks describe a REST limit or a stricter REST rule, so
they do not run on MCP: mandatory `requiredRevisionId`, the Sheets comment and
data-source refusals, the result size budget, and the Drive search query
rules.

Measured with a stubbed fetch, the adapter adds about 15 µs per call. A full
`gmail__get_message` through `executeTool` (policy, records, screening) took a
median of 18.2 ms on either transport.

### Result size

The caller sets the size limit. `callGoogleWorkspaceRestTool` takes
`maxResultBytes`, and every tool in all six services checks it the same way:
`defineTool` in `tool.ts` measures the final serialized `CallToolResult` once
(`withinResultBudget`) after the tool has built it. A result over the limit is
replaced by a tool error that gives its size and the limit, says it was not
returned, and says how to ask for less. Each tool states that advice in
`whenTooLarge`: a smaller `pageSize` for list tools, a lighter
`messageFormat` or view for Gmail, a narrower range for Sheets, `fields` for
Slides. Nothing is ever cut short. Write tools are not checked: their result
comes after the change was made, and an error then could lead the agent to
make the change twice. A write result echoes its request or Google's reply
to it, so its size follows the request. `defineTool` refuses a read tool without advice
and a write tool with it. Drive downloads also stop reading at the
limit, since larger content could never fit.

`FALLBACK_MAX_RESULT_BYTES` (250,000) in `tool.ts` applies only when a direct
caller passes no limit (tests, or `createGoogleWorkspaceRestServer` without the
option). This folder does not know Paperclip's limits.

The gateway passes `GOOGLE_WORKSPACE_REST_MAX_RESULT_BYTES` from
`server/src/services/tool-gateway.ts`: the gateway's limit on a response from a
remote MCP server (`MAX_REMOTE_MCP_RESPONSE_BYTES`, 1,000,000 bytes) less the
JSON-RPC and event-stream framing around the result, so 999,885 bytes. A
result Google's own MCP server could deliver through the gateway is also
delivered over REST, and the reverse. The gateway wraps the result for the
agent and repeats the payload, so the delivered result is up to twice as large
(measured 1.50 times for a plain-text email). The agent runner saves a
delivered result over 500,000 bytes as an artifact and gives the agent a
pointer it reads with `read_tool_result`, so a result near the limit is still
delivered in full.

Practical limits at that budget, measured with plain ASCII text (characters
that JSON escapes, and non-ASCII characters, count more):

| Service | Largest content one call returns |
| --- | --- |
| Gmail `get_message` | about 500 KB of plain-text body, or about 250 KB each when the message has both plain and HTML bodies |
| Gmail lists | the whole page must fit; lower `pageSize` |
| Calendar `get_event` | about 500 KB of description |
| Drive `read_file_content` | about 500 KB of text |
| Drive `download_file_content` | about 375 KB of file bytes (base64 adds a third) |
| Docs `read_doc` | about 240 KB of document text (the text and the edit structure both carry it) |
| Slides `read_presentation` | about 250 KB of slide text; use `fields` for more |
| Sheets `get_values` | about 500 KB of cell text, and at most 50,000 cells |

The check costs one `JSON.stringify` of the result: about 5 µs for a 4 KB
result and 0.24 ms for a 700 KB one.

### Connections saved on REST, after the switch back

A connection whose catalog was refreshed while its services were on
`paperclip_rest` has this folder's definitions saved. After the switch back,
agents see those saved definitions until the next catalog refresh, and the
argument checks use them. That refresh saves Google's definitions. It does not
hold an action for review when the saved row's schema hash is one of this
folder's shipped definitions (`shippedPaperclipSchemaHashes` in
`server/src/services/connectors/paperclip-defined-tools.ts` and the hold rule
in `server/src/services/tool-access/catalog/publication.ts`), and it keeps Off,
Ask first and the review fields.

`shipped-schema-hashes.ts` lists the input schema hash of every revision of
every tool that a connection could have saved: the first launch (#22634) and
the strict-argument revision (#22706). `fixtures/input-schemas-22634.json`
holds the #22634 schemas. A test fails when a tool's current schema is not in
the list, so add the new hash whenever a schema changes.

The first switch-back refresh on builds before this list held each action
whose row carried the #22634 schemas (`quarantined`, `pending_review`). That
hold replaced the saved definition with Google's. No record keeps the earlier
definition: a refresh can save rows and stop before it writes its audit event,
so neither the audit history nor the call records prove which definition a row
had just before the hold. A refresh does not release such an action. A person
reviews it. An action that Google's server does not list (for example Gmail
`get_draft`, `list_threads` or `search_messages`, if Google does not have
them) is removed by that refresh.

### Flipping a service

1. Implement every tool in that service's allowlist (`toolScopes` in the
   shared file) in this folder, plus its probe reads and their scopes in `probe.ts` and the service's
   API host in `google-http.ts`.
2. Set the service to `paperclip_rest` in `GOOGLE_WORKSPACE_TOOL_TRANSPORT`.

`googleWorkspaceRestTransportGaps()` in the adapter, run by
`google-workspace-rest-dispatch.test.ts`, fails while any service set to
`paperclip_rest` is missing an allowlisted tool, so a partial flip cannot ship.

### Connections saved before a switch

A connection keeps the tool definitions its last catalog refresh saved. After
a service switches to `paperclip_rest`, the saved definitions of an existing
connection are still Google's MCP definitions. Two things keep such a
connection working with no user action:

- **Agents see this folder's definitions at once.** When the gateway lists a
  connection's tools for an agent, it takes the input schema, output schema,
  description and annotations of a `paperclip_rest` tool from this folder, not
  from the saved row. It asks `paperclipDefinedTool` in
  `server/src/services/connectors/paperclip-defined-tools.ts`, which calls
  `googleWorkspaceRestToolDefinition` in the adapter.
  Routing and the advertised definition read the same transport setting in
  the same process, so an agent never gets Google's MCP schema for a call that
  goes to REST. This is an in-memory lookup: no request and no refresh before
  the turn starts.
- **The next catalog refresh saves this folder's definitions.** Catalog
  publication asks the same `paperclipDefinedTool`. It never holds such an
  action for review, and it clears the review hold (`quarantined`,
  `pending_review`) of an action held only because a remote definition
  changed. Clearing the hold does not count the action as new, so it does not
  add the action to the connection's profile: an action a person turned Off
  (left out of the profile) stays Off, also when it was held, and an Ask first
  policy stays in force. Only actions the connection never had (Gmail
  `list_threads` and `search_messages`) get the connection's default for new
  actions.

The saved risk level of an action changes only on that refresh. Until then,
`docs__update_doc`, `slides__update_presentation`, `sheets__update_spreadsheet`
and `calendar__update_event` keep the level saved from Google's MCP
definition (`write`); after it they are `destructive`. Write actions are
Allowed by default at either level.

### Input differences an agent meets after a switch

Checked against Google's published MCP references, since no `tools/list`
from Google's servers is recorded yet. These are the cases where a call that
Google's saved schema allowed is refused by this folder; each is also stated
in the tool's own description and schema, which agents now receive:

| Tool | Google's schema | This folder |
| --- | --- | --- |
| `docs__update_doc`, `slides__update_presentation` | `writeControl` optional; `targetRevisionId` allowed | `writeControl.requiredRevisionId` required (read the document first); `targetRevisionId` refused |
| `docs__update_doc`, `slides__update_presentation` | any request kind | closed list of request kinds; kinds that read another file refused |
| `sheets__update_spreadsheet` | `writeControl` allowed | `writeControl` refused (no revision check in Sheets REST) |
| `sheets__get_spreadsheet` | `commentsIncluded: true` allowed | refused (not in the Sheets API) |
| `sheets__insert_dimension` | `DIMENSION_UNSPECIFIED` in the enum | refused |
| `calendar__delete_event` | a recurring series ID deletes the series | refused; pass one occurrence |
| `gmail__create_draft` | attachments | refused, as Google's tool does today |
| `drive__search_files` | full MCP query language and `orderBy` | terms without a Drive `q` equivalent refused; `orderBy` limited |
| every tool | not recorded what an argument outside the schema does | refused with the argument's name (see "Unknown arguments") |

Each refusal is a tool error that says what to do, and nothing is changed.

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
  it never returns a result, or a page, with a body missing. One call reads at
  most 20 such bodies (see "Google requests per call"). Google's reference
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
- **`label:` in search queries.** Google's `search_threads` reference says its
  query accepts label IDs, not display names. Gmail search (the `q` parameter
  that REST passes to Gmail) uses label names, with spaces written as hyphens,
  as in Gmail's own search operators (`label:friends`). REST parameters named
  `labelIds` take IDs. Our query descriptions describe the REST behavior, and
  `allowlist.test.ts` checks that no description says `label:` takes IDs.
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
- **Filters on list tools** (checked 2026-11-23). `list_threads` had no
  `query`, so a call with `query` listed every thread; it now takes `query`
  (see "Not verified against Google's servers"). `search_messages` and
  `list_drafts` already take `query`, sent as Gmail's `q`. `list_labels` has
  no filter: Gmail's `labels.list` has none. Calendar `list_events` filters
  with `fullText`, and `list_calendars` has no filter in REST. Drive
  `list_recent_files` stays without `query`, as in Google's Drive MCP tool;
  `search_files` is the Drive tool that filters. In each case an argument the
  tool does not have is refused, never ignored.
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
not include. "Bodies" are separately stored bodies (at most two per message,
plain and HTML, and none for most mail). One call reads at most 20 of them
(`MAX_SEPARATE_BODIES_PER_CALL` in `gmail/message.ts`). When the messages in a
call need more, the call reads none and returns a tool error that starts with
"Could not read the full body of every message" and says to ask for fewer
results or to use `get_message`.

Quota units come from Gmail's published per-method costs
(<https://developers.google.com/workspace/gmail/api/reference/quota>, recorded
2026-11-17): `messages.get` and `drafts.get` 20 (60 with `format=full`),
`threads.get` 40 (120 with `format=full`), `messages.attachments.get` 20,
`threads.list` 10, `messages.list` and `drafts.list` 5, `labels.list` 1,
`drafts.create` 10. Gmail allows 6,000 units per user per minute.

| Tool | Requests at the maximum page size | Worst-case quota units |
| --- | --- | --- |
| `get_message` | 1 + up to 2 bodies = 3 | 60 + 40 = 100 |
| `get_thread` | 1 + up to 20 bodies = 21 | 120 + 400 = 520 |
| `search_threads` | 1 + 50 = 51 | 10 + 50 × 40 = 2,010 |
| `list_threads` | 1 + 50 = 51 | 2,010 |
| `search_messages` | 51; with `FULL_CONTENT` 1 + 50 + 20 = 71 | 1,005; with `FULL_CONTENT` 5 + 50 × 60 + 400 = 3,405 |
| `get_draft` | 1 + up to 2 bodies = 3 | 60 + 40 = 100 |
| `list_drafts` | 51; with `DRAFT_VIEW_FULL` (the default) 71 | 1,005; with `DRAFT_VIEW_FULL` 3,405 |
| `list_labels` | 1 | 1 |
| `create_draft` | 1, or 2 for a reply | 10, or 30 for a reply |

The worst single call (3,405 units) fits inside the 6,000-unit per-user
minute. At the default page size of 20 the worst is 1,605 units. Concurrency
does not change the total: the 10 parallel reads only spread one call's fixed
units over less time. A second maximal call in the same minute can exceed the
per-user quota; Google then answers 429, which becomes the `rate_limited` tool
error ("Google is rate limiting requests. Try again shortly."). Gmail's quota
page states no per-user concurrency limit.

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
- **`list_threads`**: input `pageSize`, `pageToken`, `query`, `includeTrash`
  and `view` as in `search_threads`, plus `labelIds` (at most 20; a thread
  must have all of them); result is `search_threads`'s. `query` is sent as
  Gmail's `q`, with the same name and meaning as in `search_threads`, and a
  thread must match both the query and the labels. Drafts are excluded unless
  `DRAFT` is among the labels or the query uses `in:draft`; spam and trash are
  included when `SPAM` or `TRASH` is among the labels or `includeTrash` is set.
- **`search_messages`**: input as `search_threads`, with `messageFormat` from
  `get_message` instead of `view`; result is `{ messages, nextPageToken,
  resultCountEstimate }` with `get_message`'s `Message`. Unlike `get_message`,
  the default (and `MESSAGE_FORMAT_UNSPECIFIED`) is `MINIMAL`, so a search does
  not pull every body. One `messages.list`, then one `messages.get` per message,
  plus bodies with `FULL_CONTENT`.

A switch back to `google_mcp` would drop these three unless Google adds them.

To check when a live tester exists: record `read_doc` and `read_presentation`
answers from Google's Docs and Slides MCP servers for a test document and
deck, and compare their `content` with ours. Google publishes only that
`content` is an object; our text form and structure are unverified against
Google's server.

## Calendar tools

Names, input fields, enums, result shapes and annotations come from Google's
Calendar MCP reference
(<https://developers.google.com/workspace/calendar/api/v3/reference/mcp>,
recorded 2026-11-17). All calls go to the Calendar REST API v3 at
`https://www.googleapis.com/calendar/v3/`. Scopes below are the narrowest
one each REST call accepts among those `toolScopes.calendar` allows.

| Tool | REST calls | Works with |
| --- | --- | --- |
| `list_calendars` | `calendarList.list` | `calendar.calendarlist.readonly` |
| `get_event` | `events.get` | `calendar.events.readonly` or `calendar.events` |
| `list_events` | `events.list` (plus a one-field `events.list` for the calendar's time zone when a time has no offset and no `timeZone` is given) | `calendar.events.readonly` or `calendar.events` |
| `search_events` | `events.list` with `q` on `primary` | `calendar.events.readonly` or `calendar.events` |
| `suggest_time` | `freeBusy.query`; without the free/busy permission, `events.list` on each attendee's calendar; a one-field `events.list` on `primary` for the time zone when none is given | `calendar.events.freebusy`, or `calendar.events.readonly` / `calendar.events` with the fallback |
| `create_event` | `events.insert` (plus the time zone read for a timed event without `timeZone`) | `calendar.events` |
| `update_event` | `events.get`, then `events.patch` with `If-Match` | `calendar.events` |
| `delete_event` | `events.get`, then `events.delete` | `calendar.events` |
| `respond_to_event` | `events.get`, then `events.patch` of `attendees` with `If-Match` | `calendar.events` |

`events.list` and `events.get` accept `calendar.events.freebusy`,
`calendar.events.readonly` and `calendar.events`, so the time zone read works
for every grant. `freeBusy.query` does not accept `calendar.events`, which is
why `suggest_time` has a fallback (see open questions). Google's reference
for `freeBusy.query`
(<https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query>,
recorded 2026-11-17) says: "This request allows authorization with at least
one of the following scopes:" and lists only
`https://www.googleapis.com/auth/calendar.readonly`,
`https://www.googleapis.com/auth/calendar`,
`https://www.googleapis.com/auth/calendar.events.freebusy` and
`https://www.googleapis.com/auth/calendar.freebusy`.

### Time handling

- Times without an offset are read in `timeZone` when given, otherwise in the
  event's own time zone (`update_event`), otherwise in the calendar's time zone
  read from Google. A time zone is never guessed, and the server's own zone is
  never used. Unknown or non-IANA names (including `+05:00`) are refused.
- A stated offset (`Z`, `-07:00`) is always used as given.
- A local time that does not exist (DST spring forward) moves forward by the
  gap; a repeated local time (DST fall back) takes the first occurrence. This
  is the same rule as JavaScript Temporal's `compatible`.
- Timed events are sent as `dateTime` with an explicit offset plus `timeZone`,
  so Google never has to resolve a local time. Arithmetic uses `Intl` only; no
  date library.
- All-day events (`allDay: true`) use only the dates. The end is exclusive, as
  in Google Calendar: an end on the start date, or an end at midnight, means
  through the day before; an end later in a day includes that day.
- `list_events` defaults to now through 7 local days later (7 × 24 hours when
  no time zone was needed). Recurring events are expanded into occurrences
  (`singleEvents=true`).
- `update_event`: changing only the start keeps the elapsed duration; changing
  only `timeZone` keeps the same moment and shows it in the new zone; changing
  only the start of an all-day event keeps its number of days.

### Notifications

Write tools follow the defaults Google's MCP reference documents:
`create_event`, `update_event` and `delete_event` default to `ALL` (Google
emails every attendee); `respond_to_event` defaults to `EXTERNAL_ONLY`.
`NOTIFICATION_LEVEL_UNSPECIFIED` means the same default. `NONE`,
`EXTERNAL_ONLY` and `ALL` map to REST `sendUpdates=none|externalOnly|all`,
and `sendUpdates` is always sent explicitly. Each tool description says what
its default sends.

### How `suggest_time` works

1. Resolve the time zone (see above) and the range; at most 62 days.
2. Read busy times for every attendee with one `freeBusy.query` (a read, so it
   may be retried once). If Google answers that the grant lacks the free/busy
   permission, read each attendee's calendar with `events.list` instead,
   counting events that are not cancelled, not marked free, and not declined
   by the calendar's owner; all-day events count from midnight to midnight in
   that calendar's zone.
3. If any attendee's availability cannot be read (free/busy errors, not
   shared, not found), return an error naming them. It never suggests a time
   from partial data.
4. Merge all busy times, take the free gaps inside the range, and intersect
   them with the allowed daily windows: `startHour` to `endHour` local time
   (default the whole day; `24:00` means midnight), skipping Saturdays and
   Sundays when `excludeWeekends` is set. `endHour` must be later than
   `startHour`; overnight windows are not supported.
5. Return free periods at least `durationMinutes` long (default 30), earliest
   first, at most `preferences.pageSize` (default 5, at most 50). Each slot is
   a whole free period, not split into meeting-length pieces, and its
   `start`/`end` are in the resolved zone.

Limits: attendees whose calendars are not shared with the user at all make the
call fail rather than be ignored; there is no ranking by preference beyond
earliest first; working hours and out-of-office settings are not read.

### Differences from Google's Calendar MCP tools

- **`update_event` is annotated `destructiveHint: true`** (deliberate). It
  overwrites fields, can remove attendees and replaces reminders, so
  approval and confirmation in Paperclip must treat it as destructive.
  Google's reference marks it non-destructive. It stays `idempotentHint:
  true`: the same patch applied twice leaves the event the same.
  `respond_to_event` stays non-destructive (it changes only the user's own
  response). `allowlist.test.ts` checks the write tools' annotations.
- **Time zone when none is given.** Google says its server resolves the
  user's time zone. Here it is the target calendar's time zone (the primary
  calendar for `suggest_time`), read from `events.list`, since the user
  settings API needs a scope outside the allowlist.
- **`search_events`** is keyword search (REST `q`: title, description,
  location, attendees, organizer, every term must match) on the primary
  calendar across all dates, not semantic search. A recurring series is
  returned once, as the series. Default page size 25.
- **`list_events` `orderBy: startTimeDesc`.** REST only sorts ascending, so
  this reads every matching page (up to 2,000 events; more is an error asking
  for a narrower range), reverses it, and pages by offset.
- **`list_events` page tokens** are ours (`pc1.` plus base64url JSON). They
  carry the first page's resolved time range, so later pages use the same
  range even when it defaulted to "now", plus Google's page token or the
  newest-first offset. A token from another order, or a raw Google token, is
  refused.
- **`create_event`** does not add the signed-in user as an attendee when
  others are invited (Google's tool does on the primary calendar); learning
  the user's address needs a scope outside the allowlist.
- **`delete_event` refuses a whole recurring series (deliberate).** REST
  `events.delete` and Google's tool delete the whole series when given the
  series' ID. Here, if the event read before deletion has `recurrence` and no
  `recurringEventId`, the tool returns an error asking for one occurrence's
  ID (from `list_events`) and sends no delete. The person approving the call
  sees only an event ID, and a whole series is a much larger change than it
  looks. Single events and single occurrences are deleted as usual, one ID per
  call, and the result is the event as read before deleting, with
  `status: cancelled`.
- **`update_event` and `respond_to_event` on a recurring event.** A series'
  ID changes (or responds for) the whole series; one occurrence's ID changes
  only that occurrence. Both descriptions say so, and the result shows which:
  a series has `recurrence` and no `recurringEventId`; an occurrence has
  `recurringEventId`.
- **`update_event` and `respond_to_event`** read the event first and patch
  with `If-Match`. If the event changed in between, nothing is changed and the
  tool says so. `update_event` with no changes returns the event without
  writing.
- **`respond_to_event`** needs the user to be an attendee on that calendar's
  copy (`self: true`); otherwise it refuses without writing.
- **`googleMeetUrl`** accepts only `https://meet.google.com/xxx-xxxx-xxx` links
  or bare meeting IDs.
- **Event results** omit `label` and `taskId` (not in REST). `availability`
  comes from REST `transparency`; `conferenceUrl` from `hangoutLink` or the
  video entry point.

## Drive tools

Names, input fields, result shapes and annotations come from Google's Drive
MCP reference
(<https://developers.google.com/workspace/drive/api/reference/mcp>, recorded
2026-11-17) and the `tools/list` of Google's hosted Drive MCP server on the
same date, which adds `snippetVerbosity`, `includeRichMetadata`,
`revisionId`, `pregeneratedId` and `inheritedPermissionsDisabled` to the
published pages. All calls go to the Drive REST API v3 at
`https://www.googleapis.com/drive/v3/` (uploads at
`https://www.googleapis.com/upload/drive/v3/`). The allowlist gives the six
reads `drive.readonly` and the two writes `drive.file`. Each REST method below
accepts that scope according to its reference page (recorded 2026-11-17), so
no broader scope is needed or requested.

| Tool | REST calls | Scope it runs under | Google reference |
| --- | --- | --- | --- |
| `search_files` | `files.list` | `drive.readonly` | <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list> |
| `list_recent_files` | `files.list` | `drive.readonly` | <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list> |
| `get_file_metadata` | `files.get` | `drive.readonly` | <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get> |
| `get_file_permissions` | `permissions.list` | `drive.readonly` | <https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list> |
| `read_file_content` | `files.get`, then `files.export` (Google files) or `files.get` with `alt=media` (text files); with comments, `comments.list` | `drive.readonly` | <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export>, <https://developers.google.com/workspace/drive/api/reference/rest/v3/comments/list> |
| `download_file_content` | `files.get`, then `files.export`, `files.get` with `alt=media`, or `revisions.get` with `alt=media` | `drive.readonly` | <https://developers.google.com/workspace/drive/api/reference/rest/v3/revisions/get> |
| `create_file` | `files.create` (metadata only, or `uploadType=multipart` on the upload path) | `drive.file` | <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create> |
| `copy_file` | `files.copy` | `drive.file` | <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/copy> |
| (probe) | `about.get` | `drive.readonly` or `drive.file` | <https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get> |

### What `drive.file` allows

`files.copy` accepts only `drive`, `drive.appdata`, `drive.file` and
`drive.photos.readonly`; `drive.readonly` cannot copy. Google's scope guide
(<https://developers.google.com/workspace/drive/api/guides/api-specific-auth>)
says `drive.file` covers files "that you open with an app or that the user
shares with an app". So with `drive.file`:

- `create_file` creates new files and folders in My Drive, and in folders this
  app created or was given.
- `copy_file` copies files this app created or was given. Whether Google also
  lets it copy a file the same token can only read through `drive.readonly` is
  not documented and has not been tried against Google (see open questions).
  When Google refuses, the tool error says that `drive.file` covers only files
  this app created or opened, and that nothing was created. The same applies
  to a `parentId` the app cannot use.
- Neither tool changes, moves, shares, trashes or deletes an existing file, and
  no tool in this folder does.

### Content

| File | `read_file_content` | `download_file_content` default |
| --- | --- | --- |
| Google Doc | `files.export` as `text/markdown` | `text/plain` |
| Google Sheet | `text/csv` of the first sheet, after a line saying only the first sheet is shown | `text/csv`, first sheet only (the description says so and names the XLSX type for every sheet) |
| Google Slides | `text/plain` | `text/plain` |
| Google Drawing | not supported | `image/svg+xml` |
| Apps Script | not supported | `application/vnd.google-apps.script+json` |
| Other Google types (folder, form, site, shortcut) | not supported | tool error |
| `text/*`, JSON, XML, YAML, `+json` and `+xml` types | the stored bytes as UTF-8 | the stored bytes |
| Anything else (PDF, Office, images, video) | not supported | the stored bytes |

`exportMimeType` picks the export format for Google files and is ignored for
other files, as in Google's reference. It must be one of the formats Google's
export table lists for that file type (`EXPORT_FORMATS` in
`drive/content.ts`, from
<https://developers.google.com/workspace/drive/api/guides/ref-export-formats>);
anything else is refused before a request is sent. Every request uses the
`fileId` the caller passed, never an ID taken from Google's answer. `download_file_content` returns
`{ id, title, mimeType, content }`: `content` is base64 and `mimeType` is the
type of the returned bytes (the export format for Google files).
"Not supported" means `fileContent: ""` with `textFormattingNotSupported:
true`, the field Google's result has for this case. Text that is not valid
UTF-8 is also not supported.

**Size cap.** Every Drive tool is bound by the caller's result limit (see
"Result size"). The result carries the payload twice, as `structuredContent`
and as its JSON text. Content is also never read past the limit, since more
could never fit: a stored file whose metadata size is larger is refused before
any download, and exports and revisions are read through
`GoogleHttp.download`, which stops at the limit. Both
limits are far under Google's 10 MB export limit
(<https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export>)
and the 20 MB `MAX_RESPONSE_BYTES`. A refused result is an error that says
nothing was returned and how to ask for less (a smaller `pageSize`, no
`includeRichMetadata` or `includeComments`, another export format, or
`read_file_content` for a Google file's text). It never returns cut-short
content. Google's `exportSizeLimitExceeded` answer gives a similar error. `create_file`
uploads at most 5 MB, the limit for one multipart upload.

**Redirects.** `files.export` and `alt=media` downloads are answered by
`www.googleapis.com` itself. `google-http.ts` never follows a redirect (it
sends `redirect: "manual"`, and the gateway's guarded fetch never follows
one either), so a download Google redirects elsewhere is a tool error, not a
request to a host outside the allowlist.

### Search

`search_files` takes Google's MCP query language (`title contains 'x' and
modifiedTime > '...'`). `drive/query.ts` tokenizes and parses it into a tree,
checks each term and operator against the list Google publishes, and writes a
new Drive `q` string from the tree. Values are always re-quoted with `'` and
`\` escaped, so text inside a value can never become an operator; tests cover
quote, backslash and parenthesis injection. Mapping: `title` → `name`;
`parentId = 'x'` → `'x' in parents`; `owner = 'x'` → `'x' in owners`; `!=` on
those → `not ...`; `visibility = 'anyone'` or `'domain'` → both of Drive's
`...CanFind` and `...WithLink` values; other terms pass through. `creator`,
`sharedFrom`, `sharedTo`, `followUp`, `folderProperties` and
`visibility = 'external'` have no Drive `q` equivalent and are refused with an
error rather than ignored. Unless the query uses `trashed`,
`and trashed = false` is added, as Google's tool does.

Drive's `name contains` is a prefix match ("HelloWorld" matches `'Hello'`, not
`'World'`), so `title contains` is too; the query help says so and suggests
`fullText contains` for a word inside a title. When Google answers
`incompleteSearch: true` (it could not search every corpus), both list tools
return `incompleteSearch: true` so an agent does not take a short list as
proof that a file does not exist. Google's MCP result has no such field.

### Google requests per call

`search_files`, `list_recent_files` and `get_file_metadata`: 1.
`get_file_permissions`: 1 per 100 permissions, at most 10 (more is an error).
`download_file_content`: 2 (1 when the stored size is over the cap).
`read_file_content`: 1 for unsupported types, otherwise 2, plus 1 per 100
comment threads with `includeComments`, at most 10 (more is an error, never a
partial list). `create_file` and `copy_file`: 1. Page size for `search_files`
and `list_recent_files`: default 10, at most 100 (Drive allows 1,000). Reads
may be retried once by `google-http.ts`. Writes never are, and any failure
after a write was sent says it may or may not have happened.

### Differences from Google's Drive MCP tools

- **No content snippets.** REST has no generated snippet, so `contentSnippet`
  is never returned. `excludeContentSnippets` and `snippetVerbosity` are
  accepted (and still may not both be set) but change nothing.
- **Rich metadata.** `includeRichMetadata` adds `ownerName`,
  `lastModifyingUserName`, `lastModifyingUserEmail` and `visibility`.
  `visibility` comes from the file's `anyone` and `domain` permissions and is
  absent when Google does not show the user the file's sharing.
  `lastCommentedTime` is not returned; REST has no such field.
- **Text, not extraction.** Google's `read_file_content` also reads PDFs,
  Office files, images and video transcripts. REST can only do that by
  converting the file into a new Google file, which is a write, so those types
  return `textFormattingNotSupported: true`.
- **Spreadsheets** read as CSV of the first sheet only, since Drive's text
  exports of a spreadsheet hold only the first sheet. Every sheet needs the
  Sheets API.
- **Comments** are listed in `unanchoredComments` and never placed in the
  text, so `contentAnchoredComments` is always empty; REST anchors are opaque.
- **`revisionId`** works only for files that are not Google files.
- **`list_recent_files` `orderBy`** maps to Drive's `recency desc`,
  `modifiedTime desc` and `modifiedByMeTime desc`; other values fall back to
  recency, as Google documents.
- **`search_files` `orderBy`** accepts `modifiedTime` and `viewedByMeTime`,
  with `asc` or `desc`; anything else is an error. Without it, Drive's own
  order is used, which may differ from Google's relevance order.
- **Shared drives.** Lists include shared-drive items the user can see
  (`includeItemsFromAllDrives`), within Drive's default `user` corpus.
- **`create_file` conversion** uses a fixed table (text, Markdown, HTML, RTF,
  Word and OpenDocument text to Docs; CSV, TSV, Excel and OpenDocument sheets
  to Sheets; PowerPoint and OpenDocument presentations to Slides) instead of
  reading Drive's `importFormats`. Without content, only Docs, Sheets, Slides
  and folders can be created.
- **`copy_file`** sends no name or folder unless given, so the copy's default
  name and folder are the REST defaults. Folders cannot be copied.
- **`pregeneratedId`** is passed to Drive as the new file's `id`. This folder
  has no tool that generates IDs.

## Docs and Slides tools

Names and input fields come from Google's MCP references
(<https://developers.google.com/workspace/docs/api/reference/mcp/tools_list/read_doc>,
`.../update_doc`,
<https://developers.google.com/workspace/slides/api/reference/mcp/tools_list/read_presentation>
and `.../update_presentation`, recorded 2026-11-17). Annotations follow them
except `destructiveHint` on `update_doc` (see the differences below). Each
tool makes one REST call; `read_doc` makes a second only when Google refuses
the first for the user's access (see "Suggestions and comments").

| Tool | REST call | Works with | Google documentation |
| --- | --- | --- | --- |
| `read_doc` | `documents.get` with `includeTabsContent=true` and an explicit `suggestionsViewMode` | `documents.readonly` or `documents` | <https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get> |
| `update_doc` | `documents.batchUpdate` | `documents` | <https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate> |
| `read_presentation` | `presentations.get` | `presentations.readonly` or `presentations` | <https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/get> |
| `update_presentation` | `presentations.batchUpdate` | `presentations` | <https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/batchUpdate> |

### What the read tools return

Google documents both results only as `{ content: object }`, "a JSON
representation" of the file, and does not say what is inside. Here `content`
holds:

- `text`: the whole file as Markdown-style text. Docs: every tab (child tabs
  included, each under `=== Tab: Parent / Child ===` when there is more than
  one), headings as `#`, list items with their real numbering (`1.`, `a.`,
  `iv.`, nested formats such as `1.2.`, start numbers, numbering that
  continues across interrupting paragraphs), tables as `| cells |` with nested
  tables flattened into one cell, merged table cells placed on the full grid
  (every row has the table's column count; cells covered by a merge read
  `(merged left)` or `(merged up)`, never a blank), links as `[text](url)` (heading, bookmark and
  tab links as `#heading=…`, `#bookmark=…`, `#tab=…`), footnote references as
  `[^n]` with the footnotes after the body, headers and footers labelled
  default, first page or even pages, person and date chips, rich links, page
  and column breaks, and, in the `SUGGESTIONS_INLINE` view only, pending
  suggestions as `{+inserted+}` and `{-deleted-}`. Slides: each slide as `## Slide n` (marked skipped when it
  is), title placeholders as `###`, bullets with their own glyph, tables,
  groups, word art, and each slide's speaker notes under `Speaker notes:`.
- A structure for edits. Docs: `tabs[]` with every paragraph's and table
  cell's `startIndex`, `endIndex`, named style and list, plus headers, footers
  and footnotes by segment ID. A paragraph's `text` is exact: each non-text
  index (an image, a footnote reference, a chip) is one U+FFFC, so
  `text.length` equals `endIndex - startIndex`. Slides: `slides[]` with each
  page element's `objectId`, type, placeholder and raw text, table cells by
  row and column (Slides tables are placed on the grid by each cell's
  `location` and spans, since `tableCells` leaves out covered cells), and the
  speaker notes shape's `objectId`.
- `revisionId`, which the update tools require.
- `notes`: what could not be shown as text, with a count, and for Docs always
  which suggestions view was used.
- Docs: `suggestionsViewMode`, the view the document was read in.
- With `commentsIncluded`, a `[Comments]` section (`commentsViewMode` on both
  APIs).

### Suggestions and comments

`read_doc` always asks for `suggestionsViewMode=SUGGESTIONS_INLINE`, so
pending suggested edits are shown and the indices are the ones
`documents.batchUpdate` needs (the Document reference: "When editing a
document, changes must be based on a document with SUGGESTIONS_INLINE").
Google answers 403 to that view when the user may not see suggestions; without
an explicit view a viewer would silently get `PREVIEW_WITHOUT_SUGGESTIONS`.
On a 403 permission answer the tool reads again with
`PREVIEW_WITHOUT_SUGGESTIONS` (without comments, which Google returns only
with inline suggestions). That result says, in `suggestionsViewMode` and
`notes`, that pending suggestions are not shown and that its indices may not
be valid for `update_doc`; if comments were asked for, `[Comments]` and
`notes` say they are not available with the user's access. Any other failure
(not found, API disabled, a missing Docs permission on the grant) is returned
as is, without a second read. A document that is readable is never turned
into an error by these options.

`read_presentation` with `commentsIncluded` asks for
`commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED`. If Google refuses that with a
permission error, the tool reads only the presentation's ID to check that the
presentation itself is readable; if it is, it returns an error saying comments
are not available with the user's access and that it can be read without
`commentsIncluded`. If not, Google's own error is returned.

`read_presentation` with `fields` returns Google's resource limited to those
fields, unchanged, as Google's tool does.

What cannot be represented, and is listed in `notes` when present: pictures
(shown as `[image: title or alt text]`), drawings, charts, equations (the Docs
API does not return their content), dropdown values, Slides videos (shown with
their link), and text that slide masters and layouts put on every slide.
Formatting other than headings, lists and links (bold, colors, fonts, sizes)
is not in `text`. Checklist items render as plain list items: the Docs API
does not say whether a box is ticked.

A result over the caller's limit (see "Result size") is refused with an error
that gives the size and returns nothing; it is never cut short. The final
serialized MCP result carries the content twice (as JSON text and as
structured content), and `read_doc` also repeats each paragraph's text in its
edit structure. To read a
large presentation in parts, pass `fields`, for example
`["slides(objectId,pageElements(objectId,shape.text))"]`. `read_doc` has no
way to read part of a document, since Google's tool has no such input and
`documents.get` cannot select one tab; a document whose result would be over
the limit cannot be read through this tool.

### How the update tools work

Google's tools take `documents.batchUpdate` and `presentations.batchUpdate`
requests as they are, so these do too: the requests are posted unchanged and
in the caller's order, in one call. Google applies them in order and all or
none; each request sees the file as changed by those before it. Reordering
them here would change what dependent requests (insert, then style the
inserted text) do, so nothing is reordered. The descriptions tell callers to
order several index-based edits from one read from the highest index to the
lowest; the tests show that order gives the intended result and the reverse
does not.

`writeControl.requiredRevisionId` is required (Google makes it optional). It
is the `revisionId` from the read tool. If the file changed since, Google
rejects the whole batch and the tool answers that the file is no longer at
the revision you read, nothing was changed, and to read it again. A rejection
counts as a conflict when Google's structured `error.status` is
`FAILED_PRECONDITION` or `ABORTED`, or a reason in `error.details` names a
revision or an unmet condition; only when neither field says so does the
message decide ("required revision", "revision ID" or "latest revision").
Any other 400 returns Google's own message.
`targetRevisionId` (Docs), which would apply the edit to a newer version, is
refused. The answer includes the new revision in `writeControl`, also for
Slides (Google's Slides tool lists only `replies`). A write is never retried;
a failure after it was sent carries the uncertain-outcome warning.

Each request must name exactly one request kind; at most 500 per call.

The requests can delete or replace content in the one file the call names:
text (`deleteContentRange`, `deleteText`, `replaceAllText`), tabs
(`deleteTab`) and slides or page elements (`deleteObject`), as in Google's
tools. Both update descriptions say so. The tools cannot create, delete, move,
copy or share files, and there is no tool that can.

#### Allowed request kinds

Each update tool accepts only the request kinds in a closed list:
`DOCS_REQUEST_KINDS` in `docs/request-kinds.ts` and `SLIDES_REQUEST_KINDS` in
`slides/request-kinds.ts`, built from Google's REST request references
(<https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request>,
<https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/request>,
recorded 2026-11-17). A kind is allowed only when it acts within the one file
being edited. Any kind not on the list, including one Google adds later, is
refused with an error that names it, and nothing is sent. The same table
builds the lists in the tool descriptions and drives the tests, and a test
checks it covers every kind in Google's reference.

Docs: every kind in Google's `documents.batchUpdate` reference and in its
`update_doc` MCP reference is listed. All are allowed except `insertRichLink`
(refused); `insertInlineImage` and `replaceImage` are allowed only in the
restricted form below.

Slides: every kind in Google's `presentations.batchUpdate` reference and in
its `update_presentation` MCP reference (which adds `importSlides`,
`createAudio` and `updateAudioProperties`) is listed. All are allowed except
`createSheetsChart`, `replaceAllShapesWithSheetsChart`, `refreshSheetsChart`,
`importSlides` and `createAudio` (refused); `createVideo`, `createImage`,
`replaceImage`, `replaceAllShapesWithImage` and `updatePageProperties` are
allowed only in the restricted forms below. No other kind can link content
from another file: linked charts come only from the refused Sheets chart
kinds, and linked slides only from the refused `importSlides`.

The tests keep Google's full lists and check that each kind is classified
explicitly; only a kind on neither list falls through to "not a request kind
this tool accepts".

Refused, because they read another file:

| Tool | Kind | Reason |
| --- | --- | --- |
| `update_doc` | `insertRichLink` | A smart chip that points to another file and shows its title. |
| `update_presentation` | `createSheetsChart`, `replaceAllShapesWithSheetsChart`, `refreshSheetsChart` | Read a chart from a Google Sheets spreadsheet. |
| `update_presentation` | `importSlides` | Copies slides from another presentation (in Google's MCP tool list, not in REST). |
| `update_presentation` | `createAudio` | Inserts an audio file from Google Drive (in Google's MCP tool list, not in REST). |

Refused forms of allowed kinds: `createVideo` is accepted only with
`source: "YOUTUBE"` (a `DRIVE` video is another file). Image kinds
(`insertInlineImage` and `replaceImage` in Docs; `createImage`, `replaceImage`,
`replaceAllShapesWithImage` and a `stretchedPictureFill.contentUrl` page
background in Slides) are allowed with a public image link, since Google
fetches it without the user's data, but refused when the link is on
`drive.google.com` or `docs.google.com`, which names another file. Links in
text styles stay allowed: they only point somewhere and read nothing.

This is a deliberate difference from Google's tools, which accept every
request kind.

Both update tools are annotated `destructiveHint: true` and
`idempotentHint: false`, because a batch can delete or overwrite content and
repeating it repeats the edit. Google marks `update_doc` non-destructive; this
is a deliberate difference so that approval and confirmation in Paperclip
match what the tool can do. `allowlist.test.ts` checks all four tools'
annotations.

### Differences from Google's Docs and Slides MCP tools

- `content` is the text form and structure above, not the raw REST resource
  (except `read_presentation` with `fields`). Google does not publish the
  inner format of `content`, and ours has not been compared with an answer
  from Google's server (see "Not verified against Google's servers").
- `requiredRevisionId` is required and `targetRevisionId` is refused.
- `update_doc` is annotated destructive (Google: not destructive).
- `read_doc` always sets `suggestionsViewMode` and falls back to
  `PREVIEW_WITHOUT_SUGGESTIONS` for users who may not see suggestions.
- Both update tools accept only a closed list of request kinds and refuse
  kinds and forms that read another file (see "Allowed request kinds").
- At least one request is required.
- Descriptions are our own wording. The `documentId` description does not
  name Drive's file ID field.

## Sheets tools

Names, input fields, result shapes and annotations come from Google's Sheets
MCP reference
(<https://developers.google.com/workspace/sheets/api/reference/mcp>, recorded
2026-11-17). All calls go to the Sheets REST API v4 at
`https://sheets.googleapis.com/v4/spreadsheets/`; `google-http.ts` allows that
host only under that path, checked after URL normalization. Each tool works
with exactly the scopes `toolScopes.sheets` allows.

| Tool | REST call | Works with | Google documentation |
| --- | --- | --- | --- |
| `get_values` | `spreadsheets.values.get` | `spreadsheets.readonly` or `spreadsheets` | <https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get> |
| `get_spreadsheet` | `spreadsheets.get` | `spreadsheets.readonly` or `spreadsheets` | <https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get> |
| `update_values` | `spreadsheets.values.update`, `valueInputOption=RAW` | `spreadsheets` | <https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update> |
| `update_formulas` | `spreadsheets.values.update`, `valueInputOption=USER_ENTERED` | `spreadsheets` | <https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update> |
| `insert_dimension` | `spreadsheets.batchUpdate` with one `insertDimension` | `spreadsheets` | <https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate> |
| `update_spreadsheet` | `spreadsheets.batchUpdate` | `spreadsheets` | <https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate> |

Every tool makes exactly one Google request. Writes are never retried; a write
that fails after it was sent carries the usual "may or may not have been
made" warning.

### Values

- **`get_values` returns formatted values**, as Google Sheets displays them
  (`valueRenderOption=FORMATTED_VALUE`, `majorDimension=ROWS`, both sent
  explicitly; these are the REST defaults, and Google's tool exposes no render
  option). Numbers, currency, percentages and dates come back as the displayed
  text (`"$1,200.50"`, `"12%"`, `"1/5/2026"`), booleans as `"TRUE"`/`"FALSE"`,
  errors as their text (`"#DIV/0!"`), and formula cells as their result.
  Any other argument, such as `valueRenderOption`, is refused.
  Google's answer is returned unchanged: trailing empty rows and columns are
  left out, so rows can differ in length; an empty range has no `values`
  field; in a merged area only the top-left cell holds the value. One range per
  call, as in Google's tool (no `values.batchGet`).
- **Unformatted values, formulas and several ranges** come from
  `get_spreadsheet` with `ranges` and `includeGridData`: each cell has
  `userEnteredValue` (including the formula), `effectiveValue` (dates and
  times as serial numbers, days since 1899-12-30) and `formattedValue`; merged
  areas are listed in `merges`. The Spreadsheet resource is returned unchanged
  under `content`. `fields` takes Google's field-mask syntax, including
  groups such as `sheets.properties(sheetId,title)`; a mask with any character
  other than letters, digits, `_ . , ( ) / *`, or with unbalanced parentheses,
  is refused before sending.
- **`update_values` writes raw values** (`RAW`): strings are stored as given,
  so `"=A1"`, `"2026-01-05"` and `"1,000"` stay text. Google's reference does
  not name the option; RAW is our reading of it, because Google ships a
  separate `update_formulas` tool. **`update_formulas`** uses `USER_ENTERED`,
  so a string starting with `=` becomes a formula and other text may be parsed
  by the spreadsheet's locale. Both take strings, finite numbers, booleans and
  `null` (skip the cell); `""` clears a cell; anything else is refused before
  sending.
- **Ranges** are checked before sending (`sheets/range.ts`): A1 (`A1`,
  `A1:C10`, `A:C`, `2:5`, `A2:C`, `$A$1`) or R1C1 (`R1C1:R10C3`), with an
  optional sheet name. A sheet name with anything other than letters, digits
  and `_` must be in single quotes with apostrophes doubled (`'Q1 Plan'!A1`,
  `'Bob''s list'!A:A`); an unquoted one is refused with that hint. A bare name
  is a sheet or named range. Columns are limited to `ZZZ` and rows to
  10,000,000.

### Bounds

- At most **50,000 cells** per call, read or written (`MAX_CELLS_PER_CALL`).
  Reads count the cells Google returns (`values` rows, or `rowData` values in
  grid data); writes count the cells sent (`values`/`formulas`, or the rows of
  `updateCells` and `appendCells`).
- A tool's whole result is bound by the caller's limit (see "Result size"),
  measured on this folder's own result, which carries the value twice (as
  `structuredContent` and as JSON text, since MCP clients read either).
  A write request body is at most 1,000,000 characters.
- Over a limit, a read returns an error that starts with the size and asks for
  a narrower range, fewer or narrower `ranges`, or fewer `fields`, to read in
  smaller pieces; a write sends nothing. Nothing
  is ever cut short and presented as complete. A Google answer over the 20 MB
  transport limit gets the same narrowing message.
- Server-side operations in `update_spreadsheet` (for example `repeatCell`,
  `sortRange`, `findReplace`, `copyPaste`) are bounded by Google, not here.

### Write results

Write results are Google's REST response under `content`, plus `status`, a
sentence naming what changed. Google says its result has a `status` field but
not what it holds.

- `update_values`/`update_formulas`: `Updated 4 cells in 'Q1 Plan'!A1:B2
  (2 rows × 2 columns) as raw values.`, from Google's `updatedRange` and
  `updatedCells`.
- `insert_dimension`: the inserted rows or columns, 1-based (`sheet ID 0,
  rows 6–8`), and that no values were written.
- `update_spreadsheet`: each request in order with the range it touched
  (`1. deleteDimension on sheet ID 0, columns B–C`), and the cells written by
  `updateCells`/`appendCells`. Where each request type keeps its range (for
  example `addNamedRange.namedRange.range`) is listed once in
  `REQUEST_TARGETS`; a test fails if a supported type has no entry.

### `update_spreadsheet` operations

Google's reference lists 74 request types. 64 are accepted, each request must
have exactly one of them, and anything else is refused before sending. Refused:

- **Comments** (`insertComment`, `addCommentReply`, `updateCommentPost`,
  `deleteComment`, `deleteCommentReply`): not part of the Sheets REST API.
- **Data sources** (`addDataSource`, `updateDataSource`, `deleteDataSource`,
  `refreshDataSource`, `cancelDataSourceRefresh`): they need a BigQuery scope
  outside the allowlist, and Google's insufficient-scope answer would wrongly
  ask the user to reconnect.

Google's documented list includes operations that remove content, and they
are accepted as documented: `deleteSheet`, `deleteDimension`, `deleteRange`,
`deleteDuplicates`, `deleteTable`, `deleteNamedRange`, `deleteEmbeddedObject`,
`deleteFilterView`, `deleteConditionalFormatRule`, `deleteProtectedRange`,
`deleteBanding`, `deleteDeveloperMetadata`, `deleteDimensionGroup` and
`clearBasicFilter`; `cutPaste`, `findReplace`, `sortRange`, `pasteData`,
`trimWhitespace` and `randomizeRange` change existing cells. No operation
deletes or creates a spreadsheet or changes its sharing. Because of these,
`update_spreadsheet` says `destructiveHint: true`, where Google's reference
says `false`.

### Differences from Google's Sheets MCP tools

- **`get_spreadsheet` `commentsIncluded: true` is refused.** `spreadsheets.get`
  cannot return comments (they are in the Drive API, outside the Sheets
  scopes). `false` or unset works.
- **`update_spreadsheet` `writeControl` is refused.** Sheets
  `spreadsheets.batchUpdate` has no required-revision check, so a write cannot
  be made conditional; any `writeControl` is an error rather than ignored.
- **`update_spreadsheet` refuses comment and data source requests** (above)
  and is marked destructive.
- **`insert_dimension` refuses `DIMENSION_UNSPECIFIED`** (Google says not to
  use it), `endIndex` not greater than `startIndex`, and `inheritFromBefore`
  with `startIndex` 0, before sending.
- **`status`** in write results is our sentence; Google's value is not
  documented.
- **Not verified against Google's servers:** whether Google's `get_values`
  uses formatted values and whether its `update_values` uses `RAW` (both are
  the closest reading of the reference). A recorded comparison on the
  enrolled internal account would settle both.

## Open questions

- Whether an OAuth client marked as an AI-powered agent may call the REST APIs.
  The AI Tools Addendum says an agent must use a Google MCP, so the fallback
  is for an outage or a Google problem, not for normal use.
- Each Google Cloud project behind a connection needs the REST APIs enabled
  for the fallback. Without that, calls return the `api_disabled` tool error.
- `freeBusy.query` does not accept `calendar.events`, and the read & write
  Calendar selection grants `calendar.calendarlist.readonly` and
  `calendar.events` only (the `calendar.events` → `calendar.events.freebusy`
  implication in `googleWorkspaceEffectiveScopes` is ours, not Google's). Those
  users get the `events.list` fallback, which cannot see coworkers who share
  only free/busy. Adding `calendar.events.freebusy` (already one of the 14
  submitted scopes) to the `calendar.write` profile would fix that.
- Whether `files.copy` with a token that holds `drive.readonly` and
  `drive.file` can copy a file the app never created or opened. Google's scope
  pages do not say; one live call on the test account will tell. If it cannot,
  `copy_file` copies only files this app created or that were opened with it.

## Removal procedure

The owner decided on 2026-11-24 to keep this folder as the fallback. Remove it
only on a new decision.

1. Check that every service in `GOOGLE_WORKSPACE_TOOL_TRANSPORT` is
   `google_mcp`. Move `argument-guards.ts` and the request-kind lists it uses
   out of this folder first, because the MCP path uses them.
2. Delete this folder, `server/src/google-workspace-rest-tools/`.
3. Delete `server/src/services/google-workspace-rest-dispatch.ts` and its
   test, and the two call sites: the `paperclip_rest` branch in
   `executeRemoteHttpTool` (`server/src/services/tool-gateway.ts`), with
   `GOOGLE_WORKSPACE_REST_MAX_RESULT_BYTES` there, and
   `googleWorkspaceRestTools` in
   `server/src/services/tool-access/catalog/discovery.ts`. Delete
   `server/src/__tests__/google-workspace-rest-transport.test.ts`.
4. Check that the build, typecheck and tests pass, then delete the setting
   and `transport` itself if nothing else uses them.

## Development

```sh
cd server && npx vitest run src/google-workspace-rest-tools
```

Test fixtures in `fixtures/` and each service's `fixtures/` folder are synthetic, in the shape
of Google's REST responses. They contain no real mail, addresses or IDs.
