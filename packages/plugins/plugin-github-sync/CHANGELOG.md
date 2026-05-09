# @paperclipai/plugin-github-sync

## 0.1.0

### Initial release — one-way Paperclip → GitHub issue mirror

**Features**

- Mirrors Paperclip issues to a GitHub repository on `issue.created` and `issue.updated` events.
- Goal-subtree filtering: `syncedGoalIds` accepts UUID or short-prefix strings; an issue is in scope when its goal or any ancestor goal matches. Empty array syncs all goals.
- Status mapping: `done` → `closed/completed`, `cancelled` → `closed/not_planned`, all other statuses → `open`.
- Body sanitisation: internal Paperclip links (`[label](/PREFIX/issues/…)`) are rewritten to plain text; bare UUID v4 strings are replaced with `[id-redacted]` before pushing to GitHub.
- Title format: `[GLA-NN] Issue title` when an identifier is present.
- `paperclip-synced` label applied to every mirrored issue.
- Outbound-only sync footer appended to every body: informs GitHub readers that comments are not read back.
- Issue-number mapping persisted in `plugin_state` (`scope: issue`, `namespace: github-sync`, `key: gh-issue-number`) — re-enabled integrations update existing GitHub issues rather than re-creating them.
- Goal-subtree cache: 5-minute TTL per company, invalidated on `goal.updated`.
- Rate-limit handling: backs off on HTTP 429 and 403+`x-ratelimit-remaining: 0` with up to 3 retries and exponential back-off.
- `dryRun` mode (default `true`): logs sync actions without calling GitHub — disable once ready to go live.
- Admin UI in Company Settings → GitHub Sync (repo, host, PAT/secret, synced goals, dry-run toggle).
- Manual sync endpoint: `POST /api/issues/{issueId}/sync-to-github`.
- GitHub Enterprise Server supported via the `host` field.

**Security**

- PAT stored as a Paperclip secret; never returned by the API, never logged.
- Token redacted from all error messages before surfacing.
- Host-pinning on every outbound request — constructed URL host is validated against the configured host before each call.
- `redirect: "error"` on all fetch calls — no redirect-following.
- No inbound webhook route; plugin has zero surface area for GitHub → Paperclip traffic.
