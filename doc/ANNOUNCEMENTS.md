# In-app announcements

Paperclip displays one optional announcement card in the board UI. Its feed is
`https://pages.paperclip.ing/announcements/v1/current.json`. The instance fetches
JSON on demand and renders it with native components.

## Operator configuration

- `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false` disables fetching and display.
- `PAPERCLIP_ANNOUNCEMENTS_FEED_URL` overrides the public HTTPS manifest URL.
  Credentials, query strings, private destinations and redirects are rejected.

Announcements are independent of telemetry. Feed/image requests originate from
the instance without account IDs, company data, cookies or event tracking. The
host sees ordinary server network request metadata. The browser requests only
its own Paperclip API.

## Authoring and publishing

The shared `announcementManifestSchema` defines the format:

```json
{
  "schemaVersion": 1,
  "announcement": {
    "id": "2026-09-projects",
    "eyebrow": "New in Paperclip",
    "title": "Your next idea starts here",
    "description": "Bring your agents and work together in a project.",
    "secondaryLink": { "kind": "external", "label": "Learn more", "url": "https://paperclip.ing" },
    "primaryAction": { "kind": "route", "label": "Open projects", "path": "/projects" }
  }
}
```

Content is plain text. Optional fields: `image: { path, alt }`, `expiresAt` (ISO
timestamp), and `minimumPaperclipVersion` (stable `major.minor.patch`). Internal
actions accept stable pages in `ANNOUNCEMENT_APP_ROUTES` and use the selected
company. External HTTPS links open a new tab. Actions only navigate.

Images are `assets/<sha256>.png`, `.jpg` or `.webp`, at most 2 MiB, relative to
the manifest directory. Use an approximately 2.6:1 banner with important content
near the center; mobile crops it shorter. The manifest is limited to 64 KiB.
Run `shasum -a 256 hero.png` to get the image digest, copy the file to
`announcements/assets/<digest>.png`, and use `assets/<digest>.png` in the
manifest. An image correction changes this asset filename while retaining the
announcement ID.

Edit `announcements/current.json`, put its image under `announcements/assets/`,
then run:

```sh
node cli/node_modules/tsx/dist/cli.mjs scripts/publish-announcements.ts announcements --dry-run
```

Set `PAPERCLIP_PAGE_BUCKET`, optionally `PAPERCLIP_PAGE_BASE_URL`, and the page
uploader's namespaced `PAPERCLIP_PAGE_AWS_ACCESS_KEY_ID` and
`PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY` (optional `PAPERCLIP_PAGE_AWS_SESSION_TOKEN`),
or `PAPERCLIP_PAGE_AWS_PROFILE`. Ambient AWS credentials also work.

```sh
node cli/node_modules/tsx/dist/cli.mjs scripts/publish-announcements.ts announcements --publish
```

The helper rejects symlinks, validates image digests, uploads images first and
the manifest last, and verifies the public manifest and asset headers. Only `announcements/v1/`
is written; no remote objects are deleted or infrastructure changed. Allow up
to six minutes for CDN propagation. Manifest caching is five minutes; immutable
assets use one year. Before first publication verify the distribution's active
cache policy has minimum TTL <= 300 and maximum TTL >= 300 for the manifest,
and maximum TTL >= 31536000 for assets. Check the behavior matching each path,
including any referenced cache policy. Public response headers alone cannot
prove the effective cache lifetime or override a higher minimum. See
[AWS cache expiration](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html).

Retain the ID when fixing copy/images. Use a new ID to announce something new.
Publish `announcement: null` to withdraw the card. Restoring an old ID preserves
earlier dismissals. ETags improve fetching but never determine redisplay.

## Timing and persistence

Show after three seconds when opening or returning to Paperclip, after company
selection and onboarding. Dialogs and toasts take priority. Phones show it above
bottom navigation. No automatic timeout, outside-click dismissal or carousel.

The instance caches the feed for an hour, deduplicates concurrent fetches, and
uses conditional requests. Failed requests have a fifteen-minute cooldown; no
card appears for unavailable/invalid/incompatible content. Each request has a
three-second deadline. Active tabs do not poll for announcements. Publication
and withdrawal are discovered on a return after cache expiry (normally within
about 65 minutes for returning users).

Closing or following either link saves a unique `(userId, announcementId)`
record in the instance DB, shared across browsers and companies. Its first
write and audit entry commit together; the active company is audit context.
Viewers can dismiss their own card. No-login instances share `local-board`.
Separate installations do not share state.

The browser hides immediately, stores pending writes per account, and retries
on reconnect/return. Failed saves explain that cross-device sync has not
completed. If browser storage is unavailable, state lasts for this visit. Other
tabs close through BroadcastChannel/storage events; another browser refreshes
state on return. Logout clears displayed state and aborts account-bound work.
A failed state lookup never shows a card.

Board-only APIs: `GET /api/announcements/current`,
`GET /api/announcements/:id/image`, and `POST /api/announcements/:id/dismiss`
with `{ "companyId": "..." }`. Responses use `private, no-store`. Repeated POSTs
return 204 without duplicate audits. Pending dismissals remain valid after the
feed moves to another ID.

Production ships with an empty manifest. Design guide / Storybook fixtures are
never used as a production fallback.
