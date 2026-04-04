# Release Automation Setup

This document covers the GitHub and npm setup required for the current Paperclip release model:

- **canaries:** manual `workflow_dispatch` (channel `canary`) or nightly schedule — not on every `master` push
- **stable:** manual promotion from a chosen source ref
- **npm auth:** `NPM_TOKEN` in GitHub Environments `npm-canary` and `npm-stable` (required for CI publish today)
- optional future: npm trusted publishing (OIDC) once every package is configured on npmjs.com

Repo-side files that depend on this setup:

- `.github/workflows/release.yml`
- `.github/CODEOWNERS`

### Workflow prerequisites

1. **Secret `NPM_TOKEN`** — Create an npm **automation** token with publish access to `@paperclipai/*` (all 15 packages including `@paperclipai/cli`). Add it as **`NPM_TOKEN`** in GitHub Environments **`npm-canary`** and **`npm-stable`**. [`.github/workflows/release.yml`](../.github/workflows/release.yml) sets `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` and runs **`npm whoami`** before `pnpm install` on publish jobs.

2. **`setup-node` registry URL** — Publish jobs use `actions/setup-node` with:

   - `registry-url: https://registry.npmjs.org`
   - `always-auth: true`

Without (1), `npm whoami` fails immediately. Without (2), the CLI may not use the token correctly.

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

- `@paperclipai/cli`
- `@paperclipai/server`
- `@paperclipai/ui`
- public packages under `packages/`

### 2.1. In npm, open each package settings page

For each package:

1. open npm as an owner of the package
2. go to the package settings / publishing access area
3. add a trusted publisher for the GitHub repository `Viraforge/paperclip`

### 2.2. Add one trusted publisher entry per package

npm currently allows one trusted publisher configuration per package.

Configure:

- workflow: `.github/workflows/release.yml`

Repository:

- `Viraforge/paperclip`

Environment name:

- leave the npm trusted-publisher environment field blank

Why:

- the single `release.yml` workflow handles both canary and stable publishing
- GitHub environments `npm-canary` and `npm-stable` still enforce different approval rules on the GitHub side

### 2.3. Verify trusted publishing (optional future)

**Current production path:** publish jobs use **`NPM_TOKEN`** in `npm-canary` / `npm-stable` (see prerequisites above).

If you later configure OIDC trusted publishing for every package and want to drop the long-lived token:

1. run a canary publish with `NPM_TOKEN` removed from the environment (test in a fork first)
2. confirm `npm whoami` and `pnpm publish` succeed via OIDC only
3. run a stable dry-run, then one real stable publish
4. only then revoke automation tokens

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

- canary publishes run via **workflow_dispatch** (channel `canary`) or **schedule**; they should not require human reviewers on the environment
- restrict which branches can *trigger* the workflow in GitHub Actions settings if desired

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
npx @paperclipai/cli@canary onboard
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
