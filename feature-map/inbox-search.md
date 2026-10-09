# Inbox, decisions, and search

People find work that needs their attention, distinguish unread activity from required decisions, archive handled items, and search across the company.

Implementation: [inbox](../ui/src/pages/Inbox.tsx), [decisions](../ui/src/pages/WhatNeedsMe.tsx), [search](../ui/src/pages/Search.tsx).

## Sub-features

- `views`: use Mine, Recent, Unread, Blocked, and broader task views.
- `triage`: read or archive attention items without pretending the underlying task is complete.
- `decisions`: open the source of a decision and act in the right context.
- `search`: query company work and follow a result to its original record.

## How to get to it (user POV)

### `inbox`

Use Inbox links or the corresponding task views when the combined list is enabled.

### `decisions`

Open `/decisions`, then a queue at `/decisions/queues/:key` and its source item.

### `search`

Open `/search` or the navigation search entry.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Seed assigned, unread, blocked, and resolved tasks plus a pending decision. Record the combined Inbox/Tasks experimental setting.

### `inbox`

Automated: [archive routes](../server/src/__tests__/inbox-archive-routes.test.ts) cover server mutations. [Task-list helpers](../ui/src/pages/Issues.test.tsx) cover search URLs, pagination, and presentation constants; they do not render the combined Inbox/Tasks page. Reading, archiving, and navigating that page remain manual checks.

Manual: Read an unread task, return to Unread, archive a handled item, and reload. Verify personal triage state changes while task status stays correct. Switch users and companies to check isolation.

### `decisions`

Automated: [decision queues](../server/src/__tests__/decision-queues-routes.test.ts) covers route behavior. End-to-end queue-to-source navigation is manual.

Manual: Open a pending decision, follow its source, resolve it through the supported control, and reload the queue. Confirm it retires only after the decision persisted and unrelated pending items remain.

### `search`

Automated: [search page](../ui/src/pages/Search.test.tsx) and [company search service](../server/src/__tests__/company-search-service.test.ts) cover UI and server search separately.

Manual: Search a unique task title and content phrase, open the result, and compare the actual record. Test filters, no results, and a second company. Verify stale results do not expose inaccessible data.

## Gotchas

- Personal archival is not task cancellation or completion.
- Legacy Inbox routes can redirect to the combined task view; record which host actually rendered.
- Search service tests do not establish the relevance quality of every query.
