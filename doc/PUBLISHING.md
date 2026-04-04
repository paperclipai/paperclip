# Publishing to npm

Low-level reference for how Paperclip packages are prepared and published to npm.

For the maintainer workflow, use [doc/RELEASING.md](RELEASING.md). This document focuses on packaging internals.

## Current Release Entry Points

Use these scripts:

- [`scripts/release.sh`](../scripts/release.sh) for canary and stable publish flows
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh) after pushing a stable tag
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh) to repoint `latest`
- [`scripts/build-npm.sh`](../scripts/build-npm.sh) for the CLI packaging build

Paperclip no longer uses release branches or Changesets for publishing.

## Why the CLI needs special packaging

The CLI package, `@paperclipai/cli`, imports code from workspace packages such as:

- `@paperclipai/server`
- `@paperclipai/db`
- `@paperclipai/shared`
- adapter packages under `packages/adapters/`

Those workspace references are valid in development but not in a publishable npm package. The release flow rewrites versions temporarily, then builds a publishable CLI bundle.

## `build-npm.sh`

Run:

```bash
./scripts/build-npm.sh
```

This script:

1. runs the forbidden token check unless `--skip-checks` is supplied
2. runs `pnpm -r typecheck`
3. bundles the CLI entrypoint with esbuild into `cli/dist/index.js`
4. verifies the bundled entrypoint with `node --check`
5. rewrites `cli/package.json` into a publishable npm manifest and stores the dev copy as `cli/package.dev.json`
6. copies the repo `README.md` into `cli/README.md` for npm metadata

After the release script exits, the dev manifest and temporary files are restored automatically.

## Package discovery and versioning

Public packages are discovered from:

- `packages/`
- `server/`
- `ui/`
- `cli/`

The version rewrite step now uses [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs), which:

- finds all public packages
- sorts them topologically by internal dependencies
- rewrites each package version to the target release version
- rewrites internal `workspace:*` dependency references to the exact target version
- updates the CLI's displayed version string

Those rewrites are temporary. The working tree is restored after publish or dry-run.

## `@paperclipai/ui` packaging

The UI package publishes prebuilt static assets, not the source workspace.

The `ui` package uses [`scripts/generate-ui-package-json.mjs`](../scripts/generate-ui-package-json.mjs) during `prepack` to swap in a lean publish manifest that:

- keeps the release-managed `name` and `version`
- publishes only `dist/`
- omits the source-only dependency graph from downstream installs

After packing or publishing, `postpack` restores the development manifest automatically.

### Manual first publish for `@paperclipai/ui`

If you need to publish only the UI package once by hand, use the real package name:

- `@paperclipai/ui`

Recommended flow from the repo root:

```bash
# optional sanity check: this 404s until the first publish exists
npm view @paperclipai/ui version

# make sure the dist payload is fresh
pnpm --filter @paperclipai/ui build

# confirm your local npm auth before the real publish
npm whoami

# safe preview of the exact publish payload
cd ui
pnpm publish --dry-run --no-git-checks --access public

# real publish
pnpm publish --no-git-checks --access public
```

Notes:

- Publish from `ui/`, not the repo root.
- `prepack` automatically rewrites `ui/package.json` to the lean publish manifest, and `postpack` restores the dev manifest after the command finishes.
- If `npm view @paperclipai/ui version` already returns the same version that is in [`ui/package.json`](../ui/package.json), do not republish. Bump the version or use the normal repo-wide release flow in [`scripts/release.sh`](../scripts/release.sh).

If the first real publish returns npm `E404`, check npm-side prerequisites before retrying:

- `npm whoami` must succeed first. An expired or missing npm login will block the publish.
- For an organization-scoped package like `@paperclipai/ui`, the `paperclipai` npm organization must exist and the publisher must be a member with permission to publish to that scope.
- The initial publish must include `--access public` for a public scoped package.
- npm also requires either account 2FA for publishing or a granular token that is allowed to bypass 2FA.

## Version formats

Paperclip uses calendar versions:

- stable: `YYYY.MDD.P`
- canary: `YYYY.MDD.P-canary.N`

Examples:

- stable: `2026.318.0`
- canary: `2026.318.1-canary.2`

## Publish model

### Canary

Canaries publish under the npm dist-tag `canary`.

Example:

- `@paperclipai/cli@2026.318.1-canary.2`

Install:

```bash
npx @paperclipai/cli@canary onboard
```

### Stable

Stable publishes use the npm dist-tag `latest`.

Example:

- `@paperclipai/cli@2026.318.0`

Stable publishes do not create a release commit. Instead:

- package versions are rewritten temporarily
- packages are published from the chosen source commit
- git tag `vYYYY.MDD.P` points at that original commit

## CI npm authentication

**Today:** GitHub Environments **`npm-canary`** and **`npm-stable`** store secret **`NPM_TOKEN`** (npm automation token). [`.github/workflows/release.yml`](../.github/workflows/release.yml) sets `NODE_AUTH_TOKEN` and runs `npm whoami` before publish.

**Future:** OIDC trusted publishing (no long-lived token) is documented in [doc/RELEASE-AUTOMATION-SETUP.md](RELEASE-AUTOMATION-SETUP.md) once every package on npmjs.com is wired to `Viraforge/paperclip` + `release.yml`.

## Rollback model

Rollback does not unpublish anything.

It repoints the `latest` dist-tag to a prior stable version:

```bash
./scripts/rollback-latest.sh 2026.318.0
```

This is the fastest way to restore the default install path if a stable release is bad.

## Related Files

- [`scripts/build-npm.sh`](../scripts/build-npm.sh)
- [`scripts/generate-npm-package-json.mjs`](../scripts/generate-npm-package-json.mjs)
- [`scripts/generate-ui-package-json.mjs`](../scripts/generate-ui-package-json.mjs)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`cli/esbuild.config.mjs`](../cli/esbuild.config.mjs)
- [`doc/RELEASING.md`](RELEASING.md)
