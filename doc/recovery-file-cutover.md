# Check existing recovery files before web-server replacement

This check covers only observed legacy files on one explicitly selected instance.
There is no verified production backlog. An empty installation needs no migration.
This check does not inspect Postgres obligations, Runner delivery, other volumes,
other instances, or the rest of web-server replacement readiness.

Use the retained volume and the instance root from the old server configuration.
The instance root is the directory that contains `accounting-receipts/` and
`quota-credential-recovery/`. It is not the parent directory of all instances.
Use canonical absolute paths. The check rejects symlink components, including
system aliases such as `/var` on macOS; use the actual `/private/var` path there.
The chosen instance directory must exist. Missing recovery directories are normal.

Run this command from a checkout that includes the check. Node is the only runtime
dependency. It needs no database connection, master key, or package installation.

```sh
node scripts/recovery-cutover.mjs --instance-root /absolute/retained/instance
```

The default command reports JSON and exits successfully even when work remains.
For an automation gate, add `--check`:

```sh
node scripts/recovery-cutover.mjs --instance-root /absolute/retained/instance --check
```

| Exit code | Meaning |
| --- | --- |
| `0` | Report produced; with `--check`, all three scans are clear |
| `1` | With `--check`, unresolved files or an unknown/incomplete scan block cutover |
| `2` | Invalid arguments or the inventory could not run |

The sandbox directory defaults to `data/sandbox-orphan-cleanup/` below the chosen
instance. If the old server uses `SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR`, supply that same
environment value when running the check. An explicit `--orphan-directory` takes
precedence. A relative or empty override is rejected; supply its canonical absolute
path for this check. An override is an additional explicitly selected root and can
be outside the instance directory. The check does not search for other overrides.

```sh
node scripts/recovery-cutover.mjs --instance-root /absolute/retained/instance \
  --orphan-directory /absolute/retained/orphans --check
```

The report gives one summary for each of the three recovery kinds. It never
prints filenames, input paths, file contents, identifiers, token values, decrypted
material, or raw filesystem errors. `unverifiedFiles` includes every regular file,
including JSON, temporary, probe, truncated, corrupt, and unreadable files. The
check does not read file bytes and cannot claim that a file is valid or settled.
That decision belongs to the existing recovery owner and its format definitions.

Only the credential directory's immediate UUID company directories are traversed;
empty company directories are normal after recovery. Accounting and orphan files
use flat directories. Unexpected directories, deeper nesting, symlinks, and
special entries count as `unknownEntries` and block. The check does not follow
symlinks or inspect unexpected subtrees. Directory/stat/close failures increment
`readFailures` or leave the scan incomplete. An invalid or missing instance root
also blocks; it is not an empty installation.

The default shared budget is 10,000 observed entries across all three scans,
including company directories. `--max-entries` accepts 1 through 100,000. At the
limit the scanner reads at most one extra entry per open directory to detect
truncation. An unfinished scan reports `complete: false` and status `unknown`.
Counts are observed lower bounds, not total records or total pending operations.
A complete scan with any files reports `blocked`; any uncertainty reports
`unknown`. Only a complete empty scan reports `clear`.

For the final cutover gate, stop the old producers first and retain the old volume.
Run the check after the relevant recovery owners finish their work and producers
are stopped again. A live scan is a point-in-time inventory, not an atomic drain
certificate. Concurrent renames or writes invalidate the snapshot; the tool does
not lock writers or protect against a hostile process that changes paths during
inspection. Do not use it to certify a live writable or untrusted volume.

If files exist, keep the old volume and let the existing owners settle actual
entries with their existing permissions and database checks:

- Accounting: `run-cost-accounting.ts` uses the `usage-receipts.ts` replay and
  per-run recovery paths. The receipt owner validates the accounting envelope and
  handles database conflicts and settlement.
- Credentials: `ai-connections.ts` and `ai-connection-runtime.ts` use
  `quota-credential-recovery.ts` during account credential access and refresh.
  The owner validates encrypted material with the original instance master key
  and preserves grant, company and credential version fences.
- Orphan cleanup: `environment-runtime.ts` exposes `flushDeferredOrphanCleanups`
  to the existing cleanup lifecycle. `sandbox-orphan-cleanup-spool.ts` owns the
  record format and removes a file only after the recovery path saves ownership.

These are service entry points, not standalone operator commands. This change
adds no import, deletion, replay, decryption, or bulk migration command. Do not
trigger new paid runs or token exchanges merely to empty the report. If an owner
cannot settle a record, preserve it and record an explicit reconciliation outcome
through the existing incident/operations process. Corrupt files need owner review;
they do not disappear from the gate because a recovery reader skipped them.
Never delete unresolved files to obtain a clear result. An approved exception
requires separate evidence; this tool continues to block while the files remain.
Retain the volume and required secrets through rollback compatibility review.

Verify the check without any real instance data:

```sh
node --test scripts/recovery-cutover.test.mjs
```

The tests use disposable synthetic directories and spawn the actual CLI. They
cover pending legacy layouts, malformed bytes, temporary files, empty directories,
symlinks, overrides, scan limits, safe diagnostics, failure injection, exit codes,
and preservation of source bytes. They establish file inventory behavior only.
They do not establish that any production volume is clear or that domain recovery
has completed.
