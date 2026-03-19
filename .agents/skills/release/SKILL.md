---
name: release
description: >
  Coordinate a full Paperclip release across engineering verification, npm,
  GitHub, smoke testing, and announcement follow-up. Use when leadership asks
  to ship a release, not merely to discuss versioning.
---

# Release Coordination Skill

Run the full Paperclip maintainer release workflow, not just an npm publish.

This skill coordinates:

- stable changelog drafting via `release-changelog`
- canary verification and publish (manual dispatch or nightly; not every `master` push)
- Docker smoke testing via `scripts/docker-onboard-smoke.sh`
- manual stable promotion from a chosen source ref
- GitHub Release creation
- website / announcement follow-up tasks

## Trigger

Use this skill when leadership asks for:

- "do a release"
- "ship the release"
- "promote this canary to stable"
- "cut the stable release"

## Preconditions

Before proceeding, verify all of the following:

1. `.agents/skills/release-changelog/SKILL.md` exists and is usable.
2. The repo working tree is clean, including untracked files.
3. There is at least one canary or candidate commit since the last stable tag.
4. The candidate SHA has passed the verification gate or is about to.
5. If manifests changed, the CI-owned `pnpm-lock.yaml` refresh is already merged on `master`.
6. GitHub Environments `npm-canary` / `npm-stable` have secret **`NPM_TOKEN`**, or local `npm login` for emergency manual publish.
7. If running through Paperclip, you have issue context for status updates and follow-up task creation.

If any precondition fails, stop and report the blocker.

## Inputs

Collect these inputs up front:

- whether the target is a canary check or a stable promotion
- the candidate `source_ref` for stable
- whether the stable run is dry-run or live
- release issue / company context for website and announcement follow-up

## Step 0 — Release Model

Paperclip release model (merge, deploy, and npm are separate):

1. merging to `master` runs PR CI only — **not** npm publish
2. **canary:** run `release.yml` with **channel `canary`**, or wait for nightly schedule
3. canaries use `YYYY.MDD.P-canary.N`
4. stable releases use `YYYY.MDD.P`
5. the middle slot is `MDD`, where `M` is the UTC month and `DD` is the zero-padded UTC day
6. the stable patch slot increments when more than one stable ships on the same UTC date
7. stable releases are manually promoted via `release.yml` with **channel `stable`**
8. only stable releases get `releases/vYYYY.MDD.P.md`, git tag `vYYYY.MDD.P`, and a GitHub Release
9. app production deploy uses **Deploy Vultr** (`deploy-vultr.yml`), not the Release workflow

Critical consequences:

- do not use release branches as the default path
- do not derive major/minor/patch bumps
- do not create canary changelog files
- do not create canary GitHub Releases

## Step 1 — Choose the Candidate

For canary validation:

- inspect the latest successful **Release** workflow run for channel `canary` (or nightly)
- record the canary version and source SHA

For stable promotion:

1. choose the tested source ref
2. confirm it is the exact SHA you want to promote
3. resolve the target stable version with `./scripts/release.sh stable --date YYYY-MM-DD --print-version`

Useful commands:

```bash
git tag --list 'v*' --sort=-version:refname | head -1
git log --oneline --no-merges
npm view paperclipai@canary version
```

## Step 2 — Draft the Stable Changelog

Stable changelog files live at:

- `releases/vYYYY.MDD.P.md`

Invoke `release-changelog` and generate or update the stable notes only.

Rules:

- review the draft with a human before publish
- preserve manual edits if the file already exists
- keep the filename stable-only
- do not create a canary changelog file

## Step 3 — Verify the Candidate SHA

Run the standard gate:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

If the GitHub release workflow will run the publish, it can rerun this gate. Still report local status if you checked it.

## Step 4 — Validate the Canary

Publish or confirm a canary via `.github/workflows/release.yml`:

- **channel:** `canary`
- **source_ref:** usually `master`
- **dry_run:** `false` to publish (or check nightly run output)

Confirm:

1. workflow succeeded (`npm whoami` + publish steps)
2. npm canary publish succeeded
3. git tag `canary/vYYYY.MDD.P-canary.N` exists

Useful checks:

```bash
npm view paperclipai@canary version
git tag --list 'canary/v*' --sort=-version:refname | head -5
```

## Step 5 — Smoke Test the Canary

Run:

```bash
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```

Useful isolated variant:

```bash
HOST_PORT=3232 DATA_DIR=./data/release-smoke-canary PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```

Confirm:

1. install succeeds
2. onboarding completes without crashes
3. the server boots
4. the UI loads
5. basic company creation and dashboard load work

If smoke testing fails:

- stop the stable release
- fix the issue on `master`
- run or wait for the next canary publish (`release.yml` channel `canary` or nightly)
- rerun smoke testing

## Step 6 — Preview or Publish Stable

The normal stable path is manual `workflow_dispatch` on:

- `.github/workflows/release.yml`

Inputs:

- **channel:** `stable`
- `source_ref`
- `stable_date`
- `dry_run`

Before live stable:

1. resolve the target stable version with `./scripts/release.sh stable --date YYYY-MM-DD --print-version`
2. ensure `releases/vYYYY.MDD.P.md` exists on the source ref
3. run the stable workflow in dry-run mode first when practical
4. then run the real stable publish

The stable workflow:

- re-verifies the exact source ref
- computes the next stable patch slot for the chosen UTC date
- publishes `YYYY.MDD.P` under dist-tag `latest`
- creates git tag `vYYYY.MDD.P`
- creates or updates the GitHub Release from `releases/vYYYY.MDD.P.md`

Local emergency/manual commands:

```bash
./scripts/release.sh stable --dry-run
./scripts/release.sh stable
git push public-gh refs/tags/vYYYY.MDD.P
./scripts/create-github-release.sh YYYY.MDD.P
```

## Step 7 — Finish the Other Surfaces

Create or verify follow-up work for:

- website changelog publishing
- launch post / social announcement
- release summary in Paperclip issue context

These should reference the stable release, not the canary.

## Failure Handling

If the canary is bad:

- publish another canary, do not ship stable

If stable npm publish succeeds but tag push or GitHub release creation fails:

- fix the git/GitHub issue immediately from the same release result
- do not republish the same version

If `latest` is bad after stable publish:

```bash
./scripts/rollback-latest.sh <last-good-version>
```

Then fix forward with a new stable release.

## Output

When the skill completes, provide:

- candidate SHA and tested canary version, if relevant
- stable version, if promoted
- verification status
- npm status
- smoke-test status
- git tag / GitHub Release status
- website / announcement follow-up status
- rollback recommendation if anything is still partially complete
