# Toast semantics

Toasts are transient feedback, not a company activity feed. Live task notifications
are personal to the connected human, including in multiplayer and `local_trusted`
mode (`local-board`). Access to a task does not subscribe someone to notifications.

## Which tasks qualify

A task qualifies when the viewer creates an ordinary human task, is its current
human assignee, comments directly in Paperclip, receives an open addressed request,
or performs a deliberate action included in the existing
Mine participation allowlist in
[`issue-participation.ts`](../server/src/services/issue-participation.ts).
Read receipts, denied requests, and automatic read-time recovery cleanup do not
count. Automatic creator attribution, synchronized comments, and manual routine
runs also do not count. Comment source checks apply to historical imports.

A task also qualifies when its current description or a non-deleted comment
contains an explicit mention of the viewer: `[Name](user://USER_ID)`. The shared
user-mention parser resolves the exact user ID; plain names and bare URLs do not
count. Existing comments are checked, so users need not have opened the task.
The event introducing the first mention can notify immediately. Removing the
only mention removes that qualification unless another participation rule holds.
Historical comment lookup uses an exact viewer-link regex backed by the existing
comment-body trigram index and returns at most one body for the shared parser.

Agent ownership, primary-agent preference, task/run `responsibleUserId`, company
membership, and involvement in a parent task do not qualify on their own.
Activity by any person or agent can notify a qualifying viewer. These rules do
not change Mine membership, task permissions, assignment, or inbox archive state.

## Events and suppression

| Event | Toast behavior |
| --- | --- |
| Task created, updated, or commented on | Requires personal task eligibility. The viewer's own activity stays quiet. |
| Run failed, timed out, or cancelled | Requires eligibility for the persisted run's task. An event's task hint or agent identity is not sufficient. |
| Agent error without a task, or run without a task | No live toast. Status remains available in company views. |
| Run started or succeeded | No live toast. |
| Save, Copy, and other direct action feedback | Existing caller-owned feedback is unchanged. |
| Company join request | Existing join-request notification behavior is unchanged. |

Eligibility is an additional gate, not a promise that every event produces a
toast. Existing rules still suppress activity for the task in view and run
outcomes already represented by the visible task/run tree. Comment-driven updates
can be combined with their paired comment event when that metadata is available.
Intentional operator interruptions and workspace contention do not announce run
failures. Duplicate terminal outcomes and failures older than five minutes (when
timestamps are available) remain quiet. Reconnect suppression, per-category rate
limits, content deduplication, and toast lifetime limits remain in effect. Hidden
pages close the live socket and drop events unless desktop notifications are
enabled. With Needs attention or All, the socket stays open so newly eligible
toasts can still fire. They reconcile query data on return without replaying a
notification backlog.
Archiving a task is not a notification unsubscribe.

## Delivery contract

The company WebSocket authorizes each event before evaluating relevance. Its
viewer-specific copy of the shared `LiveEvent` envelope contains `toastEligible`.
Only `true` permits a live task/run toast. Missing/false values, unresolved viewer
identity, and relevance lookup failures stay quiet. Agent-authenticated sockets
do not receive human toast eligibility. This field is computed per connection,
never persisted or published on the shared company event bus.

Authorized events still reach cache handling and component subscribers when
eligibility is false. Lookup failure is logged but does not discard the authorized
event. Existing task/run privacy checks and payload redaction remain in force.
Task activity notifications use the task title as their heading. The body names
the actor and previews the comment or describes the change, including the old
and new status when available. Markdown in comment previews becomes plain text.
Updates without a meaningful change stay quiet. Comment-driven updates produce
one notification with the comment and its changes. Creation notifications name
the creator. The title is limited to 120 characters and the body to 240.

After task-read authorization, the server adds the persisted task title and a
closed `notificationDetails` projection of the already-redacted activity. This
projection allows bounded comment IDs/previews, known status/priority values,
assignment/change flags, and comment/reopen context. It does not copy arbitrary
activity details, task descriptions, or raw change receipts. The title uses the
existing company-scoped identifier lookup. Comment previews read the complete
non-deleted comment by company, task, and comment ID. Task-registered secrets are
redacted from the complete title/comment before the preview is shortened, using
the same task redaction registry as HTTP reads. Titles and comment previews both apply the existing
pattern-based credential and configured username redaction, including creation
and update events without a comment. The notification
path uses the existing task-context indexes in two ordered reads, each limited to
129 rows. It accepts at most 128 distinct runs, 64 unique secrets and 64 KiB of
unique encrypted material, with a 16 KiB registry limit per run. Exceeding a limit
omits free text; the browser can use a previously loaded task title. HTTP history
reads retain their existing redaction behavior.

Authorized viewers share one identity/redaction promise for the same published
event. Each viewer still passes its own access check before reading that result.
The shared result contains redacted text and expires with the event object. Each
new event reads fresh redaction data; no plaintext secret values are cached.
Registry reads select only secret metadata, not full run contexts. Missing comments
and read/redaction failures omit the preview; they never reuse the event snippet.
If the optional task-identity lookup fails, the event still arrives. The browser uses a cached
title or `Task`; task identifiers remain in navigation links. Permission-check
failures do not use this fallback. Older servers can supply cached titles and
legacy activity details, but unspecified updates remain quiet.
When an authenticated comment event omits the comment ID, the visible task thread
refreshes through its authorized HTTP read instead of trying to hydrate the comment.
Closed sockets cannot deliver stale notifications after account/company changes.
No client-side task-list cache or new database migration is required. During a
mixed-version rollout, a new client receiving events from an older server stays
quiet until the server provides eligibility.

## Desktop notifications

Profile settings include an opt-in **Desktop notifications** control. Off is
the default. **Needs attention** mirrors error and warning toasts plus join
requests and requests that need you. **All** mirrors every in-app
toast that already passed the live-update gates above. Paperclip uses the
browser Notification API only while this tab is hidden, and only after this
browser grants permission. Enabling Needs attention or All also keeps the live
socket open while this tab is hidden so those toasts can fire. Off keeps the
existing close-on-hidden behavior. The choice stays in this browser. This is
not Web Push: a closed tab cannot notify.

## Verification

See [`inbox-search/toasts`](../maps/feature-map/inbox-search.md#toasts) for the
two-user browser recipe and linked regression suites. The map describes coverage;
it is not evidence that a particular deployment passed that journey.
