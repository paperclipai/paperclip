---
title: On-Disk File Layout
summary: Where Paperclip stores data, runtime scratch, and per-user state on disk
---

Paperclip writes to two parallel "homes" by design: a **repo-scoped instance home** for the running server's data and runtime artifacts, and a **user-scoped home** for CLI/dev-runner state. This page maps every Paperclip-adjacent folder so it's clear which are authoritative, which are scratch, and which are stale.

## TL;DR

- Authoritative data: embedded Postgres at `<instance-home>/db/`. Nothing else on disk is a source of truth.
- Folders named after companies or agents (e.g. `companies/<companyId>/`, `workspaces/<agentId>/`) are **runtime scratch** keyed by UUID — adding or removing them by hand does not create or delete records.
- The legacy `services/paperclip/companies/` directory in the repo checkout is unrelated old scratch and is not read by the server.

## Roots

### 1. `<instance-home>/` — primary runtime home (authoritative)

The instance home is either repo-scoped (`<repo>/.paperclip-home/instances/<instance>/`) or user-scoped (`~/.paperclip/instances/<instance>/`), depending on the workspace strategy chosen at onboarding. Everything the server reads and writes for a running instance lives here.

| Path | Purpose | Authoritative? |
|---|---|---|
| `db/` | Embedded Postgres data dir | **Yes — source of truth** |
| `data/backups/` | Hourly Postgres dumps (default 30-day retention) | Derived |
| `data/storage/` | Blob/attachment bytes when `storage.provider = local_disk` | **Yes** |
| `data/run-logs/` | Per-heartbeat run transcripts and structured logs | Derived |
| `logs/` | Server process logs | Derived |
| `secrets/master.key` | Local encryption key for secret values stored in the DB | **Yes — back this up** |
| `config.json` | Instance config: ports, storage provider, backup policy | **Yes** |
| `companies/<companyId>/` | Per-company adapter scratch (e.g. `claude-prompt-cache/`, `agents/`) | Scratch |
| `workspaces/<agentId>/` | Per-agent git worktree where the agent does code work | Scratch (regenerable from git) |
| `projects/<companyId>/<projectId>/` | Per-project scratch | Scratch |
| `runtime-services/` | Worker/runtime-service state | Scratch |
| `telemetry/` | Local telemetry spool | Scratch |
| `_trash/{projects,companies}/` | Quarantine for orphaned scratch awaiting final deletion (see "Stale state") | Scratch |

If you need to inspect, move, or remove a company, use the API or CLI — not the disk. Renaming the UUID-named folders desyncs the cache without changing the DB.

### 2. `~/.paperclip/instances/<instance>/` — user-scoped state

This exists even when the instance home is repo-scoped, because the CLI and dev-runner write user-level state regardless of which checkout you're in. Typical contents:

| Path | Purpose |
|---|---|
| `runtime-services/paperclip-dev-*.json` | Dev-runner pid/port/process-group bookkeeping so `pnpm dev` can reuse or restart watch processes |
| `telemetry/state.json` | Anonymous install ID + salt |
| `projects/<companyId>/<projectId>/...` | Old per-project scratch (see "Stale state" below) |

This is **not** a second copy of the database. It's separate state owned by the CLI/dev-runner.

### 3. `~/.paperclip-worktrees/instances/<instance>/<branch-or-ticket-slug>/` — ticket worktrees

Created when an agent needs an isolated worktree for a long-running ticket. Folder names are branch/ticket slugs (e.g. `pap-552-install-without-moved-symlinks`).

These are **auto-pruned** when the corresponding branch no longer exists locally or on any remote (typical signal: branch merged and deleted). The sweep runs on the primary checkout's server heartbeat (default: hourly, gated by `PAPERCLIP_WORKTREE_AUTOPRUNE_INTERVAL_MS`) and only inspects directories at least one hour old whose embedded postgres is not running. Set `PAPERCLIP_WORKTREE_AUTOPRUNE=false` to disable. Run `paperclipai worktree:gc --dry-run` to preview, or `paperclipai worktree:gc` to prune on demand (use `--force` to bypass uncommitted-change checks in the linked checkout).

### 4. Repo-root untracked dirs

The following are local-only dev scratch and **not** part of Paperclip runtime state:

- `services/paperclip/companies/` — legacy research bundles from a pre-DB workflow. Untracked, not read by the server.
- `services/paperclip/state/`, `services/paperclip/temp/`, `custom-skills/` — local dev scratch.

## Stale state

These folders are scratch and safe to delete:

- `<instance-home>/projects/<companyId>/` and `<instance-home>/companies/<companyId>/` where `<companyId>` is no longer present in the DB. Happens when a company is deleted or re-imported under a new UUID. **Auto-collected**: the server runs a daily sweep on startup and at `PAPERCLIP_PROJECTS_GC_INTERVAL_HOURS` (default 24h), moving orphans to `<instance-home>/_trash/{projects,companies}/<companyId>-<timestamp>/`. Quarantined entries older than `PAPERCLIP_PROJECTS_GC_RETENTION_DAYS` (default 14d) are then permanently deleted. Set `PAPERCLIP_PROJECTS_GC_ENABLED=false` to disable.
- `~/.paperclip-worktrees/instances/<instance>/<slug>/` for branches/tickets that are merged and gone. **Auto-collected**: the primary instance's heartbeat sweeps these (gated by `PAPERCLIP_WORKTREE_AUTOPRUNE`).
- `services/paperclip/companies/` in older checkouts. Not read by the server.

Manual GC commands:

- `paperclipai projects:gc [--apply] [--retention-days <n>]` — preview (default) or apply the same scan the server's auto-sweep runs: quarantine orphaned project & company scratch into `_trash/`, then delete trash older than the retention window.
- `paperclipai worktree:gc [--dry-run] [--force]` — list / delete orphaned worktree instance directories under `~/.paperclip-worktrees/`.

## Cheat sheet

| You want… | Where to look |
|---|---|
| List of all companies | API: `GET /api/companies` (DB-backed) |
| An issue's content, comments, attachment metadata | Postgres (via API), not disk |
| Raw attachment bytes | `<instance-home>/data/storage/` |
| An agent's working git worktree | `<instance-home>/workspaces/<agentId>/` |
| Adapter prompt cache for a company | `<instance-home>/companies/<companyId>/claude-prompt-cache/` |
| Server logs / run transcripts | `<instance-home>/logs/` + `data/run-logs/` |
| Instance config (ports, storage, backups) | `<instance-home>/config.json` |
| Encryption key for secrets in the DB | `<instance-home>/secrets/master.key` |

See also: [Storage](./storage.md), [Database](./database.md), [Secrets](./secrets.md).
