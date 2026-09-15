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

The publisher validates both package archives first, then submits each missing
package without waiting for the other to become visible. One visibility poll
checks both accepted packages, so their registry propagation delays overlap.
The publisher succeeds only after both packages pass the identity and
distribution-pin checks. A visibility timeout names the package still missing.

The final `stack-deploy-result` artifact contains `result.json` with contract
version 1, request ID, SHA, stage `build`, and status `ready`. It expires after
30 days. This confirms artifact availability; it does not certify a tenant deploy.

## Publishing configuration and isolation

### Migrator publication on merge

The `Cloud artifacts` workflow starts a `cloud-migrator` dispatch of `release.yml`
for every push to `master`. This dispatch builds and publishes only the exact-source
`@paperclipai/shared` and `@paperclipai/db` preview packages. It starts independently
of the full npm release and does not wait for the Docker image. The normal Docker
workflow supplies the image separately.

The run title is `Cloud migrator <FULL_SHA>`. A successful `Cloud artifacts`
dispatch job only confirms that GitHub accepted the request. Inspect the matching
`release.yml` run to confirm publication completed. This path does not produce a
`stack-deploy-result` or certify source-test success or deployment readiness.
Cloud must still verify all deployment prerequisites.

To retry one commit, dispatch `release.yml` on `master` with `channel=cloud-migrator`,
the full SHA as `source_ref`, a new UUID v4 as `request_id`, and `dry_run=false`.
`preview_migrator` is not required for this channel. Existing packages are verified
and reused. Preview and migrator-only runs use separate workflow concurrency
groups. Only their package publication jobs share a group for the same SHA, so
they cannot publish the same version concurrently and the migrator does not wait
for a preview's image build. Different SHAs publish in separate groups; the full
release keeps its existing group.

### Publisher identity

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

## Direct cloud migrator artifacts

`cloud-migrator-artifacts.yml` builds the DB and shared preview packages on each
canonical `master` push. A manual run also requires `master` and uses its exact
commit. This workflow runs on GitHub-hosted runners. It has no PR trigger.

The build resolves a complete npm lockfile from the two local archives. It then
pins their download URLs to immutable, content-addressed objects. The cloud
migration runner can use `npm ci` with this lockfile before either new package
version is available on npm. Existing external dependencies still come from npm
and carry SHA-512 integrity pins. Package lifecycle scripts remain disabled.
Before upload, the build job smoke-installs the real archives and their complete
external and bundled dependency graph with an empty npm cache. It imports both
installed packages. This check uses local archive URLs because public objects
do not exist yet; all versions and integrity pins remain unchanged.

Artifacts use the existing runner-history S3 bucket and CloudFront distribution,
under the separate `cloud-migrators/v1/` prefix. The manifest at
`https://d1p6rlowie26tp.cloudfront.net/cloud-migrators/v1/<full-sha>/manifest.json`
records the full source SHA, exact preview version, and the size, URL, and SHA-512
hash of each archive and the lockfile. Blob URLs include the content hash.
The publisher validates the complete bundle before any write, writes all blobs
before the manifest, and verifies downloads through the public endpoint.
A retry reuses a complete existing manifest after verification. The publisher
also creates a GitHub/Sigstore build-provenance attestation for the manifest
before upload. This independently binds all package and lockfile content hashes
to the canonical workflow, master ref, repository identity, and source commit.
Cloud must verify this signature and its certificate claims before accepting
the executable archives; hashes served by the artifact store alone are not
sufficient provenance.

The build job has no AWS credential. The publish job downloads only the four
fixed files, validates them, and uploads them without executing their code.
The dedicated `paperclip-cloud-migrator-github` OIDC role trusts only
`repo:paperclipai/paperclip:ref:refs/heads/master`. Its policy permits prefix
listing and conditional `PutObject` calls in this one prefix. It permits no
object deletion or overwrite. PRs, including allowlisted PRs, cannot assume it.

The deploy policies are checked in under `.github/cloud-migrator-deploy/`:

- `trust-policy.json`: the role trust policy.
- `upload-policy.json`: the role's inline permission policy.
- `cloudfront-read-statement.json`: append this statement to the existing bucket
  policy, preserving its other statements and public-access blocks.

There is no lifecycle expiry on this prefix. Keep referenced artifacts for
rollback; deleting them can prevent a fresh migrator install for an old release.
Cloud readiness consumes the signed direct bundle after its exact-source
publisher succeeds. It retains source verification, image identity, and the
cloud runner's integrity and migration compatibility checks. The cloud direct
artifact switch must be enabled before adopting this gate. Automatic npm-only
migrator dispatch is removed; explicit npm previews and manual migrator runs
remain available. See `doc/cloud-build-readiness.md` for coordinated rollback.

Local verification:

```sh
node --test scripts/cloud-migrator-artifacts.test.mjs
node scripts/cloud-migrator-artifacts.mjs verify <full-sha>
```
