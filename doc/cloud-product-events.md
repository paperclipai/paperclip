# Cloud Product Events

Cloud product events are rows in the `cloud_product_events` table
(`packages/db/src/schema/cloud_product_events.ts`). Only a Paperclip Cloud
instance writes them. A self-hosted instance writes none. They are not
Paperclip Telemetry events, they are not OpenTelemetry exports, and they are
not run-log events.

## When an instance writes an event

- The instance writes events only when `isCloudManagedInstance()` is true.
- The activity log write path records most events. `persistActivity` calls
  `recordCloudProductEvent` after it stores the activity row.
- Four events have no usable activity row. The module that owns the action
  records them directly, after the action commits. Refer to
  [Direct events](#direct-events).
- A failure to store an event does not fail the activity write or the product
  action. The server logs a warning and continues.
- Activity from the Cloud control actor `paperclip-cloud` writes no event.
- A built-in agent writes no `run.finished` event and no `agent.first_run`
  event.

## Event list

`CLOUD_PRODUCT_EVENT_NAMES` in `server/src/services/cloud-product-events.ts` is
the closed list. `draftCloudProductEvent` in the same file is the only mapping
from an activity action to an event. `DIRECT_CLOUD_PRODUCT_EVENT_NAMES` is the
part of the closed list that the direct record functions write.

### Events from the activity log

| Event | Source activity | Properties |
| --- | --- | --- |
| `ai_provider.connected` | `ai_connection.connected` | `provider`, `method` |
| `agent.created` | `agent.created`, `agent.hire_created` | `role`, `source` |
| `plan.created` | `issue.document_created` with key `plan` | none |
| `artifact.created` | `issue.document_created` with another key, `issue.work_product_created`, `issue.attachment_added` | `kind`, `type` |
| `task.created` | `issue.created` | `origin`, `isSubtask`, `isOnboarding` |
| `task.completed` | `issue.updated` when the status changes to `done` | `origin`, `isSubtask`, `isOnboarding` |
| `connector.connected` | `tool_connection.created` | `transport`, `status` |
| `routine.created` | `routine.created` | none |
| `routine.run_triggered` | `routine.run_triggered` | `source`, `status`, `routineId` |
| `interaction.resolved` | `issue.thread_interaction_accepted`, `issue.thread_interaction_rejected`, `issue.thread_interaction_answered` | `kind`, `result` |
| `project.created` | `project.created` | none |
| `goal.created` | `goal.created` | none |
| `skill.added` | `company.skill_created`, `company.skill_catalog_installed` | `source` |

`isOnboarding` is true for the first task of the onboarding wizard and for the
first task that Paperclip Cloud seeds. The seeded task has the origin `manual`,
so `origin` alone does not identify it.

### Direct events

| Event | Source | Entity | Properties |
| --- | --- | --- | --- |
| `run.finished` | An agent run changes to a final status. `emitAgentTaskRun` calls `recordRunFinishedCloudProductEvent`. | `heartbeat_run` | `outcome`, `errorCode`, `failureClass`, `adapterType`, `model`, `durationSeconds`, `inputTokens`, `outputTokens`, `cachedTokens` |
| `agent.first_run` | The first run of an agent ends. `finalizeAgentStatus` calls `recordAgentFirstRunCloudProductEvent`. | `agent` | `role`, `adapterType` |
| `connector.used` | A call to a tool connection ends. `emitConnectionInvoked` calls `recordConnectorUsedCloudProductEvent`. | `tool_connection` | `connectorKey`, `status` |
| `plan.approved` | A person accepts a confirmation request for the plan document of the task. `acceptRequestConfirmation` calls `recordDirectCloudProductEvent`. | `issue` | none |

Rules for `run.finished`:

- `outcome` is the final run status: `succeeded`, `failed`, `cancelled`,
  `timed_out`, or `interrupted`.
- A run that changes from one final status to a different final status writes a
  second event. Use the entity ID to count each run one time.
- `failureClass` is absent when `outcome` is `succeeded`. For each other
  outcome, `cloudRunFailureClass` derives it from the run error code. The value
  is one of this closed set:
  - `stopped`: a person stopped or paused the work.
  - `missing_access`: a person must supply a credential, a secret, or access.
  - `provider_limit`: a provider usage limit stopped the run.
  - `waiting_on_person`: a person must change a configuration choice, change a
    budget, or give an approval.
  - `execution_failure`: the adapter, the provider, or the server failed the
    run. This includes a lost process and a server restart.
  - `other`: each other error code, and a run with no error code.
- `PERSON_OWNED_FAILURE_CODES` in `server/src/services/continuation-cause.ts`
  is the product list of customer-side codes. A test fails when a code in that
  list has no customer-side class.
- `model` is the model that the run reported, or the model in the agent
  configuration. It is stored only when it is a short fixed value.
- The token counts are present only when the run reported usage.

Rules for `connector.used`:

- The instance writes at most one event for each tool connection, each company,
  and each UTC day. The event describes the first call of that day that ended.
- `connectorKey` is the catalog key of the connection. A connection that is not
  from the catalog has the value `custom`.
- A process keeps the pairs of the current day in memory, so most calls do no
  database work for this event. The first call of a pair in a process does one
  check in the database. Thus a restart writes no second event for the same
  day. A transaction-level advisory lock makes the check and the insert safe
  when two processes record the same pair at the same time.
- On a Cloud-managed instance, `emitConnectionInvoked` reads the call and its
  connection one time for each call that ends. Paperclip Telemetry uses the same
  read.
- A connection test that a user starts in the setup flow counts as a call.
- The event does not tell a built-in agent from another agent. The call record
  does not hold that data.

Rules for `plan.approved`:

- The event is written only when the confirmation request is of the kind
  `request_confirmation`, its target is the document with the key `plan`, and
  the target is on the same task.
- The actor is the person who accepted. An acceptance by an agent or by the
  system writes no event, unless the agent relays the decision of a verified
  person.

## Data rules

- An event holds no free text. Titles, names, document text, comments, file
  names, and prompts never enter the table.
- A text property is stored only when it is a short fixed value that matches
  `^[a-z0-9][a-z0-9._:-]{0,63}$`. Any other value is dropped.
- A direct event stores a property only when it is such a fixed value, a finite
  number, or a boolean. `recordDirectCloudProductEvent` applies this rule to
  each caller.
- An error message, a model name that is not a fixed value, a connection name,
  and a plan text never enter the table.
- Each event holds the company ID, the actor type and ID, the responsible user
  ID, and the entity type and ID.
- The responsible user of `run.finished` is the responsible user of the run.
  For `agent.first_run` it is the responsible user of the first run of the
  agent. For `connector.used` it is the user who made the call, or the
  responsible user of the run or the task of the call. For `plan.approved` it is
  the person who accepted.
- The instance keeps events for 30 days. A write removes older rows at most
  once each hour. No background worker runs.

## How Paperclip Cloud reads events

`GET /api/instance/product-events?after=<cursor>&limit=<count>` returns events
in commit-safe order. The response holds `events`, `nextAfter`, and `hasMore`.

- The request must carry a Cloud control assertion for the action
  `product-events:read`. A board user, an agent, or an API key cannot read this
  endpoint. For this reason the endpoint is not in the OpenAPI document.
- The response holds only the events of the Cloud primary company of the stack.
- `limit` accepts 1 to 500. The default is 200.
- `after` is the `nextAfter` value of the last response. Omit it for the first
  read.

Each row stores the ID of the database transaction that wrote it. The cursor
orders rows by that transaction ID and then by row ID. A read returns a row
only after each transaction that started before it has ended. This prevents a
skipped event when two writes commit out of order. A long open transaction on
the database delays later events until it ends.

## Adding or changing an event

1. Add the name to `CLOUD_PRODUCT_EVENT_NAMES`.
2. If an activity row describes the action, add the mapping to
   `draftCloudProductEvent`. Copy fixed values only.
3. If no activity row describes the action, add the name to
   `DIRECT_CLOUD_PRODUCT_EVENT_NAMES` and call `recordDirectCloudProductEvent`
   from the module that owns the action, after the action commits. Do not wait
   for the result in the product action.
4. Add a test in `server/src/__tests__/cloud-product-events.test.ts`.
5. Update the event list in this document.
6. Request a privacy review.
