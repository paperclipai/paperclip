# Versioned online workspace migration entry

A finite operator can preserve local workspaces with the canonical online
migration owners while the web process keeps its current release. It does not
start the app, a listener, a scheduler, a provider run or the offline migration
service. The web remains on its normal release policy.

## Release and data identities

Use one reviewed normal Core release tree, including its own `server`, workspace
packages, `node_modules`, Node 24 runtime and `tsx` loader. Verify the artifact's
release provenance and extracted file hashes before execution. Keep that tree
under a separate private tool root. Do not replace `/app`, mix old server modules
with new modules, install over the serving tree, or copy individual patched owner
files. Core's canonical storage registry reads the stored instance configuration;
this entry does not load a Cloud distribution overlay.

The request names both the **tool commit** and the **serving source commit and
Railway deployment**. They can differ. The tool reads its own release marker or
`server/dist/build-info.json`, ignoring an inherited `PAPERCLIP_BUILD_COMMIT` for
that check. It checks the current deployment and loopback health separately.
Run as the existing application user with the original data-home, database and
key bindings. Credentials remain in that process and are never printed.

The supported private-root mode is the unbundled source entry with the same
release's loader and module tree. The compiled entry is also usable when its
complete compiled dependency tree is present. Normal builds register
`online-workspace-migration.mjs` beside the other runtime entries, but that file
is not a self-contained portable artifact: current bundling preserves original
module locations and external dependencies. Do not move only its chunks to a
new root and treat them as a separate release.

## Request and command

Write one regular, mode 0600 JSON request, at most 64 KiB:

```json
{
  "schema": "paperclip.online-workspace-migration.v1",
  "toolCommit": "<reviewed full Core commit>",
  "toolRoot": "/private/operator/core-release",
  "source": {
    "commit": "<actual serving full Core commit>",
    "deploymentId": "<actual Railway deployment UUID>"
  },
  "companyId": "<exact company UUID>",
  "workspaceIds": ["<exact workspace UUID>"],
  "mode": "inspect",
  "deadlineMs": 720000,
  "concurrency": 1
}
```

From the tool root, use its own Node 24 and loader:

```sh
PAPERCLIP_ONLINE_WORKSPACE_MIGRATION=true \
  ./node/bin/node --max-old-space-size=2048 --import ./cli/node_modules/tsx/dist/loader.mjs \
  ./server/src/maintenance/online-workspace-migration.ts /private/operator/request.json
```

`inspect` with one member performs bounded read-only canonical inventory. With
multiple members it requires the actual cohort API and calls its `apply:false`
preflight inside a read-only transaction with storage access forbidden. It does
not combine singleton eligibility into cohort proof. The observation holds no
source fence and grants no later admission. `single` invokes one canonical
importer. `cohort` invokes the existing cohort owner once for the exact
full sorted set, one through eight unique workspaces, with the requested bounded
concurrency. A release without that owner refuses cohort apply and multi-member inspection.
Single inspection, single import and exact single-journal resume remain available. A cohort preflight
identifier is not an apply token; its durable journal remains the canonical
resume record.

`resume` requires exactly one workspace plus exact `operationId` and `snapshotId`.
It takes the existing complete source-owner scope, checks the saved running,
unfinished journal and pending/uploaded snapshot under that scope, and calls the
normal importer with the original `createDb` pool. That importer joins the live
source scope and retains its full lifecycle, source, finalizer, physical-file and
publication checks. No caller resets the journal or supplies a replacement ID.
A finished, foreign or changed journal refuses for explicit reconciliation.
Cohort retries must use the same full workspace set and the existing cohort owner;
a singleton cannot resume a cohort journal.

## Schema, cancellation and proof

Before key hydration or any publication, the entry calls the existing
nonmutating `inspectMigrations` owner against the complete tool migration
manifest. Pending schema refuses. It independently requires the nullable text
`native_run_finalizations.controller_host_hash` column. Schema application belongs
to the existing schema-prestage owner; this entry never applies DDL.

Stored runtime configuration and the existing encrypted key are read through
their normal owners. Shared S3 storage is required. Canonical migration owns all
writes, snapshots, encryption, authenticated restore, locks and recovery recipes.
The entry does not assert stopped writers, terminate an agent, clear a hold or
change remote authority. An unrelated active run is not a global-idle blocker.
An actual scoped writer, foreign alias or unsupported source still refuses.

Programmatic administrative calls to `migrateRemoteWorkspace` and
`migrateRemoteWorkspaceCohort` can pass `sourceLockWaitMs` with their existing
`signal` to join the source-lock queue. The budget covers acquisition of the
complete sorted source scope, rather than restarting for each key. Timeout or
abort rolls back that admission before any journal reservation. This opt-in uses
an independent source transaction and preserves the lifecycle and publication
checks; activity is published after commit. Omitted options retain try-only
admission. This is a canonical API option, not an additional JSON entry field.

Before each apply, use the existing per-operation memory, CPU and temporary-disk
resource preflight. A concurrency bound is not resource admission. Budget every
logical capture and up to two nested-child verifications. Qualify one single
import and a two-member cohort before considering eight, using actual RSS,
scratch headroom and elapsed-time evidence. This entry makes no implicit resource
safety claim.

The deadline is at most 720 seconds. Shutdown aborts the active operation and
awaits the canonical owner before closing only this database's process-local
clients. It does not promise instant cancellation of a dependency that ignores
its signal. An interrupted SSH session does not prove that an operator process
stopped; reconcile the durable journals before retrying.

Output includes the separate identities, canonical authority IDs, source digests,
outcome and process peak RSS. It excludes repository URLs, local file paths,
keys and database URLs. Completed operation IDs come from the exact returned
snapshot's succeeded migration journal, including a legitimately superseded
snapshot. This readback runs after publication commits. A readback failure
reports reconciliation required; it does not prove that publication failed or
authorize a blind retry. A successful import is preparatory preservation, not an
ephemeral-enrollment or zero-downtime acceptance receipt. Operational proof still
requires the reviewed release artifact, fresh source/volume witnesses, resource
headroom and actual hosted readback.
