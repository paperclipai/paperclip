# Releasing Paperclip

Maintainer runbook for shipping Paperclip across npm, GitHub, and the website-facing changelog surface.

The release model is now commit-driven:

1. Every push to `master` publishes a canary automatically.
2. Stable releases are manually promoted from a chosen tested commit or canary tag.
3. Stable release notes live in `releases/vYYYY.M.D.md`.
4. Only stable releases get GitHub Releases.

## Versioning Model

Paperclip uses calendar versions that still fit semver syntax:

- stable: `YYYY.M.D`
- canary: `YYYY.M.D-canary.N`

Examples:

- stable on March 17, 2026: `2026.3.17`
- fourth canary on March 17, 2026: `2026.3.17-canary.3`

Important constraints:

- do not use leading zeroes such as `2026.03.17`
- do not use four numeric segments such as `2026.03.17.1`
- the semver-safe canary form is `2026.3.17-canary.1`

## Release Surfaces

Every stable release has four separate surfaces:

1. **Verification** — the exact git SHA passes typecheck, tests, and build
2. **npm** — `paperclipai` and public workspace packages are published
3. **GitHub** — the stable release gets a git tag and GitHub Release
4. **Website / announcements** — the stable changelog is published externally and announced

A stable release is done only when all four surfaces are handled.

Canaries only cover the first two surfaces plus an internal traceability tag.

## Core Invariants

- canaries publish from `master`
- stables publish from an explicitly chosen source ref
- tags point at the original source commit, not a generated release commit
- stable notes are always `releases/vYYYY.M.D.md`
- canaries never create GitHub Releases
- canaries never require changelog generation

## TL;DR

### Canary

Every push to `master` runs the canary path inside [`.github/workflows/release.yml`](../.github/workflows/release.yml).

It:

- verifies the pushed commit
- computes the canary version for the current UTC date
- publishes under npm dist-tag `canary`
- creates a git tag `canary/vYYYY.M.D-canary.N`

Users install canaries with:

```bash
npx paperclipai@canary onboard
```

### Stable

Use [`.github/workflows/release.yml`](../.github/workflows/release.yml) from the Actions tab with the manual `workflow_dispatch` inputs.

Inputs:

- `source_ref`
  - commit SHA, branch, or tag
- `stable_date`
  - optional UTC date override in `YYYY-MM-DD`
- `dry_run`
  - preview only when true

Before running stable:

1. pick the canary commit or tag you trust
2. create or update `releases/vYYYY.M.D.md` on that source ref
3. run the stable workflow from that source ref

The workflow:

- re-verifies the exact source ref
- publishes `YYYY.M.D` under npm dist-tag `latest`
- creates git tag `vYYYY.M.D`
- creates or updates the GitHub Release from `releases/vYYYY.M.D.md`

## Local Commands

### Preview a canary locally

```bash
./scripts/release.sh canary --dry-run
```

### Preview a stable locally

```bash
./scripts/release.sh stable --dry-run
```

### Publish a stable locally

This is mainly for emergency/manual use. The normal path is the GitHub workflow.

```bash
./scripts/release.sh stable
git push public-gh refs/tags/vYYYY.M.D
./scripts/create-github-release.sh YYYY.M.D
```

## Stable Changelog Workflow

Stable changelog files live at:

- `releases/vYYYY.M.D.md`

Canaries do not get changelog files.

Recommended local generation flow:

```bash
VERSION=2026.3.17
claude --print --output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-4-6 "Use the release-changelog skill to draft or update releases/v${VERSION}.md for Paperclip. Read doc/RELEASING.md and .agents/skills/release-changelog/SKILL.md, then generate the stable changelog for v${VERSION} from commits since the last stable tag. Do not create a canary changelog."
```

The repo intentionally does not run this through GitHub Actions because:

- canaries are too frequent
- stable notes are the only public narrative surface that needs LLM help
- maintainer LLM tokens should not live in Actions

## Smoke Testing

For a canary:

```bash
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```

For the current stable:

```bash
PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

Useful isolated variants:

```bash
HOST_PORT=3232 DATA_DIR=./data/release-smoke-canary PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
HOST_PORT=3233 DATA_DIR=./data/release-smoke-stable PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

Minimum checks:

- `npx paperclipai@canary onboard` installs
- onboarding completes without crashes
- the server boots
- the UI loads
- basic company creation and dashboard load work

## Rollback

Rollback does not unpublish versions.

It only moves the `latest` dist-tag back to a previous stable:

```bash
./scripts/rollback-latest.sh 2026.3.16 --dry-run
./scripts/rollback-latest.sh 2026.3.16
```

Then fix forward with a new stable release date.

## Failure Playbooks

### If the canary publishes but smoke testing fails

Do not run stable.

Instead:

1. fix the issue on `master`
2. merge the fix
3. wait for the next automatic canary
4. rerun smoke testing

### If stable npm publish succeeds but tag push or GitHub release creation fails

This is a partial release. npm is already live.

Do this immediately:

1. push the missing tag
2. rerun `./scripts/create-github-release.sh YYYY.M.D`
3. verify the GitHub Release notes point at `releases/vYYYY.M.D.md`

Do not republish the same version.

### If `latest` is broken after stable publish

Roll back the dist-tag:

```bash
./scripts/rollback-latest.sh YYYY.M.D
```

Then fix forward with a new stable release.

## Related Files

- [`scripts/release.sh`](../scripts/release.sh)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh)
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh)
- [`doc/PUBLISHING.md`](PUBLISHING.md)
- [`doc/RELEASE-AUTOMATION-SETUP.md`](RELEASE-AUTOMATION-SETUP.md)
