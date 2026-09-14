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

Content is plain text. Every manifest object rejects unknown fields, including
misspellings in actions and images. Optional fields: `image: { path, alt }`, `expiresAt` (ISO
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
For a host serving a subdirectory, `PAPERCLIP_PAGE_DEFAULT_PREFIX` prepends a
validated path to both S3 keys and public URLs. Use lowercase letters, numbers
and hyphens in each segment, without leading/trailing slashes.

```sh
node cli/node_modules/tsx/dist/cli.mjs scripts/publish-announcements.ts announcements --publish
```

The helper rejects symlinks, validates image digests, uploads images first and
the manifest last, and verifies the public manifest and asset headers. It writes
only the resolved announcement prefix; no remote objects are deleted or
infrastructure changed. Allow up
to six minutes for CDN propagation. Manifest caching is five minutes; immutable
assets use one year. Before first publication verify the distribution's active
cache policy has minimum TTL <= 300 and maximum TTL >= 300 for the manifest,
and maximum TTL >= 31536000 for assets. Check the behavior matching each path,
including any referenced cache policy. Public response headers alone cannot
prove the effective cache lifetime or override a higher minimum. See
[AWS cache expiration](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html).

Retain the ID when fixing copy/images. Use a new ID to announce something new.
ETags improve fetching but never determine redisplay.

## Preview an announcement before publishing

Use a named staging feed. `--staging <name>` writes
`announcements/staging/<name>/v1/` instead of `announcements/v1/`, so a preview
cannot overwrite the production manifest. With no source directory it uses
`announcements/examples/staging/`, including a sample banner. Commands default
to dry-run unless `--publish` is supplied.

For Paperclip's existing preview host, use the branch preview area that
CloudFront already has permission to read:

```sh
aws sso login --profile paperclip-dev
export PAPERCLIP_PAGE_AWS_PROFILE=paperclip-dev
export PAPERCLIP_PAGE_BUCKET=paperclipai-runner-e2e-history-078455283791-us-east-1
export PAPERCLIP_PAGE_BASE_URL=https://d1p6rlowie26tp.cloudfront.net
export PAPERCLIP_PAGE_DEFAULT_PREFIX=storybook/branches/codex-announcements

# Copy the public fixture into an ignored directory and edit current.json there.
mkdir -p .paperclip
cp -R announcements/examples/staging .paperclip/announcement-preview
node cli/node_modules/tsx/dist/cli.mjs scripts/publish-announcements.ts .paperclip/announcement-preview --staging my-preview --dry-run
node cli/node_modules/tsx/dist/cli.mjs scripts/publish-announcements.ts .paperclip/announcement-preview --staging my-preview --publish
```

Choose a unique staging name for your test and use the printed manifest URL.
The preview host currently uses CloudFront's `Managed-CachingDisabled` policy
for this branch area: edge TTL is zero even though public responses preserve
the five-minute manifest and one-year asset cache headers. This is useful for
preview iteration; it does not verify a production distribution's effective
cache lifetime. For another host, configure its bucket, base URL and optional
prefix, then verify its matching cache behavior as described above.

Create a test-drive configuration in this worktree. Put the feed override in
the **selected instance's `.env`**, not just the invoking shell: test-drive
deliberately clears inherited `PAPERCLIP_*` variables.

```sh
mkdir -p .paperclip/announcement-test-drive/instances/default
# On a new test directory, create this file. On reuse, update these entries
# while preserving the file's existing keys.
cat > .paperclip/announcement-test-drive/instances/default/.env <<'EOF'
PAPERCLIP_ANNOUNCEMENTS_FEED_URL=https://d1p6rlowie26tp.cloudfront.net/storybook/branches/codex-announcements/announcements/staging/my-preview/v1/current.json
PAPERCLIP_ANNOUNCEMENTS_ENABLED=true
PAPERCLIP_DB_BACKUP_ENABLED=false
HEARTBEAT_SCHEDULER_ENABLED=false
EOF

# A fresh test-drive needs a provider key for its initial CEO. Use your usual
# provider environment variable; never put a real key into a manifest or commit.
# Reusing an initialized data directory does not require a bootstrap key.
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts test-drive --data-dir .paperclip/announcement-test-drive --no-browser
```

See [test-drive setup](DEVELOPING.md#one-command-isolated-manual-test-drive) for harness/key options.
Open the printed local URL. The app chooses a free port starting at 3100 and
keeps its database under the supplied directory. It creates no tasks or initial
agent run. After onboarding/company selection, allow three seconds for the card.

Before promoting content, verify:

- The image, copy and both actions fit desktop/mobile and both themes.
- A dialog or bottom-left toast temporarily hides the card, then restores it.
- Close or follow a link; reload, switch companies and open another tab/browser.
  The same account should keep that ID dismissed.
- Edit copy with the same ID: it stays dismissed. Publish a new ID: it appears
  on the next eligible visit. Clearing browser storage alone does not reset
  database dismissals; use a new ID or a fresh isolated data directory.
- Try the empty fixture and a URL that returns 404. The dashboard remains usable
  with no announcement and no announcement error popup.

Stop and restart test-drive after changing its feed URL or republishing content
when you need immediate results. This clears the server's one-hour feed cache
while retaining dismissal records in the same data directory. Reload or return
to the app after restart; an uninterrupted active tab does not discover cards.
For promotion, validate the reviewed content again, configure the production
host/prefix, and publish without `--staging`. Production's checked-in manifest
remains empty until a real announcement is ready.

## No announcement and withdrawal

The explicit **none** value is JSON `null`, not the string `"none"`:

```json
{
  "schemaVersion": 1,
  "announcement": null
}
```

Publish this manifest to withdraw an announcement while retaining every user's
dismissed IDs. Restoring an old announcement cannot resurrect it for people who
dismissed it. The ready-to-publish empty fixture is
`announcements/examples/none/current.json`:

```sh
node cli/node_modules/tsx/dist/cli.mjs scripts/publish-announcements.ts announcements/examples/none --staging my-empty-preview --publish
```

A remote **404** is also a normal empty feed: the board API returns HTTP 200
with `null`, clears previous content/ETag, and waits fifteen minutes before
checking upstream again. It produces no announcement warning in server logs or
popup in the UI. Other unavailable or invalid feeds likewise produce no card
or UI error popup; unexpected upstream failures can be logged for operators.
Withdrawal follows the cache/return timing below. Explicit expiration also
removes a visible card when its deadline arrives.

## Timing and persistence

Show after three seconds when opening or returning to Paperclip, after company
selection and onboarding. Dialogs and toasts take priority. Phones show it above
bottom navigation. No automatic timeout, outside-click dismissal or carousel.
Tab visibility controls the return check: moving focus to the address bar or
an adjacent app pane leaves the card visible and does not restart its settling
period. A hidden tab clears the card; becoming visible fetches fresh dismissal
state before showing anything, even if that lookup takes longer than three
seconds.

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
feed moves to another ID. The instance retains only the IDs of validated
announcements in a publication registry, so offline retries survive withdrawal
and restarts. A caller-invented ID returns 404 without creating dismissal or
audit rows. This registry is not an archive and records no interaction events.

Production ships with an empty manifest. Design guide / Storybook fixtures are
never used as a production fallback.
