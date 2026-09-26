---
title: "Auditing execution workspace paths"
description: "Check that every execution workspace still points at a directory that can host its run, and read the three ways a workspace path fails."
---

An execution workspace stores two things that have to agree: the id of the
project workspace it belongs to, and the `cwd` the adapter will launch from.
Nothing in the data model forces them to describe the same folder. When they
drift apart the run dies before it starts, and the error it leaves behind
describes the folder it landed in rather than the one it asked for.

## Run the audit

```bash
pnpm workspaces:check
```

It reads `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and `PAPERCLIP_COMPANY_ID`,
calls `GET /api/companies/{companyId}/execution-workspaces` and
`GET /api/projects/{projectId}/workspaces`, and writes nothing. Exit code 0
means clean, 1 means findings, 2 means the audit could not run.

```
Audited 11763 execution workspaces across 10 projects.
3601 run in a Paperclip-managed default folder (no declared project workspace); not held to a git bar.
No problems found.
```

That is the real output on the Lunaria instance, 2026-09-19, after the repair
described below. Add `--json` for machine-readable findings, `--limit N` to
widen how many offenders are printed per class.

**Do not wire this as a recurring in-product check.** Almost every tick is a
no-op, and a no-op tick still costs a full agent run. Run it by hand after a
bulk path change, or from a shell job that only speaks when it is red.

## What it looks for

| Finding | Meaning |
| --- | --- |
| `sibling_cwd` | The row names project workspace X but its `cwd` is project workspace Y's, on the same project. This is the cause; the rest are usually its symptoms. |
| `missing_workspace_path` | The `cwd` does not exist. |
| `workspace_volume_not_mounted` | The `cwd`, or a symlink it goes through, lives under a `/Volumes/<disk>` mount point that is not mounted. |
| `missing_git_metadata` | The `cwd` exists, its volume is mounted, and it genuinely has no `.git`. Only raised when the linked project workspace is a `git_repo`. |

Execution workspaces whose project declares no workspace at all are skipped.
Those run in a Paperclip-managed `_default` folder and are non-git by design;
holding them to a git bar would bury real findings under thousands of false
ones.

## The three failure messages, and why they are three

A run that requires git and cannot get it now says which of the three happened:

```
… but "/Users/x/dev/repo" does not exist.
… but "/Users/x/dev/repo" is on external volume "/Volumes/SSD", which is not mounted.
… but "/Users/x/assets" has no .git metadata.
```

They used to be one message — the third one — for all three causes. An external
disk that had been unplugged reported a repository problem, so the reader went
looking for a broken checkout that was never broken.

The unmounted-volume case matters more than it looks, because a checkout is
often reached through a symlink: `~/dev/<repo>` pointing at
`/Volumes/<disk>/dev/<repo>`. The entry point still exists as a link while the
whole target subtree is gone, and only the link's target names the disk. The
classifier walks the symlink chain by hand for exactly this reason — `realpath`
throws on a link whose target is missing, which is the case being diagnosed.

## Why a repository-level sweep does not catch this

Running `git rev-parse` across every checkout on the box comes back green while
runs keep dying, because the checkouts are fine. The broken thing is a row that
points at the wrong one of them. The only control that sees it compares an
execution workspace's `cwd` against the project workspace its own row names,
which is what this audit does.

## Reference incident

On 2026-09-19 thirteen execution workspaces were created carrying the id of a
`git_repo` project workspace and the `cwd` of that project's other workspace, a
`non_git_path` assets folder. The anchor resolver, unable to materialize the
named workspace, had fallen through to the first sibling whose folder happened
to exist, and returned that sibling's `cwd` while the row kept the named
workspace's id. Two runs died before starting on `has no .git metadata`,
pointing at a folder nobody had asked for.

The resolver no longer does this: a run that names a project workspace elects
that workspace or nothing, and a `non_git_path` workspace never wins an implicit
election while a repository workspace is available. See
`selectAnchorWorkspaceCandidatesForRun` in `server/src/services/heartbeat.ts`.
