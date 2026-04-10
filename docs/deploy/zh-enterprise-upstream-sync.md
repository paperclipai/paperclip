---
title: zh-enterprise Upstream Sync
summary: Scheduled upstream replay and PR automation for the Chinese enterprise fork
---

This workflow pair keeps a `zh-enterprise` fork close to `paperclipai/paperclip` without pushing directly to the long-lived maintenance branch.

## Repository and remote model

The automation assumes two Git remotes with different roles:

- `origin`: your writable fork of Paperclip. GitHub Actions pushes `bot-upgrade/*` branches here and opens PRs here.
- `upstream`: the official `paperclipai/paperclip` repository. The workflow only fetches from this remote.

This split matters because the bot must be able to push upgrade branches somewhere safe, while `upstream` remains the read-only source of truth.

## Long-lived branches

Keep these branch roles stable:

- `zh-enterprise`: the reviewed integration branch for the Chinese enterprise fork.
- `bot-upgrade/*`: short-lived bot branches, one branch per upstream sync attempt.

The workflows never push directly to `zh-enterprise`.

## Token, secrets, and optional LLM configuration

### Required token assumptions

No extra secret is required if the repository-level Actions token is allowed to write to the fork.

The workflows assume the default `github.token` can:

- push `bot-upgrade/*` branches to the fork repository
- create and edit pull requests in that same fork
- upload workflow artifacts

If your repository policy downgrades the default token to read-only, grant GitHub Actions read/write repository permissions or swap the workflow to a write-capable repo token.

### Optional translation env vars

Low-risk translation writes stay optional. The workflow passes through these values when configured:

- `LLM_API_BASE` (recommended as a repository variable)
- `LLM_API_KEY` (recommended as a repository secret)
- `LLM_MODEL` (recommended as a repository variable)

If any of them are missing, upstream-sync still runs, but low-risk files stay in review-only mode instead of being auto-translated.

## Scheduled sync behavior

`.github/workflows/upstream-sync.yml` runs on a schedule and on `workflow_dispatch`.

Each scheduled run:

1. checks out the fork with full history
2. fetches `upstream/master` and `origin/zh-enterprise`
3. runs `pnpm sync:upstream`
4. uploads the generated JSON report, PR body, and validation log
5. if the CLI reports `ready_for_pr=true`, commits any remaining low-risk translation edits, pushes the bot branch, and creates or updates the PR

`no-op` runs stay green. Conflict, orchestration, and validation-failed runs upload artifacts first and then fail the workflow so maintainers notice them.

## Manual dry-run from GitHub Actions

Use **Actions → Upstream Sync → Run workflow** and enable the `dry_run` input.

Dry-run mode still fetches the refs, generates the report artifacts, and prints the workflow outputs, but it does not:

- push `bot-upgrade/*`
- commit translation edits
- create or update a PR

This is the safest way to inspect what the next sync would do.

## PR creation and update behavior

When upstream-sync returns `ready_for_pr=true`:

1. the workflow configures a bot git identity
2. stages remaining working-tree changes
3. excludes the generated `reports/` artifacts from the commit
4. commits low-risk translation/file-generation edits when they exist
5. pushes the bot branch to `origin`
6. creates a new PR to `zh-enterprise`, or updates the existing open PR for the same branch

The PR body always comes from the generated `pr_body_path` output.

## PR validation workflow

`.github/workflows/upstream-sync-pr.yml` runs on `pull_request` events that target `zh-enterprise`, but only executes for `bot-upgrade/*` source branches.

It installs dependencies and runs the same required checks used by upstream-sync:

- `pnpm --filter @paperclipai/ui typecheck`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm check:i18n`

The workflow also regenerates dry-run upstream-sync artifacts for the PR branch when possible, then uploads the report and validation log artifacts with `if: always()`.

## Maintainer playbook

### `no-op`

No new maintenance commits were discovered. No action is required.

### `conflict`

A replay conflict blocked the bot branch. Download the artifacts, inspect the conflict diagnostics, resolve the replay manually on a fresh branch, and open/update the PR yourself.

### `validation failure`

The replay completed, but one of the required checks failed. Review the uploaded validation log, fix the failing changes on the bot branch, and rerun the PR validation workflow.

### successful ready PR

Review the generated PR like any other upgrade PR. Check the replay summary, low-risk translation edits, manual-review items, and validation output before merging into `zh-enterprise`.

## Important note about low-risk translation edits

Low-risk translation changes are not separate maintenance commits inside the upstream-sync CLI. The discovery workflow commits those remaining working-tree edits right before pushing the bot branch so the PR contains the translated files together with the replayed maintenance stack.
