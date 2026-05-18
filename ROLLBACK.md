# Paperclip Fork Sync Rollback Plan

**Date**: 2026-04-30
**Operation**: Sync `fork/master` from upstream `origin/master` (paperclipai/paperclip)

## Pre-sync SHAs (rollback anchors)

| Ref | SHA |
|-----|-----|
| fork/master            | f701c3e78c1164be7a4acd7a4c3dafd526d420d8 |
| origin/master          | ad5432feced3644439e1690c5fbbb8a10902ee3b |
| local master           | b9a80dcf226c50c8778a70443e41557980376a03 |
| feat/manifest-model-prefix-skip | 15abd0e22b2dd5f71ccade049e37fa434262c018 |
| feat/bulk-company-agent-pause-resume | 22a7b6196474e9953537c5e8fc777bb6eb028fa4 |

## Backup refs created

Tags pushed to `fork`:
- `backup/pre-sync-fork-master-2026-04-30` → f701c3e7
- `backup/pre-sync-local-master-2026-04-30` → b9a80dcf
- `backup/pre-sync-feat-bulk-2026-04-30` → 22a7b619
- `backup/pre-sync-feat-manifest-2026-04-30` → 15abd0e2

Ancestry verified clean linear: `fork/master` → `local master` (+4) → `origin/master` (+97).

## Rollback procedure

If sync produces unexpected state, restore fork/master:

```bash
cd /Users/nicholasrhodes/Development/paperclip-temp
git fetch fork --tags
git checkout master
git reset --hard f701c3e78c1164be7a4acd7a4c3dafd526d420d8
git push fork master --force-with-lease
```

To restore feature branches:
```bash
git checkout feat/manifest-model-prefix-skip
git reset --hard 15abd0e22b2dd5f71ccade049e37fa434262c018
git checkout feat/bulk-company-agent-pause-resume
git reset --hard 22a7b6196474e9953537c5e8fc777bb6eb028fa4
```

Backup tags persist on `fork` remote; do not delete until sync verified.
