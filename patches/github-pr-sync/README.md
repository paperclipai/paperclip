# GitHub PR Sync Patch Bundle

This directory contains an external patch bundle for the GitHub PR -> Paperclip control-plane integration.

## Contents
- `github-pr-sync-e2e.patch` — applies the feature to a clean Paperclip checkout
- `e2e-smoke.sh` — local/isolated smoke verification after apply
- `supportopia-remote-pr-ops.sh` — Supportopia-specific remote helper/doc sync script

## Intended workflow
This bundle is for environments where you want to keep the upstream Paperclip codebase untouched and apply the feature as an external customization layer.

### Apply
```bash
git apply patches/github-pr-sync/github-pr-sync-e2e.patch
```

### Verify
```bash
pnpm -r typecheck
pnpm test:run
pnpm build
patches/github-pr-sync/e2e-smoke.sh /path/to/paperclip-checkout
```

## Notes
- The patch contains the real implementation, tests, docs, and bridge scripts.
- The smoke script assumes the patch has already been applied.
- `supportopia-remote-pr-ops.sh` is environment-specific to the current Supportopia VPS layout.
