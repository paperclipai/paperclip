---
name: forgejo-actions
description: Inspect and drive Forgejo Actions CI on forgejo.big.netlobo.com with fj-ex — list runs and jobs, stream logs, download artifacts, cancel or rerun runs, and trigger workflow_dispatch. Forgejo CI only; use gh for GitHub.
---

# Forgejo Actions (fj-ex)

`fj-ex` extends `fj` with Forgejo Actions operations that require web-UI endpoints: full run/job logs, artifacts, cancel/rerun, and workflow dispatch. It runs alongside `fj`.

## Authentication and host

`fj-ex` infers the host from the current repo's git remotes, or falls back to `$FJ_FALLBACK_HOST`. Bind `FJ_FALLBACK_HOST=forgejo.big.netlobo.com` (or pass `--host`/`-H` per command).

```bash
fj-ex auth login --host forgejo.big.netlobo.com     # interactive, once; session persists
```

If login is unavailable, check that `FJ_FALLBACK_HOST` is bound and that the host matches a git remote in the current directory.

## Commands

```bash
# List recent workflow runs (filter by status, workflow, or --latest)
fj-ex actions runs --repo owner/name --latest
fj-ex actions runs --repo owner/name --status failed

# List jobs for a run, optionally --watch
fj-ex actions jobs --repo owner/name --latest

# Stream job logs to stdout (job index is 0-based)
fj-ex actions logs job --repo owner/name --latest --job-index 0

# Artifacts
fj-ex actions artifacts list --repo owner/name
fj-ex actions artifacts download --repo owner/name <artifact-name>

# Cancel / rerun — preview first with --dry-run
fj-ex actions cancel --repo owner/name --run-index 50 --dry-run
fj-ex actions rerun  --repo owner/name --latest --failed-only

# Dispatch a workflow_dispatch event
fj-ex actions trigger --repo owner/name

# Non-destructive end-to-end validation of the CLI against the host
fj-ex smoke-test
```

## Conventions

- `--repo`/`-r` targets `owner/name`; `--host`/`-H` targets the instance. Both can usually be inferred from the current git remote.
- Run indexes and job indexes are 0-based and are shown by `runs`/`jobs` respectively.
- Use `--dry-run` before any `cancel` or `rerun`.
- Downloaded logs and artifacts may contain secrets — treat them as sensitive, and do not write them into the repo or the transcript.

## When a check fails

1. `fj-ex actions runs --repo owner/name --latest` to find the run and its index.
2. `fj-ex actions jobs --repo owner/name --run-index <n>` to find the failing job.
3. `fj-ex actions logs job --repo owner/name --run-index <n> --job-index <j>` to read the failure.
4. Fix the cause, push, then `fj-ex actions rerun` (or wait for the push-triggered run) instead of re-triggering blindly.
