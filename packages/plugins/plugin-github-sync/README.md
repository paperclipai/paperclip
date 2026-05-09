# GitHub Sync

One-way Paperclip → GitHub issue mirror with goal-subtree filtering.

> **One-way only.** Issues flow from Paperclip to GitHub. Nothing is ever read back from GitHub. There is no inbound webhook, no GitHub → Paperclip direction, and no comment sync.

## What it does

- Mirrors Paperclip issues to GitHub issues in a repo you control.
- Keeps the mirror in sync: create, rename, re-describe, close, reopen, cancel — all propagate.
- Stamps mirrored issues with the `paperclip-synced` label and a footer that says comments on the GitHub side are not read back.
- Strips internal Paperclip links and bare UUIDs from the body before pushing — no internal routing paths or opaque IDs leak.
- Filters by goal subtree: configure `syncedGoalIds` to only mirror issues that belong to a specific goal or its descendants. Leave it empty to mirror everything.

## What it does NOT do

- It does **not** read GitHub. No webhooks, no polling, no inbound path.
- It does **not** sync comments, labels (other than `paperclip-synced`), assignees, milestones, or GitHub Projects.
- It does **not** delete GitHub issues when a Paperclip issue is deleted — the GitHub issue stays and must be closed manually.
- It does **not** sync issues that have no `goalId` when `syncedGoalIds` is non-empty.
- It does **not** propagate Paperclip agent assignments, priorities, or internal metadata.

## Configuration

All configuration lives in **Company Settings → GitHub Sync** in the Paperclip UI.

| Field | Required | Default | Description |
|---|---|---|---|
| `repo` | yes | — | Target repo in `owner/repo` format, e.g. `acme/my-repo` |
| `host` | no | `github.com` | GitHub host. Use your GitHub Enterprise hostname if not on github.com. |
| `secretRef` | yes | — | UUID of the Paperclip secret that holds the PAT. The PAT needs `repo` scope (Issues write). |
| `syncedGoalIds` | no | `[]` (all) | List of goal UUIDs or UUID prefixes whose issue subtrees are eligible. Empty = mirror all. |
| `dryRun` | no | `true` | When `true`, sync actions are logged but no GitHub API calls are made. |

### Storing the GitHub PAT

1. In Paperclip, go to **Company Settings → Secrets** and create a new secret with your GitHub Personal Access Token (PAT). The PAT must have `repo` scope (or `Issues: write` on a fine-grained token).
2. Copy the secret UUID (or use the "Enter new PAT" flow in the GitHub Sync section, which creates the secret for you).
3. Paste the UUID into the `secretRef` field.

The token is never returned by the Paperclip API and never logged.

### Goal-subtree filtering

Set `syncedGoalIds` to one or more goal UUIDs (or short UUID prefixes like `eee6ff51`) to limit mirroring to issues that belong to those goals or any descendant goal. The resolver walks up to 5 levels of the goal hierarchy and caches results for 5 minutes (invalidated on `goal.updated`).

**Examples:**

```jsonc
// Mirror everything (no filtering)
{ "syncedGoalIds": [] }

// Mirror only issues under the "improve openrunner" goal tree
{ "syncedGoalIds": ["eee6ff51-0607-41bb-9c68-330516e57f9f"] }

// Short-prefix form — matches any goal whose ID starts with this prefix
{ "syncedGoalIds": ["eee6ff51"] }
```

Issues with no `goalId` are skipped when `syncedGoalIds` is non-empty.

## Dry-run workflow

The plugin ships with `dryRun: true` by default. In this mode every sync action is logged to the plugin logs but no GitHub API call is made.

**Recommended rollout:**

1. Enable GitHub Sync with `dryRun: true`.
2. Create or update a few test issues and inspect the plugin logs via **Company Settings → GitHub Sync** (last sync message) or directly in the plugin logs table.
3. Confirm the logged title, body, and state look correct — no internal links, no raw UUIDs.
4. If everything looks right, uncheck **Dry-run mode** and click **Update config**.
5. Trigger a manual sync on a known issue via `POST /api/issues/{issueId}/sync-to-github` to verify the first live call.

## Disabling

In **Company Settings → GitHub Sync**, click **Disable**. This sets `enabled: false` on the plugin company settings. Existing mirrored issues are **not** touched on GitHub. Re-enable at any time; the issue-number mapping is preserved in the plugin state store so previously mirrored issues will be updated rather than re-created.

## Status mapping

| Paperclip status | GitHub state | Reason |
|---|---|---|
| `todo`, `in_progress`, `in_review`, `blocked` | `open` | — |
| `done` | `closed` | `completed` |
| `cancelled` | `closed` | `not_planned` |

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

## Install Into Paperclip

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/path/to/plugin-github-sync","isLocalPath":true}'
```

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.

## Goal tree depth

| Context | Typical depth |
|---------|--------------|
| Real-world Paperclip goal trees | 2–3 levels |
| Documented max supported | 5 levels |
| Fixture worst-case (tests) | 3 levels |

The resolver walks the `parentId` chain with a `visited` cycle-guard; it terminates safely on malformed trees. A 5-level walk costs at most 5 API calls and is cached per company for 5 minutes (TTL), invalidated on every `goal.updated` event.
