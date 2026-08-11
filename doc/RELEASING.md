# Releasing Paperclip

Maintainer runbook for shipping Paperclip across npm, GitHub, and the website-facing changelog surface.

The release model is now commit-driven:

1. Every push to `master` publishes a canary automatically.
2. Once a night, the newest master commit with a green canary publish is
   smoke-tested and republished as the nightly.
3. Betas are manual, human-approved promotions of a chosen nightly.
4. Stable releases promote a beta that has soaked for at least 3 days
   (bypass requires a written justification).
5. Stable release notes live in `releases/vYYYY.MDD.P.md`.
6. Only stable releases get GitHub Releases.

The user-facing guide to the channels is [`CHANNELS.md`](CHANNELS.md).

## Versioning Model

Paperclip uses calendar versions that still fit semver syntax:

- stable: `YYYY.MDD.P`
- canary: `YYYY.MDD.P-canary.N`
- nightly: `YYYY.MDD.P-nightly.N`
- beta: `YYYY.MDD.P-beta.N`

Examples:

- first stable on March 18, 2026: `2026.318.0`
- second stable on March 18, 2026: `2026.318.1`
- fourth canary for the `2026.318.1` line: `2026.318.1-canary.3`
- first nightly cut on March 18, 2026: `2026.318.1-nightly.0`
- first beta promoted on March 18, 2026: `2026.318.1-beta.0`

A promotion republishes the exact source commit of the previous lane's build
(canary → nightly → beta); the version dates the promotion, not the source
build.

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

Canaries, nightlies, and betas only cover the first two surfaces plus an
internal traceability tag.

## Core Invariants

- canaries publish from `master`
- nightlies republish a commit that already shipped a canary (the commit must
  carry a `canary/v*` tag), and only after the release smoke suite passes
  against that exact published canary
- betas republish a commit that already shipped a nightly (the commit must
  carry a `nightly/v*` tag), behind the `npm-beta` approval gate, and the
  published beta is re-smoked
- stables publish from an explicitly chosen source ref, which must have
  shipped as a beta at least 3 days earlier unless a written justification
  is provided
- tags point at the original source commit, not a generated release commit
- stable notes are always `releases/vYYYY.MDD.P.md`
- canaries, nightlies, and betas never create GitHub Releases
- canaries, nightlies, and betas never require changelog generation
- Docker `:latest` moves only on stable releases; master builds publish
  `:canary`, nightly builds `:nightly`, and beta builds `:beta`

## TL;DR

### Canary

Every push to `master` runs the canary path inside [`.github/workflows/release.yml`](../.github/workflows/release.yml).

It:

- verifies the pushed commit
- computes the canary version for the current UTC date
- publishes workspace packages dependency-first under npm dist-tag `canary`
- waits for each package version to become registry-visible before continuing
- publishes the user-facing `paperclipai` package last, so `paperclipai@canary` does not advance before the full package set exists
- verifies that `canary` resolves to the just-published version and that published internal dependencies exist on npm
- installs `paperclipai@canary` into a clean temporary prefix as the final npm gate
- fails by default if npm leaves `latest` pointing at a canary; use `--allow-canary-latest` only when that state is intentional
- creates a git tag `canary/vYYYY.MDD.P-canary.N`

Users install canaries with:

```bash
npx paperclipai@canary onboard
# or
npx paperclipai@canary onboard --data-dir "$(mktemp -d /tmp/paperclip-canary.XXXXXX)"
```

### Nightly

A scheduled job in [`.github/workflows/release.yml`](../.github/workflows/release.yml)
runs once a night at 09:00 UTC.

It:

- selects the newest commit on `master` that carries a `canary/v*` tag (the
  tag is pushed only after a successful canary publish, so it is the
  green-publish signal)
- skips with a job-summary reason when there is no new candidate or the
  candidate already shipped as a nightly
- runs the release smoke suite ([`release-smoke.yml`](../.github/workflows/release-smoke.yml))
  against that exact published canary version — red smoke means no nightly
  tonight
- republishes the same source commit as `YYYY.MDD.P-nightly.N` under the npm
  dist-tag `nightly` (the commit was already verified by its canary run, so
  verification is not repeated)
- creates and pushes the git tag `nightly/vYYYY.MDD.P-nightly.N`
- dispatches [`docker.yml`](../.github/workflows/docker.yml) at that tag to
  publish the `:nightly` images

To force a nightly outside the schedule (recovery, or promoting a specific
canary), dispatch `release.yml` with `channel: nightly`. Leave
`source_version` empty for automatic selection, or set it to an exact
canary version. `dry_run: true` previews the publish and skips smoke, the tag
push, and the Docker dispatch.

Users install nightlies with:

```bash
npx paperclipai@nightly onboard
```

### Beta

Betas are manual promotions. Dispatch
[`release.yml`](../.github/workflows/release.yml) with `channel: beta`.

- leave `source_version` empty to promote the newest nightly, or set it to an
  exact nightly version such as `2026.807.0-nightly.0`
- the selection job resolves the nightly's source commit and fails loudly if
  it does not exist or already shipped as a beta
- the publish waits for approval in the **`npm-beta` environment** — its
  required reviewers are the promotion gate
- promotions run the release tooling of the source commit, so the source
  nightly must postdate the beta channel's introduction; the selection job
  rejects older sources with a clear error (in practice every nightly cut
  after the beta tooling merged qualifies)
- the same commit is republished as `YYYY.MDD.P-beta.N` under the npm
  dist-tag `beta`, tagged `beta/vYYYY.MDD.P-beta.N`, and `docker.yml` is
  dispatched at that tag to publish the `:beta` images
- after publishing, the release smoke suite runs against the exact published
  beta version as verification
- `dry_run: true` previews the publish and skips the tag push, Docker
  dispatch, and post-publish smoke

Users install betas with:

```bash
npx paperclipai@beta onboard
```

### Stable

Use [`.github/workflows/release.yml`](../.github/workflows/release.yml) from the Actions tab with the manual `workflow_dispatch` inputs.

[Run the action here](https://github.com/paperclipai/paperclip/actions/workflows/release.yml)

Inputs:

- `channel`
  - `stable` (the default) for a stable release; `beta` and `nightly` run
    those lanes instead (see above)
- `source_ref`
  - commit SHA, branch, or tag
- `stable_date`
  - optional UTC date override in `YYYY-MM-DD`
  - enter a date like `2026-03-18`, not a version like `2026.318.0`
- `skip_soak_justification`
  - written reason for releasing a stable whose source has not soaked as a
    beta for 3 days; leave empty for normal releases
- `dry_run`
  - preview only when true

The stable preflight enforces the beta soak: the source commit must carry a
`beta/v*` tag whose npm publish time is at least 3 days old. If it is not,
the run fails unless `skip_soak_justification` is provided; the justification
is echoed into the job summary. Dry runs report soak state without blocking.

Before running stable:

1. pick the beta you are promoting (its source commit is the `source_ref`)
2. confirm the beta has soaked for 3 days with no open blockers
3. resolve the target stable version with `./scripts/release.sh stable --date "$(date +%F)" --print-version`
4. create or update `releases/vYYYY.MDD.P.md` on that source ref
5. run the stable workflow from that source ref

Example:

- `source_ref`: `master`
- `stable_date`: `2026-03-18`
- resulting stable version: `2026.318.0`

The workflow:

- re-verifies the exact source ref
- computes the next stable patch slot for the chosen UTC date
- publishes `YYYY.MDD.P` under npm dist-tag `latest`
- creates git tag `vYYYY.MDD.P`
- dispatches [`docker.yml`](../.github/workflows/docker.yml) at that tag to
  publish `:latest` and the versioned stable images
- creates or updates the GitHub Release from `releases/vYYYY.MDD.P.md`

## Docker Image Tags

[`docker.yml`](../.github/workflows/docker.yml) publishes both the self-hosted
image and the `-cloud` variant with the same lane mapping:

| Build ref | Tags |
| --- | --- |
| `master` push | `:canary`, `:sha-<short>` |
| `nightly/v*` tag | `:nightly`, `:sha-<short>` |
| `beta/v*` tag | `:beta`, `:sha-<short>` |
| `v*` tag (stable) | `:latest`, `:YYYY.MDD.P`, `:YYYY.MDD`, `:sha-<short>` |

Lane tags are pushed by release workflows using `GITHUB_TOKEN`, and GitHub
suppresses push-triggered workflow runs for those pushes. The release jobs
therefore dispatch `docker.yml` explicitly at the new tag ref; the tag
mapping keys off `github.ref` either way.

## Local Commands

### Preview a canary locally

```bash
./scripts/release.sh canary --dry-run
```

### Preview a nightly locally

Requires HEAD to be a commit that already shipped a canary (it must carry a
`canary/v*` tag):

```bash
./scripts/release.sh nightly --dry-run
```

### Preview a beta locally

Requires HEAD to be a commit that already shipped a nightly (it must carry a
`nightly/v*` tag):

```bash
./scripts/release.sh beta --dry-run
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
gh workflow run release-smoke.yml -f paperclip_version=nightly
gh workflow run release-smoke.yml -f paperclip_version=beta
gh workflow run release-smoke.yml -f paperclip_version=latest
```

The nightly lane runs this same suite automatically against its candidate
before publishing, and the beta lane runs it against the published beta as
post-publish verification.

Minimum checks:

- `npx paperclipai@canary onboard` installs
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

### If the nightly skipped or failed

A skipped nightly is working as designed — the job summary names the reason
(no new green candidate, candidate already shipped, or red smoke). Nothing was
published, so there is nothing to clean up.

To recover after fixing the cause, either wait for the next scheduled run or
force one: dispatch `release.yml` with `channel: nightly` (optionally pinning
`source_version` to a specific canary).

If the nightly published to npm but the tag push or Docker dispatch failed,
push the `nightly/v*` tag manually and run `docker.yml` at that tag.

### If a beta looks bad during soak

Do not promote it to stable. Fix forward: land the fix on `master`, let it
ship through canary and nightly, and promote a new beta. The soak clock
starts over for the new beta.

If the published beta is actively harmful to beta users, move the `beta`
dist-tag back to the previous beta version with `npm dist-tag add` per
package, and re-point the `:beta` Docker tags at the previous beta's images.

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
