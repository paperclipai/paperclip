# Upstream — `@pro-vi/designer`

This service is a **vendored copy** of [`@pro-vi/designer`](https://github.com/pro-vi/designer),
an MCP + CLI for driving [claude.ai/design](https://claude.ai/design) (the
Claude wireframe + hi-fi design tool that has no API).

We vendor (rather than depend via npm or use a git subtree) for three
reasons:

1. **CI ownership**: paperclip's CI builds + pushes the Docker image to
   Blockcast's Harbor registry; the upstream repo doesn't.
2. **In-house patches**: this service is used by the cluster's UXDesigner
   agent, and we may need to apply patches (selectors changes, cookie
   storage paths, identity-pool integration) without waiting for upstream.
3. **Lockfile insulation**: the upstream `package-lock.json` references
   versions that are out of step with paperclip's pnpm graph; vendoring
   keeps our dependency surface independent.

## Source

- **Upstream repo**: https://github.com/pro-vi/designer
- **Upstream license**: MIT (vendored copy retains the LICENSE file)
- **Vendored from commit**: `e7b5790a6217982ec0044436950275e4b74e556f`
- **Vendored on**: 2026-05-24 (BLO-6870)
- **Maintainer (upstream)**: Provi Zhang

## What we changed vs upstream

- `package.json`: renamed `@pro-vi/designer` → `@blockcast/designer`,
  marked `"private": true`, repository fields updated to point at this
  monorepo subdirectory. Scripts + dependencies unchanged.
- `Dockerfile.pod` → `Dockerfile` (renamed for monorepo CI consistency
  with `docker-designer.yml` looking up `packages/services/designer/Dockerfile`).
- `.github/workflows/` removed (CI now lives at
  `paperclip/.github/workflows/docker-designer.yml`).
- `package-lock.json`, `node_modules/`, `dist/`, `coverage/` excluded from
  the vendoring (regenerated locally / in CI).
- `release-please-config.json` + `.release-please-manifest.json` removed
  (the package is private, not published).

## How to re-sync from upstream

```bash
# 1. Update the upstream working tree
cd ~/src/designer && git pull origin main

# 2. From the paperclip monorepo root
cd ~/src/paperclip/paperclip
git checkout -b sync/designer-upstream

# 3. Rsync the source files (preserving the in-house changes above)
rsync -a \
  --exclude=.git --exclude=node_modules --exclude=dist --exclude=coverage \
  --exclude=.github/workflows --exclude=artifacts --exclude='*.tsbuildinfo' \
  --exclude='.release-please-manifest.json' \
  --exclude=release-please-config.json --exclude=package-lock.json \
  --exclude=UPSTREAM.md \
  ~/src/designer/ packages/services/designer/

# 4. Restore the package.json patches
#    (name, private, repository.url) — do this by hand or via a sed script
git diff packages/services/designer/package.json

# 5. Update this file with the new upstream commit
git -C ~/src/designer rev-parse HEAD  # paste into "Vendored from commit"
# also update "Vendored on"

# 6. Run tests + lint
cd packages/services/designer && npm install && npm run check

# 7. Commit
git add packages/services/designer/ && git commit -m "chore(designer): sync from upstream sha <…>"
```

## Future work

Consider converting this to a `git subtree` once the upstream cadence is
predictable enough that the manual sync is worth automating. The subtree
form lets `git subtree pull` handle the merge mechanically (at the cost
of more complex commit history).
