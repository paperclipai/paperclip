# Wire `q=` into Blocker/Parent picker search

**Issue:** ENS-1903
**Date:** 2026-05-17

## Problem

Blocker/Parent pickers in `IssueProperties.tsx` fetch issues via `issuesApi.list(companyId)` with no params. The server returns up to 1000 issues sorted by priority — on busy companies, low-priority issues are entirely outside the window. The picker's text filter is client-side only, so it can't find rows the server never returned.

## Changes

All in `ui/src/components/IssueProperties.tsx`:

1. **Add `useDebounced` hook** — same pattern already used in `ImportFromVaultDialog.tsx`. Debounces search input by 200ms.

2. **Replace single `allIssues` query with two search queries:**
   - `blockerPickerIssues`: enabled when blocker popover is open, passes `debouncedBlockedBySearch` as `q=` with `limit=50`
   - `parentPickerIssues`: enabled when parent popover is open, passes `debouncedParentSearch` as `q=` with `limit=50`
   - When search is empty, queries fire with no `q` (returns top-50 by current sort)

3. **Remove client-side text filters** — server-side `q=` handles matching now.

4. **Update dependent computations** — `descendantIssueIds` and `currentParentIssue` use `parentPickerIssues` instead of `allIssues`.

## Query key strategy

Uses existing `queryKeys.issues.search(companyId, q, projectId, limit)` which already includes search term in the cache key — React Query caches per-search-term automatically.

## Risks

- `descendantIssueIds` (cycle prevention for parent picker) is now computed from the 50-result search window rather than the full 1000-issue window. This is an incomplete check, but the server should also validate parent cycles on update.
