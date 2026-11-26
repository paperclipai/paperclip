# Toast semantics

Toasts are transient feedback, not a company activity feed. Live task notifications
are personal to the connected human, including in multiplayer and `local_trusted`
mode (`local-board`). Access to a task does not subscribe someone to notifications.

## Which tasks qualify

A task qualifies when the viewer created it, is its current human assignee,
authored a comment, or performed a deliberate action included in the existing
Mine participation allowlist in
[`issue-participation.ts`](../server/src/services/issue-participation.ts).
Read receipts, denied requests, and automatic read-time recovery cleanup do not
count. Comment authorship follows Mine's existing historical participation rule.

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
pages reconcile their data on return without replaying a notification backlog.
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
When an authenticated comment event omits the comment ID, the visible task thread
refreshes through its authorized HTTP read instead of trying to hydrate the comment.
Closed sockets cannot deliver stale notifications after account/company changes.
No client-side task-list cache or new database migration is required. During a
mixed-version rollout, a new client receiving events from an older server stays
quiet until the server provides eligibility.

## Verification

See [`inbox-search/toasts`](../maps/feature-map/inbox-search.md#toasts) for the
two-user browser recipe and linked regression suites. The map describes coverage;
it is not evidence that a particular deployment passed that journey.
