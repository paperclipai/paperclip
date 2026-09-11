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

The CLI package, `paperclipai`, imports code from workspace packages such as:

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

- `paperclipai@2026.318.1-canary.2`

This keeps the default install path unchanged while allowing explicit installs with:

```bash
npx paperclipai@canary onboard
```

The release script now verifies two things after a canary publish:

- the `canary` dist-tag resolves to the version that was just published
- every published internal `@paperclipai/*` dependency referenced by that manifest exists on npm

It also treats `latest -> canary` as a failure by default, because npm metadata can otherwise leave the default install path pointing at an unreleased canary dependency graph. Only pass `./scripts/release.sh canary --allow-canary-latest` when that `latest` behavior is explicitly intended.

### Stable

Stable publishes use the npm dist-tag `latest`.

Example:

- `paperclipai@2026.318.0`

Stable publishes do not create a release commit. Instead:

- package versions are rewritten temporarily
- packages are published from the chosen source commit
- git tag `vYYYY.MDD.P` points at that original commit

## Trusted publishing

The intended CI model is npm trusted publishing through GitHub OIDC.

That means:

- no long-lived `NPM_TOKEN` in repository secrets
- GitHub Actions obtains short-lived publish credentials
- trusted publisher rules are configured per workflow file

See [doc/RELEASE-AUTOMATION-SETUP.md](RELEASE-AUTOMATION-SETUP.md) for the GitHub/npm setup steps.

## Release enrollment for new public packages

Paperclip does not auto-publish every non-private workspace package anymore.
CI publishing is controlled by [`scripts/release-package-manifest.json`](../scripts/release-package-manifest.json).

When you add a new public package:

1. add it to the manifest and decide whether CI should publish it immediately
2. if CI should publish it, reserve the name on npm with the placeholder bootstrap before merge
3. if CI should not publish it yet, keep `"publishFromCi": false`
4. only enable `"publishFromCi": true` after npm trusted publishing is configured for that package

PR CI now checks changed release-enabled package manifests against npm. That catches a missing first-publish bootstrap before the change reaches `master`. When a PR needs this bootstrap, commitperclip also posts an informational notice on the PR naming the exact command, so contributors know a maintainer action is pending rather than something they can fix.

### One-time bootstrap sequence for a new package

Creating a brand-new package name on npm still needs one human maintainer with npm write access.
After that, trusted publishing takes over — and CI publishes the only real content the package ever gets.

The bootstrap intentionally does **not** publish the package's real build output.
It publishes a tiny placeholder at version `0.0.0` (a manifest, a README, and an
`index.js` that throws a descriptive error), because:

- real package content should only ever reach npm from CI, after the PR that adds the package has been reviewed and merged
- the PR CI gate only requires the name to resolve on the registry
- the trusted publisher rule can only be configured once the package page exists
- the placeholder needs no local build and no workspace state, so it can be published from any checkout (including `master`, before the new package's PR merges)

Example for a newly added public package from the repo root:

```bash
# safe preview (stages the placeholder and runs npm publish --dry-run)
pnpm run release:bootstrap-package -- @paperclipai/new-package

# one-time placeholder publish from an authenticated maintainer machine
# (prompts for npm one-time passwords; they are never passed as arguments)
pnpm run release:bootstrap-package -- @paperclipai/new-package --publish
```

The helper script:

- refuses names outside the `@paperclipai/` scope
- checks that the package does not already exist on npm
- stages the placeholder in a temporary directory and previews it with `npm publish --dry-run --access public`
- with `--publish`, prompts for a one-time password and publishes. Codes are entered interactively and handed to npm through its environment (`npm_config_otp`), so they never appear on a command line, in shell history, or in a process listing; a rejected or expired code re-prompts
- then waits for the registry to show the package (a first publish can take a few minutes to become visible on the read/write endpoints) and prompts for a second code to deprecate the placeholder, so accidental installs warn loudly. If the wait times out or the deprecation fails, it prints the exact `npm deprecate` command to run manually

Until the first stable release supersedes it, the `latest` dist-tag points at the
deprecated placeholder. Internal consumers are unaffected: release version
rewrites pin exact calver versions, so nothing inside the release package set
resolves through `latest`.

For the real `--publish` step, the maintainer machine must already be authenticated to npm.
If `npm whoami` returns `401`, first run `npm logout --registry=https://registry.npmjs.org/` to clear any stale local auth, then run `npm login` or `npm adduser` locally as an npm org member, and finally rerun the helper.
That local human auth is fine for the one-time bootstrap publish; we just do not want the same auth model inside CI.
`--publish` requires an interactive terminal: the helper prompts for the one-time password right before the publish and again before the deprecation, handing each code to npm through its environment (`npm_config_otp`), so codes never appear in command arguments, shell history, or process listings.

After the placeholder publish succeeds:

1. open `https://www.npmjs.com/package/@paperclipai/new-package`
2. go to `Settings` → `Trusted publishing`
3. add repository `paperclipai/paperclip`
4. set workflow filename to `release.yml`
5. optionally go to `Settings` → `Publishing access` and enable `Require two-factor authentication and disallow tokens`
6. only then set `"publishFromCi": true` in [`scripts/release-package-manifest.json`](../scripts/release-package-manifest.json)

Once those steps are done, future canary and stable publishes for that package are automated through GitHub OIDC. The manual step only reserves the name on npm; every real version ships from CI.

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
