# Publishing to npm

Low-level reference for how Paperclip packages are built for npm.

For the maintainer release workflow, use [doc/RELEASING.md](RELEASING.md). This document is only about packaging internals and the scripts that produce publishable artifacts.

## Current Release Entry Points

Use these scripts instead of older one-off publish commands:

- [`scripts/release-start.sh`](../scripts/release-start.sh) to create or resume `release/X.Y.Z`
- [`scripts/release-preflight.sh`](../scripts/release-preflight.sh) before any canary or stable release
- [`scripts/release.sh`](../scripts/release.sh) for canary and stable npm publishes
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh) to repoint `latest` during rollback
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh) after pushing the stable branch tag

## Why the CLI needs special packaging

The CLI package, `paperclipai`, imports code from workspace packages such as:

- `@paperclipai/server`
- `@paperclipai/db`
- `@paperclipai/shared`
- adapter packages under `packages/adapters/`

Those workspace references use `workspace:*` during development. npm cannot install those references directly for end users, so the release build has to transform the CLI into a publishable standalone package.

## `build-npm.sh`

Run:

```bash
./scripts/build-npm.sh
```

This script does six things:

1. Runs the forbidden token check unless `--skip-checks` is supplied
2. Runs `pnpm -r typecheck`
3. Bundles the CLI entrypoint with esbuild into `cli/dist/index.js`
4. Verifies the bundled entrypoint with `node --check`
5. Rewrites `cli/package.json` into a publishable npm manifest and stores the dev copy as `cli/package.dev.json`
6. Copies the repo `README.md` into `cli/README.md` for npm package metadata

`build-npm.sh` is used by the release script so that npm users install a real package rather than unresolved workspace dependencies.

## Publishable CLI layout

During development, [`cli/package.json`](../cli/package.json) contains workspace references.

During release preparation:

- `cli/package.json` becomes a publishable manifest with external npm dependency ranges
- `cli/package.dev.json` stores the development manifest temporarily
- `cli/dist/index.js` contains the bundled CLI entrypoint
- `cli/README.md` is copied in for npm metadata

After release finalization, the release script restores the development manifest and removes the temporary README copy.

## Package discovery

The release tooling scans the workspace for public packages under:

- `packages/`
- `server/`
- `cli/`

`ui/` remains ignored for npm publishing because it is private.

This matters because all public packages are versioned and published together as one release unit.

## Canary packaging model

Canaries are published as semver prereleases such as:

- `1.2.3-canary.0`
- `1.2.3-canary.1`

They are published under the npm dist-tag `canary`.

This means:

- `npx paperclipai@canary onboard` can install them explicitly
- `npx paperclipai onboard` continues to resolve `latest`
- the stable changelog can stay at `releases/v1.2.3.md`

## Stable packaging model

Stable releases publish normal semver versions such as `1.2.3` under the npm dist-tag `latest`.

The stable publish flow also creates the local release commit and git tag on `release/X.Y.Z`. Pushing that branch commit/tag, creating the GitHub Release, and merging the release branch back to `master` happen afterward as separate maintainer steps.

## Rollback model

Rollback does not unpublish packages.

Instead, the maintainer should move the `latest` dist-tag back to the previous good stable version with:

```bash
./scripts/rollback-latest.sh <stable-version>
```

That keeps history intact while restoring the default install path quickly.

## Notes for CI

The repo includes a manual GitHub Actions release workflow at [`.github/workflows/release.yml`](../.github/workflows/release.yml).

Recommended CI release setup:

- use npm trusted publishing via GitHub OIDC
- require approval through the `npm-release` environment
- run releases from `release/X.Y.Z`
- use canary first, then stable

## Related Files

- [`scripts/build-npm.sh`](../scripts/build-npm.sh)
- [`scripts/generate-npm-package-json.mjs`](../scripts/generate-npm-package-json.mjs)
- [`cli/esbuild.config.mjs`](../cli/esbuild.config.mjs)
- [`doc/RELEASING.md`](RELEASING.md)
