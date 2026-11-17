---
navigation: {"section":"Tasks and conversations","sectionOrder":20,"order":30}
---

# Inbox, decisions, and search

People find work that needs their attention, distinguish unread activity from required decisions, archive handled items, and search across the company.

Feature ID: `inbox-search`.

Implementation: [inbox](../../ui/src/pages/Inbox.tsx), [decisions](../../ui/src/pages/WhatNeedsMe.tsx), [search](../../ui/src/pages/Search.tsx).

Agent access: [companion](../agent-access-map/inbox-search.md).

## Sub-features

- `views`: `inbox-search/views` — use Mine, Recent, Unread, Blocked, and broader task views.
- `triage`: `inbox-search/triage` — read or archive attention items without pretending the underlying task is complete.
- `decisions`: `inbox-search/decisions` — open the source of a decision and act in the right context.
- `search`: `inbox-search/search` — query company work and follow a result to its original record.
- `toasts`: `inbox-search/toasts` — receive live task notifications only for personal participation or explicit mentions.

## How to get to it (user POV)

### `inbox`

In Coordinator, open Tasks → Mine, Unread, Blocked, Recent, or Everything. Old `/inbox/*` links redirect to the matching task view. Classic uses Inbox links or the task views when its combined list is enabled.

### `decisions`

Open `/decisions`, then a queue at `/decisions/queues/:key` and its source item.

In Coordinator, `/decisions` is **Inbox**. Pending cards use the existing attention feed and canonical
resolvers. **Tasks → Needs attention** projects the same feed as distinct tasks.
With **Settings → Experimental → Coordinator workspace** enabled, `/decisions`
is **Needs You**. Pending cards use the existing attention feed and canonical
resolvers. **Tasks → Needs attention** projects the **For you** feed as distinct tasks.

Both `/decisions` surfaces switch between **For you** (default), **Unassigned**,
**Company** and **Archived** (`?view=unassigned|company|archived`); each list is
cached per person and view. Board members (not viewers) also get **Everyone**
(`?view=all`): every person's open cards, with its own tab count that is never
in the badge. **Archived** lists only the open cards you archived
(with the archive date and any Stale chip), then a **Snoozed** group with the
time each card comes back; its Close… menu offers **Restore** (or **Restore
now** and **Change snooze time**) instead of Archive, and the cards stay
answerable. Its tab count is never in the badge, and the other views no longer
show Snoozed/Archived curtains. Your own cards say **Why me?**, a different person's card shows **For
@name**, and an ownerless request card offers **Claim**, which makes you its
addressee and removes it from everyone else's pool (`attention.claimed` activity).
For you shows "N cards need an owner" while the pool has cards; that count is
not in the badge.
Escalation owners catch cards that name no person: a project's **Decision owner**
(Project → Configuration) first, then the company's **Default decision owner**
(Company Settings → Decisions), else Unassigned. The company's **Budget owner**
gets each budget hard stop in For you ("You own budget escalation", with Raise
limit / Keep paused) while Company still shows it to every operator as "For
@owner"; a different person's Raise limit or Keep paused leaves the owner a
receipt. An owner who is no longer an active member is skipped.
Every card carries `closeModes` for one close API
(`POST /companies/:companyId/attention/:sourceKind/:sourceId/close`):
**Withdraw** closes an interaction, decision or approval for everyone through
its own withdraw/cancel, never as consent, and tells the agent; **Archive** and
**Snooze** hide the card for you only. **Transfer** (`…/transfer`) routes an
interaction to another person who can answer it. A late second answer gets 409
"Already answered" naming who answered first. Failed-run, recovery and
agent-error cards offer only actions they can complete (Retry, Open run, Open
recovery, Inspect).
Each card on both surfaces has one **Close…** menu with only its `closeModes`:
**Withdraw request…** (confirms, optional reason, cannot be undone), **Archive
for me**, **Snooze for me** (both with Undo) and, for interactions, **Transfer
to @x**. A card for a different person asks "This is for @x. Continue?" before
its answer controls, Withdraw or Transfer. Failed runs **Retry** inline; budget
stops **Raise budget** or **Keep paused** inline. Stale cards carry a **Stale ·
reason** chip and sit in a collapsed **Stale (N)** group at the bottom of each
view; **Withdraw all stale** lists every card first and withdraws only those
with a real withdraw. "Dismiss — no effects" and the questions-only Cancel are
gone; archived and snoozed cards live in the **Archived** view.
One obligation is one card: a pending approval leads, with the in-review task
that waits on it as a line under it, and a failed run leads (with **Retry**),
with the task it blocks under it; the run then shows where the blocked task
does. A budget hard stop leads its override approval ("Approval this answers"):
Raise limit or Keep paused answers both, and the approval is no longer an
ownerless card in Unassigned. The feed still returns every card, the evidence hides and returns with
its lead, and each view count and the badge count the obligation once. A task
with a configured human review stage keeps its review card next to the approval.
Search, filter by agent/project, sort, and group by task/agent/project apply to
both open decisions and the visible Recent Decisions receipts. Successful
resolutions resize into compact receipts while the same contained Gather Light
effect used for task creation runs concurrently. The receipt stays in its card
position until that treatment finishes, then settles under **Recent Decisions**.
Motion follows the saved history result; failed saves retain the actionable card,
reduced motion settles immediately, and revisiting history does not replay it. The initial
24-hour display window is an experimental assumption, not data deletion.
Resolving an artifact decision does not itself complete its task. If the task
remains in review without a maintained reviewer or continuation, its separate
canonical stalled-review item stays in Inbox and Tasks → Needs attention.
Coordinator presents the existing recovery actions with **Mark task done** as
the task-level verdict, distinct from the saved artifact receipt.

Open **Decision history** (on both `/decisions` surfaces) for the paginated
history panel; it merges answered questions and confirmations, Decisions-v1
outcomes and approvals. It opens on **Handled by me or for me** (what you
answered, withdrew or transferred, what someone handled for you, and the cards
that were for you); **Everyone** in the same panel lists every person's.
Coordinator's Recent Decisions opens on the same scope. Outcome filters include **Withdrawn**, **Expired** (not
cards closed with their task), **Closed with task** and **Handled for me**, within either scope; a
withdrawn entry names who withdrew it and the reason.

### `search`

Open `/search` or the navigation search entry.

### `toasts`

Keep a company page open while another person or agent updates a task.
See [toast semantics](../../doc/TOASTS.md) for eligibility and suppression rules.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Seed assigned, unread, blocked, and resolved tasks plus a pending decision. Record the combined Inbox/Tasks experimental setting.

### `inbox`

Automated: [archive routes](../../server/src/__tests__/inbox-archive-routes.test.ts) cover server mutations. [Task-list helpers](../../ui/src/pages/Issues.test.tsx) cover search URLs, pagination, and presentation constants; they do not render the combined Inbox/Tasks page. [Coordinator Tasks browser checks](../../tests/e2e/coordinator-inbox-views.spec.ts) exercise personal views, read state, archive, keyboard undo, mobile swipes, and saved columns.

Automated: [Issue service regressions](../../server/src/__tests__/issues-service.test.ts)
cover exclusion of historical automatic read cleanup from user participation,
unread counts, and activity timestamps while retaining explicit user decisions
and audit history.

Automated: [Source regressions](../../server/src/__tests__/issues-creation-visibility.test.ts) cover channel attribution, imported comments, direct participation, addressed requests, unread results, and access checks. [Routine regressions](../../server/src/__tests__/routines-service.test.ts) cover fresh, coalesced, and skipped manual runs.
The source regressions also create an addressed request through the service for a
human assignee. They check unread lists, flags, and counts, plus exclusion of
historical questions and closed requests while preserving authorization requests.

Manual: Seed GitHub, Slack, scheduled routine, and manual routine tasks. Attribution, imported comments, and reading alone keep them outside Mine. Direct board/API comments, human assignment, and open addressed requests admit them. Resolve the request and check that another valid reason is needed. Inbox discovery and Blocked hide unrelated automation by default; the **Show agent-created tasks** checkbox reveals it without subscribing the user. Reload and verify membership, unread badges, archive/resurfacing, and preference persistence.

Manual: Read an unread task, return to Unread, archive a handled item, and reload. Verify personal triage state changes while task status stays correct. Switch users and companies to check isolation.

Seed a completed task whose only activity under the viewing user is automatic
read cleanup. Refresh Mine and Unread: the task must not appear through that
participation, while the cleanup remains in activity history. Record an explicit
user recovery decision on a separate task and verify it still counts. This
browser journey remains manual.

Cold-open verification: load Mine with its snapshot response delayed while
approvals resolve. Only the stable list placeholder should appear until the
initial sources settle; a failed-run row must not jump when tasks arrive. Release
visible-row details separately and compare row/title bounds. Mine reads its own
100-row snapshot with parent/run context; sidebar badges use the count endpoint.
The [Inbox component checks](../../ui/src/pages/Inbox.test.tsx) cover the source
barrier and selected-source query; [badge tests](../../server/src/__tests__/inbox-dismissals.test.ts)
cover unread counts. Browser timing and layout proof remain separate from these tests.

### `decisions`

Automated: [decision queues](../../server/src/__tests__/decision-queues-routes.test.ts) covers route behavior. End-to-end queue-to-source navigation is manual.

Manual: Open a pending decision, follow its source, resolve it through the supported control, and reload the queue. Confirm it retires only after the decision persisted and unrelated pending items remain.

Coordinator regression sources: [canonical history](../../server/src/__tests__/decision-history.test.ts)
exercises real PostgreSQL cross-source pagination, answered-question retention,
company/private-task isolation, and private v1 targets.
[Attention service regressions](../../server/src/__tests__/attention-service.test.ts)
cover pending question forms and confirmations in persistent agent chats, removal
after an answer with retained history, and company/task-visibility/addressee checks.
Idle chats without structured requests remain absent. The
[Inbox component test](../../ui/src/components/coordinator/CoordinatorNeedsYou.test.tsx)
checks that a chat-sourced canonical question reaches its original resolver and context.
Idle chats without structured requests remain absent.
[Audience, badge and claim tests](../../server/src/__tests__/attention-audience-service.test.ts)
cover the view partition, the For you badge with per-view counts, the personal
`view=archived` list and its tab count, and the claim service and route
permission matrix. The [canonical history](../../server/src/__tests__/decision-history.test.ts)
tests also cover approvals, the Withdrawn / Expired / Closed with task filters,
and the Handled by me or for me / Everyone scope (instigator walk, addressee and
assignee precedence, receipts, filters and paging inside a scope).
[Close and transfer tests](../../server/src/__tests__/attention-close.test.ts)
cover withdraw for every interaction kind (including on a closed task), approval
and decision cancel, personal archive/snooze, transfer, history labels, and the
400/403/404/409/422 matrix of the close, transfer and approval-cancel routes.
[Current-card tests](../../server/src/__tests__/attention-current-cards.test.ts)
cover the shared active-request predicate with Mine, the 30-day, closed-task,
decision-deadline and 7-day Unassigned stale rules, stale approval escalation
without withdrawal, fingerprint-only resurfacing of dismissed and snoozed cards,
and the idempotent closed-task sweep.
[Escalation owner tests](../../server/src/__tests__/attention-escalation-owners.test.ts)
cover project decision owners ahead of the default owner, skipping an inactive
owner, the budget owner's hard stop in For you and in everyone's Company view
(one badge card), Company only without a budget owner, and the budget owner's
receipt; the [project](../../server/src/__tests__/project-decision-owner-route.test.ts)
and [company](../../server/src/__tests__/company-default-decision-owner-route.test.ts)
route tests cover the active-member 422 and board-only writes.
[Obligation tests](../../server/src/__tests__/attention-obligations.test.ts)
cover the approval/review, budget-stop/override-approval and blocked-task/failed-run joins, the separate human
review gate, placement with the blocked task's person, one count per obligation,
evidence that hides and restores with its lead, and the split after an answer. The
[Needs You component test](../../ui/src/components/coordinator/CoordinatorNeedsYou.test.tsx)
checks that a chat-sourced canonical question reaches its original resolver and context,
and the view switch, banner, Why me?, For @name and Claim, and Everyone for a board member only (with the withdraw confirmation for another person's card); the
[classic page view test](../../ui/src/pages/WhatNeedsMe.views.test.tsx) checks the same on Decisions,
plus the Archived view with Restore, Change time and Decision history on both pages.
The [Decisions views stories](../../ui/storybook/stories/inbox-search/needs-you-views.stories.tsx)
show For you, Unassigned, Company, Archived, Everyone, a different person's cards, one card for each obligation and the escalation owners (including the budget owner's hard stop in another person's Company view).
It also checks simultaneous resize/light and delayed movement to Recent Decisions.
[Shared card-motion tests](../../ui/src/components/coordinator/CoordinatorTaskCommitment.test.tsx)
cover reduced-motion settlement and returning to a resolved card without replay.
The [decision-motion stories](../../ui/storybook/stories/design-proposals/coordinator-decision-motion.stories.tsx)
exercise real Inbox/resolver components with isolated approval, question, and failed-save responses.
[Projection helpers](../../ui/src/lib/coordinator-attention.test.ts) cover distinct
pending task membership and presentation-only recency decay. Browser verification
must additionally approve copy, approve a visual, and answer a question; confirm
three retained receipts, task/chat consistency, resize/collapse motion, and exact
task context on receipt click. Turning the setting off restores the classic surface.

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

- [Command-palette and keyboard entry points](./navigation-preferences.md#palette-shortcuts) also reach search. Verify quick-filter/query handoff separately from opening the full search route.
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

Capability ID: `inbox-search/views`.

Scope: ui
Storybook: Mine/Recent/Unread/Blocked and broader task views; combined versus standalone host; loading/empty/error/filter states.
Production: Use persisted personal participation/read data; verify scoped counts and list navigation/reload; automatic read cleanup must not create Mine membership.
Sources: Source: [Inbox.tsx](../../ui/src/pages/Inbox.tsx), [Issues.tsx](../../ui/src/pages/Issues.tsx). Tests: [Inbox.test.tsx](../../ui/src/pages/Inbox.test.tsx), [Issues.test.tsx](../../ui/src/pages/Issues.test.tsx), [issues-service.test.ts](../../server/src/__tests__/issues-service.test.ts)

#### `toasts`

Capability ID: `inbox-search/toasts`.

Scope: ui
Storybook: Eligible live task toast, explicit mention, quiet unrelated event, own-action/visible-task suppression, dedupe and company/account switch.
Production: Persisted participation and mentions determine per-viewer socket eligibility; quiet events still refresh caches; reload retains eligibility, unauthorized resources remain denied.
Sources: Source: [ToastViewport.tsx](../../ui/src/components/ToastViewport.tsx), [ToastContext.tsx](../../ui/src/context/ToastContext.tsx), [LiveUpdatesProvider.tsx](../../ui/src/context/LiveUpdatesProvider.tsx), [task-toast-eligibility.ts](../../server/src/realtime/task-toast-eligibility.ts). Tests: [ToastContext.test.tsx](../../ui/src/context/ToastContext.test.tsx), [ToastViewport.test.tsx](../../ui/src/components/ToastViewport.test.tsx), [LiveUpdatesProvider.hook.test.tsx](../../ui/src/context/LiveUpdatesProvider.hook.test.tsx), [task-toast-eligibility.test.ts](../../server/src/__tests__/task-toast-eligibility.test.ts), [live-events-toast.test.ts](../../server/src/__tests__/live-events-toast.test.ts), [multi-user-authenticated.spec.ts](../../tests/e2e/multi-user-authenticated.spec.ts)

Coordinator and classic navigation, the phone bar and both Decisions pages show one badge: the person's current **For you** cards, read from the same per-person feed, with no midnight reset. Unassigned and Company counts stay on their own tabs. Task questions resolve through their original interaction; pending chat projections, counts and recorded receipts invalidate together.
