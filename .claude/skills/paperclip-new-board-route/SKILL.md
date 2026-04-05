---
name: paperclip-new-board-route
description: |
  Fix "Company not found" error when adding a new top-level page to the Paperclip UI.
  Use when: (1) you add a new route in App.tsx and get "Company not found" when navigating 
  to it from the sidebar, (2) a new SidebarNavItem resolves to an unknown company prefix, 
  (3) the router misinterprets a route segment as a company prefix. Root cause: 
  BOARD_ROUTE_ROOTS in ui/src/lib/company-routes.ts must include every board-level route root.
author: Claude Code
version: 1.0.0
date: 2026-04-05
---

# Paperclip: Registering a New Board Route

## Problem

Adding a new page to the Paperclip board UI results in **"Company not found"** when navigating
to it. The URL looks correct (e.g., `/documents`) but the app treats the segment as a company
prefix instead of a route name.

## Root Cause

`ui/src/lib/company-routes.ts` maintains `BOARD_ROUTE_ROOTS` — a set of known board-level
route name prefixes. The custom router (`ui/src/lib/router.tsx`) uses this set to decide
whether a path like `/documents` is:

- A board route → prepend company prefix → `/PAP/documents`
- A company prefix → treat `documents` as a company name → "Company not found"

If your route name is **not** in `BOARD_ROUTE_ROOTS`, the router falls through to the
company-prefix branch and fails.

## Solution

Whenever you add a new top-level board route in `App.tsx`, also add it to `BOARD_ROUTE_ROOTS`:

**File:** `ui/src/lib/company-routes.ts`

```ts
const BOARD_ROUTE_ROOTS = new Set([
  "dashboard",
  "issues",
  "routines",
  "goals",
  // ... existing entries ...
  "your-new-route",   // ← add this
]);
```

## Checklist for Adding a New Board Page

1. Create `ui/src/pages/YourPage.tsx`
2. Import and add a `<Route path="your-route" element={<YourPage />} />` inside `boardRoutes()` in `App.tsx`
3. **Add `"your-route"` to `BOARD_ROUTE_ROOTS` in `ui/src/lib/company-routes.ts`** ← easy to forget
4. Add a `SidebarNavItem to="/your-route"` if the page needs a sidebar link
5. Add an `UnprefixedBoardRedirect` route at the top level of `App.tsx` if the page should be
   accessible without a company prefix in the URL (e.g., `/your-route` → `/PAP/your-route`)

## Verification

After adding to `BOARD_ROUTE_ROOTS`, clicking the sidebar link should navigate to
`/:companyPrefix/your-route` instead of showing "Company not found".

## Notes

- `GLOBAL_ROUTE_ROOTS` is a separate set for routes that are never company-scoped (`auth`,
  `invite`, `instance`, etc.). Don't confuse the two.
- Plugin routes added via the plugin system don't need to be in `BOARD_ROUTE_ROOTS` — the
  plugin slot outlet handles them differently via the `:pluginRoutePath` catch-all route.
