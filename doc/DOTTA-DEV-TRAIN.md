# Dotta development PR train

The Dotta development PR train builds a disposable assembly branch named
`dev/dotta`. It starts from the current `origin/master` and adds each open pull
request that has the `dotta-dev` label.

> Never base a branch on `dev/dotta`. Every pull request must start from master
> and target master. The train branch is force-updated and can change at any
> time.

The train script only assembles and pushes a Git branch. It does not build or
deploy Paperclip. The separate deploy script described below owns the mandatory
database backup, production build, application swap, service restart, and smoke
check.

## Prerequisites

Install `git`, the GitHub CLI (`gh`), and `jq`. Authenticate `gh` with an account
that can manage labels and push the `dev/dotta` branch in
`paperclipai/paperclip`.

The normal train run creates or updates the label. You can also create it before
the first run:

```sh
gh label create dotta-dev \
  --repo paperclipai/paperclip \
  --color 7B61FF \
  --description "Include this PR in the disposable dev/dotta assembly branch" \
  --force
```

## Put a pull request on the train

Add the label to an open pull request that targets master:

```sh
gh pr edit <number> --repo paperclipai/paperclip --add-label dotta-dev
```

The train reads the current PR head each time. Push new commits to the PR branch,
then run the train again to include them.

## Run the train

Start from a clean Paperclip worktree:

```sh
scripts/dotta-dev-train.sh
```

The script performs these steps:

1. Create or update the `dotta-dev` label.
2. List open labeled PRs and sort them by PR number.
3. Fetch `origin` and reset local `dev/dotta` to `origin/master`.
4. Fetch and merge each PR head with `git merge --no-ff`.
5. Abort and skip a PR when its merge conflicts. The script does not resolve a
   conflict.
6. Write the manifest.
7. Push `dev/dotta` with `--force-with-lease`.

Use a dry run to build the local branch and manifest without changing the label
or pushing the train branch:

```sh
scripts/dotta-dev-train.sh --dry-run
```

The default manifest path is `.paperclip/dotta-dev-manifest.json`. Use a custom
path when another process needs the file:

```sh
scripts/dotta-dev-train.sh --manifest /path/to/dotta-dev-manifest.json
```

## Read the manifest

The manifest records:

- `schemaVersion` and `generatedBy`: identify a manifest that the train may
  safely replace on a later run.
- `baseMasterSha`: the exact `origin/master` commit used as the base.
- `trainCommitSha`: the exact assembled `dev/dotta` commit. The deploy refuses
  a manifest whose value does not equal the source ref.
- `included`: the PR number, head SHA, title, and migration flag for each merged
  PR.
- `skipped`: the same PR data plus the reason it was skipped.
- `dryRun`: whether the run omitted the remote update.

`migrations` is `true` when a PR changes a file below
`packages/db/src/migrations/`. Treat that flag as a deployment warning, not as
permission to apply the migration.

The command also prints the included and skipped lists for a quick operator
check.

The script refuses to overwrite a tracked manifest path, a symlink, or an
existing file that is not a prior train manifest. Remove or choose another path
instead of reusing an operator-owned file. A manifest from a successful train
run can be reused on later runs.

## Merge a pull request upstream

Review and merge the individual pull request into master through the normal
GitHub flow. Then run the train again. The merged PR is no longer open, so it
falls out of the train. Other labeled PRs remain.

Do not merge `dev/dotta` into master. The individual pull requests are the
upstream units.

## Roll back a pull request from the train

Remove its label and run the train again:

```sh
gh pr edit <number> --repo paperclipai/paperclip --remove-label dotta-dev
scripts/dotta-dev-train.sh
```

This removes the PR code from the rebuilt branch. It does not undo external
effects from an earlier deployment.

## Migration risk

An unmerged migration can change a real database after deployment. Removing the
label or rebuilding the branch does not reverse an applied migration. Back up
the database before a later deployment step, merge migration PRs upstream
quickly, and follow the normal migration recovery procedure when a rollback is
required. Train assembly itself never applies migrations.

## Deploy the assembled train

Run the train first and keep its manifest. A real deploy consumes the pushed
`origin/dev/dotta` ref and refuses a manifest produced by a train dry run:

```sh
scripts/dotta-dev-train.sh
# PAPERCLIP_API_KEY must be set for full health details in authenticated mode.
scripts/dotta-dev-deploy.sh \
  --manifest .paperclip/dotta-dev-manifest.json
```

Pass `PAPERCLIP_API_KEY` only through the environment. The deploy script does
not print or persist it. A board API key or another bearer accepted by the live
instance can be used. The authenticated health response is required because the
final smoke check compares the running `serverVersion` with the new stamp.

The deploy order is fixed and fail-closed:

1. Run `scripts/backup-db.sh` into the live instance backup directory. The
   deploy stops unless that invocation creates a new, non-empty
   `dotta-dev-deploy-*.sql.gz` file.
2. Fetch and archive `origin/dev/dotta` into a new staging directory, install
   dependencies, and run the production build.
3. Write `.paperclip-build-version` with every included PR number and the full
   SHA-256 of the train manifest. The same manifest and source commit are copied
   into the staged application for inspection.
4. Move the old `/srv/paperclip/app` aside, move the stage into place, request
   a guarded hot restart, and restart `paperclip.service`.
5. Require a new service PID, an `ok` health response carrying the exact version
   stamp, and a hot-restart report for the same old and new PIDs, the current
   restart window, and no lost runs.

If a failure happens after the directory swap, the script restores the previous
application directory and restarts the service. It deliberately does not
restore the database automatically: the operator must first determine whether
a migration ran and whether restoring data is safe.

The version is visible in the existing account-menu version display and in the
authenticated `/api/health` response. Its form is:

```text
dotta-dev.prs-<PR numbers>.manifest-sha256-<full manifest hash>.git-<source SHA>
```

### Scratch verification

Dry-run mode still invokes and verifies a backup, builds `dev/dotta`, swaps an
existing scratch application directory, and checks the deployed files. It
requires explicit scratch paths and refuses `/srv/paperclip/app`; it never calls
`systemctl`:

```sh
scratch="$(mktemp -d)"
mkdir -p "$scratch/app"
scripts/dotta-dev-deploy.sh \
  --dry-run \
  --source-ref dev/dotta \
  --manifest /path/to/dry-run-manifest.json \
  --app-dir "$scratch/app" \
  --stage-dir "$scratch/stage" \
  --backup-dir "$scratch/backups"
```

Use an isolated Paperclip instance whose database is running for this command;
the backup remains mandatory in scratch mode.

## Roll back deployed train code

To remove one PR from the running train, remove its label, rebuild the train,
and deploy again:

```sh
gh pr edit <number> --repo paperclipai/paperclip --remove-label dotta-dev
scripts/dotta-dev-train.sh
scripts/dotta-dev-deploy.sh --manifest .paperclip/dotta-dev-manifest.json
```

This is the normal rollback path. It restores the code shape without creating a
reverse commit, and the new version stamp proves that the PR is absent.

Removing code does not undo a database migration. If the removed PR changed the
database and the live data is damaged, stop further writes and use the fresh
backup path printed by the deploy as the escape hatch. Database restoration is
a separate, coordinated recovery operation: preserve the failed application and
current database, confirm the matching backup and secrets key are available,
restore the database with the supported Paperclip recovery procedure, then
deploy the rebuilt train and repeat the health/version smoke. Do not improvise a
raw database restore while the service is writing.

## Conflicts and stale heads

The script skips a PR when it conflicts with the assembled branch and lists the
conflicting files in the manifest. Resolve the conflict on the PR branch against
master or coordinate the dependent PRs, then run the train again.

The script also skips a PR when the fetched head does not match the SHA returned
by GitHub. This can happen when a new commit arrives during assembly. Run the
train again to use one consistent head.
