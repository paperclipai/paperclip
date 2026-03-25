# Releasing Paperclip

Maintainer runbook for shipping Paperclip across npm, GitHub, and the website-facing changelog surface.

The release model separates **merge CI**, **app deploy**, and **npm publish**:

1. **Canary** — manual `workflow_dispatch` (channel `canary`) or nightly schedule; not on every `master` push.
2. **Stable** — manual `workflow_dispatch` (channel `stable`) from a chosen ref.
3. Stable release notes live in `releases/vYYYY.MDD.P.md`.
4. Only stable releases get GitHub Releases.

Merging to `master` does **not** publish npm packages. Deploy the app with **Deploy Vultr** when ready ([`deploy-vultr.yml`](../.github/workflows/deploy-vultr.yml)).

For the full PR / branch-protection / `npx` policy in one place, see [`docs/deploy/github-workflow-policy.md`](../docs/deploy/github-workflow-policy.md).

## Versioning Model

Paperclip uses calendar versions that still fit semver syntax:

- stable: `YYYY.MDD.P`
- canary: `YYYY.MDD.P-canary.N`

Examples:

- first stable on March 18, 2026: `2026.318.0`
- second stable on March 18, 2026: `2026.318.1`
- fourth canary for the `2026.318.1` line: `2026.318.1-canary.3`

Important constraints:

- the middle numeric slot is `MDD`, where `M` is the UTC month and `DD` is the zero-padded UTC day
- use `2026.303.0` for March 3, not `2026.33.0`
- do not use leading zeroes such as `2026.0318.0`
- do not use four numeric segments such as `2026.3.18.1`
- the semver-safe canary form is `2026.318.0-canary.1`

## Release Surfaces

Every stable release has four separate surfaces:

1. **Verification** — the exact git SHA passes typecheck, tests, and build
2. **npm** — `paperclipai` and public workspace packages are published
3. **GitHub** — the stable release gets a git tag and GitHub Release
4. **Website / announcements** — the stable changelog is published externally and announced

A stable release is done only when all four surfaces are handled.

Canaries only cover the first two surfaces plus an internal traceability tag.

## Core Invariants

- canaries publish from `source_ref` (default `master`) or nightly schedule at `master`
- stables publish from an explicitly chosen source ref
- tags point at the original source commit, not a generated release commit
- stable notes are always `releases/vYYYY.MDD.P.md`
- canaries never create GitHub Releases
- canaries never require changelog generation

## TL;DR

### Canary

Run [`.github/workflows/release.yml`](../.github/workflows/release.yml) manually:

- **channel:** `canary`
- **source_ref:** branch, SHA, or tag (default `master`)
- **dry_run:** `true` to preview without publishing

Or rely on the **nightly schedule** (02:00 UTC) which publishes from `master`.

The job computes the canary version for the current UTC date, publishes under npm dist-tag `canary`, and creates `canary/vYYYY.MDD.P-canary.N`.

**Prerequisite:** GitHub Environments `npm-canary` and `npm-stable` must define secret **`NPM_TOKEN`** (npm automation token with publish access). The workflow runs `npm whoami` before `pnpm install` to fail fast if auth is missing.

Users install canaries with:

```bash
npx @paperclipai/cli@canary onboard
# or
npx @paperclipai/cli@canary onboard --data-dir "$(mktemp -d /tmp/paperclip-canary.XXXXXX)"
```

### Stable

Use [`.github/workflows/release.yml`](../.github/workflows/release.yml) from the Actions tab → **Run workflow**.

[Run the action here](https://github.com/Viraforge/paperclip/actions/workflows/release.yml)

Inputs:

- **channel:** `stable` (default)
- **source_ref** — commit SHA, branch, or tag
- **stable_date** — optional UTC date override in `YYYY-MM-DD` (e.g. `2026-03-18`, not `2026.318.0`)
- **dry_run** — preview only when true (runs verify + dry-run publish)

Before running stable:

1. pick the canary commit or tag you trust
2. resolve the target stable version with `./scripts/release.sh stable --date "$(date +%F)" --print-version`
3. create or update `releases/vYYYY.MDD.P.md` on that source ref
4. run the stable workflow from that source ref

Example:

- `source_ref`: `master`
- `stable_date`: `2026-03-18`
- resulting stable version: `2026.318.0`

The workflow:

- re-verifies the exact source ref
- computes the next stable patch slot for the chosen UTC date
- publishes `YYYY.MDD.P` under npm dist-tag `latest`
- creates git tag `vYYYY.MDD.P`
- creates or updates the GitHub Release from `releases/vYYYY.MDD.P.md`

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
git push public-gh refs/tags/vYYYY.MDD.P
PUBLISH_REMOTE=public-gh ./scripts/create-github-release.sh YYYY.MDD.P
```

## Stable Changelog Workflow

Stable changelog files live at:

- `releases/vYYYY.MDD.P.md`

Canaries do not get changelog files.

Recommended local generation flow:

```bash
VERSION="$(./scripts/release.sh stable --date 2026-03-18 --print-version)"
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

Automated browser smoke is also available:

```bash
gh workflow run release-smoke.yml -f paperclip_version=canary
gh workflow run release-smoke.yml -f paperclip_version=latest
```

Minimum checks:

- `npx @paperclipai/cli@canary onboard` installs
- onboarding completes without crashes
- authenticated login works with the smoke credentials
- the browser lands in onboarding on a fresh instance
- company creation succeeds
- the first CEO agent is created
- the first CEO heartbeat run is triggered

## Rollback

Rollback does not unpublish versions.

It only moves the `latest` dist-tag back to a previous stable:

```bash
./scripts/rollback-latest.sh 2026.318.0 --dry-run
./scripts/rollback-latest.sh 2026.318.0
```

Then fix forward with a new stable patch slot or release date.

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
2. rerun `PUBLISH_REMOTE=public-gh ./scripts/create-github-release.sh YYYY.MDD.P`
3. verify the GitHub Release notes point at `releases/vYYYY.MDD.P.md`

Do not republish the same version.

### If `latest` is broken after stable publish

Roll back the dist-tag:

```bash
./scripts/rollback-latest.sh YYYY.MDD.P
```

Then fix forward with a new stable release.

## Related Files

- [`scripts/release.sh`](../scripts/release.sh)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh)
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh)
- [`doc/PUBLISHING.md`](PUBLISHING.md)
- [`doc/RELEASE-AUTOMATION-SETUP.md`](RELEASE-AUTOMATION-SETUP.md)
