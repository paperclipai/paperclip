# Work-folder preview migration reconciliation

The work-folder branch previously assigned `0275_sandbox_work_folders` after the
mainline `0274_agent_chat` migration. Mainline subsequently assigned 0275 to
iMessage support and 0276 to AI connections. Both mainline migrations must remain
in the sequence and execute on existing preview databases.

The merged sequence preserves mainline SQL, journal entries and snapshots through
0276. `pnpm --filter @paperclipai/db generate --name sandbox_work_folders` generates
0277 and its snapshot from the complete merged schema. Its six work-folder table
definitions equal the prior generated work-folder snapshot. The reviewed
idempotent work-folder SQL is retained byte-for-byte at the generated 0277 path,
including guards for preview tables, constraints, indexes and missing sync columns.
Its SHA-256 remains
`0c62020d37107e3b2284823c2a297a8dd4b505cbdd3993a0e757c93ac8f3a257`.
No existing journal timestamp or database migration row is rewritten.

The application migrator identifies applied SQL by hash. Consequently a database
that already ran the old 0275 work-folder SQL recognizes the renamed 0277 hash,
while independently applying the missing mainline 0275 and 0276 migrations. An
older preview with the four separate work-folder migrations applies the
idempotent 0277 consolidation as well. A timestamp-only migrator cannot establish
this behavior and is not an acceptable substitute.

`packages/db/src/work-folder-preview-migration.test.ts` reconstructs both the exact
f3c67d50 history and the exact 64814d5 history from pinned SQL hashes and journals.
It seeds legacy/native tasks and provider sessions, files, trash, operation
receipts, pending uploads and unpushed checkpoint references before upgrading.
It checks data and original journal preservation, both new mainline schemas,
six-table schema equivalence, uniqueness/tenant constraints and idempotent replay.
The 64814d5 history is also the migration history used by the later d4ae130 app.
`migration-snapshot-drift.test.ts` independently compares the generated snapshot
with the merged schema.

## Cloud deployment requirement

Cloud's ordered-prefix compatibility guard must not be bypassed. Inserting the
two missing mainline migrations before the renamed work-folder migration changes
the ordered manifest even though the work-folder SQL hash is retained. Before
deployment, add a reviewed, exact-version transition to Cloud's consolidation
catalog for the actual deployed source schema marker and final target package,
including their full manifest fingerprints and required SQL hashes. The current
staging markers are the prior 08dd27e and 64814d5 package versions; an additional
f3/f4-to-target entry is necessary only for a direct upgrade from those versions.
The final target cannot be bound until its candidate revision and artifacts exist.
Snapshot, migration success, authenticated readiness and post-migration data
checks remain mandatory. This document does not authorize deployment or merging.
