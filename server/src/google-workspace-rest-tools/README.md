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
It also has all nine allowlisted Calendar tools (see "Calendar tools" below).

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

  A grant that allows none of them (for example compose-only Gmail) is listed
  without a probe. An insufficient-scope answer to a probe never makes a
  service unavailable. A 401 refreshes the token and probes once more; a
  second 401 on a managed grant marks it `needs_reauthorization`, as the MCP
  path does. Any other probe failure makes that one service unavailable while
  the others stay usable. Health checks use the same branch.

MCP Tasks, MCP resources and elicitation only exist on the `google_mcp` path.

Measured with a stubbed fetch, the adapter adds about 15 µs per call. A full
`gmail__get_message` through `executeTool` (policy, records, screening) took a
median of 18.2 ms on either transport.

### Flipping a service

1. Implement every tool in that service's allowlist (`toolScopes` in the
   shared file) in this folder, plus its probe reads and their scopes in `probe.ts` and the service's
   API host in `google-http.ts`.
2. Set the service to `paperclip_rest` in `GOOGLE_WORKSPACE_TOOL_TRANSPORT`.

`googleWorkspaceRestTransportGaps()` in the adapter, run by
`google-workspace-rest-dispatch.test.ts`, fails while any service set to
`paperclip_rest` is missing an allowlisted tool, so a partial flip cannot ship.

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

- Whether an OAuth client marked as an AI-powered agent may call the REST APIs.
- Each Google Cloud project behind a connection needs the REST APIs enabled
  (Gmail now; Drive, Docs, Sheets, Slides and Calendar as their tools land).
  Without that, calls return the `api_disabled` tool error.
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

Test fixtures in `fixtures/`, `gmail/fixtures/` and `calendar/fixtures/` are synthetic, in the shape
of Google's REST responses. They contain no real mail, addresses or IDs.
