---
title: Parallel Agent Workflow
summary: Source boundaries for concurrent agent work
---

# Parallel Agent Workflow

Parallel work is safe only when each agent owns a clear source boundary and leaves receipts that another reviewer can verify.

## Start of Work

Run the repo surface checks before editing:

```sh
pwd
git rev-parse --show-toplevel
git status --short --branch
```

Then write down the paths you own for the issue. Owned paths should be narrow: specific files when possible, directories only when the issue actually requires them.

## Dirty Worktree Rules

- Pre-existing dirty files are not yours by default.
- Do not revert, format, stage, or commit unrelated dirty files.
- If a dirty file overlaps your owned path, inspect it first with `git diff -- <path>` and decide whether the issue can still proceed safely.
- If the overlap changes behavior you must rely on, report the conflict in the issue and name the owner/action needed.

## Handoff Receipt

Every handoff comment should include:

- Owned paths changed.
- Validation commands run and whether they passed.
- Checks not run and why.
- Any dirty-worktree files intentionally left untouched.

Do not claim that a service, host, runtime, preview URL, or deployment is healthy unless you ran a command that directly checked it.
