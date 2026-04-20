---
title: Branching Workflow
description: Git branching strategy for the Paperclip fork
---

# Branching Workflow

This document describes the branching strategy used in the JavierCervilla/paperclip fork.

## Branches

| Branch           | Purpose                                                         | Deployed to          |
| ---------------- | --------------------------------------------------------------- | -------------------- |
| `master`         | Synced from upstream `paperclipai/paperclip` via GitHub Actions | —                    |
| `preview`        | Staging environment for verifying features before production    | Preview environment  |
| `deploy/dokploy` | Production deployment branch                                    | Production (Dokploy) |

## Flow

```
upstream (paperclipai/paperclip)
        │
        ▼
     master  ←── auto-synced via sync-upstream.yml
        │
        ▼
feature/* branches
        │
        ▼
     preview  ←── staging: verify features here
        │
        ▼
  deploy/dokploy  ←── production: promote from preview
```

## Day-to-Day Workflow

1. **Feature development**: Create feature branches from `preview`.
2. **Merge to preview**: Open a PR targeting `preview`. Once approved and merged, the change deploys to the preview/staging environment.
3. **Verify in staging**: Test the change in the preview environment.
4. **Promote to production**: Once verified, merge `preview` into `deploy/dokploy` (or cherry-pick specific commits).

## Upstream Sync

- `master` is kept in sync with upstream automatically via the `sync-upstream.yml` GitHub Action.
- Periodically merge `master` into `preview` to pick up upstream changes.
- **Never commit custom features directly to `master`** — it is reserved for upstream sync.

## Docker Compose Files

- `deploy/docker-compose.dokploy.yml` — Production environment
- `deploy/docker-compose.preview.yml` — Preview/staging environment

Both files use the same structure but with separate volume names to avoid data conflicts between environments.

## Key Rules

- `master` must stay no more than 1 week behind upstream.
- `deploy/dokploy` must always produce a successful Docker build.
- All features must pass through `preview` before reaching `deploy/dokploy`.
