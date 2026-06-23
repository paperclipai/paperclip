# Workspace Hygiene

Repo roots should contain source code, tracked documentation, and intentionally ignored tool state only. Agent scratch files in the repo root make PR publication slower and increase the chance of unrelated files leaking into commits.

## Where Files Belong

| File type | Location |
| --- | --- |
| Temporary issue scripts | `.paperclip-local/scratch/<issue-id>/` |
| Command output used during investigation | `.paperclip-local/scratch/<issue-id>/` |
| Durable deliverables for board/reviewer inspection | Paperclip issue attachment or work product |
| Repo documentation | `doc/` or `docs/` |
| Repo automation scripts | `scripts/` |
| Test fixtures committed with code | nearest package test fixture directory |

## What May Stay in the Repo Root

- Standard tracked project files such as `package.json`, `pnpm-workspace.yaml`, `README.md`, `AGENTS.md`, and config files.
- Intentional ignored local runtime directories listed in `.gitignore`, such as `node_modules/`, `.paperclip/`, `.paperclip-local/`, and `.runtime-backups/`.

Anything else in the root should have a clear owner and reason, or it should be moved to a scratch/archive directory.

## Scratch Archive Convention

When cleaning old root-level agent output, move it to:

```text
.paperclip-local/scratch-archive/YYYY-MM-DD/<issue-or-category>/
```

Add a `MANIFEST.md` in that archive directory with:

- Cleanup date.
- Who moved the files.
- Why the files were moved.
- Whether they are safe to delete later.

Do not move files that belong to an active run or an active uncommitted change.

## Before Starting Work

Run:

```sh
git status --short
```

If unrelated untracked files are present, ignore them unless they block your task. For PR publication work, use a clean worktree instead of trying to reason around a cluttered shared checkout.

## Before Publishing a PR

Run:

```sh
scripts/check-pr-publication-readiness.sh --base <base-ref>
```

The script reports branch, status, commits ahead of base, tracked diff files, and untracked files. Do not push until the output matches the intended scope.
