# Janitor Dry-Run Checklist

Use this checklist before every cleanup run. The Janitor must produce a dry-run manifest before deleting anything.

## Preflight

Record:

- Current timestamp
- Host/container name
- Paperclip instance root
- Company ID if available
- Janitor agent ID
- Disk usage for `/paperclip`
- Disk usage for `/tmp`

Suggested commands:

```bash
date -Is
hostname || true
df -h /paperclip 2>/dev/null || true
df -h /tmp 2>/dev/null || true
```

## Active Run Check

List active heartbeat runs and treat any `pending` or `running` run as protected.

If the CLI/API cannot list active runs, do not prune workspaces or lock files. Temp dirs older than retention may still be pruned if they are scoped and ownerless.

## Candidate Manifest

Create a manifest with these sections:

```text
janitor-manifest-<timestamp>/
  preflight.txt
  active-runs.json
  stale-heartbeat-artifacts.json
  orphaned-workspaces.txt
  stale-temp-dirs.txt
  stale-locks.txt
  oversized-workspaces.txt
  skipped.txt
```

The manifest must be written before cleanup. Prefer `/tmp/paperclip-janitor-<timestamp>/` for runtime manifests.

## Required Safety Gates

Before pruning a candidate, confirm:

- It is under an allowed cleanup path
- It is not a symlink, or symlink handling is explicitly safe and non-following
- It is older than the retention window
- It is not associated with a current active run
- It is not a parent/root directory
- Size calculation completed or failed safely

## Skip Conditions

Skip and report if:

- Candidate path is empty
- Candidate path is `/`, `/tmp`, `/paperclip`, or another root-like parent
- Candidate path contains `..`
- Candidate path is outside the allowlist
- Ownership cannot be determined
- Active run state cannot be checked for workspace/lock cleanup
- The command needed for safe API-backed cleanup does not exist
