# GitHub Sync

One-way Paperclip → GitHub issue mirror with goal-subtree filtering

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
  -d '{"packageName":"/Users/jlqueguiner/paperclip-openrunner/packages/plugins/plugin-github-sync","isLocalPath":true}'
```

## Goal-Subtree Filtering

Issues are mirrored to GitHub only when they belong to an in-scope goal subtree.
Configure `syncedGoalIds` with one or more goal ID prefixes (full UUID or short prefix like `eee6ff51`).
An issue is in scope when its `goalId`, or any ancestor goal, starts with one of those prefixes.

```jsonc
// adapterConfig example
{
  "syncedGoalIds": ["eee6ff51"],   // "improve openrunner" subtree
  "repo": "acme/openrunner",
  "secretRef": "github-token"
}
```

**No goalId**: when `syncedGoalIds` is non-empty, issues without a `goalId` are skipped.

**Empty `syncedGoalIds`**: all issues are mirrored (no filtering).

### Goal tree depth

| Context | Typical depth |
|---------|--------------|
| Real-world Paperclip goal trees | 2–3 levels (company → team → squad) |
| Documented max supported | 5 levels |
| Fixture worst-case (tests) | 3 levels |

The resolver walks the `parentId` chain with a `visited` cycle-guard; it terminates safely even on malformed trees. A 5-level walk costs at most 5 API calls and is cached per company for 5 minutes (TTL). The cache is invalidated on every `goal.updated` event.

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
