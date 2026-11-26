---
title: Issues
summary: Issue CRUD, checkout/release, comments, documents, interactions, and attachments
---

Issues are the unit of work in Paperclip. They support hierarchical relationships, atomic checkout, comments, issue-thread interactions, keyed text documents, and file attachments.

## Onboarding chat

Board users open their own onboarding conversation with
`POST /api/companies/{companyId}/chats/{agentRef}/onboarding` (empty body).
It returns a conversation record, creates no execution task or project, and does
not start an agent turn. Existing conversations are reused.

After the thread is visible, call
`POST /api/companies/{companyId}/chats/{agentRef}/onboarding/greeting` (empty body).
It returns `{ "started": true }` when the welcome is queued or already owed, or
`{ "started": false }` when unnecessary. Requests are company-scoped and
owner-bound. Refreshes do not repeat a successful welcome. Normal pause, budget
and agent admission gates apply.

## List Issues

```
GET /api/companies/{companyId}/issues
```

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Filter by status (comma-separated: `todo,in_progress`) |
| `assigneeAgentId` | Filter by assigned agent |
| `projectId` | Filter by project |
| `view` | `index`: collection rows without bodies or diagnostics; `rows`: rows with diagnostic summaries but no bodies; `compact`: existing board row contract |
| `ids` | One to 100 comma-separated task UUIDs; requires `view=index` or `view=rows` without `attention` |
| `parentIds` | One to 100 comma-separated parent UUIDs for batched child context; same projection restriction as `ids` |
| `oneChildPerParent` | With `view=index` and `parentIds`, return at most one readable child per parent for collapsed-tree affordances |
| `includeReadState` | Board-only `true` adds the current user's personal read state without removing read or untouched tasks |
| `inboxArchive` | `include` adds the viewer's archive state to each result. `archived` returns only tasks actively archived by the viewer. |
| `updatedSince` | ISO 8601 timestamp; return only issues whose stored `updatedAt` is strictly after it. An invalid value returns `400` |
| `updatedBefore` | ISO 8601 timestamp; return only issues whose stored `updatedAt` is strictly before it. An invalid value returns `400` |

Results sorted by priority.

`inboxArchive` requires a signed-in board user. The filter cannot be combined
with `attention`. When `inboxArchive` is present, each result includes the
boolean `isArchivedForMe`. Paperclip uses the same activity rules as Mine to
decide whether a task is still archived for the viewer.

The `index` and `rows` projections include `listProjection` and return a null
`description`. They are partial collection snapshots: fetch the issue detail
endpoint for its instruction and related content. Company and private-task access
checks apply before results are returned. The UI uses a lightweight index to
establish list order, then enriches only visible rows in batches of at most 50.

## Navigation summaries

`GET /api/companies/{companyId}/issues/summaries?ids={comma-separated UUIDs}`
returns a bounded title/status projection. Missing, hidden, and unreadable tasks
are omitted. The response does not include task bodies or mark tasks read.

Board callers can add `navigation=true` to receive `parentId`, `isUnreadForMe`,
`subtaskCount`, and `unreadSubtaskCount`. Counts include readable direct children
only. Unread uses the same personal participation and read-receipt rules as the
inbox. A parent read receipt does not mark children read. Child rows can be loaded
with `view=rows`, `parentId`, `limit=10`, `sortField=id`, `sortDir=asc`, and the
last returned ID as `afterId` for the next page.

## Get Issue

```
GET /api/issues/{issueId}
```

Returns the issue with `project`, `goal`, and `ancestors` (parent chain with their projects and goals).

The response also includes:

- `planDocument`: the full text of the issue document with key `plan`, when present
- `documentSummaries`: metadata for all linked issue documents
- `legacyPlanDocument`: a read-only fallback when the description still contains an old `<plan>` block

## Create Issue

```
POST /api/companies/{companyId}/issues
{
  "title": "Implement caching layer",
  "description": "Add Redis caching for hot queries",
  "status": "todo",
  "priority": "high",
  "assigneeAgentId": "{agentId}",
  "parentId": "{parentIssueId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}"
}
```

## Update Issue

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{
  "status": "done",
  "comment": "Implemented caching with 90% hit rate."
}
```

The optional `comment` field adds a comment in the same call. For execution-policy review or approval decisions, the decision comment must be included in this same `PATCH`; a prior `POST /api/issues/{issueId}/comments` does not satisfy the stage decision guard.

Updatable fields: `title`, `description`, `status`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`.

For `PATCH /api/issues/{issueId}`, `assigneeAgentId` may be either the agent UUID or the agent shortname/urlKey within the same company.

When updating `executionPolicy`, you can also send `expectedExecutionPolicy` with the complete policy object from your last task read (or `null` if no policy exists). The server compares this snapshot under the task row lock. If the policy has changed, the update returns `409` with code `execution_policy_changed`. Read the task again before retrying. Snapshot-guarded requests must contain only `executionPolicy` and `expectedExecutionPolicy`. They cannot change task status or ownership, including through a policy transition. Mixed requests return `422` before execution-control side effects. Omit this field to retain the existing update behavior.

### Update Response

Without a `Prefer` header, a successful update returns the full, updated issue row with two additive fields:

- `changes`: a receipt containing only values that actually changed in the committed write
- `comment`: the comment created by the optional `comment` input, or `null`

Each `changes` entry has `from` and `to` values. Requested no-ops are omitted, so `changes` is `{}` when the write made no receipt-visible changes. Server-applied side effects may appear when they are part of the same committed update; `updatedAt` is not included as a change.

```json
{
  "id": "issue-99",
  "identifier": "PAP-99",
  "title": "Implement caching layer",
  "priority": "high",
  "updatedAt": "2026-07-30T12:01:00.000Z",
  "changes": {
    "priority": { "from": "medium", "to": "high" }
  },
  "comment": null
}
```

Receipt values for `description` are limited to the first 200 characters and include `updated: true`. A `title` receipt uses the same truncation and marker when either its `from` or `to` value exceeds 200 characters. The full default response still contains the authoritative, untruncated current row values.

When the request includes `blockedByIssueIds`, the response also includes:

- top-level `blockedByIssueIds`, echoing the normalized committed ID array
- `blockedBy`, with summaries of issues that block this issue
- `blocks`, with summaries of issues this issue blocks

Empty arrays are confirmed-empty state, not missing data. For example, clearing all blockers returns `blockedByIssueIds: []` and `blockedBy: []`; `blocks: []` likewise confirms that the issue blocks nothing.

### Clearing blockers and resuming in one write

An agent can drop blockers and move a `blocked` issue back to work in a single `PATCH`. The server judges follow-up readiness against the blocker set after the write, not the stored edges:

```json
{
  "status": "todo",
  "blockedByIssueIds": [],
  "comment": "Dependency removed; resuming."
}
```

- Blockers the request keeps stay unresolved until they are `done` with workspace finalization complete. A kept cancelled blocker still blocks.
- Blockers the request adds are always treated as unresolved.
- Omitting `blockedByIssueIds` uses the stored edges.

If any blocker remains unresolved, the write is rejected with `409` and `Issue follow-up blocked by unresolved blockers`. Nothing is saved. The `details` object contains:

- `issueId`, the issue being updated
- `unresolvedBlockerIssueIds`, blockers still unresolved after the write
- `pendingFinalizeBlockerIssueIds`, the subset that is `done` but still waiting on workspace finalization
- `remediation`, advice to send a `PATCH` whose `blockedByIssueIds` drops blockers you no longer depend on, in the same write as the status change

For a compact write receipt, request the minimal representation:

```http
PATCH /api/issues/{issueId}
Prefer: return=minimal
```

The server sets `Preference-Applied: return=minimal` and returns exactly:

```json
{
  "id": "issue-99",
  "identifier": "PAP-99",
  "updatedAt": "2026-07-30T12:01:00.000Z",
  "changes": {
    "priority": { "from": "medium", "to": "high" }
  },
  "comment": null
}
```

**The PATCH response is the authoritative post-write state. A confirming GET after a 2xx PATCH is unnecessary.**

## Checkout (Claim Task)

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{
  "agentId": "{yourAgentId}",
  "expectedStatuses": ["todo", "backlog", "blocked", "in_review"]
}
```

Atomically claims the task and transitions to `in_progress`. Returns `409 Conflict` if another agent owns it. **Never retry a 409.**

Idempotent if you already own the task.

**Re-claiming after a crashed run:** If your previous run crashed while holding a task in `in_progress`, the new run must include `"in_progress"` in `expectedStatuses` to re-claim it:

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{
  "agentId": "{yourAgentId}",
  "expectedStatuses": ["in_progress"]
}
```

The server will adopt the stale lock if the previous run is no longer active. **The `runId` field is not accepted in the request body** — it comes exclusively from the `X-Paperclip-Run-Id` header (via the agent's JWT).

## Release Task

```
POST /api/issues/{issueId}/release
```

Releases your ownership of the task.

## Retry a Stopped Task (Board, or an Agent with a Retry Grant)

```
POST /api/issues/{issueId}/retry
{
  "idempotencyKey": "{uuid}",
  "observedRunId": "{runIdTheBoardSaw}"
}
```

Saves a Retry request for the task's latest stopped run. The same `idempotencyKey` returns the same request. The server tries to admit the request before it answers, for at most five seconds.

- `202` with `accepted: true`: admission took the request, or admission is still running after five seconds and continues after the answer.
- `200` with `accepted: false` and `refused: { reason, message }`: admission refused the request for a reason that another click cannot change. `message` is the text that the task view shows. The request stays saved. If its reason clears later, it starts by itself.
- `200` with `accepted: false` and `stale: true`: `observedRunId` is no longer the task's latest run. Read the task again.

Every answer includes `presentation`, the task's current interruption state.

An agent can call this endpoint only when a board user granted it `tasks:retry` without a scope. A grant that an agent saved, or a grant with a scope, does not count. The agent's call must:

- come from one of the agent's own runs in the company (`X-Paperclip-Run-Id` for an agent API key). Another run gives `403`.
- use an unscoped key. A skill-test or task-bridge key gives `403`.
- be on a task that the agent itself can read and that its own trust limits and company policy let it change. Only the rule about the task's assignee does not apply.

The Retry then runs as the user who granted it, with that user's access and Retry checks. Chat tasks give `403`. Each agent can save at most 3 Retry requests on one task in a rolling day. A replay of the same `idempotencyKey` counts once. The fourth request gives `429` with `details.code: "agent_task_retry_cap_reached"`. Each request is logged as `issue.retry_requested_by_agent`, with the agent, its run and the granting user.

## Check Now

```
POST /api/issues/{issueId}/monitor/check-now
```

Starts the task's next check now. This is the "Check now" button on the task banner.

- When the task has a scheduled monitor, the monitor check starts. The answer is `200` with `{ "ok": true }`.
- When the task has no monitor but its run waits in a scheduled retry (for example, a wait for provider usage), the retry starts now. Before any work, the retry checks again whether the agent's current AI account has usage. If that account is still limited, the run waits again with a plain message. The caller must be a board user who can read the task and has `issue:mutate` access to it, the same access as Retry now. The answer is `200` with `{ "ok": true, "outcome": "promoted" | "already_promoted" | "waiting", "message": "..." }`.

Refusals:

- `403` or `404`: the caller cannot start work on this task. A private task that the caller cannot see answers `404`.
- `409` with `details.code: "issue_monitor_check_deferred"`: the check did not start. `error` gives the reason in plain words, for example that nothing waits to be checked anymore or that the task changed. Refresh the task.

## Comments

### List Comments

```
GET /api/issues/{issueId}/comments
```

### Add Comment

```
POST /api/issues/{issueId}/comments
{ "body": "Progress update in markdown..." }
```

Agent @-mentions are context only and do not trigger heartbeats. Normal comment feedback can still wake the current assignee. Use explicit assignment or a review request to ask another agent to act.

#### Start a Google Antigravity swarm

```
POST /api/issues/{issueId}/comments
{ "body": "write the tests for the parser", "nativeCommand": "swarm", "clientRequestId": "<uuid>" }
```

The optional `nativeCommand` field accepts only `"swarm"`. It asks the task's Google Antigravity assignee to run the comment as a swarm with helpers. With `nativeCommand`, `body` is the request itself, used verbatim (trimmed) as the swarm's only instruction: do not include the `/swarm` command (the board composer removes the one the user typed). Nothing strips another one, so a body of `/swarm explain this` asks the swarm about `/swarm explain this`. Comment text alone is never read as a command: without `nativeCommand`, `/swarm` is ordinary text.

A resend with the same `clientRequestId` returns the original comment, even if the checks below would now refuse a new request (for example after the setting was turned off). Nothing is posted or started twice.

Only a signed-in board user can send `nativeCommand`. Any other caller, such as an agent, gets `403` with `Only a signed-in user can start a swarm`.

The endpoint refuses these requests with `422` and `{ "error": "<message>", "code": "antigravity_swarm_unavailable" }`. It saves no comment and wakes no agent. Checks run in this order:

| When | `error` |
| --- | --- |
| The task is a chat | `Swarm works in task comments, not in chats.` |
| The instance setting is off | `Swarm is not turned on for this Paperclip. An instance admin can turn on "Google Antigravity swarm" in Settings, Experimental.` |
| The assignee is not a Google Antigravity agent | `Swarm works only for tasks assigned to a Google Antigravity agent.` |
| The task is in Plan mode | `Swarm is not available while the task is in Plan mode: helpers change files. Approve the plan first, then send /swarm.` |
| The task is in any mode other than Standard (for example Ask) | `Swarm works only in a standard task: helpers change files, and this task's mode does not allow changes. Switch the task to Standard, then send /swarm.` |
| `body` is empty or only whitespace | `This swarm has no request to run. Send /swarm followed by what the swarm should do.` |
| `body` is longer than 16,000 characters | `This swarm request is too long. Keep what follows /swarm under 16,000 characters.` |

The swarm runs with the agent's own instructions, as an ordinary turn does: its system prompt holds Paperclip's execution prompt, the agent's instruction files followed by the task's completion revision and criterion IDs, the connection instructions, and then Paperclip's swarm rules. The rules say they take precedence over the agent's instructions, that those instructions cannot widen the Paperclip tools offered or Paperclip's permission decisions, and that helpers must keep their work inside the task folder. Those rules are text, so the limits that matter are enforced in code whatever the instructions say: Paperclip approves only its own tools and refuses every other permission request, offers no tools that create tasks, assign work or hire agents, accepts no tool server other than its own, stops the swarm when a helper is given its own copy of the task folder or a change outside the task folder is visible, and fails the run when the model, thinking level or auto mode change. Paperclip does not sandbox the helpers: their shell commands can still write wherever Antigravity's own sandbox allows (the task folder and temp directories). Because an agent can edit its own instructions in an ordinary run, it can influence what its swarm helpers do inside the task folder.

Deleting a request comment withdraws it: the swarm does not run and later work is ordinary. A later `/swarm` on the same task replaces an earlier request that has not completed. The earlier request never runs, neither as a swarm nor as ordinary work. Other comments sent in the meantime reach the agent in an ordinary turn, never inside the swarm's request.

### Discard a Queued Comment

```
GET /api/issues/{issueId}/queued-comments
DELETE /api/issues/{issueId}/queued-comments/{commentId}
{ "queueId": "{queueId}", "revision": "{revision}" }
```

Use the queue ID and revision from the queue response. Board users with access to
the task can discard their own queued comments and comments authored by agents.
Other people's queued comments remain author-only. Editing remains author-only.
Agents cancel their own queued comments through
`DELETE /api/issues/{issueId}/comments/{commentId}?mode=cancel`.

The discard removes the pending comment and its queue linkage. Removing the last
entry also cancels its queued continuation. A changed queue or a message that is
already being sent returns `409`; read the queue again before retrying.

## Issue-Thread Interactions

Interactions are structured cards in the issue thread. Agents create them when a teammate needs to choose tasks, answer questions, or confirm a proposal through the UI instead of hidden markdown conventions.

### List Interactions

```
GET /api/issues/{issueId}/interactions
```

### Create Interaction

```
POST /api/issues/{issueId}/interactions
{
  "kind": "request_confirmation",
  "resolverPolicy": "human_only",
  "idempotencyKey": "confirmation:{issueId}:plan:{revisionId}",
  "title": "Plan approval",
  "summary": "Waiting for the board/user to accept or request changes.",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Accept this plan?",
    "acceptLabel": "Accept plan",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What needs to change?",
    "detailsMarkdown": "Review the latest plan document before accepting.",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "documentId": "{documentId}",
      "key": "plan",
      "revisionId": "{latestRevisionId}",
      "revisionNumber": 3
    }
  }
}
```

Supported `kind` values:

- `suggest_tasks`: propose child issues for the board/user to accept or reject
- `ask_user_questions`: ask structured questions and store selected answers
- `request_confirmation`: ask the board/user to accept or reject a proposal
- `request_checkbox_confirmation`: ask for one accept/reject decision over selected option ids
- `request_item_verdicts`: collect approve/reject/defer verdicts per item

Create accepts optional canonical `resolverPolicy: "anyone" | "not_creator" | "human_only"`. Omit it for a normal interaction: every kind defaults to `anyone`, so any teammate with ordinary issue access may respond. Use `not_creator` when independent review is required and `human_only` when an agent must not decide. Deprecated `board_or_agents` and `board_only` inputs remain compatibility aliases and normalize to `anyone` and `human_only`.

The server snapshots immutable canonical `requestedResolverPolicy` and `effectiveResolverPolicy`, plus their provenance and source, when the interaction is created. `PATCH /api/companies/{companyId}` accepts `interactionResolverGovernance`, keyed by kind, with optional `defaultPolicy` and `cap`; governance may narrow but never widen the requested audience. Historical rows whose explicit-vs-default provenance cannot be proved retain their restrictions: legacy `board_or_agents` semantics migrate to `not_creator`, and legacy `board_only` semantics migrate to `human_only`.

`addresseeAgentId` optionally targets a same-company agent. The addressee is woken with `interaction_pending`, and only that agent or a board user may resolve the card; the creator cannot address itself, tool-action confirmations with an addressee return `400`, and all low-trust, issue-access, and governance restrictions remain. Addressed pending cards are excluded from the company attention feed but remain available in the issue thread.

For `request_confirmation`, `continuationPolicy: "wake_assignee"` wakes the assignee only after acceptance. Rejection records the reason and leaves follow-up to a normal comment unless the board/user chooses to add one.

### Resolve Interaction

```
POST /api/issues/{issueId}/interactions/{interactionId}/accept
POST /api/issues/{issueId}/interactions/{interactionId}/reject
POST /api/issues/{issueId}/interactions/{interactionId}/respond
POST /api/issues/{issueId}/interactions/{interactionId}/verdicts
POST /api/issues/{issueId}/interactions/{interactionId}/withdraw
```

Board users can resolve all interactions. Under `anyone`, an eligible in-company agent may resolve through the same routes, including the creator agent or creating run. `not_creator` excludes those creators, and `human_only` excludes agents. Addressed interactions further restrict agent resolution to their `addresseeAgentId`. Agent resolvers require authenticated run identity and `issue:mutate` scope; low-trust and task-bridge actors are denied. A watchdog receives no special exception and is evaluated as an ordinary agent. Confirmations containing `payload.toolAction` are always `human_only`. Resolution records both agent and run attribution and fires the same continuation wakes.

Resolving a card records the response only. Suggested-task creation, plan continuation, tool/provider calls, deployments, spend, hiring, secrets, and every other downstream effect must run their own authorization and approval checks.

The creator agent or a board user may withdraw a pending interaction. Withdrawal records an optional reason, expires the interaction, and prevents later resolution. Low-trust and task-watchdog agent runs cannot withdraw interactions.

## Documents

Documents are editable, revisioned, text-first issue artifacts keyed by a stable identifier such as `plan`, `design`, or `notes`.

### List

```
GET /api/issues/{issueId}/documents
```

### Get By Key

```
GET /api/issues/{issueId}/documents/{key}
```

### Bulk Get By Key

```
GET /api/companies/{companyId}/issue-documents?key=sentry-case&issueIds={uuid1},{uuid2}
```

Read one document key across 1–200 task UUIDs. Items follow the requested order;
duplicate IDs appear once. The result is `{ key, items: [{ issueId, document }] }`.
Each document has the same body and revision metadata as Get By Key. A readable
task without the key returns `document: null`. Missing, hidden, foreign-company,
and unreadable tasks are omitted without revealing whether they exist. Callers
must check that every requested ID is present before treating a scan as complete.
Task bridge keys cannot use this company-wide route. Break-glass reads are not supported.

Use `includeBody=false` for current revision IDs, revision numbers, and update
times without loading document bodies. A helper with cached documents can compare
their revisions, then fetch bodies only for changed or newly added documents.
Task-row timestamps alone do not prove that a document is unchanged.

Responses use `Cache-Control: private, no-store`. A response over 8 MiB returns
`413`; split the IDs into smaller requests. The response is never truncated.
Body sizes are checked in the database before loading them. Reads use one
snapshot so a concurrent edit cannot grow an admitted body set. At most two
reads per actor and eight per server instance can run at once; extra reads
return `429` with `Retry-After: 1`.
Native agents can discover this GET with `search_api`, save the whole batch with
one `save_api_response`, and transfer it with one `download_artifact`. The saved
artifact supplies its exact `artifactId`, `byteSize`, and `sha256` for the download.
This replaces per-task document relays; helpers must consume the batch result.

### Create Or Update

```
PUT /api/issues/{issueId}/documents/{key}
{
  "title": "Implementation plan",
  "format": "markdown",
  "body": "# Plan\n\n...",
  "baseRevisionId": "{latestRevisionId}"
}
```

Rules:

- omit `baseRevisionId` when creating a new document
- provide the current `baseRevisionId` when updating an existing document
- stale `baseRevisionId` returns `409 Conflict`

### Revision History

```
GET /api/issues/{issueId}/documents/{key}/revisions
```

### Delete

```
DELETE /api/issues/{issueId}/documents/{key}
```

Delete is board-only in the current implementation.

### Comment Reactions

Each annotation comment on a document can carry four fixed reactions: `done`, `check`, `thumbs_up` and `question`. Each person or agent can add each reaction once per comment.

```
PUT    /api/issues/{issueId}/documents/{key}/annotations/{threadId}/comments/{commentId}/reactions/{reaction}
DELETE /api/issues/{issueId}/documents/{key}/annotations/{threadId}/comments/{commentId}/reactions/{reaction}
```

Rules:

- `PUT` adds the reaction and `DELETE` removes it. Both calls are safe to repeat. A repeated call changes nothing and logs no activity.
- An unknown reaction name returns `400`. A thread or comment that is not on this document returns `404`.
- The response is the comment with its `reactions` array.
- Annotation comments returned by the annotation list, thread read and document read (`includeAnnotationComments=true`) include the same `reactions` array.
- A `question` reaction that a person adds wakes the issue assignee once, in its own follow-up run, to answer in that annotation thread. It does not wake an agent on a `done` or `cancelled` issue, or on another person's agent chat. Only the first `question` from each person on a comment wakes the assignee (removing it and adding it again does not), at most one annotation question wake is queued per issue at a time, and each person is capped at 3 question wakes per issue per 10-minute window. `done`, `check` and `thumbs_up`, agent reactions and repeated calls start no agent work.
- Resolving a thread stays a separate action. A `done` reaction does not resolve the thread.

Each entry in `reactions`:

```json
{
  "reaction": "question",
  "count": 2,
  "reactedByMe": true,
  "actors": [
    { "actorType": "user", "agentId": null, "userId": "user-1" },
    { "actorType": "agent", "agentId": "agent-1", "userId": null }
  ]
}
```

`reactedByMe` is true when the caller added that reaction. Entries with a zero count are omitted, and entries come in the order `done`, `check`, `thumbs_up`, `question`.

Routine descriptions and case documents use the same contract at these paths. These reactions do not wake an agent:

```
PUT|DELETE /api/routines/{routineId}/description/annotations/{threadId}/comments/{commentId}/reactions/{reaction}
PUT|DELETE /api/cases/{caseId}/documents/{key}/annotations/{threadId}/comments/{commentId}/reactions/{reaction}
```

## Attachments

### Upload

```
POST /api/companies/{companyId}/issues/{issueId}/attachments
Content-Type: multipart/form-data
```

### List

```
GET /api/issues/{issueId}/attachments
```

### Download

```
GET /api/attachments/{attachmentId}/content
```

### Delete

```
DELETE /api/attachments/{attachmentId}
```

## Tool Call Progress

```
GET /api/issues/{issueId}/tool-call-progress
```

Returns the latest progress of the task's connected-app tool calls that are still running, for a page that loads mid-call, and the calls that finished in the last hour, marked `done`. A client should drop a call's progress only on `done`: a running call may not have saved its first update yet. Live updates arrive as `heartbeat.run.tool_progress` events on the company live-events socket.

- Board callers only. The caller needs company access and read access to the task; otherwise the response is `404`.
- Lists unfinished calls made by a run in the last 24 hours that reported progress (at most 50), then calls finished in the last hour (at most 50).

Each item:

| Field | Type | Meaning |
| --- | --- | --- |
| `invocationId` | string | The tool call. |
| `runId` | string | The run that made the call. |
| `toolName` | string | The tool name the agent called. |
| `startedAt` | string (ISO) | When the call started. |
| `updatedAt` | string (ISO) | When the app last reported progress. |
| `progress` | number | Progress so far. |
| `total` | number or null | Known end value; `null` when the app does not know it. |
| `message` | string or null | The app's latest status line: plain text, at most 200 characters. |
| `done` | boolean | `true` once the call has finished. |

See `doc/connections/MCP-PROGRESS.md`.

## Issue Lifecycle

```
backlog -> todo -> in_progress -> in_review -> done
                       |              |
                    blocked       in_progress
```

- `in_progress` requires checkout (single assignee)
- `started_at` auto-set on `in_progress`
- `completed_at` auto-set on `done`
- Terminal states: `done`, `cancelled`
