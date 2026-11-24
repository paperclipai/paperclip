# Workspace storage

Managed-cloud storage, managed environments, remote workspace storage, run evidence, and volume-free servers.

## Managed cloud prerequisites

A nonblank Cloud tenant token or the presence of `PAPERCLIP_MANAGED_CONFIG`
selects the managed-cloud profile. A supplied blank or invalid managed feature
document refuses startup. Without either signal, the instance remains self-hosted.
The managed profile also requires:

- `PAPERCLIP_STORAGE_PROVIDER=s3` or `storage.provider: "s3"` in the canonical
  database snapshot. An invalid explicit environment value refuses startup even
  if the snapshot selects S3.
- An explicit nonblank `PAPERCLIP_STORAGE_S3_BUCKET` or `storage.s3.bucket`.
  The self-hosted `paperclip` bucket default does not qualify. The region defaults
  to `us-east-1`; an explicit blank region refuses startup. An optional endpoint
  must be an HTTP(S) URL without embedded credentials.
- An external PostgreSQL URL from the environment `DATABASE_URL`.
  The managed profile never falls back to embedded PostgreSQL.
- A stable `PAPERCLIP_SECRETS_MASTER_KEY` supplied by the deployment secret store.
  Use the same value across replacements. The existing provider accepts 32-byte
  base64, 64-character hex, or a raw 32-byte UTF-8 string. A key file alone does
  not qualify because a replacement web server may not have that file.

Bootstrap validates the environment database URL and encryption master key before
opening the database or creating local state. Effective storage validation follows
canonical snapshot resolution, before signing keys, first-party Telemetry or app
construction. Raw canonical rows and legacy S3 imports cannot obtain a missing
bucket from schema defaults. Already-stored nonblank bucket values remain
canonical, including the deliberate name `paperclip`; prior normalization cannot
reliably establish their original provenance.
It does not contact S3 or verify credentials, bucket access, database connectivity,
or that a key matches existing encrypted data. Operators must qualify ordinary
S3 put/read/delete with deployment credentials and preserve the existing key.
AWS credentials continue to use the provider's normal SDK credential chain.
Local and self-hosted storage and key-file defaults remain unchanged.

These are prerequisites for shared storage and secrets. They do not establish
that the whole web server is disposable or that all execution and recovery paths
survive web-server replacement. Run-log/trace storage and producer retention are
separate changes.

## Managed environments

The `environments` list in `PAPERCLIP_MANAGED_CONFIG` declares instance-level
environments that boot provisions and tenants cannot edit. It holds at most one
sandbox entry (no `driver`, or `driver: "sandbox"`) and any number of
`driver: "plugin"` entries. A plugin entry names a plugin by its manifest id
(`pluginKey`) and one of its environment drivers:

```json
{
  "name": "Remote Host",
  "description": "Runs the agent on a remote host",
  "driver": "plugin",
  "pluginKey": "example.remote-host-plugin",
  "driverKey": "tasks",
  "driverConfig": {},
  "instanceDefault": true
}
```

Names and `pluginKey`–`driverKey` pairs must be unique, `driverConfig` must not
contain secret-like keys, and `instanceDefault` is allowed on at most one plugin
entry and never on the sandbox entry. Any other key refuses startup. `plugins.autoInstall`
holds catalog keys, not manifest ids, so boot also refuses to start unless an
auto-installed bundled or distribution catalog entry installs the entry's
`pluginKey`.

Boot validates the driver config through the plugin, marks the row
`managedPluginEnvironment: "<pluginKey>:<driverKey>"`, and adopts an existing
unmarked row for the same plugin and driver. While the plugin is down, the row is
archived; it comes back when the worker is ready. Removing an entry never archives
its row.

Boot fills the instance default only when it is unset, names the local
environment, or names a deleted one. A plugin entry with `instanceDefault` fills
first, right after its ensure; then, under `enableManagedSandboxOnly`, the
managed sandbox fills. So a new instance gets the plugin environment, and an
existing instance keeps the default it already has. If the plugin is down at a
new instance's first boot, the managed sandbox fills the default instead, and the
plugin environment does not replace it later. Recovery after boot never fills.
Like an admin's default write, the plugin fill declines while an active agent
that follows the default has not been prepared by that plugin; the managed
sandbox then fills as usual. The fill locks the default row and rechecks it, so a
concurrent boot or admin write is never overwritten. A filled default is an
ordinary set value: nothing reverts it when the mode is later turned off, and an
admin can change it in instance settings.

`server/src/services/managed-config-capabilities.json` lists the managed-config
capabilities a release supports, for the control plane to read at a release
commit. It must equal `MANAGED_CONFIG_CAPABILITIES` in `managed-config.ts`
(`managed-config-capabilities.test.ts` checks this), and the parser accepts plugin
entries only while that list includes `pluginEnvironments`. When sending a plugin
environment, include `runnerLifecycleMode` only if the target release also lists
`pluginEnvironmentRunnerLifecycleMode`.


## Experimental native remote workspace storage

`experimental.remoteWorkspaceStorageEnabled` is a managed feature, on by default
for Cloud and self-hosted instances. New Paperclip Runner sandbox workspaces
enroll automatically when durable storage is configured and the fresh source is
supported. Existing host workspaces and configured local folders retain their
legacy behavior until explicitly imported; the default does not convert them.
The local, SSH, and plugin environment drivers, legacy adapters, and Dot keep
their existing paths.
An explicit stored `false` disables new enrollment, and a managed setting takes
precedence over the stored choice. Enrolled workspaces retain remote authority
when enrollment is disabled; losing a storage prerequisite fails their admission
instead of falling back to a controller checkout.

After enrollment, roll back only to binaries that understand the same remote
workspace authority and saved-version format. Older local-only binaries are
unsupported rollback targets.

This mode requires an external PostgreSQL `DATABASE_URL`, configured S3 storage,
and the same encryption master key on every replacement server. The managed
profile requires `PAPERCLIP_SECRETS_MASTER_KEY` as described above. Self-hosted
instances may instead preserve their existing configured
`PAPERCLIP_SECRETS_MASTER_KEY_FILE` across replacements. An embedded database,
local-disk object storage, or a newly generated replacement key cannot provide
this durability contract. New workspaces continue through the legacy path when
these prerequisites are absent. Validate S3 put/read/delete and database access
with the deployment credentials before enrollment.
Snapshot expiry also needs `s3:ListBucketVersions` on the bucket and
`s3:DeleteObjectVersion` on the snapshot object prefix. S3-compatible endpoints
must support version listing. Retention verifies that every version and delete
marker is gone. Denied permissions and object locks keep a retry obligation.

The sandbox holds current working files. PostgreSQL records its location,
writer epoch, and committed snapshot; encrypted immutable snapshots live in S3.
S3 multipart uploads stream up to four parts concurrently. One producer reads
the source in order, and bounded stream buffers preserve backpressure. Failed
uploads cancel and settle their active requests before multipart cleanup.
Snapshot publication still requires full object hash and size verification.
Snapshot hashing, encryption, and decryption run on worker threads
(`server/src/storage/file-crypto-pool.ts`), so they do not hold the server's
thread. The Content-MD5 of each uploaded part is computed the same way. At most
two jobs run at once, each through two reused 1 MiB buffers. A waiting job holds
file names, not file contents, and a cancelled job stops at its next chunk.
Every integrity check runs as before, with the same failures; archive contents
and saved snapshot formats are unchanged. Reproduce the effect on the server's
thread with:

```sh
pnpm --filter @paperclipai/server exec tsx scripts/benchmark-workspace-snapshot-crypto.ts --mib=1024
```

The benchmark saves and restores one synthetic archive through the real storage
functions and the real S3 client. The object store is a local process that
checks each part's Content-MD5. A third process requests a trivial route from
the measured server and times each reply with its own clock. It reports
main-thread busy time, the longest event-loop delay, process CPU time, wall
time, peak memory, and the latency of the unrelated requests. To compare two
revisions, run it from a checkout of each. The result is synthetic: the store
is on loopback without TLS, and sandbox transfer is excluded.

Archive transfers that still stream on the server's thread use bounded 1 MiB
filesystem stream buffers to reduce event-loop handoffs under background load.
Reproduce that scheduling effect with:

```sh
node --expose-gc scripts/benchmark-workspace-archive-io.mjs
```

This bounded benchmark alternates three baseline/treatment pairs over the same
32 MiB archive with 5 ms of competing main-thread work per turn. It runs real
hashing and encryption file passes, compares plaintext and ciphertext digests,
and reports callback counts and diagnostic peak memory growth. Larger buffers
trade additional bounded stream memory for fewer scheduling handoffs. The result
is synthetic; it does not identify the competing workload or establish hosted
finalization latency, and excludes sandbox, database, and object-storage time.

Preparation creates a saved baseline, and native finalization saves the stopped
writer's files before releasing its persistence obligation. Replacing a
webserver reconnects to the recorded allocation without copying files back to
a controller checkout. Saved versions restore in a new sandbox without the old
host, sandbox, or Git remote. Files changed since the last save still depend on
the live sandbox: losing that allocation can lose those edits. There is no
periodic workspace backup in this release.

Remote workspace command timeouts report `remote_workspace_operation_timed_out`
with the operation (`prepare`, `repository`, `archive_helper`, `capture`, `restore`,
or `cleanup`) and its timeout in milliseconds. Command output is excluded from
that diagnostic. A timeout does not prove the remote process stopped or that a
save failed before publication. Reconcile the existing workspace and operation
receipts before recovery; the transport does not automatically repeat the command.
The internal helper commands suppress Node runtime warnings so their fixed
failure labels stay separate from warning text. Actual command errors still
fail the operation. This does not change an agent process's environment.

Loading an encrypted saved snapshot cancels its storage request after five
minutes without incoming bytes, including a wait for response headers. Incoming
bytes renew that idle deadline, so a large download can take longer while it
makes progress. The failure is `remote_workspace_snapshot_download_stalled`;
private download scratch is removed before returning and the saved snapshot is
unchanged. Preparation offers its existing bounded retry only after rechecking
the same clean saved version and workspace owner. Caller cancellation still
cancels the request and does not become a download timeout.
Export cleanup keeps this typed timeout diagnostic in the operation's
`metadata.exportCleanup.lastError`. Other cleanup errors retain a generic message.
The saved snapshot stays acknowledged and the cleanup obligation stays pending
until the existing reconciliation path settles it.

Files reads use the current committed saved version when remote authority is
clean and has no active writer, even while its old allocation remains recorded.
The saved loader verifies the company, workspace, snapshot, and archive before
reading. Dirty or writer-owned authority uses the live allocation and cannot
substitute an older save if that allocation is unavailable. A saved read permits
cleanup to clear its recorded allocation while the epoch, snapshot, source,
clean state, and absent writer stay identical. A new or reintroduced allocation
still invalidates that read. Live reads retain the full allocation fence, and
private saved-file copies are removed after use.
Embedders that omit the optional saved-file loader keep valid live reads. They
still report unavailability when neither a live location nor a loader exists.

Existing local task workspaces require an explicit import. Run from a source
checkout with the deployment's database, S3, and key configuration loaded:

```sh
pnpm --filter @paperclipai/server exec tsx scripts/migrate-remote-workspaces.ts \
  --company-id <company-uuid> --workspace-id <workspace-uuid> --dry-run
pnpm --filter @paperclipai/server exec tsx scripts/migrate-remote-workspaces.ts \
  --company-id <company-uuid> --workspace-id <workspace-uuid> --apply
```

Dry-run is the default and reports eligibility and blocking reasons without
importing. Apply retains the source folder, uploads an encrypted snapshot,
independently restores it for verification, rechecks source/writer state, and
atomically activates remote authority. Active execution, unresolved operations
or recovery, unsafe paths, and explicitly concurrent shared writers block
import. An interrupted apply retains its journal and admission hold; retry the
same command to reconcile it before starting another writer.

An import preserves the workspace's lifecycle state and the task's current
workspace binding. It can import an archived or superseded workspace without
reopening the task or selecting that older workspace for future turns. A changed
task binding during the import blocks publication.

If an archived folder has already been removed, the importer can reconstruct it
in private scratch space from its encrypted task-directory restore point or
validated Git restoration recipe. For older Git workspaces without a recipe,
it requires a successful branch-deletion receipt and the exact saved commit in
the verified source repository. It never substitutes today's default branch.
Git restore points retain unpushed history and staged and unstaged edits, even
when the source repository has pruned the saved branch. Missing, expired,
corrupt, or unbound sources block the import. Publication still requires an
independent download and restore of the new encrypted snapshot. The old folder
remains absent, and the importer does not change the original restore point.

An interrupted archived Git import reuses its original uploaded archive after
authentication, including when the upload reply was lost. It does not rebuild
that archive from today's remote branch pointers. The original import journal,
restoration recipe, task binding, and execution fences must still match before
publication. Saved nested sources must still belong to the same company and
project with the same repository URL; publication locks and rechecks those source
rows. Imports from mutable local folders still recapture and compare the
current files; a saved upload does not permit later local edits to be discarded.

If every recorded snapshot upload is definitively absent, an unpublished
archived Git import can recapture the same validated logical source. Private Git
administrative bytes can differ between reconstructions. The original journal
and every upload attempt remain recorded; available prior uploads and concurrent
publication winners are reused. Unknown or corrupt objects block recapture.
The source recipe and ownership checks still gate authority publication.

When the verified Git source still exists, reconstruction also copies its local
`info/exclude` rules into the private repository before applying a saved restore
point. This keeps saved ignored files, including recovery receipts and bundles,
in their original classification. The source ignore file stays unchanged.
Symlinked, oversized, or changing source ignore files block reconstruction.

Archived imports restore nested linked checkouts as private standalone
repositories. The saved branch name belongs to the old path, so reconstruction
does not register a new worktree or reset a branch in the shared project cache.
A verified cache can supply Git objects without copying its current working
files. Each private copy retains the restore point's extra commits under local
refs so they survive portable archive capture and garbage collection. Ordinary
linked-worktree recovery still requires its original path ownership.

Shared physical folders require Cloud's offline enrollment maintenance process.
A task-level hold cannot fence another workspace record pointing at the same
folder. Maintenance verifies that legacy deployments have stopped and that no
runs are active or queued, then imports nested task directories before parent
roots. A parent can omit a runtime-created nested task folder only after an
independent restore and source comparison prove that its committed snapshot
covers those bytes. The parent snapshot records that dependency, and retention
pins the child snapshot until the parent is deleted. Changed or unavailable
nested data blocks publication. Ordinary user folders remain in the archive.
Interrupted maintenance resumes the same import journals; completed records
leave the pending set. Original folders remain on the retained volume.

Supported sources include empty task folders, repository URLs, and managed
mutable repositories. Authorized mentioned projects attach all their configured
Git repositories as writable copies under `.paperclip-repositories/` in the task
workspace. These copies use the existing remote save/restore lifecycle and do not
write to the source project's folder. Later turns retain their saved paths, refs,
pins and edits, and recheck each retained project's access and trust policy.
New repository attachments after a save are acquired separately from the saved
archive. Repository refs use `repoRef`, then `defaultRef`, then the Git remote's
default. A configured remote branch is resolved before its checkout is published.
Configured local folders use the legacy path until imported. V1 rejects explicitly read-only sources
and custom cleanup/teardown commands on remote close. Automatic Core services, manual workspace jobs, services,
and runtime commands are also rejected before any local directory access; run
those commands through an agent task. One writer owns each logical
workspace; separate workspaces can run concurrently. The Files panel identifies
**Live workspace** and **Saved copy** with its save time. An unavailable dirty
allocation is not silently replaced with an older saved copy.

Workspace validation failures show their redacted explanation in the task's
failure notice. They retain the normal Retry permission and admission gates.
Retained-folder access and trust denials use this explanation; low-trust project
boundary denials retain their dedicated project-access action.

Remote archive capture retains fixed validation failures and a closed set of
Node filesystem codes as `remote_workspace_archive_fs_<errno>`. The transport
accepts exact diagnostic messages from separate or combined command output.
Paths, filenames, file contents, and unknown errors remain redacted. The existing
full-disk and unfinished-Git messages keep their priority. These diagnostics
describe a failed capture attempt; saving and recovery still require their
ordinary verified receipts.

A child or follow-up task can use a remote workspace inherited through its
persisted task binding, including an isolated workspace or operator branch.
Reservation checks current task/run access and all retained workspace sources.
The original `sourceIssueId` remains provenance; it does not prevent authorized
bound tasks from continuing saved work. Explicitly selected roots follow the
same binding contract and the [filesystem access boundary](workspace-repositories.md#filesystem-access-boundary-2026-10-20). Task-assignment
grants are not filesystem permissions. The single-writer fence still applies.
If reservation finds a current running writer, the bound task uses the existing
workspace wait and scheduled retry path, including for isolated workspaces and
operator branches. Reservation does not acquire another allocation or change
the writer's saved files. A stale writer or a stopped writer with unfinished
saves still requires reconciliation; contention retries cannot clear that fence.
The wait retains the run's admitted assignment role so reassignment during
preparation cannot resume the former assignee through the guest-run path.

Use the focused `remote-workspace-*` and `remote-workspaces.integration` suites
for storage, import, retention, and lifecycle regression checks. These checks do
not qualify a deployed Runner/provider or a zero-outage webserver deploy. Keep
the existing persistent volume until the other instance data paths and deploy
handoff are separately qualified. See the
[snapshot storage contract](#experimental-remote-workspace-snapshots).

## S3-backed run evidence

New logs and opted-in provider traces automatically use the instance's existing
S3 storage configuration, bucket, credentials and prefix, under `run-logs/` and
`provider-traces/`. No extra storage switches are needed. Local-disk instances
remain local. See [run evidence storage](run-evidence-storage.md) for required provider
capabilities, stable keys, operating limits, automatic history migration and qualification.
Do not remove a web volume until its complete retained evidence inventory and
the independent disposable-server requirements are satisfied.

## Volume-free execution admission

With `PAPERCLIP_EPHEMERAL_SERVER=true`, workspace preparation requires Paperclip
Runner and remote workspace storage. A fresh run still has its initial `legacy`
label at this phase; that label is not the selected execution mode. The runtime
selector checks the resolved native warm lifecycle before admission and rejects
legacy or per-turn execution. External conversation providers keep their existing
exemption because they own no task filesystem. Source resolution checks this
contract again before a configured host folder can fall back to local storage.
When the task source's project uses plugin storage that the selected
environment cannot serve, the refusal names that storage and environment and
ends the run `configuration_incomplete` (reason
`project_storage_environment_incompatible`). See
[project-environment-compatibility.md](project-environment-compatibility.md).

A replacement controller reconstructs an active remote agent-directory cache
from the registered sandbox, including unsaved files. The remote directory,
lease and save baseline remain unchanged; current canonical files are never
uploaded over the retained execution. Remote collection and cleanup serialize
through Postgres across controller homes. A missing remote collector retains a
pending save instead of treating an empty local cache as the agent's files.
A run whose instruction preparation finds another operation on the same
agent's directory holding that lock does not fail. Before native admission it
is cancelled as an expected wait and a `agent_directory_busy` retry is
scheduled 5 to 15 seconds later; this lane spends no failure retries and stops
after 30 attempts. A native run resuming on its own saved state instead stays
on the same run and is rescheduled through the same-run retry schedule; its
count is kept on the run's context so a resume claim does not reset it, and a
Stop, a lost lease or a moved task leave it to normal settlement. A busy lock
met while collecting files after a turn is not deferred this way.

Agent configuration writes refuse external instructions on a volume-free
server. An agent's managed instruction paths are saved as absolute paths under
the home of the server that wrote them, and each replacement server can have a
new home. When a configuration change keeps the saved `instructionsFilePath`
of a managed bundle, the bundle stays managed and its paths are rewritten under
the current server's managed root. A change that sets a different
`instructionsFilePath` is classified from that path and is still refused when
it points outside the managed root.

### Runner controller state on a restarted volume-free server

A volume-free server keeps Runner controller files under
`runtime/paperclip-runner/durable-sessions/` while it runs. Its durable record is
the Postgres checkpoint, so those files are disposable. Early in startup, before
any controller can write, a volume-free server claims an empty (or absent) state
directory by writing `.volume-free-owner.json` there. A later start that finds
this marker treats every file in the directory as its own, and the data
eligibility gate does not count it as legacy volume data; normal restart
recovery reconciles it as it would after a crash of a volume-backed server. A
server started without `PAPERCLIP_EPHEMERAL_SERVER` removes the marker, because
from then on it may write files that exist only on that disk.

A volume-free server that finds files it did not claim (a mounted legacy volume,
or a directory written before this marker existed) logs a warning and keeps the
existing protection: if the native controller check finds state the database does
not prove, startup refuses and the error names the run, the task and the file,
because that file may be the only copy of the run's progress. Adopt it with the
native controller migration first.

## Experimental remote workspace snapshots

Migration [0421_bright_skaar.sql](../packages/db/src/migrations/0421_bright_skaar.sql)
adds the company-scoped `execution_workspace_snapshots` ledger. It records the
workspace, source operation/run, parent, generation, writer epoch, encrypted
object receipt, hashes, manifest digest, and retention state. Integrity and key
fields remain nullable while an upload is pending. Upload attempts record their
candidate object keys before I/O so a lost reply can be reconciled and abandoned
objects can be reclaimed. Object existence alone is not a committed save.

`execution_workspaces.metadata.remoteWorkspace`, schema
`paperclip.remote-workspace.v1`, holds the source, epoch, committed snapshot ID,
remote allocation/path, writer run, and dirty flag. Paths in this record belong
to the remote allocation. Save publication checks the current writer/epoch and
atomically commits the ledger row, authority pointer, and operation receipt.
`execution_workspaces.metadata.remoteWorkspaceSnapshotRepositories` records the
committed snapshot ID and the repository descriptors covered by that archive.
Reservation retains this coverage when it adds requested repositories to the
current source. Successful save publication advances coverage and the snapshot
pointer together. Older saved workspaces capture their previous source inventory
at the next reservation. Newly attached repositories use normal acquisition;
they cannot claim coverage from an older archive. No schema migration is needed.
`workspace_operations` journals preparation, save, restore, and local import;
large file bodies stay outside the database. Ledger identities deliberately
survive source-record deletion so object cleanup can finish.

Snapshots stream through authenticated encryption into S3. Portable archives
preserve supported files, modes, empty directories, confined symlinks, and Git
checkout/index/object state, including unpushed history. Linked worktrees and
object alternates are normalized into standalone Git storage. The versioned
exclusion policy omits runtime transport material and proven rebuildable
dependencies; unsupported entries fail the save.

The current snapshot and active run/restore/recovery/unfinished-operation
references pin saved data. Unreferenced superseded versions receive a seven-day
grace. Retention uses committed producer notifications and actual deadlines;
pinned history and an empty queue do not cause recurring scans. Deletion fences
new adoption, rechecks references, and removes every recorded upload candidate
and winning object within the company/workspace prefix.

When retention finds a pinned version, it records the first reference that holds
it in `metadata.retentionPin`: the current pointer, an importing parent, an
operation, an unfinished child, a run, or a recovery action. The candidate query
leaves that version out while the recorded reference still holds, so execution
notifications do not re-examine unchanged history. When the recorded reference
releases, the next pass checks every reference again. It records the next
reference that holds, or schedules or retires the version. The record is durable,
so a restarted server keeps the exclusion. A version without a record, such as
one saved before this change, is examined once. Wakes coalesce for up to one
second.

Database backups contain snapshot receipts, not S3 payloads or encryption keys.
Disaster recovery requires the database, object store, and original master key.
Unsaved live sandbox edits remain outside that saved-version guarantee. See
[setup and explicit local import](workspace-storage.md#experimental-native-remote-workspace-storage).
