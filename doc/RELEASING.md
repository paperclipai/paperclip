# Releasing Paperclip

Maintainer runbook for shipping a full Paperclip release across npm, GitHub, and the website-facing changelog surface.

This document is intentionally practical:

- TL;DR command sequences are at the top.
- Detailed checklists come next.
- Motivation, failure handling, and rollback playbooks follow after that.

## Release Surfaces

Every Paperclip release has four separate surfaces:

1. **Verification** — the exact git SHA must pass typecheck, tests, and build.
2. **npm** — `paperclipai` and the public workspace packages are published.
3. **GitHub** — the stable release gets a git tag and a GitHub Release.
4. **Website / announcements** — the stable changelog is published externally and announced.

Treat those as related but separate. npm can succeed while the GitHub Release is still pending. GitHub can be correct while the website changelog is stale. A maintainer release is done only when all four surfaces are handled.

## TL;DR

### Canary release

Use this when you want an installable prerelease without changing `latest`.

```bash
# 0. Start clean
git status --short

# 1. Verify the candidate SHA
pnpm -r typecheck
pnpm test:run
pnpm build

# 2. Draft or update the stable changelog
#    releases/vX.Y.Z.md

# 3. Preview the canary release
./scripts/release.sh patch --canary --dry-run

# 4. Publish the canary
./scripts/release.sh patch --canary

# 5. Smoke test what users will actually install
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh

# Users install with:
npx paperclipai@canary onboard
```

Result:

- npm gets a prerelease such as `1.2.3-canary.0` under dist-tag `canary`
- `latest` is unchanged
- no git tag is created
- no GitHub Release is created
- the working tree returns to clean after the script finishes

### Stable release

Use this only after the canary SHA is good enough to become the public default.

```bash
# 0. Start from the vetted commit
git checkout master
git pull
git status --short

# 1. Verify again on the exact release SHA
pnpm -r typecheck
pnpm test:run
pnpm build

# 2. Confirm the stable changelog exists
ls releases/v*.md

# 3. Preview the stable publish
./scripts/release.sh patch --dry-run

# 4. Publish the stable release to npm and create the local release commit + tag
./scripts/release.sh patch

# 5. Push the release commit and tag
git push origin HEAD:master --follow-tags

# 6. Create or update the GitHub Release from the pushed tag
./scripts/create-github-release.sh X.Y.Z
```

Result:

- npm gets stable `X.Y.Z` under dist-tag `latest`
- a local git commit and tag `vX.Y.Z` are created
- after push, GitHub gets the matching Release
- the website and announcement steps still need to be handled manually

### Emergency rollback

If `latest` is broken after publish, repoint it to the last known good stable version first, then work on the fix.

```bash
# Preview
./scripts/rollback-latest.sh X.Y.Z --dry-run

# Roll back latest for every public package
./scripts/rollback-latest.sh X.Y.Z
```

This does **not** unpublish anything. It only moves the `latest` dist-tag back to the last good stable release.

### GitHub Actions release

There is also a manual workflow at [`.github/workflows/release.yml`](../.github/workflows/release.yml). It is designed for npm trusted publishing via GitHub OIDC instead of long-lived npm tokens.

Use it from the Actions tab:

1. Choose `Release`
2. Choose `channel`: `canary` or `stable`
3. Choose `bump`: `patch`, `minor`, or `major`
4. Choose whether this is a `dry_run`
5. Run it from `master`

The workflow:

- reruns `typecheck`, `test:run`, and `build`
- gates publish behind the `npm-release` environment
- can publish canaries without touching `latest`
- can publish stable, push the release commit and tag, and create the GitHub Release

## Release Checklist

### Before any publish

- [ ] The working tree is clean, including untracked files
- [ ] The target branch and SHA are the ones you actually want to release
- [ ] The required verification gate passed on that exact SHA
- [ ] The bump type is correct for the user-visible impact
- [ ] The stable changelog file exists or is ready to be written at `releases/vX.Y.Z.md`
- [ ] You know which previous stable version you would roll back to if needed

### Before a canary

- [ ] You are intentionally testing something that should be installable before it becomes default
- [ ] You are comfortable with users installing it via `npx paperclipai@canary onboard`
- [ ] You understand that each canary is a new immutable npm version such as `1.2.3-canary.1`

### Before a stable

- [ ] The candidate has already passed smoke testing
- [ ] The changelog should be the stable version only, for example `v1.2.3`
- [ ] You are ready to push the release commit and tag immediately after npm publish
- [ ] You are ready to create the GitHub Release immediately after the push
- [ ] You have a post-release website / announcement plan

### After a stable

- [ ] `npm view paperclipai@latest version` matches the new stable version
- [ ] The git tag exists on GitHub
- [ ] The GitHub Release exists and uses `releases/vX.Y.Z.md`
- [ ] The website changelog is updated
- [ ] Any announcement copy matches the shipped release, not the canary

## Verification Gate

The repository standard is:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

This matches [`.github/workflows/pr-verify.yml`](../.github/workflows/pr-verify.yml). Run it before claiming a release candidate is ready.

## Versioning Policy

### Stable versions

Stable releases use normal semver:

- `patch` for bug fixes
- `minor` for additive features, endpoints, and additive migrations
- `major` for destructive migrations, removed APIs, or other breaking behavior

### Canary versions

Canaries are semver prereleases of the **intended stable version**:

- `1.2.3-canary.0`
- `1.2.3-canary.1`
- `1.2.3-canary.2`

That gives you three useful properties:

1. Users can install the prerelease explicitly with `@canary`
2. `latest` stays safe
3. The stable changelog can remain just `v1.2.3`

We do **not** create separate changelog files for canary versions.

## Changelog Policy

The maintainer changelog source of truth is:

- `releases/vX.Y.Z.md`

That file is for the eventual stable release. It should not include `-canary` in the filename or heading.

Recommended structure:

- `Breaking Changes` when needed
- `Highlights`
- `Improvements`
- `Fixes`
- `Upgrade Guide` when needed

Package-level `CHANGELOG.md` files are generated as part of the release mechanics. They are not the main release narrative.

## Detailed Workflow

### 1. Decide the bump

Review the range since the last stable tag:

```bash
LAST_TAG=$(git tag --list 'v*' --sort=-version:refname | head -1)
git log "${LAST_TAG}..HEAD" --oneline --no-merges
git diff --name-only "${LAST_TAG}..HEAD" -- packages/db/src/migrations/
git diff "${LAST_TAG}..HEAD" -- packages/db/src/schema/
git log "${LAST_TAG}..HEAD" --format="%s" | grep -E 'BREAKING CHANGE|BREAKING:|^[a-z]+!:' || true
```

Use the higher bump if there is any doubt.

### 2. Write the stable changelog first

Create or update:

```bash
releases/vX.Y.Z.md
```

This is deliberate. The release notes should describe the stable story, not the canary mechanics.

### 3. Publish one or more canaries

Run:

```bash
./scripts/release.sh <patch|minor|major> --canary
```

What the script does:

1. Verifies the working tree is clean
2. Computes the intended stable version from the last stable tag
3. Computes the next canary ordinal from npm
4. Versions the public packages to `X.Y.Z-canary.N`
5. Builds the workspace and publishable CLI
6. Publishes to npm under dist-tag `canary`
7. Cleans up the temporary versioning state so your branch returns to clean

This means the script is safe to repeat as many times as needed while iterating:

- `1.2.3-canary.0`
- `1.2.3-canary.1`
- `1.2.3-canary.2`

The target stable release can still remain `1.2.3`.

### 4. Smoke test the canary

Run the actual install path in Docker:

```bash
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```

Minimum checks:

- [ ] `npx paperclipai@canary onboard` installs
- [ ] onboarding completes without crashes
- [ ] the server boots
- [ ] the UI loads
- [ ] basic company creation and dashboard load work

### 5. Publish stable from the vetted commit

Once the candidate SHA is good, run the stable flow on that exact commit:

```bash
./scripts/release.sh <patch|minor|major>
```

What the script does:

1. Verifies the working tree is clean
2. Versions the public packages to the stable semver
3. Builds the workspace and CLI publish bundle
4. Publishes to npm under `latest`
5. Restores temporary publish artifacts
6. Creates the local release commit and git tag

What it does **not** do:

- it does not push for you
- it does not update the website
- it does not announce the release for you

### 6. Push the release and create the GitHub Release

After a stable publish succeeds:

```bash
git push origin HEAD:master --follow-tags
./scripts/create-github-release.sh X.Y.Z
```

The GitHub release notes come from:

- `releases/vX.Y.Z.md`

### 7. Complete the external surfaces

After GitHub is correct:

- publish the changelog on the website
- write the announcement copy
- ensure public docs and install guidance point to the stable version

## GitHub Actions and npm Trusted Publishing

If you want GitHub to own the actual npm publish, use [`.github/workflows/release.yml`](../.github/workflows/release.yml) together with npm trusted publishing.

Recommended setup:

1. Configure the GitHub Actions workflow as a trusted publisher for **every public package** on npm
2. Use the `npm-release` GitHub environment with required reviewers
3. Run stable publishes from `master` only
4. Keep the workflow manual via `workflow_dispatch`

Why this is the right shape:

- no long-lived npm token needs to live in GitHub secrets
- reviewers can approve the publish step at the environment gate
- the workflow reruns verification on the release SHA before publish
- stable and canary use the same mechanics

## Failure Playbooks

### If the canary fails before publish

Nothing shipped. Fix the code and rerun the canary workflow.

### If the canary publishes but the smoke test fails

Do **not** publish stable.

Instead:

1. Fix the issue
2. Publish another canary
3. Re-run smoke testing

The canary version number will increase, but the stable target version can remain the same.

### If the stable npm publish succeeds but push fails

This is a partial release. npm is already live.

Do this immediately:

1. Fix the git issue
2. Push the release commit and tag from the same checkout
3. Create the GitHub Release

Do **not** publish the same version again.

### If the stable release is bad after `latest` moves

Use the rollback script first:

```bash
./scripts/rollback-latest.sh <last-good-version>
```

Then:

1. open an incident note or maintainer comment
2. fix forward on a new patch release
3. update the changelog / release notes if the user-facing guidance changed

### If the GitHub Release is wrong

Edit it by re-running:

```bash
./scripts/create-github-release.sh X.Y.Z
```

This updates the release notes if the GitHub Release already exists.

### If the website changelog is wrong

Fix the website independently. Do not republish npm just to repair the website surface.

## Rollback Strategy

The default rollback strategy is **dist-tag rollback, then fix forward**.

Why:

- npm versions are immutable
- users need `npx paperclipai onboard` to recover quickly
- moving `latest` back is faster and safer than trying to delete history

Rollback procedure:

1. identify the last known good stable version
2. run `./scripts/rollback-latest.sh <version>`
3. verify `npm view paperclipai@latest version`
4. fix forward with a new stable release

## Scripts Reference

- [`scripts/release.sh`](../scripts/release.sh) — stable and canary npm publish flow
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh) — create or update the GitHub Release after push
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh) — repoint `latest` to the last good stable release
- [`scripts/docker-onboard-smoke.sh`](../scripts/docker-onboard-smoke.sh) — Docker smoke test for the installed CLI

## Related Docs

- [doc/PUBLISHING.md](PUBLISHING.md) — low-level npm build and packaging internals
- [skills/release/SKILL.md](../skills/release/SKILL.md) — agent release coordination workflow
- [skills/release-changelog/SKILL.md](../skills/release-changelog/SKILL.md) — stable changelog drafting workflow
