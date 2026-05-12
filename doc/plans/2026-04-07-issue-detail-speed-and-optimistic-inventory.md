# 2026-04-07 Issue Detail Speed And Optimistic Inventory

Status: Proposed
Date: 2026-04-07
Audience: Product and engineering
Related:
- `ui/src/pages/IssueDetail.tsx`
- `ui/src/components/IssueProperties.tsx`
- `ui/src/api/issues.ts`
- `ui/src/lib/queryKeys.ts`
- `server/src/routes/issues.ts`
- `server/src/services/issues.ts`
- [PAP-1192](/PAP/issues/PAP-1192)
- [PAP-1191](/PAP/issues/PAP-1191)
- [PAP-1188](/PAP/issues/PAP-1188)
- [PAP-1119](/PAP/issues/PAP-1119)
- [PAP-945](/PAP/issues/PAP-945)
- [PAP-1165](/PAP/issues/PAP-1165)
- [PAP-890](/PAP/issues/PAP-890)
- [PAP-254](/PAP/issues/PAP-254)
- [PAP-138](/PAP/issues/PAP-138)

## 1. Purpose

This note inventories the Paperclip issues that point to the same UX class of problem:

- pages feel slow because they over-fetch or refetch too much
- actions feel slow because the UI waits for the round trip before reflecting obvious local intent
- optimistic updates exist in some places, but not in a consistent system

The immediate trigger is [PAP-1192](/PAP/issues/PAP-1192): the issue detail page now feels very slow.

## 2. Short Answer

The issue detail page is not obviously blocked by one pathological endpoint. The main problem is the shape of the page:

- `IssueDetail` fans out into many independent queries on mount
- some of those queries fetch full company-wide collections for data that is local to one issue
- common mutations invalidate almost every issue-related query, which creates avoidable refetch storms
- the page has only a minimal top-level `Loading...` fallback and very little staged or sectional loading UX

Measured against the current assigned issue (`PAP-1191`) on local dev, the slowest single request was the full company issues list:

- `GET /api/issues/:id` about `18ms`
- `GET /api/issues/:id/comments|activity|approvals|attachments` about `6-8ms`
- `GET /api/companies/:companyId/agents|projects` about `9-11ms`
- `GET /api/companies/:companyId/issues` about `76ms`

That strongly suggests the current pain is aggregate client fan-out plus over-broad invalidation, not one obviously broken endpoint.

## 3. Similar Issue Inventory

## 3.1 Issue-detail and issue-action siblings

- [PAP-1192](/PAP/issues/PAP-1192): issue page feels like it loads forever
- [PAP-1188](/PAP/issues/PAP-1188): assignee changes in the issue properties pane were slow and needed optimistic UI
- [PAP-945](/PAP/issues/PAP-945): optimistic comment rendering
- [PAP-1003](/PAP/issues/PAP-1003): optimistic comments had duplicate draft/pending behavior
- [PAP-947](/PAP/issues/PAP-947): follow-up breakage from optimistic comments
- [PAP-254](/PAP/issues/PAP-254): long issue threads become sluggish when adding comments
- [PAP-189](/PAP/issues/PAP-189): comment semantics while an issue has a live run

Pattern: the issue page already has a history of needing both optimistic behavior and bounded thread/loading behavior. `PAP-1192` is the same family, not a new category.

## 3.2 Inbox and list-view siblings

- [PAP-1119](/PAP/issues/PAP-1119): optimistic archive had fade-out then snap-back
- [PAP-1165](/PAP/issues/PAP-1165): issue search slow
- [PAP-890](/PAP/issues/PAP-890): issue search slow, make it very fast
- [PAP-138](/PAP/issues/PAP-138): inbox loading feels stuck
- [PAP-470](/PAP/issues/PAP-470): create-issue save state felt slow and awkward

Pattern: Paperclip already has several places where the right fix was "show intent immediately, then reconcile," not "wait for refetch."

## 3.3 Broader app-loading siblings

- [PAP-472](/PAP/issues/PAP-472): dashboard charts load very slowly
- [PAP-797](/PAP/issues/PAP-797): reduce loading states through static generation/caching where possible
- [PAP-799](/PAP/issues/PAP-799): embed company data at build time to eliminate loading states
- [PAP-703](/PAP/issues/PAP-703): faster chat and better visual feedback

Pattern: the product has recurring pressure to reduce blank/loading states across the app, so the issue-detail work should fit that broader direction.

## 4. Current Issue Detail Findings

## 4.1 Mount query fan-out is high

`ui/src/pages/IssueDetail.tsx` mounts all of these data sources up front:

- issue detail
- comments
- activity
- linked runs
- linked approvals
- attachments
- live runs
- active run
- full company issues list
- agents list
- auth session
- projects list
- feedback votes
- instance general settings
- plugin slots

This is too much for the initial view of a single issue.

## 4.2 The page fetches full company issue data just to derive child issues

`IssueDetail` currently does:

- `issuesApi.list(selectedCompanyId!)`
- then filters client-side for `parentId === issue.id`

That is expensive relative to the need.

Important detail:

- the server route already supports `parentId`
- `server/src/services/issues.ts` already supports `parentId`
- but `ui/src/api/issues.ts` does not expose `parentId` in the filter type

So the client is missing an already-supported narrow query path.

## 4.3 Comments are still fetched as full-thread loads

`server/src/routes/issues.ts` and `server/src/services/issues.ts` already support:

- `after`
- `order`
- `limit`

But `IssueDetail` still calls `issuesApi.listComments(issueId)` with no cursor or limit and then re-invalidates the full thread after common comment actions.

That means we already have the server-side building blocks for incremental comment loading, but the page is not using them.

## 4.4 Cache invalidation is broader than necessary

`invalidateIssue()` in `IssueDetail` invalidates:

- detail
- activity
- runs
- approvals
- feedback votes
- attachments
- documents
- live runs
- active run
- multiple issue collections
- sidebar badges

That is acceptable for correctness, but it is expensive for perceived speed and makes optimistic work feel less stable because the page keeps re-painting from fresh network results.

## 4.5 Live run state is fetched twice

The page polls both:

- `issues.liveRuns(issueId)` every 3s
- `issues.activeRun(issueId)` every 3s

That is duplicate polling for closely related state.

## 4.6 Properties panel duplicates more list fetching

`ui/src/components/IssueProperties.tsx` fetches:

- session
- agents list
- projects list
- labels
- and, when the blocker picker opens, the full company issues list

The page and panel are each doing their own list work instead of sharing a narrower issue-detail data model.

## 4.7 The perceived loading UX is too thin

`IssueDetail` only shows:

- plain `Loading...` while the main issue query is pending

After that, many sub-sections can appear empty or incomplete until their own queries resolve. That makes the page feel slower than the raw request times suggest.

## 5. Recommended Plan

## 5.1 Phase 1: Fix perceived speed first

Ship UX changes that make the page feel immediate before deeper backend reshaping:

- replace the plain `Loading...` state with an issue-detail skeleton
- give comments, activity, attachments, and sub-issues their own skeleton/empty/loading states
- preserve visible stale data during refetch instead of clearing sections
- show explicit pending state for local actions that are already optimistic

Why first:

- it improves the user-facing feel immediately
- it reduces the chance that later data changes still feel slow because the page flashes blank

## 5.2 Phase 2: Stop fetching the full company issues list for child issues

Add `parentId` to the `issuesApi.list(...)` filter type and switch `IssueDetail` to:

- fetch child issues only
- stop loading the full company issue collection on page mount

This is the highest-confidence narrow win because the server path already exists.

## 5.3 Phase 3: Convert comments to a bounded + incremental model

Use the existing server support for:

- latest comment cursor from heartbeat context or issue bootstrap
- incremental fetch with `after`
- bounded initial fetch with `limit`

Suggested behavior:

- first load: fetch the latest N comments
- offer `load earlier` for long threads
- after posting or on live updates: append incrementally instead of invalidating the whole thread

This should address the same performance family as [PAP-254](/PAP/issues/PAP-254).

## 5.4 Phase 4: Reduce duplicate polling and invalidation

Tighten the runtime side of the page:

- collapse `liveRuns` and `activeRun` into one client source if possible
- stop invalidating unrelated issue collections after mutations that only affect the current issue
- merge server responses into cache where we already have enough information

Examples:

- posting a comment should not force a broad company issue list refetch unless list-visible metadata changed
- attachment changes should not invalidate approvals or unrelated live-run queries

## 5.5 Phase 5: Consider an issue-detail bootstrap contract

If the page is still too chatty after the client fixes, add one tailored bootstrap surface for the issue detail page.

Potential bootstrap payload:

- issue core data
- child issue summaries
- latest comment cursor and recent comment page
- live run summary
- attachment summaries
- approval summaries
- any lightweight mention/selector metadata truly needed at first paint

This should happen after the obvious client overfetch fixes, not before.

## 6. Concrete Opportunities By Surface

## 6.1 Issue detail page

- narrow child issue fetch from full list to `parentId`
- stage loading by section instead of all-or-nothing perception
- bound initial comments payload
- reduce duplicate live-run polling
- replace broad invalidation with targeted cache writes

## 6.2 Issue properties panel

- reuse page-level agents/projects data where possible
- fetch blockers lazily and narrowly
- keep local optimistic field updates without broad page invalidation

## 6.3 Thread/comment UX

- append optimistic comments directly into the visible thread
- keep queued/pending comment state stable during reconciliation
- fetch only new comments after the last known cursor

## 6.4 Cross-app optimistic consistency

The same standards should apply to:

- issue archive/unarchive
- issue property edits
- create issue/sub-issue flows
- comment posting
- attachment/document actions where the local result is obvious

## 7. Suggested Execution Order

1. `PAP-1192`: issue-detail skeletons and staged loading
2. add `parentId` support to `ui/src/api/issues.ts` and switch child-issue fetching to a narrow query
3. move comments to bounded initial load plus incremental updates
4. shrink invalidation and polling scope
5. only then decide whether a new issue-detail bootstrap endpoint is still needed

## 8. Success Criteria

This inventory is successful if the follow-up implementation makes the issue page behave like this:

1. navigating to an issue shows a shaped skeleton immediately, not plain text
2. the page no longer fetches the full company issue list just to render sub-issues
3. long threads do not require full-thread fetches on every load or comment mutation
4. local actions feel immediate and do not snap back because of broad invalidation
5. the issue page feels faster even when absolute backend timings are already reasonable
