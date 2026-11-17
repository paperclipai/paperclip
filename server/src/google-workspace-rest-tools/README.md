# Google Workspace REST tools

Paperclip's own implementation of the tools that Google's hosted Workspace MCP
servers expose (for example `https://gmailmcp.googleapis.com/mcp/v1`), backed
by Google's generally available REST APIs.

It lives in this one folder, `server/src/google-workspace-rest-tools/`, inside
the server package. It is not a separate npm package, so nothing new is
published.

This release has three Gmail tools: `get_message`, `search_threads` and
`create_draft`. There is no send tool, and none may be added. It also has all
nine allowlisted Calendar tools (see "Calendar tools" below).

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
  says that the change may or may not have been made. Every method other than
  GET (POST, PATCH, PUT, DELETE) is a write; the only exception is a POST the
  request marks `readOnly` (Calendar's free/busy query). `www.googleapis.com`
  is allowed only under `/calendar/v3/`, checked after URL normalization.
- **One tool, one file.** Each tool in `gmail/` and `calendar/` is a set of pure functions
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
  Calendar has `probeCalendar()` in `calendar/index.ts` (one
  `calendarList.list` with `maxResults=1`), not yet exported from `index.ts`.
- `freeBusy.query` does not accept `calendar.events`, and the read & write
  Calendar selection grants `calendar.calendarlist.readonly` and
  `calendar.events` only (the `calendar.events` → `calendar.events.freebusy`
  implication in `googleWorkspaceEffectiveScopes` is ours, not Google's). Those
  users get the `events.list` fallback, which cannot see coworkers who share
  only free/busy. Adding `calendar.events.freebusy` (already one of the 14
  submitted scopes) to the `calendar.write` profile would fix that.

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

Test fixtures in `fixtures/`, `gmail/fixtures/` and `calendar/fixtures/` are synthetic, in the shape
of Google's REST responses. They contain no real mail, addresses or IDs.
