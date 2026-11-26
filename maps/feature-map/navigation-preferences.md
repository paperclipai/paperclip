---
navigation: {"section":"Oversight and operation","sectionOrder":70,"order":30}
---

# Navigation, profile, and announcements

People organize their sidebar, move between company resources, maintain their profile, and dismiss product announcements with the correct persistence and identity scope.

Implementation: [sidebar](../../ui/src/components/Sidebar.tsx), [profile](../../ui/src/pages/ProfileSettings.tsx), [announcements](../../ui/src/components/AnnouncementWell.tsx).

Agent access: [companion](../agent-access-map/navigation-preferences.md).

## Sub-features

- `navigation`: use current sidebar links, favorites, recents, and available layout controls.
- `preferences`: persist supported ordering/collapse choices for the intended user/company.
- `profile`: edit personal identity and inspect public profile links.
- `announcements`: inspect and dismiss an announcement with its intended instance-wide user scope.
- `fallbacks`: handle missing resources and old deep links without presenting another resource as the target.

## How to get to it (user POV)

### `sidebar-deep-links`

Use starred/recent/sidebar links and direct company-prefixed URLs.

### `profile-announcements`

Use Settings → Profile, `/u/:userSlug`, and the announcement well when a publication is available.

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

## Gotchas

- Announcement dismissals are intentionally instance-wide user preferences, unlike company-scoped domain data.
- Legacy/production shells need their own navigation check when affected.
- A route redirect is part of the journey; do not document a removed screen as if it still renders.

### Storybook verification

#### `preferences`

Scope: ui
Storybook: Mount Sidebar using real preference boundary with stars/order/collapse/recents state. Clearly distinguish in-memory section collapse, browser-local recents and server-saved stars/order.
Production: GET/PUT /sidebar-preferences/me and /companies/{id}/sidebar-preferences/me plus stars must retain intended user/company isolation across reload and switch. Section collapse reopens after reload; global collapse is disabled.
Sources: Source: [Sidebar.tsx](../../ui/src/components/Sidebar.tsx), [sidebar-preferences.ts](../../server/src/routes/sidebar-preferences.ts), [sidebar-preferences.ts](../../server/src/services/sidebar-preferences.ts). Tests: [Sidebar.test.tsx](../../ui/src/components/Sidebar.test.tsx), [sidebar-preferences-routes.test.ts](../../server/src/__tests__/sidebar-preferences-routes.test.ts)

#### `fallbacks`

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
