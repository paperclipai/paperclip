# Cloud configuration migration and package qualification

This procedure covers saved adapter preferences, the allowlisted nonsecret
startup configuration, and selected bundled plugin packages. The result is a
point-in-time report. It does not authorize a deployment, guarantee zero
downtime, establish general Railway admission, or prove that a volume can be
removed. Secret and key bytes, database credentials, artifacts, logs, local
storage, workspaces, and plugin state outside PostgreSQL need their own storage
and replacement checks. This includes the decision signing key and local
encryption keys. Their byte authority is unchanged by this procedure.
Runtime environment and secret equality, plus an actual HTTP handoff between
application processes, remain separate rollout prerequisites. The package digest
does not establish those conditions.

## Migration prerequisite

Stop every legacy file writer before the first import. This includes old
application replicas and operator commands that can write configuration or
adapter settings. One maintenance window is sufficient. The importer cannot
make an old file writer participate in its database transaction. Keep those
writers stopped after import; later file edits do not update database authority.

Keep the normal database backup and recovery procedure for the instance. Use the
new release with the same managed environment and database connection. The
server runs migration before constructing configuration-dependent services.
For an explicit source-checkout invocation, use:

```sh
pnpm exec tsx server/src/qualify-cloud-configuration.ts --migrate
```

The command uses `DATABASE_URL` and the normal Cloud environment. It does not
accept credentials as arguments. It writes the receipt to PostgreSQL and prints
a JSON report; no report file or local completion marker is required. Exit code
0 means the requested configuration/package check passed, 2 means the report has
blockers, and 1 means the operation failed. A fresh installation can report a
missing plugin registration before normal boot installation completes. Run the
check again after that installation settles.

## Database authority and retry behavior

The private `instance_settings` singleton `cloud-configuration-migration:v1`
contains the versioned receipt. The transaction locks that row and composes the
adapter and startup-config owners' atomic seed methods. Completion and both
seeds commit together. A failed write or crash before commit leaves no completed
receipt. A retry uses committed database state and never replaces a later
settings revision. Earlier independently seeded owner records remain authoritative.

The receipt records source kind, a digest of the nonsecret semantic candidate,
the imported revision, and bounded legacy external-registration evidence.
An absent startup configuration remains an authoritative `config: null`; it is
distinct from an uninitialized database record. No raw secret values are copied.
Once the receipt exists, ordinary boots do not reread legacy source files.
A replacement home can be empty or absent without changing saved authority.

All legacy readers have a 64 KiB limit. They require regular files, reject
symlinks and FIFOs, and use bounded reads. External registration inspection reads
metadata only. It never loads a registered module or follows a registered package
path. A nonempty, invalid, or unreadable registration file creates a durable
blocker. Removing the old home does not clear that blocker.

To resolve an external-registration blocker, stop its writer, deliberately
remove the unsupported registration metadata at the original source location,
and leave a present valid empty JSON array file. Read the current receipt revision
from the report, then run:

```sh
pnpm exec tsx server/src/qualify-cloud-configuration.ts --recheck-external-revision 3
```

Use the actual current revision in place of `3`. A changed revision, a different
source location, or a missing/invalid source file rejects the recheck. Reusing
the same container path with an empty home is insufficient. This is an explicit
operator resolution; qualification never clears the blocker automatically.

## Current packages and overlap comparison

Every qualification reads current settings revisions and plugin registrations.
It resolves selected packages from this image with the same bundled package
identity rules as normal loading. It verifies package bytes before importing a
trusted image manifest, then compares that manifest with the approved database
registration. Missing packages, missing evidence, incompatible versions,
unselected registrations, and integrity failures prevent qualification. Legacy
package paths and npm discovery cannot supply missing image bytes.

Image inspection happens outside database write locks. A short transaction then
locks and rereads the current configuration and registration records. A change
during inspection produces a blocker and requires a new check. The report gives
`adapterRevision`, `configRevision`, `configurationDigest`, and
`packageEvidenceDigest`. A historical completed receipt is evidence, not current
authorization. Call qualification again for a current result.

The server records this report before ordinary bundled-plugin reconciliation.
It retains `lastPackageMismatch` after later successful checks, so reconciliation
cannot erase the evidence seen before an upgrade. The report does not block
normal maintenance upgrades or replace capability approval. After an upgrade
settles, its current packages can qualify normally.

For a same-package comparison, capture the current release's
`packageEvidenceDigest` and pass it explicitly on the replacement:

```sh
pnpm exec tsx server/src/qualify-cloud-configuration.ts --expected-package-evidence sha256:REPLACE_WITH_THE_64_HEX_DIGEST
```

`configurationPackagesEligible` describes current database/configuration/package
compatibility. `samePackageOverlapEligible` is true only when an explicit expected
digest also matches. There is no permanent first-release baseline that would
prevent future maintenance releases from establishing their own evidence.

The package evidence digest covers selected packages, not container image bytes.
Distribution packages reuse and reverify their catalog digest. Builtin packages
have a bounded inventory of physical file bytes, modes, and logical symlink
targets, including standalone pnpm dependency trees. With the selected catalog
root, inventory may follow links only into that provider, the catalog SDK,
`packages/shared`, and the current image's root `node_modules`. Reached pnpm
package units include their sibling dependency links; unrelated root packages
are not scanned. Canonical directory/file deduplication bounds cycles, and
logical root labels preserve the digest when identical image bytes relocate.
Dangling or escaping links, special files, more than 50,000 entries, depth above
32, metadata above 128 KiB, or more than 256 MiB per package fail verification.
The measured cached Cloud Daytona closure has about 22,253 entries and 130 MB;
that artifact predates this change and is not a complete current release proof.
Inventory work is synchronous and linear in selected package bytes. It runs only during startup before the application is constructed
or in the explicit operator process, with no idle polling. The report includes
`packageInspectionDurationMs`. Packages must remain immutable throughout a check.

## Verification scope

The focused PostgreSQL tests use two independent clients and separate home/image
roots. They import legacy settings, change saved revisions, remove the old roots,
reconstruct from the database, and start a real plugin worker from the replacement
image fixture. They also cover concurrent migration, commit failure and retry,
database failure, stale sources, durable external blockers, package mismatch,
maintenance reconciliation, and changes during manifest inspection.

The bundled-plugin registration suite also has an actual prebuilt Daytona case.
Build its standalone package with the normal SDK linker before running that case;
it is skipped when the provider build is absent. It qualifies the real linked
SDK/shared package graph and uses the production loader and worker manager for
credential-free initialize/health calls. The runtime-path tests also invoke the
production server bundler to verify its preserved module locations.

Set `PAPERCLIP_CLOUD_CONFIGURATION_TEST_DATABASE_URL` only to an owned disposable
PostgreSQL database when embedded PostgreSQL is unavailable. The suite applies
migrations and writes/deletes test records. A complete release image, hosted
replacement, overlapping production processes, secret-byte migration, and volume
removal are not established by these local fixtures.
