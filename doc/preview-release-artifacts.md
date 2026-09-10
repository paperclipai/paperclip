# Preview deployment artifacts

The `preview` channel in `.github/workflows/release.yml` builds deployment
artifacts for one immutable source commit. It does not create a GitHub release,
move a source branch, or advance any stable, beta, nightly, or canary alias.

Dispatch `release.yml` on `master` with these inputs:

| Input | Value |
| --- | --- |
| `channel` | `preview` |
| `source_ref` | Full lowercase 40-character commit SHA in this repository |
| `request_id` | UUID v4 identifying the operator's deployment request |
| `preview_migrator` | `true` when exact-source DB/shared packages are needed |
| `dry_run` | `false` |

The workflow title is `Stack deploy <request_id> build`. Consumers must find a
run by this identity, not by the latest run. Preview builds reject workflow
definitions that do not run from `master`.

## Outputs and reuse

The image uses `ghcr.io/paperclipai/paperclip:sha-<FULL_SHA>-cloud`.
Full-SHA tags keep separate commits with the same short prefix isolated. Normal
release images retain their existing short-tag convention. Build arguments carry the full commit SHA.
Preview builds do not import or overwrite the shared release cache or release
aliases. Missing images are built for Linux amd64, matching managed deployments.

When requested, both `@paperclipai/shared` and `@paperclipai/db` use
`0.0.0-preview.g<FULL_SHA>`. Workspace dependencies are pinned to exact versions.
Packages carry `gitHead` and `paperclipPreviewCommit` source identity. npm publishes
them under the `preview` dist-tag only. Normal consumers of `latest` or `canary`
continue to select normal releases.

Registry 404 responses mean missing artifacts. Authentication errors, outages,
or existing package identity mismatches fail the workflow. Retries reuse matching
published artifacts, including a shared package published before a DB publish
failure. Allow npm's visibility polling to finish before retrying.

The final `stack-deploy-result` artifact contains `result.json` with contract
version 1, request ID, SHA, stage `build`, and status `ready`. It expires after
30 days. This confirms artifact availability; it does not certify a tenant deploy.

## Publishing configuration and isolation

Configure npm trusted publishing for **both packages** with repository
`paperclipai/paperclip`, workflow `release.yml`, and environment `npm-canary`.
The image publisher uses the same environment, whose deployment branch policy
permits only master. Both publishers also check the workflow ref before running.
This uses the existing publisher identity rather than requiring another workflow
registration. The job uses npm with OIDC trusted publishing support and provenance.
The environment's existing protections still apply.

Package compilation runs in a separate job with read-only repository access and
no npm, cloud-admin, or provider credentials. Trusted tooling from `master` packs
the requested source checkout. The existing bundled-package helper takes patch
configuration from that source checkout. Build artifacts contain only the two
fixed package tarballs.

Publishing runs on a fresh runner with trusted tooling, without a checkout of
the requested branch. It checks package identity and exact dependencies, rejects
archive path aliases, and publishes with lifecycle scripts disabled and an explicit
registry and dist-tag. Image builds also run without registry write access and export a Docker archive.
A separate trusted publisher loads that archive as data, verifies its full revision,
platform, and image ID, then pushes only the SHA tag. It never runs the image.
Dependency resolution disables scripts and pnpmfile hooks. Preview actions are
pinned to full commit SHAs.

The deploying control plane must independently verify package integrity, source
identity, SQL and migration journal contents, and schema compatibility. Publish
this workflow support before enabling an operator CLI that depends on it. Test
normal release selection and a new migration-bearing branch in staging before
allowing production use.

## Local checks

```sh
node --test scripts/preview-artifacts.test.mjs
pnpm test:release-registry
pnpm -r typecheck
pnpm test:run
pnpm build
```

For a package build without publishing, install dependencies in a disposable
checkout at an exact commit, then use the trusted helper:

```sh
node scripts/preview-artifacts.mjs pack /path/to/source /path/to/output FULL_SHA
```

This executes source build scripts. Keep output outside the repository and use an
environment without publishing or cloud-admin credentials.
