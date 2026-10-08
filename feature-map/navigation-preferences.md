# Navigation, profile, and announcements

People organize their sidebar, move between company resources, maintain their profile, and dismiss product announcements with the correct persistence and identity scope.

Implementation: [sidebar](../ui/src/components/Sidebar.tsx), [profile](../ui/src/pages/ProfileSettings.tsx), [announcements](../ui/src/components/AnnouncementWell.tsx).

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

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use two test users and companies; record the selected UI shell and any client-local preference storage.

### `sidebar-deep-links`

Automated: [sidebar](../ui/src/components/Sidebar.test.tsx) and [sidebar preference routes](../server/src/__tests__/sidebar-preferences-routes.test.ts) cover UI/server behavior.

Manual: Star and reorder supported resources, collapse a section, navigate and reload. Switch company/user and inspect the intended preference scope. Open an unavailable resource and a legacy route; verify clear fallback or correct redirect without leaking another company’s state.

### `profile-announcements`

Automated: [profile page](../ui/src/pages/ProfileSettings.test.tsx), [announcement hook](../ui/src/hooks/useAnnouncement.test.tsx), and [announcement routes](../server/src/__tests__/announcements-routes.test.ts) cover separate UI/persistence layers.

Manual: Change a disposable user’s display details, reload, and inspect an attributed profile link. Dismiss a fixture announcement, switch companies, and verify it remains dismissed for that user; check another user still has their own dismissal state.

## Gotchas

- Announcement dismissals are intentionally instance-wide user preferences, unlike company-scoped domain data.
- Legacy/production shells need their own navigation check when affected.
- A route redirect is part of the journey; do not document a removed screen as if it still renders.
