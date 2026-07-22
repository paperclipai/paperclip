# Release Automation Setup

This document covers the GitHub and npm setup required for the current Paperclip release model:

- automatic canaries from `master`
- manual stable promotion from a chosen source ref
- npm trusted publishing via GitHub OIDC
- protected release infrastructure in a public repository

Repo-side files that depend on this setup:

- `.github/workflows/release.yml`
- `.github/CODEOWNERS`

Note:

- the release workflows intentionally use `pnpm install --no-frozen-lockfile`
- this matches the repo's current policy where `pnpm-lock.yaml` is refreshed by GitHub automation after manifest changes land on `master`
- the publish jobs then restore `pnpm-lock.yaml` before running `scripts/release.sh`, so the release script still sees a clean worktree

## 1. Merge the Repo Changes First

Before touching GitHub or npm settings, merge the release automation code so the referenced workflow filenames already exist on the default branch.

Required files:

- `.github/workflows/release.yml`
- `.github/CODEOWNERS`

## 2. Configure npm Trusted Publishing

Do this for every public package that Paperclip publishes.

At minimum that includes:

- `paperclipai`
- `@paperclipai/server`
- `@paperclipai/ui`
- public packages under `packages/`

### 2.1. In npm, open each package settings page

For each package:

1. open npm as an owner of the package
2. go to the package settings / publishing access area
3. add a trusted publisher for the GitHub repository `paperclipai/paperclip`

### 2.2. Add one trusted publisher entry per package

npm currently allows one trusted publisher configuration per package.

Configure:

- workflow: `.github/workflows/release.yml`

Repository:

- `paperclipai/paperclip`

Environment name:

- leave the npm trusted-publisher environment field blank

Why:

- the single `release.yml` workflow handles both canary and stable publishing
- GitHub environments `npm-canary` and `npm-stable` still enforce different approval rules on the GitHub side

### 2.2.1. Newly added public packages need a bootstrap phase

Trusted publishing is configured on the npm package itself, not at the repo scope.
That means a brand-new public package must not be auto-enrolled into CI publishing until its npm package exists and its trusted publisher has been configured.

Repo policy:

1. add every non-private package to [`scripts/release-package-manifest.json`](../scripts/release-package-manifest.json)
2. set `"publishFromCi": true` only when CI is expected to publish that package
3. if the package is not ready for CI publishing yet, keep `"publishFromCi": false`
4. complete the package bootstrap before merging any PR that changes a release-enabled new package

Bootstrap sequence for a new package:

1. publish the package once from a trusted maintainer machine using normal npm auth
2. open that package on npm and add the `paperclipai/paperclip` trusted publisher for `.github/workflows/release.yml`
3. rerun or dry-run the release flow as needed to confirm CI publishing now works
4. only then enable `"publishFromCi": true`

PR CI enforces this by checking changed release-enabled package manifests against npm. That keeps `master` canary publishing healthy while preserving the no-long-lived-token model for normal CI releases.

### 2.3. Verify trusted publishing before removing old auth

After the workflows are live:

1. run a canary publish
2. confirm npm publish succeeds without any `NPM_TOKEN`
3. run a stable dry-run
4. run one real stable publish

Only after that should you remove old token-based access.

## 3. Remove Legacy npm Tokens

After trusted publishing works:

1. revoke any repository or organization `NPM_TOKEN` secrets used for publish
2. revoke any personal automation token that used to publish Paperclip
3. if npm offers a package-level setting to restrict publishing to trusted publishers, enable it

Goal:

- no long-lived npm publishing token should remain in GitHub Actions

## 4. Create GitHub Environments

Create two environments in the GitHub repository:

- `npm-canary`
- `npm-stable`

Path:

1. GitHub repository
2. `Settings`
3. `Environments`
4. `New environment`

## 5. Configure `npm-canary`

Recommended settings for `npm-canary`:

- environment name: `npm-canary`
- required reviewers: none
- wait timer: none
- deployment branches and tags:
  - selected branches only
  - allow `master`

Reasoning:

- every push to `master` should be able to publish a canary automatically
- no human approval should be required for canaries

## 6. Configure `npm-stable`

Recommended settings for `npm-stable`:

- environment name: `npm-stable`
- required reviewers: at least one maintainer other than the person triggering the workflow when possible
- prevent self-review: enabled
- admin bypass: disabled if your team can tolerate it
- wait timer: optional
- deployment branches and tags:
  - selected branches only
  - allow `master`

Reasoning:

- stable publishes should require an explicit human approval gate
- the workflow is manual, but the environment should still be the real control point

## 7. Protect `master`

Open the branch protection settings for `master`.

Recommended rules:

1. require pull requests before merging
2. require status checks to pass before merging
3. require review from code owners
4. dismiss stale approvals when new commits are pushed
5. restrict who can push directly to `master`

At minimum, make sure workflow and release script changes cannot land without review.

## 8. Enforce CODEOWNERS Review

This repo now includes `.github/CODEOWNERS`, but GitHub only enforces it if branch protection requires code owner reviews.

In branch protection for `master`, enable:

- `Require review from Code Owners`

Then verify the owner entries are correct for your actual maintainer set.

Current file:

- `.github/CODEOWNERS`

If `@cryppadotta` is not the right reviewer identity in the public repo, change it before enabling enforcement.

## 9. Protect Release Infrastructure Specifically

These files should always trigger code owner review:

- `.github/workflows/release.yml`
- `scripts/release.sh`
- `scripts/release-lib.sh`
- `scripts/release-package-map.mjs`
- `scripts/create-github-release.sh`
- `scripts/rollback-latest.sh`
- `doc/RELEASING.md`
- `doc/PUBLISHING.md`

If you want stronger controls, add a repository ruleset that explicitly blocks direct pushes to:

- `.github/workflows/**`
- `scripts/release*`

## 10. Do Not Store a Claude Token in GitHub Actions

Do not add a personal Claude or Anthropic token for automatic changelog generation.

Recommended policy:

- stable changelog generation happens locally from a trusted maintainer machine
- canaries never generate changelogs

This keeps LLM spending intentional and avoids a high-value token sitting in Actions.

## 11. Verify the Canary Workflow

After setup:

1. merge a harmless commit to `master`
2. open the `Release` workflow run triggered by that push
3. confirm it passes verification
4. confirm publish succeeds under the `npm-canary` environment
5. confirm npm now shows a new `canary` release
6. confirm a git tag named `canary/vYYYY.MDD.P-canary.N` was pushed

Install-path check:

```bash
npx paperclipai@canary onboard
```

## 12. Verify the Stable Workflow

After at least one good canary exists:

1. resolve the target stable version with `./scripts/release.sh stable --date YYYY-MM-DD --print-version`
2. prepare `releases/vYYYY.MDD.P.md` on the source commit you want to promote
3. open `Actions` -> `Release`
4. run it with:
   - `source_ref`: the tested commit SHA or canary tag source commit
   - `stable_date`: leave blank or set the intended UTC date like `2026-03-18`
     do not enter a version like `2026.318.0`; the workflow computes that from the date
   - `dry_run`: `true`
5. confirm the dry-run succeeds
6. rerun with `dry_run: false`
7. approve the `npm-stable` environment when prompted
8. confirm npm `latest` points to the new stable version
9. confirm git tag `vYYYY.MDD.P` exists
10. confirm the GitHub Release was created

Implementation note:

- the GitHub Actions stable workflow calls `create-github-release.sh` with `PUBLISH_REMOTE=origin`
- local maintainer usage can still pass `PUBLISH_REMOTE=public-gh` explicitly when needed

## 13. Suggested Maintainer Policy

Use this policy going forward:

- canaries are automatic and cheap
- stables are manual and approved
- only stables get public notes and announcements
- release notes are committed before stable publish
- rollback uses `npm dist-tag`, not unpublish

## 14. Troubleshooting

### Trusted publishing fails with an auth error

Check:

1. the workflow filename on GitHub exactly matches the filename configured in npm
2. the package has the trusted publisher entry for the correct repository
3. the job has `id-token: write`
4. the job is running from the expected repository, not a fork

### Stable workflow runs but never asks for approval

Check:

1. the `publish` job uses environment `npm-stable`
2. the environment actually has required reviewers configured
3. the workflow is running in the canonical repository, not a fork

### CODEOWNERS does not trigger

Check:

1. `.github/CODEOWNERS` is on the default branch
2. branch protection on `master` requires code owner review
3. the owner identities in the file are valid reviewers with repository access

## Related Docs

- [doc/RELEASING.md](RELEASING.md)
- [doc/PUBLISHING.md](PUBLISHING.md)
- [doc/plans/2026-03-17-release-automation-and-versioning.md](plans/2026-03-17-release-automation-and-versioning.md)
