# Releasing Paperclip

Maintainer runbook for shipping a full Paperclip release across npm, GitHub, and the website-facing changelog surface.

The release model is branch-driven:

1. Start a release train on `release/X.Y.Z`
2. Draft the stable changelog on that branch
3. Publish one or more canaries from that branch
4. Publish stable from that same branch head
5. Push the branch commit and tag
6. Create the GitHub Release
7. Merge `release/X.Y.Z` back to `master` without squash or rebase

## Release Surfaces

Every release has four separate surfaces:

1. **Verification** — the exact git SHA passes typecheck, tests, and build
2. **npm** — `paperclipai` and public workspace packages are published
3. **GitHub** — the stable release gets a git tag and GitHub Release
4. **Website / announcements** — the stable changelog is published externally and announced

A release is done only when all four surfaces are handled.

## Core Invariants

- Canary and stable for `X.Y.Z` must come from the same `release/X.Y.Z` branch.
- The release scripts must run from the matching `release/X.Y.Z` branch.
- Once `vX.Y.Z` exists locally, on GitHub, or on npm, that release train is frozen.
- Do not squash-merge or rebase-merge a release branch PR back to `master`.
- The stable changelog is always `releases/vX.Y.Z.md`. Never create canary changelog files.

The reason for the merge rule is simple: the tag must keep pointing at the exact published commit. Squash or rebase breaks that property.

## TL;DR

### 1. Start the release train

Use this to compute the next version, create or resume the branch, create or resume a dedicated worktree, and push the branch to GitHub.

```bash
./scripts/release-start.sh patch
```

That script:

- fetches the release remote and tags
- computes the next stable version from the latest `v*` tag
- creates or resumes `release/X.Y.Z`
- creates or resumes a dedicated worktree
- pushes the branch to the remote by default
- refuses to reuse a frozen release train

### 2. Draft the stable changelog

From the release worktree:

```bash
VERSION=X.Y.Z
claude --print --output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-4-6 "Use the release-changelog skill to draft or update releases/v${VERSION}.md for Paperclip. Read doc/RELEASING.md and skills/release-changelog/SKILL.md, then generate the stable changelog for v${VERSION} from commits since the last stable tag. Do not create a canary changelog."
```

### 3. Verify and publish a canary

```bash
./scripts/release-preflight.sh canary patch
./scripts/release.sh patch --canary --dry-run
./scripts/release.sh patch --canary
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```

Users install canaries with:

```bash
npx paperclipai@canary onboard
```

### 4. Publish stable

```bash
./scripts/release-preflight.sh stable patch
./scripts/release.sh patch --dry-run
./scripts/release.sh patch
git push public-gh HEAD --follow-tags
./scripts/create-github-release.sh X.Y.Z
```

Then open a PR from `release/X.Y.Z` to `master` and merge without squash or rebase.

## Release Branches

Paperclip uses one release branch per target stable version:

- `release/0.3.0`
- `release/0.3.1`
- `release/1.0.0`

Do not create separate per-canary branches like `canary/0.3.0-1`. A canary is just a prerelease snapshot of the same stable train.

## Script Entry Points

- [`scripts/release-start.sh`](../scripts/release-start.sh) — create or resume the release train branch/worktree
- [`scripts/release-preflight.sh`](../scripts/release-preflight.sh) — validate branch, version plan, git/npm state, and verification gate
- [`scripts/release.sh`](../scripts/release.sh) — publish canary or stable from the release branch
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh) — create or update the GitHub Release after pushing the tag
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh) — repoint `latest` to the last good stable version

## Detailed Workflow

### 1. Start or resume the release train

Run:

```bash
./scripts/release-start.sh <patch|minor|major>
```

Useful options:

```bash
./scripts/release-start.sh patch --dry-run
./scripts/release-start.sh minor --worktree-dir ../paperclip-release-0.4.0
./scripts/release-start.sh patch --no-push
```

The script is intentionally idempotent:

- if `release/X.Y.Z` already exists locally, it reuses it
- if the branch already exists on the remote, it resumes it locally
- if the branch is already checked out in another worktree, it points you there
- if `vX.Y.Z` already exists locally, remotely, or on npm, it refuses to reuse that train

### 2. Write the stable changelog early

Create or update:

- `releases/vX.Y.Z.md`

That file is for the eventual stable release. It should not include `-canary` in the filename or heading.

Recommended structure:

- `Breaking Changes` when needed
- `Highlights`
- `Improvements`
- `Fixes`
- `Upgrade Guide` when needed
- `Contributors` — @-mention every contributor by GitHub username (no emails)

Package-level `CHANGELOG.md` files are generated as part of the release mechanics. They are not the main release narrative.

### 3. Run release preflight

From the `release/X.Y.Z` worktree:

```bash
./scripts/release-preflight.sh canary <patch|minor|major>
# or
./scripts/release-preflight.sh stable <patch|minor|major>
```

The preflight script now checks all of the following before it runs the verification gate:

- the worktree is clean, including untracked files
- the current branch matches the computed `release/X.Y.Z`
- the release train is not frozen
- the target version is still free on npm
- the target tag does not already exist locally or remotely
- whether the remote release branch already exists
- whether `releases/vX.Y.Z.md` is present

Then it runs:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

### 4. Publish one or more canaries

Run:

```bash
./scripts/release.sh <patch|minor|major> --canary --dry-run
./scripts/release.sh <patch|minor|major> --canary
```

Result:

- npm gets a prerelease such as `1.2.3-canary.0` under dist-tag `canary`
- `latest` is unchanged
- no git tag is created
- no GitHub Release is created
- the worktree returns to clean after the script finishes

Guardrails:

- the script refuses to run from the wrong branch
- the script refuses to publish from a frozen train
- the canary is always derived from the next stable version
- if the stable notes file is missing, the script warns before you forget it

Concrete example:

- if the latest stable is `0.2.7`, a patch canary targets `0.2.8-canary.0`
- `0.2.7-canary.N` is invalid because `0.2.7` is already stable

### 5. Smoke test the canary

Run the actual install path in Docker:

```bash
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```

Useful isolated variants:

```bash
HOST_PORT=3232 DATA_DIR=./data/release-smoke-canary PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
HOST_PORT=3233 DATA_DIR=./data/release-smoke-stable PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

If you want to exercise onboarding from the current committed ref instead of npm, use:

```bash
./scripts/clean-onboard-ref.sh
PAPERCLIP_PORT=3234 ./scripts/clean-onboard-ref.sh
./scripts/clean-onboard-ref.sh HEAD
```

Minimum checks:

- `npx paperclipai@canary onboard` installs
- onboarding completes without crashes
- the server boots
- the UI loads
- basic company creation and dashboard load work

If smoke testing fails:

1. stop the stable release
2. fix the issue on the same `release/X.Y.Z` branch
3. publish another canary
4. rerun smoke testing

### 6. Publish stable from the same release branch

Once the branch head is vetted, run:

```bash
./scripts/release.sh <patch|minor|major> --dry-run
./scripts/release.sh <patch|minor|major>
```

Stable publish:

- publishes `X.Y.Z` to npm under `latest`
- creates the local release commit
- creates the local tag `vX.Y.Z`

Stable publish refuses to proceed if:

- the current branch is not `release/X.Y.Z`
- the remote release branch does not exist yet
- the stable notes file is missing
- the target tag already exists locally or remotely
- the stable version already exists on npm

Those checks intentionally freeze the train after stable publish.

### 7. Push the stable branch commit and tag

After stable publish succeeds:

```bash
git push public-gh HEAD --follow-tags
./scripts/create-github-release.sh X.Y.Z
```

The GitHub Release notes come from:

- `releases/vX.Y.Z.md`

### 8. Merge the release branch back to `master`

Open a PR:

- base: `master`
- head: `release/X.Y.Z`

Merge rule:

- allowed: merge commit or fast-forward
- forbidden: squash merge
- forbidden: rebase merge

Post-merge verification:

```bash
git fetch public-gh --tags
git merge-base --is-ancestor "vX.Y.Z" "public-gh/master"
```

That command must succeed. If it fails, the published tagged commit is not reachable from `master`, which means the merge strategy was wrong.

### 9. Finish the external surfaces

After GitHub is correct:

- publish the changelog on the website
- write and send the announcement copy
- ensure public docs and install guidance point to the stable version

## GitHub Actions Release

There is also a manual workflow at [`.github/workflows/release.yml`](../.github/workflows/release.yml).

Use it from the Actions tab on the relevant `release/X.Y.Z` branch:

1. Choose `Release`
2. Choose `channel`: `canary` or `stable`
3. Choose `bump`: `patch`, `minor`, or `major`
4. Choose whether this is a `dry_run`
5. Run it from the release branch, not from `master`

The workflow:

- reruns `typecheck`, `test:run`, and `build`
- gates publish behind the `npm-release` environment
- can publish canaries without touching `latest`
- can publish stable, push the stable branch commit and tag, and create the GitHub Release

It does not merge the release branch back to `master` for you.

## Release Checklist

### Before any publish

- [ ] The release train exists on `release/X.Y.Z`
- [ ] The working tree is clean, including untracked files
- [ ] If package manifests changed, the CI-owned `pnpm-lock.yaml` refresh is already merged on `master` before the train is cut
- [ ] The required verification gate passed on the exact branch head you want to publish
- [ ] The bump type is correct for the user-visible impact
- [ ] The stable changelog file exists or is ready at `releases/vX.Y.Z.md`
- [ ] You know which previous stable version you would roll back to if needed

### Before a stable

- [ ] The candidate has already passed smoke testing
- [ ] The remote `release/X.Y.Z` branch exists
- [ ] You are ready to push the stable branch commit and tag immediately after npm publish
- [ ] You are ready to create the GitHub Release immediately after the push
- [ ] You are ready to open the PR back to `master`

### After a stable

- [ ] `npm view paperclipai@latest version` matches the new stable version
- [ ] The git tag exists on GitHub
- [ ] The GitHub Release exists and uses `releases/vX.Y.Z.md`
- [ ] `vX.Y.Z` is reachable from `master`
- [ ] The website changelog is updated
- [ ] Announcement copy matches the stable release, not the canary

## Failure Playbooks

### If the canary publishes but the smoke test fails

Do not publish stable.

Instead:

1. fix the issue on `release/X.Y.Z`
2. publish another canary
3. rerun smoke testing

### If stable npm publish succeeds but push or GitHub release creation fails

This is a partial release. npm is already live.

Do this immediately:

1. fix the git or GitHub issue from the same checkout
2. push the stable branch commit and tag
3. create the GitHub Release

Do not republish the same version.

### If `latest` is broken after stable publish

Preview:

```bash
./scripts/rollback-latest.sh X.Y.Z --dry-run
```

Roll back:

```bash
./scripts/rollback-latest.sh X.Y.Z
```

This does not unpublish anything. It only moves the `latest` dist-tag back to the last good stable release.

Then fix forward with a new patch release.

### If the GitHub Release notes are wrong

Re-run:

```bash
./scripts/create-github-release.sh X.Y.Z
```

If the release already exists, the script updates it.

## Related Docs

- [doc/PUBLISHING.md](PUBLISHING.md) — low-level npm build and packaging internals
- [skills/release/SKILL.md](../skills/release/SKILL.md) — agent release coordination workflow
- [skills/release-changelog/SKILL.md](../skills/release-changelog/SKILL.md) — stable changelog drafting workflow
