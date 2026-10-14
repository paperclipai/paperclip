---
navigation: {"section":"Tasks and conversations","sectionOrder":20,"order":30}
---

# Inbox, decisions, and search

People find work that needs their attention, distinguish unread activity from required decisions, archive handled items, and search across the company.

Implementation: [inbox](../../ui/src/pages/Inbox.tsx), [decisions](../../ui/src/pages/WhatNeedsMe.tsx), [search](../../ui/src/pages/Search.tsx).

Agent access: [companion](../agent-access-map/inbox-search.md).

## Sub-features

- `views`: use Mine, Recent, Unread, Blocked, and broader task views.
- `triage`: read or archive attention items without pretending the underlying task is complete.
- `decisions`: open the source of a decision and act in the right context.
- `search`: query company work and follow a result to its original record.
- `toasts`: receive live task notifications only for personal participation or explicit mentions.

## How to get to it (user POV)

### `inbox`

Use Inbox links or the corresponding task views when the combined list is enabled.

### `decisions`

Open `/decisions`, then a queue at `/decisions/queues/:key` and its source item.

### `search`

Open `/search` or the navigation search entry.

### `toasts`

Keep a company page open while another person or agent updates a task.
See [toast semantics](../../doc/TOASTS.md) for eligibility and suppression rules.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Seed assigned, unread, blocked, and resolved tasks plus a pending decision. Record the combined Inbox/Tasks experimental setting.

### `inbox`

Automated: [archive routes](../../server/src/__tests__/inbox-archive-routes.test.ts) cover server mutations. [Task-list helpers](../../ui/src/pages/Issues.test.tsx) cover search URLs, pagination, and presentation constants; they do not render the combined Inbox/Tasks page. Reading, archiving, and navigating that page remain manual checks.

Automated: [Issue service regressions](../../server/src/__tests__/issues-service.test.ts)
cover exclusion of historical automatic read cleanup from user participation,
unread counts, and activity timestamps while retaining explicit user decisions
and audit history.

Manual: Seed a scheduled routine execution owned by the current human. It stays out of Mine until an existing participation rule admits it. Verify comments, assignment, and manual routine runs admit automated tasks while reading alone does not. Inbox discovery and Blocked hide unrelated automation by default; the **show agent-created tasks** checkbox reveals it without subscribing the user. Reload and verify membership, unread badges, archive/resurfacing, and preference persistence.

Manual: Read an unread task, return to Unread, archive a handled item, and reload. Verify personal triage state changes while task status stays correct. Switch users and companies to check isolation.

Seed a completed task whose only activity under the viewing user is automatic
read cleanup. Refresh Mine and Unread: the task must not appear through that
participation, while the cleanup remains in activity history. Record an explicit
user recovery decision on a separate task and verify it still counts. This
browser journey remains manual.

### `decisions`

Automated: [decision queues](../../server/src/__tests__/decision-queues-routes.test.ts) covers route behavior. End-to-end queue-to-source navigation is manual.

Manual: Open a pending decision, follow its source, resolve it through the supported control, and reload the queue. Confirm it retires only after the decision persisted and unrelated pending items remain.

### `search`

Automated: [search page](../../ui/src/pages/Search.test.tsx) and [company search service](../../server/src/__tests__/company-search-service.test.ts) cover UI and server search separately.

Manual: Search a unique task title and content phrase, open the result, and compare the actual record. Test filters, no results, and a second company. Verify stale results do not expose inaccessible data.

### `toasts`

Automated: [persisted eligibility](../../server/src/__tests__/task-toast-eligibility.test.ts)
checks creation, assignment, comments, mentions, deliberate edits, excluded read
activity, company isolation, local-board, and persisted run-task attribution.
[Socket delivery](../../server/src/__tests__/live-events-toast.test.ts) checks
viewer-specific projection; [UI delivery](../../ui/src/context/LiveUpdatesProvider.hook.test.tsx)
checks eligibility gating, cache updates, stale callbacks, and existing suppression.
[UI cache handling](../../ui/src/context/LiveUpdatesProvider.test.ts) checks visible
comment refresh when authenticated events omit hydration metadata.
The `task toasts follow personal involvement in multiplayer` case in the
[authenticated browser suite](../../tests/e2e/multi-user-authenticated.spec.ts)
exercises quiet unrelated updates, read-only visits, first/historical mentions,
self-activity, and visible-task suppression against persisted data.

Manual: Use two authenticated browser sessions in the same isolated company.
Create separate tasks for each person and use one shared agent. From a company
task list, verify that the other person's unrelated task updates produce no
toast but still refresh the list. Comment on one of their tasks, then have them
update it: a toast should appear. Repeat using assignment, a deliberate edit,
and a first explicit user mention in a comment or description. Reload before a
later update to prove eligibility does not depend on browser history. Mere
viewing, agent ownership, responsible-user attribution, and parent participation
must remain quiet. Task-linked failures follow the same participation rule;
generic agent errors remain quiet. Repeat while viewing the relevant task and
after switching company/account to verify suppression and isolation.

## Gotchas

- Notifications do not grant task access or change Mine membership.
- A feature-map recipe and mocked UI tests do not prove live multiplayer behavior.

- Combined Inbox/Tasks requires both `enableCombinedInboxTasks` and
  `enableStreamlinedUi`. [Standalone Inbox tests](../../ui/src/pages/Inbox.test.tsx)
  render archive/read controls and toolbars; this is not live multi-user evidence.

- Personal archival is not task cancellation or completion.
- Legacy Inbox routes can redirect to the combined task view; record which host actually rendered.
- Search service tests do not establish the relevance quality of every query.

### Storybook verification

#### `views`

Scope: ui
Storybook: Mine/Recent/Unread/Blocked and broader task views; combined versus standalone host; loading/empty/error/filter states.
Production: Use persisted personal participation/read data; verify scoped counts and list navigation/reload; automatic read cleanup must not create Mine membership.
Sources: Source: [Inbox.tsx](../../ui/src/pages/Inbox.tsx), [Issues.tsx](../../ui/src/pages/Issues.tsx). Tests: [Inbox.test.tsx](../../ui/src/pages/Inbox.test.tsx), [Issues.test.tsx](../../ui/src/pages/Issues.test.tsx), [issues-service.test.ts](../../server/src/__tests__/issues-service.test.ts)

#### `toasts`

Scope: ui
Storybook: Eligible live task toast, explicit mention, quiet unrelated event, own-action/visible-task suppression, dedupe and company/account switch.
Production: Persisted participation and mentions determine per-viewer socket eligibility; quiet events still refresh caches; reload retains eligibility, unauthorized resources remain denied.
Sources: Source: [ToastViewport.tsx](../../ui/src/components/ToastViewport.tsx), [ToastContext.tsx](../../ui/src/context/ToastContext.tsx), [LiveUpdatesProvider.tsx](../../ui/src/context/LiveUpdatesProvider.tsx), [task-toast-eligibility.ts](../../server/src/realtime/task-toast-eligibility.ts). Tests: [ToastContext.test.tsx](../../ui/src/context/ToastContext.test.tsx), [ToastViewport.test.tsx](../../ui/src/components/ToastViewport.test.tsx), [LiveUpdatesProvider.hook.test.tsx](../../ui/src/context/LiveUpdatesProvider.hook.test.tsx), [task-toast-eligibility.test.ts](../../server/src/__tests__/task-toast-eligibility.test.ts), [live-events-toast.test.ts](../../server/src/__tests__/live-events-toast.test.ts), [multi-user-authenticated.spec.ts](../../tests/e2e/multi-user-authenticated.spec.ts)
