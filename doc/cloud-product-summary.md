# Cloud product summary

A Cloud-managed instance can report a summary of the capabilities that its
organization has used. Paperclip Cloud asks for the summary through a signed
Cloud control request. The instance computes the summary from tables that it
already has. It writes nothing.

A self-hosted instance does not serve this endpoint. The summary is not
Telemetry, not Observability, and not the run log. See `rules/data-paths.mdc`.

## Why a summary and not an event stream

- The instance writes no new row. No product action gets a new write.
- There is no new table and no migration.
- The summary is computed from the current rows on each request. A restored
  database, a missed request, or a restart loses nothing.

## The endpoint

`GET /api/instance/product-summary?since=<time>`

- The request must carry a Cloud control assertion for the action
  `product-summary:read`. A request without an assertion gets `401`. Each
  other credential gets `403`.
- An instance that is not Cloud-managed has no key to verify an assertion.
  Thus it rejects each request before the handler runs. The handler returns
  `404` with the error `not_cloud_managed` as a second check.
- `since` is optional. It is a time with an offset, for example
  `2026-11-20T17:00:00Z`. A value that is not such a time gets `400` with the
  error `invalid_query`.
- The response covers the primary company of the stack only.
- The response has the header `Cache-Control: no-store`.
- The endpoint is not in the OpenAPI document, as the other signed-only Cloud
  control endpoints are not.

## The `since` rule

`since` is the time from which Paperclip Cloud may know about activity.

- A date before `since` is not returned. The capability has `firstAt: null`
  and `beforeSince: true`.
- Each count of past events and the list of recent runs cover the time from
  `since` only, when `since` is later than the start of the window.

Thus no date of a past event and no count of past events from before `since`
leaves the instance.

Three values describe the state at the time of the request, not the past: the
number of tasks that are blocked now, and the two setup lists. The `since` rule
does not change them.

## The response

```json
{
  "version": 1,
  "generatedAt": "2026-11-21T09:00:00.000Z",
  "since": "2026-11-20T17:00:00.000Z",
  "capabilities": {
    "modelConnected": { "state": "yes", "firstAt": null, "beforeSince": true },
    "agentCreated": { "state": "yes", "firstAt": "2026-11-20T18:02:11.000Z", "beforeSince": false },
    "secondAgentCreated": { "state": "no", "firstAt": null, "beforeSince": false },
    "planCreated": { "state": "unknown", "firstAt": null, "beforeSince": false }
  },
  "runs": {
    "state": "ok",
    "day": { "succeeded": 4, "failed": 2, "cancelled": 0, "timedOut": 0, "failuresByClass": { "missing_access": 2 } },
    "week": { "succeeded": 31, "failed": 3, "cancelled": 1, "timedOut": 0, "failuresByClass": { "missing_access": 2, "provider_limit": 1 } },
    "recent": [
      { "outcome": "failed", "failureClass": "missing_access", "endedAt": "2026-11-21T08:41:00.000Z" }
    ]
  },
  "waiting": { "state": "ok", "blockedTasks": 1, "oldestBlockedAt": "2026-11-20T19:30:00.000Z" },
  "activity": {
    "state": "ok",
    "lastPersonActivityAt": "2026-11-21T08:40:00.000Z",
    "tasksCompletedWeek": 12,
    "tasksCompletedMonth": 12,
    "routineRunsWeek": 3,
    "routineRunsMonth": 3
  },
  "setup": { "state": "ok", "modelProviders": ["anthropic"], "connectors": ["github", "custom"] }
}
```

### Capabilities

Each capability has a `state` of `yes`, `no`, or `unknown`.

| Key | The capability is `yes` when |
| - | - |
| `modelConnected` | An AI provider connection exists that is not a draft |
| `connectorSetUp` | A tool connection exists that is not a draft |
| `agentCreated` | An agent exists that the customer created |
| `secondAgentCreated` | Two such agents exist |
| `planCreated` | A task has a document with the key `plan` |
| `planApproved` | A confirmation of a `plan` document was accepted |
| `onboardingTaskCompleted` | The onboarding task is `done` |
| `ownTaskCompleted` | A top-level task with the origin `manual` is `done` |
| `routineTaskCompleted` | A task of a customer routine is `done` |
| `artifactCreated` | A work product, an attachment, or a document other than a plan exists |
| `routineCreated` | A routine exists that the customer created |
| `routineRun` | A customer routine has a run that created or completed a task |

- A built-in agent, the agent of the onboarding seed, and a hire that waits for
  approval are not customer agents.
- A built-in routine is not a customer routine.
- The onboarding task is the task with the origin `onboarding_first_task` or
  the task of the onboarding seed.
- `firstAt` is the earliest date among the rows that exist now. A deleted row
  takes its date with it. Paperclip Cloud keeps the earliest date that it saw.

#### Task windows

The capabilities for plans, tasks, and artifacts read the 2,000 oldest tasks
of the organization. If a capability is not found there and the organization
has more tasks, the instance reads the 2,000 newest tasks also.

- An organization with 4,000 tasks or fewer gets an exact `yes` or `no`.
- For a larger organization, `yes` is exact. `firstAt` is the earliest date in
  the tasks that were read. A capability that is in neither window has the
  state `unknown`.
- `onboardingTaskCompleted` does not use the windows. It is exact.

`routineRun` reads the 100 oldest and the 100 newest runs of each of the 100
oldest customer routines. If no run is found and the organization has more
routines, or a routine has more than 200 runs, the state is `unknown`.

Paperclip Cloud reads the summary many times each day. A new capability is in
the newest window when the next request comes.

### Runs

- A run is counted by its finish time. The time at which it was created does
  not matter. A run with no finish time is not counted.
- `day` covers the last 24 hours. `week` covers the last 7 days.
- `recent` holds at most 20 runs that have a finish time, in the order of
  that time, the newest first.
- A run of a built-in agent is not counted. A run that has not ended is not
  counted.
- An interrupted run is counted as `cancelled`.
- `failureClass` is one of `stopped`, `missing_access`, `provider_limit`,
  `waiting_on_person`, `execution_failure`, or `other`. It is `null` for a run
  that succeeded.

### Waiting, activity, and setup

- `blockedTasks` is the number of tasks with the status `blocked`.
- `oldestBlockedAt` is `null` when more than 10,000 tasks are blocked, because
  the instance does not read each of them.
- `lastPersonActivityAt` is the time of the last activity record whose actor
  is a person. The instance reads the 20,000 newest activity records of the
  last 90 days. `null` means that no such record is in them.
- `tasksCompletedWeek` and `tasksCompletedMonth` count tasks that are `done`
  and were completed in the last 7 days and the last 28 days.
- `routineRunsWeek` and `routineRunsMonth` count runs of customer routines
  that created or completed a task in the same windows.
- The setup lists cover connections that are active now.
- `modelProviders` holds provider keys from the closed provider list.
- `connectors` holds catalog keys. A connection that is not from the catalog
  is `custom`.

## Data rules

- The summary holds no free text. Titles, names, document text, comments, file
  names, prompts, and error messages never enter it.
- Each text value comes from a closed list in the code.
- Each count stops at 10,000. The value 10,000 means 10,000 or more.

## Cost rules

- Each section runs in its own read-only transaction. The summary cannot
  write.
- Each section has a time limit of 2 seconds. Before each statement, the
  instance sets the statement time limit to the time that the section has
  left. A section that does not finish in time has the state `unknown`.
  `unknown` is not `no` and is not zero.
- The request has a time budget of 6 seconds. A section that would start after
  the budget is used has the state `unknown`. A section that starts late gets
  only the time that is left.
- A section that cannot get a database connection before its time limit has
  the state `unknown`. The request does not wait for that connection.
- The sections that read small tables run first. A slow section cannot take
  the budget from them.
- Two requests for the same summary at the same time share one computation.
- A query error in one section does not fail the other sections.
- Each query on a table that grows with use reads a bounded number of rows or
  a bounded window of time:
  - plans, tasks, and artifacts: the task windows above;
  - routine runs: the run windows above, and the last 28 days for the counts;
  - agent runs: the last 8 days;
  - activity: the 20,000 newest records;
  - completed tasks: the tasks that changed in the last 28 days.
- No query counts or sorts a whole table.
- The instance does no work for this path until Paperclip Cloud sends a
  request. To stop the work, stop the requests.

## Changing the summary

1. Change the builder in `server/src/services/cloud-product-summary.ts`.
2. Add a test in `server/src/__tests__/cloud-product-summary.test.ts`.
3. Update this document.
4. Raise `version` when a key is removed or its meaning changes.
5. Request a privacy review.
