---
navigation: {"section":"Oversight and operation","sectionOrder":70,"order":30}
---

# Navigation, profile, and announcements

People organize their sidebar, move between company resources, maintain their profile, and dismiss product announcements with the correct persistence and identity scope.

Feature ID: `navigation-preferences`.

Implementation: [sidebar](../../ui/src/components/Sidebar.tsx), [profile](../../ui/src/pages/ProfileSettings.tsx), [announcements](../../ui/src/components/AnnouncementWell.tsx).

Agent access: [companion](../agent-access-map/navigation-preferences.md).

## Sub-features

- `navigation`: `navigation-preferences/navigation` — use current sidebar links, favorites, recents, and available layout controls.
- `preferences`: `navigation-preferences/preferences` — persist supported ordering/collapse choices for the intended user/company.
- `profile`: `navigation-preferences/profile` — edit personal identity and inspect public profile links.
- `announcements`: `navigation-preferences/announcements` — inspect and dismiss an announcement with its intended instance-wide user scope.
- `fallbacks`: `navigation-preferences/fallbacks` — handle missing resources and old deep links without presenting another resource as the target.
- `command-palette`: `navigation-preferences/command-palette` — open quick search and creation actions with keyboard shortcuts, then carry query/filter intent into full search.

## How to get to it (user POV)

### `sidebar-deep-links`

Use starred/recent/sidebar links and direct company-prefixed URLs.

### `profile-announcements`

Use Settings → Profile, `/u/:userSlug`, and the announcement well when a publication is available.

### `palette-shortcuts`

Press Cmd/Ctrl+K to open the command palette. `/` focuses the current page search or opens quick search; `?` opens shortcut help. Outside an input or modal, `c` starts New task and `g` then `i` opens Inbox/My work. In the palette, use **Search all** or Cmd/Ctrl+Enter for the full results page.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use two test users and companies; record the selected UI shell and any client-local preference storage.

### `sidebar-deep-links`

Automated: [sidebar](../../ui/src/components/Sidebar.test.tsx) and [sidebar preference routes](../../server/src/__tests__/sidebar-preferences-routes.test.ts) cover UI/server behavior.

Manual: Star and reorder supported resources, collapse a section, navigate and reload. Switch company/user and inspect the intended preference scope. Open an unavailable resource and a legacy route; verify clear fallback or correct redirect without leaking another company’s state.

Record persistence separately: section collapse is in-memory and reopens after
reload; global sidebar collapse is disabled. Streamlined starred projects sort
alphabetically. Recents are browser-local by user/company; stars and supported
ordering are saved server-side. Local-trusted mode does not prove two-user isolation.

### `profile-announcements`

Automated: [profile page](../../ui/src/pages/ProfileSettings.test.tsx), [announcement hook](../../ui/src/hooks/useAnnouncement.test.tsx), and [announcement routes](../../server/src/__tests__/announcements-routes.test.ts) cover separate UI/persistence layers.

Manual: Change a disposable user’s display details, reload, and inspect an attributed profile link. Dismiss a fixture announcement, switch companies, and verify it remains dismissed for that user; check another user still has their own dismissal state.

### `palette-shortcuts`

Automated: [Command palette](../../ui/src/components/CommandPalette.test.tsx), [shortcut hook](../../ui/src/hooks/useKeyboardShortcuts.test.tsx), [shortcut rules](../../ui/src/lib/keyboardShortcuts.test.ts), and [cheatsheet](../../ui/src/components/KeyboardShortcutsCheatsheet.test.tsx) test components and keyboard rules. [Company search](../../server/src/__tests__/company-search-service.test.ts) covers search contracts; browser focus and identity transitions still need a live check.

Manual: Use uniquely named visible and private task/project fixtures. Open the palette, find a permitted result, follow it, and reload the destination. Enter text with quick-filter chips such as `assignee:me`, `is:open`, and `updated:>7d`; use Search all and Cmd/Ctrl+Enter in separate attempts and verify the resulting query and filters. Switch person/company and confirm private results do not leak. Test `/` on a page with search and a page without it; inspect `?`, `c`, and `g i`. Type those keys inside an editor and a modal: they must not unexpectedly navigate or create work. Test a create action through its normal dialog and inspect the actual saved resource separately.

Sources: [Command palette](../../ui/src/components/CommandPalette.tsx), [shortcut hook](../../ui/src/hooks/useKeyboardShortcuts.ts), [query parser](../../ui/src/lib/search-query-parser.ts), and [search routes](../../server/src/routes/issues.ts).

## Gotchas

- Cmd/Ctrl+B is not a supported global sidebar shortcut. Use the current shortcut help and verify that typing and modal focus suppress navigation chords.

- Announcement dismissals are intentionally instance-wide user preferences, unlike company-scoped domain data.
- Legacy/production shells need their own navigation check when affected.
- A route redirect is part of the journey; do not document a removed screen as if it still renders.

### Storybook verification

#### `preferences`

Capability ID: `navigation-preferences/preferences`.

Scope: ui
Storybook: Mount Sidebar using real preference boundary with stars/order/collapse/recents state. Clearly distinguish in-memory section collapse, browser-local recents and server-saved stars/order.
Production: GET/PUT /sidebar-preferences/me and /companies/{id}/sidebar-preferences/me plus stars must retain intended user/company isolation across reload and switch. Section collapse reopens after reload; global collapse is disabled.
Sources: Source: [Sidebar.tsx](../../ui/src/components/Sidebar.tsx), [sidebar-preferences.ts](../../server/src/routes/sidebar-preferences.ts), [sidebar-preferences.ts](../../server/src/services/sidebar-preferences.ts). Tests: [Sidebar.test.tsx](../../ui/src/components/Sidebar.test.tsx), [sidebar-preferences-routes.test.ts](../../server/src/__tests__/sidebar-preferences-routes.test.ts)

#### `fallbacks`

Capability ID: `navigation-preferences/fallbacks`.

Scope: browser
Storybook: A NotFound rendering story can help polish, but missing-resource/legacy-deep-link capability principally needs real App/router/browser scenarios preserving company and query intent.
Production: Cold-open invalid company/resource and retired URL; verify explicit fallback or correct canonical redirect without silently targeting a different resource/company.
Sources: Source: [NotFound.tsx](../../ui/src/pages/NotFound.tsx), [App.tsx](../../ui/src/App.tsx), [company-routes.ts](../../ui/src/lib/company-routes.ts). Tests: [App.activity-routing.test.tsx](../../ui/src/App.activity-routing.test.tsx), [App.cases-routing.test.tsx](../../ui/src/App.cases-routing.test.tsx), [App.test.tsx](../../ui/src/App.test.tsx), [company-routes.test.ts](../../ui/src/lib/company-routes.test.ts)

### Recent task refresh performance

Saved recent tasks render immediately. One summary batch refreshes at most five
IDs per company/account without passive full-detail or workspace inspection.
Successful omissions remove unavailable entries; failed reads preserve history.
Verify rename, inbox archive, pause/restart, reload, cross-tab updates and account
switches. Inbox archive does not remove the task from recent history.
