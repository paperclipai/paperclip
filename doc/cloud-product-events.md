# Cloud Product Events

Cloud product events are rows in the `cloud_product_events` table
(`packages/db/src/schema/cloud_product_events.ts`). Only a Paperclip Cloud
instance writes them. A self-hosted instance writes none. They are not
Paperclip Telemetry events, they are not OpenTelemetry exports, and they are
not run-log events.

## When an instance writes an event

- The instance writes events only when `isCloudManagedInstance()` is true.
- The activity log write path records the event. `persistActivity` calls
  `recordCloudProductEvent` after it stores the activity row.
- A failure to store an event does not fail the activity write. The server logs
  a warning and continues.
- Activity from the Cloud control actor `paperclip-cloud` writes no event.

## Event list

`CLOUD_PRODUCT_EVENT_NAMES` in `server/src/services/cloud-product-events.ts` is
the closed list. `draftCloudProductEvent` in the same file is the only mapping.

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

## Data rules

- An event holds no free text. Titles, names, document text, comments, file
  names, and prompts never enter the table.
- A text property is stored only when it is a short fixed value that matches
  `^[a-z0-9][a-z0-9._:-]{0,63}$`. Any other value is dropped.
- Each event holds the company ID, the actor type and ID, the responsible user
  ID, and the entity type and ID.
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
2. Add the mapping to `draftCloudProductEvent`. Copy fixed values only.
3. Add a test in `server/src/__tests__/cloud-product-events.test.ts`.
4. Update the event list in this document.
5. Request a privacy review.
