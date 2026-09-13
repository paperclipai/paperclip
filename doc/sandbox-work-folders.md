# Sandbox work folders

Shared folders can contain saved files from several sandboxes. The cached-file inspector keeps earlier run failures visible with a **View failed run** link, separately from the last successful save time and direct file-operation errors.

Finalization runs once per execution, including its file flush and session-state
publication. Repeated error cleanup keeps the original failure visible. A later
authorized run recovers unsaved edits from the retained sandbox before loading
incoming shared files; it does not rewrite the failed run as successful.

Reusable sandbox resume resolves provider configuration from the recorded lease,
as workspace operations and cleanup do. This preserves provider-selected defaults
such as Daytona's region when the environment leaves them unspecified. Existing
configuration and identity checks still reject incompatible reuse; stopping and
resuming a compatible lease must reopen the same account-scoped provider handle.

Task workspace binding follows the sandbox's `reuseLease` setting independently
of the native runner's process lifecycle. Both `warm` and `per_turn` retain the
task's execution workspace and compatible provider session; restarting the
provider process is not a request for a fresh sandbox. Local execution and
sandboxes with reuse disabled retain their existing behavior.

Session compatibility compares effective workspace settings. A project title or
description edit, and startup pinning an inherited workspace mode to the same
already-effective mode, do not invalidate the session. Actual project policy,
network settings, model, and identity changes remain compatibility boundaries.

Periodic saves are best effort for files that continue changing during a scan;
the required final flush must still save the settled working copy or visibly
retain it for recovery. A continuously rewritten file missing one periodic save
and the existing file-preview polling lag are accepted limitations. Startup
latency should be compared with the legacy folder path on an equivalent workload,
rather than treating isolated cold-start timings as an independent acceptance gate.

The deployed acceptance entry point is `pnpm test:e2e:work-folders:deployed`.
Set `PAPERCLIP_DEPLOYED_STACK_MANIFEST` to a JSON manifest matching
`tests/runner-e2e/deployed-stack.ts`, `PAPERCLIP_DEPLOYED_STACK_AUTH` to a private
0600 JSON file containing `baseURL` and a normally authorized `boardApiToken`,
and `PAPERCLIP_DEPLOYED_STACK_EVIDENCE` to an absolute output directory.
The token must belong to the manifest's `userId` and have company access. The
harness verifies that identity before file operations or paid agent execution.
The harness never launches a local server. It checks the deployed commit and
adapter inventory, exercises scoped file APIs, and starts real sandbox tasks
for every configured profile, including cold/warm Git state and real timed saves.
Cold and warm checks verify actual file bytes in all four scopes, including
nested empty executable files. Disposable Git commits use an explicit author
and committer environment because sandbox launches clear inherited Git identity.
Engine coverage is derived from each live agent's configuration. A warm pass
requires the same host-recorded physical sandbox identity and a surviving cache
marker; restoring durable files into a replacement is tested separately.
The maintainer-approved matrix is Codex, Claude, OpenCode, and Pi in both runner
generations (11 CLI/ACP profiles). Only Cursor, Gemini, Grok, and Kimi are deferred
for this campaign. Missing required profiles fail the inventory gate.
Credentials are not recorded in Playwright reports. These API checks supplement
the required browser walkthrough, two real 180-second intervals, and recovery
scenarios; passing them alone is not staging acceptance.

The separate three-turn Daytona runner qualification writes into
`PAPERCLIP_TASK_DIR` when the host supplies scoped folders. After each turn it
checks that run's final save and reads the exact bytes through the task file API.
It still checks the same sandbox, provider session, and ordered turn markers.
Runs without a scoped manifest retain the existing host-workspace assertions.
The test does not treat a missing host mirror as proof that a scoped file was lost.

The staging matrix covers legacy Codex and Claude with both CLI and ACP,
legacy OpenCode and Pi, and native Codex, OpenCode, and ACPX Claude/Codex/Pi.
Cursor, Gemini, Grok, and Kimi are excluded from this acceptance campaign by
explicit user instruction. Other required profiles must not be silently skipped.

Native Pi uses `pi-acp@0.0.33` with the official Linux x64 Pi `0.84.2`
standalone executable. The image build verifies the archive and executable
SHA-256, then starts an ACP session through the runner's descriptor-based
launcher. It does not make a model request. Live staging must still verify the
qualified OpenRouter model, work folders, saves, and recovery. The same image
exposes this Pi executable to the legacy adapter. Provider-pack shims resolve
links before locating their runtime so task-local launch paths remain valid.
Because this pinned Pi ACP adapter does not forward MCP tools, the native runner
stages a private Pi extension that reads the authenticated run-owned tool catalog.
It preserves tool schemas, idempotent call IDs, cancellation, and the bridge's
private-tool boundary. The bridge credential is injected at launch and excluded
from persisted environment records; project extensions remain untrusted.

## Existing tasks and upgrade compatibility

Session fingerprint normalization accepts exact fingerprints produced by the
previous algorithm for the same effective configuration, including an inherited
workspace mode that startup subsequently pinned. It does not waive model, secret
version, or workspace-policy changes. Subsequent session publication writes the
normalized fingerprint through the existing persistence path.

If project metadata changed before the first upgraded run, the original timestamp
cannot be reconstructed from the old hash. The host can instead verify the exact
execution-workspace fingerprint recorded by that session's last successful run.
This requires the same company, task, agent, responsible user, conversation, and
reused workspace, and matching fingerprints for every other session category.
Missing or conflicting evidence still requests a fresh conversation while retaining
working files. After normalization, the session is marked so this one-time
compatibility path cannot mask later configuration changes.

Legacy Codex and Claude session codecs retain their remote execution identity.
Sandbox conversations bind to the physical provider sandbox and environment,
so creating a new host lease record for another turn does not discard the
conversation. Older records missing this metadata can be repaired from their
last successful host run only when the company, agent, responsible user, task,
workspace, environment, provider sandbox, working directory, and conversation
all match. An explicit conflicting identity is never overwritten. Local and SSH
session matching remain separate; a replacement sandbox cannot inherit a
conversation merely because its working-directory path is the same.
Old codecs that recorded the host checkout path are translated to the sandbox
path only when both the saved workspace and its local realization prove that
exact host path and project-workspace ID. Arbitrary path changes still reset.
Codex configuration refresh replaces only the managed auth/config/skills entries;
it preserves the sandbox's rollout files and SQLite state, including WAL files.
Those provider-session files stay outside shared work-folder collections.
Claude also retains the MCP server identity used by its conversation. A
host-verified old record missing that identity may migrate with only the built-in
Paperclip server; unknown external MCP server sets do not bypass the existing
session compatibility check.
Failed sandbox acquisition retains its provisional resume claim immediately.
Startup also recovers provisional claims left active by older terminal runs;
it does not reclaim an executing run or a pending provider release. A temporary
provider startup failure therefore cannot permanently block the task's next run.
If folder preparation fails before publishing a new manifest, heartbeat explicitly
retains the lease even when the previous run completed a successful final save.

An intentional native session reset (for example, changing the model) can start a
new conversation inside the task's retained sandbox. The host authorizes this
only when it mints a new logical session ID; the runner atomically claims an
absent session directory. Existing task files and previous conversation state
remain in place. A normal continuation, restart recovery, existing partial
session directory, or saved checkpoint cannot take this fresh-session path.

Older reusable per-turn sandboxes may have a task-owned execution workspace with
no explicit reuse preference. Startup can recover that default binding only for
the same company, project, and source task. Explicit workspace preferences remain
authoritative, and workspace freshness and lease identity checks still apply.

Tasks that have already completed a sandbox run without work-folder persistence
keep their original workspace, adapter file-sync/restore behavior, and provider
session directories. Upgrading does not move, clean, or replace those files. This
compatibility mode persists across turns and sandbox expiry; it does not claim
the new scoped-folder or repository-checkpoint durability guarantee for old tasks.
New tasks enter the scoped lifecycle below. Automatic migration of an old task's
working tree into scoped folders is not performed.

Retained PRP v1 runners continue ordinary native turns without session goals.
The host checks the authenticated protocol version before probing or changing
a goal, so an optional v2 request cannot disconnect an older runner or block
its final suspension and checkpoint. Unauthenticated connections do not provide
capability evidence.

Version-1 reusable leases obtain their missing task and responsible-user identity
from company-scoped host run records. Reuse still requires matching agent, task,
user, environment, workspace, provider, and configuration fingerprint. Missing or
conflicting identity records, configuration drift, or a failed resume retain the
old sandbox and report a recovery error instead of destroying its only copy.
The provider cannot opt a new task into this compatibility mode.

Some older releases retained a sandbox without recording a workspace binding on
the task. When that binding and any explicit workspace preference are absent,
startup recovers the retained workspace from the matching task, project, agent,
responsible user, and sandbox environment. Local execution, explicit workspace
choices, and tasks that have entered scoped persistence do not use this fallback.
The normal workspace freshness and provider identity checks still apply.
After a validated legacy resume, both runner generations adopt the existing
sandbox working copy without uploading a replacement Git directory or host
overlay. This preserves its index and repository-local state. The legacy
outbound merge still saves working files to the host. A missing native sync
stamp on a pre-change lease does not make the host copy authoritative.

When an older sandbox image lacks a required runner capability, startup stages
the server-resolved runner artifact, including the vendored binary in packaged
server builds. The uploaded artifact and the controller's runner identity use
the same file. Replacement is atomic and preserves the previous launcher if
staging fails; it does not reset the task's working files or provider session.

A follow-up task run waits up to 30 seconds for a terminal predecessor to release
its reusable sandbox. While that handoff is pending, startup cannot allocate a
second workspace or resume the sandbox concurrently. An active predecessor or
an incomplete release reports a retryable resume error and preserves the lease.
The next run claims the reusable lease in Postgres before resuming the provider;
competing server processes cannot both resume the same released sandbox.
An incomplete resume keeps a provisional lease marker until provider verification
succeeds. Failed-run cleanup retains that exact lease without stopping or deleting
its sandbox, so a retry cannot silently create a replacement. Daytona refreshes
the live sandbox state on explicit resume, including externally stopped resources
whose cached handles still say running. Terminal sandbox release claims ownership
in Postgres before provider calls; duplicate completion paths and an old run's
stale lease snapshot cannot stop a newer owner. Native runs persist their selected
resource disposition independently of workspace copy-back, so recovery retains a
successful warm sandbox consistently.

An uncertain provider stop leaves a durable release claim and reports
`sandbox_release_recovery_required`. Startup cannot resume that resource or create
a replacement while its stop may still be in flight. Recovery requires verifying
that the original provider operation settled before resolving the matching claim;
time passing or an application restart never clears it automatically. The working
copy remains retained, and deletion or orphan cleanup is not a fallback.
This applies to both runner generations and leaves distinct task/user bindings
isolated.
If Daytona rejects a command because its cached shell session no longer exists,
the provider creates one replacement session and retries within the original
command deadline. This applies only to a confirmed rejection before dispatch;
errors while polling or reading output never replay a potentially executed
command. Concurrent callers share the replacement session.
Native ACPX recovery also admits a provider started lazily by model selection.
Selection waits for verified process ownership before accepting the configured
model; cleanup and out-of-band process launches remain fenced. This matters
when reopening a persisted Codex session after stopping its sandbox.
The host retains the verified command snapshot and its pinned descriptors until
runtime cleanup, so reconnecting for the first turn after model selection can
launch again without reopening a mutable executable path. A failed turn-start
signal remains observable without crashing a sidecar that consumes only the
turn's event stream and result.
The new scoped-shell startup setting is not added to an existing unscoped Codex
session's protected launch arguments. Its durable provider profile remains
unchanged during attachment.

For an active native sandbox run, the app keeps the control-plane journal while
the sandbox keeps the runner journal. An app restart must verify the exact
remote run, session, runner, and lease identity; a missing controller-side runner
file is not evidence of corruption. Recovery checks the remote process marker,
Linux process fingerprint, and command-line binding before adopting a live
runner. The runner must then authenticate to its existing durable PRP authority.
Adoption preserves the provider attempt and does not launch another runner or
replace its artifacts. A dead runner can restart only from verified suspended
state. Missing or conflicting evidence preserves the controller journal and
fails recovery. Verification failures release the claimed execution lease and
persist a recovery disposition. Temporary connection failures retry after 30
seconds through the same remote verifier and consume the bounded attempt budget;
missing or conflicting authority blocks automatic replacement. The retry keeps
remote process identifiers and cannot launch a provider before verification.
Host PID checks do not establish remote process ownership.
Remote runners have a five-minute reconnect grace period for app replacement;
liveness probes share one request in flight and run at most once per second.

Acceptance must resume representative pre-upgrade legacy and native tasks with
committed, staged, unstaged, and untracked work, verify their original paths and
usable continuation, and exercise their existing restore mechanism after a
sandbox restart. A newly created task passing the scoped-folder matrix does not
establish upgrade compatibility.

## New sandbox tasks

Sandbox runs use the operating-system user's home directory. Both legacy
adapters and the native runner enter the same host-owned lifecycle before
dispatch. Local execution keeps its existing workspace and home behavior.
Legacy ACP proxies use a private host staging directory while agent sessions start
in the sandbox home. After login-shell initialization, remote agents restore the
managed Git PATH ahead of paths added by the profile. This preserves both the
Git launcher and custom runtime initialization. For API-key Codex ACP runs, the adapter writes the explicit
key to an owner-only login file in the staging copy; host credentials stay unchanged.
Per-run GitHub launchers declare their own CommonJS package scope so warm runs
inside ES-module repositories can still execute Git and GitHub CLI commands. Native runner launches carry the validated scoped paths
through both runnerd’s Rust sidecar filter and the ACPX JavaScript launch filter,
including the explicitly controller-projected GitHub broker environment. ACPX does not inherit ambient host GitHub credentials or
shell startup hooks. CLI configuration remains in its private runtime directories.
Native OpenCode preserves the same explicit GitHub binding through both its
runner proxy and provider process. It does not inherit repository credentials
or shell startup hooks from the host; provider diagnostics redact the projected
capabilities and credential configuration values.
Warm sandbox task bindings persist independently of the experimental isolated
workspace setting. Only the active host run can establish that binding; the
setting still controls user-configurable worktree operations.

```text
$HOME/
  task/      current issue's working files
  agent/     current agent's durable files
  user/      responsible user's private Paperclip files
  project/   current project's shared files
  repos/     task-specific project repository checkouts
  .codex/    CLI configuration and provider session state
  .cache/    disposable caches
```

An absent task, user, or project produces an empty, unbound directory. The
`user/` collection never copies a person's computer home directory. Existing
managed agent workspace files are imported once, excluding CLI homes, caches,
Git metadata, and conventional credential directories. Task attachments become
editable working copies whose filenames include attachment IDs; original
uploads remain unchanged. Task plans and documents are not materialized.

The agent starts in `$HOME`. `PAPERCLIP_PRIMARY_REPO` and the workspace context
identify the repository for project commands. `AGENT_HOME` and
`PAPERCLIP_{TASK,AGENT,USER,PROJECT,REPOS}_DIR` expose the bound directories.
Legacy adapters use the host-bound sandbox home for both CLI launch and skill
discovery; a private per-run runtime directory must not override it. CLI-specific
configuration remains separately staged beneath that home. Local and SSH homes
are unchanged.
Sandbox Codex tool commands preserve the environment initialized by the adapter:
login-shell execution and shell snapshots are disabled so image profiles cannot
replace the managed Git PATH. This applies to CLI and ACP execution in both
runner generations; local execution keeps its existing settings.
Legacy and native Codex ACP select the provider's `agent-full-access` initial mode only
inside a validated external work-folder sandbox with an explicit `approve-all`
binding. This avoids an inner network namespace that prevents tools from reaching
the sandbox's loopback API and Git-credential callback bridge. Local
execution and the `approve-reads` / `deny-all` modes retain their existing policy.
CLI state is separate from the four shared collections. A change of task,
agent, responsible user, or project cannot reuse a sandbox with another binding.

The cache inspector shows “Waiting for first save” until an active run has a
completed checkpoint. Missing or unavailable sync status is never labeled saved.

## Storage and synchronization

Postgres stores company/owner bindings, paths, executable bits, current object
references, trash entries, retry receipts, and each sandbox's sync baseline.
Contents use the configured `StorageProvider`: S3 or self-hosted `local_disk`.
The sandbox disk is a working copy, not the durability authority. With local
disk object storage, operators must persist and back up that storage directory
alongside Postgres. S3 recovery needs the database and bucket; it does not need
the original sandbox or application workspace volume.

Startup hydrates only the four bound collections. A warm startup first saves
uncheckpointed local changes and then downloads changed incoming files. There
is no background incoming refresh while an agent edits. Explicit refresh is
queued until the run stops, after a successful final flush.
If another writer changes a shared file between listing and download, incoming
transfer uses the downloaded version's size, hash, and executable bit. Its sync
baseline records those same bytes, so an unchanged copy cannot overwrite a later
shared edit.

Providers with native file synchronization or explicit streaming-stdin support
hydrate files through bounded stdin batches instead of one remote command per
small chunk. A batch carries at most 4 MiB of file bytes and 256 operations;
each file still uses confined paths, SHA-256 validation, and atomic publication.
Before publishing an incoming batch or applying incoming deletions, the host
persists the intended versions in Postgres. After a failed or lost response,
the next run reconciles those intents against observed disk contents before
saving outgoing changes. Imported bytes therefore cannot overwrite a newer
shared version by being mistaken for an agent edit; actual subsequent edits
still synchronize normally. Failed explicit refreshes retain the same intent.
Other providers keep the small-argument transport. Incoming storage responses
are prefetched sixteen at a time without consuming queued response bodies, and
closed if transfer fails. The transport keeps its separate bounded batch buffer.
Repository restores use the same path, then recreate confined repository links.

Read-only sandbox commands retry transient connection failures and HTTP
502/503/504 responses up to three attempts within one 120-second deadline.
Script failures, invalid responses, and authorization failures are not retried.
An incoming bulk batch has a unique ID and a signed receipt in its private
staging directory. If the provider loses the response, the host checks that
receipt: a completed batch is acknowledged without publishing its files again;
only a missing claim permits resubmitting the same batch ID. An atomic claim
prevents two concurrent submissions from applying the same batch twice. A
running or interrupted batch is never replayed. Its bounded outcome check
either observes completion or fails visibly and retains the working copy for
the next run's existing intent reconciliation. This does not make arbitrary
sandbox commands or repository mutations retryable.

Host-owned GitHub launcher staging also retries transient transport failures up
to three times within a single 15-second deadline per file or permission step.
The same run-specific file is locked, hash-checked, and atomically replaced, so
a lost reply after a successful upload does not rewrite the file on retry.
Cancellation, script failures, and invalid responses stop setup. This retry is
limited to launcher preparation; it never replays an agent or Git command.

Repository checkpoints transfer up to sixteen distinct batch-readable blobs
of at most 1 MiB concurrently, plus at most four larger streaming blobs.
Transports without batched reads retain the four-stream limit. Identical files
share one content-addressed upload. Small-file reads are grouped into at most
1 MiB and 64 files per remote command, with at most four read batches cached
per checkpoint and sixteen additional batches held by active readers.
Retries bypass that cache and reopen the actual file. All active transfers
must settle, and a second filesystem scan must match, before the
complete checkpoint reference can advance. Scoped-file retry receipts and
last-write-wins publication remain ordered.

Outgoing checkpoints run every **180 seconds**, with at most one in flight,
and a final flush when execution stops. File signatures include content and
executable state. Unchanged stale working copies do not overwrite newer shared
files. Changed files use server-accepted last-write-wins. Operation IDs persist
before transfer so a lost response retries the same operation rather than
overwriting a later writer. A failed save remains visible and prevents lease
cleanup from destroying the working copy. Providers with resume support can
recover a retained lease on the next run with the same identity/configuration,
including a lease originally configured as ephemeral.

S3 uploads observe source completion and cancel failed requests before reporting
success. Optional SDK streaming checksums are disabled to avoid an unhandled
digest rejection when a source file changes during transfer. Work-folder SHA-256
verification and complete-checkpoint publication remain required. A changing
source must fail its save without stopping the application or another run.
Scoped-file and repository-blob uploads retry transient network errors and
retryable HTTP responses up to three attempts, using the same object key. Each
attempt opens a fresh source and verifies its complete size and SHA-256; the
previous request and reader must settle before another attempt starts. Changed
content, ownership errors, and authentication failures are not retried. Exhausted
retries retain the previous complete checkpoint and the recoverable working copy.

Deletion moves files to recoverable trash. Restore rejects path collisions.
Explicit purge and permanent owner deletion schedule object cleanup through a
durable deletion journal. Overwritten scoped-file content is not versioned.
The current complete repository checkpoint remains retained while its task
binding exists. Superseded manifests and unused blobs enter a 24-hour deletion
queue; shared blobs in the current checkpoint stay protected. A save that takes
more than one hour fails visibly and must retry before its old references expire.
The scheduler retries object cleanup every three minutes; disabled heartbeat
scheduling also disables this cleanup sweep.

Every file API checks company and owner authorization. User collections are
available only to the current user and their bound, authorized agent run.
Generic company access does not grant user-file access. Background transfers
also recheck the responsible user's active membership before saving.

Paths reject traversal, control characters and reserved runtime segments.
Scoped files cannot be symbolic links or hard links. Linux transport pins
parent directory descriptors and uses no-follow opens. Repository symlinks
must stay inside their checkout, outside `.git`. Transfers stream in bounded
chunks; individual files are limited to 1 GiB, scans to 100,000 entries, and UI
previews to 8 MiB.

## Repositories

Each task owns independent clones of all project workspaces with a repository
URL. Names derive from repository names, with stable workspace-ID suffixes on
collisions. Initial clones use existing Git credentials and starting-ref policy;
the primary clone also honors the task's configured branch. Warm starts never
reset branches, clean edits, or rerun completed setup. Added repositories are
prepared at the next startup; removed bindings retain saved work. Replacement
sandboxes rerun project setup to restore excluded dependencies; an existing
warm checkout keeps both its completed setup and reusable caches.

A complete repository checkpoint includes Git objects, refs, HEAD and index,
tracked working files, and nonignored untracked files. It excludes dependencies
and generated ignored caches, Git credentials/configuration, hooks, and private
runtime state, including nested plugin repositories inside private runner caches.
Checkpoints reject in-progress Git locks and a tree that changes
during scanning. The database pointer advances only after all required objects
and the manifest have been saved. Restores verify ownership and hashes, then
publish the restored directory atomically. Git origin configuration is recreated
from the host binding. Linked worktrees and submodules using external `.git`
directories are not supported by this checkpoint format.

## API and UI

Cached-file inspection is an opt-in development tool. Enable **Allow viewing
cached task files** in Experimental settings under Paperclip Developer Mode.
Task properties then show **Files → View cached files** beneath Execution in
the Workspace section. The dialog previews and downloads the task, project,
assigned agent, and responsible user's saved collections. Missing bindings are
empty; private user files are available only to that user. Existing server
ownership checks apply independently of the visibility setting.

The inspector clearly identifies saved copies that can lag behind agent edits.
Checkboxes select files; the move-to-trash action appears only for a nonempty
selection. Each scope has Files and Trash tabs, with restoration from retained
trash. Upload, folder creation, sandbox refresh, and permanent purge controls
remain outside this inspector. It does not list repositories or the live sandbox disk.
Agent, project, and profile pages have no standalone stored-file entry points.
Live sandbox filesystem inspection remains a separate future feature. The
editable stored-file browser remains in Storybook for design reference.

All routes start at
`/api/companies/:companyId/work-folders/:scope/:ownerId`:

- `GET /`: paginated active files or trash (`trash=true`).
- `GET /content?path=...`: confined download/preview stream.
- `PUT /content?path=...`: raw `application/octet-stream` upload; supports
  `Idempotency-Key`, `X-File-Content-Type`, and `X-File-Executable`.
- `POST /operations`: idempotent mkdir, delete, restore, or purge.
- `GET /sync`: save state, last successful save, errors, and refresh state.
- `POST /refresh`: request refresh at the active run's safe boundary.

## Acceptance gate

The Cloud app image includes a build-owned remote provider pack at
`/opt/paperclip-runner/provider-pack` and configures
`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH` to that directory. Native OpenCode
and ACPX runs verify the sandbox's installed pack against this manifest. Reuse
requires a valid full manifest digest and matching content, including artifact
hashes, the distribution tree, dependency pins, platform, and Node requirements.
The source revision remains provenance; a revision-only difference does not
require retransferring identical contents. App and sandbox builds omit the
redundant `dist/bin/paperclip-runnerd` from the pack because that executable is
shipped and verified separately. If content differs, the host stages its
complete pack before launch. The pack is built
from the app revision, includes the production lockfile and artifact hashes,
and must pass its provider-launch checks during the image build. It belongs to
the app image, not the workspace volume or a scoped file collection. Ordinary
local execution is unchanged.

When diagnosing startup delays, distinguish scoped-file hydration from native
runtime preparation. `work_folder.prepared` records the intended layout before
hydration completes. `provider_pack.verify_preinstalled` reports installed-pack
verification; a fallback within `runner.artifact.prepare` can transfer gigabytes
independently of task files. Acceptance must prove that a matching image uses
its installed pack instead of silently relying on that fallback.

Both provider-pack build stages install from the immutable
`docker/daytona-runner/provider-dependencies.lock.yaml` using pnpm 9.15.4 and a
frozen install. This deployment input is separate from the CI-owned app
lockfile. Each stage checks its SHA-256 before installing, builds the provider
entrypoints under that graph, and records the installed lock in the pack.
Refresh this lock from a reviewed CI-resolved artifact when provider manifests
or patches change, update both expected hashes, and qualify a new sandbox image.
Matching source files alone does not prove matching dependencies: acceptance
also compares the actual app and sandbox production-lock hashes.

The qualification entry `build-provider-pack.mjs` (also exposed as
`pnpm --filter @paperclipai/paperclip-runner build:provider-pack`) requires
Docker with BuildKit and builds the canonical `linux/amd64` provider stage.
It uses the same digest-pinned Node interpreter, dedicated dependency graph,
and fresh TypeScript compilation as the sandbox image; host `node_modules`,
CI's root lock and previously compiled outputs are not assembly inputs.
Both Docker stages call the low-level assembler directly, avoiding recursion.
The entry verifies exported manifest and artifact bytes before atomically
replacing its output. Failed builds or validation preserve the previous pack.
This produces a local artifact and does not publish an image or release.

Native and legacy Git credential callbacks honor the same experimental duplex
setting and provider capability gates. When streaming is disabled or unavailable,
the file bridge remains supported. Credential acquisition allows 35 seconds per
request so the bridge can return its response within its 30-second window.
Transient transport failures receive at most three attempts within a 75-second
overall budget; authorization denials and invalid responses are not retried.
Only credential acquisition is retried, before starting Git or `gh`; repository
operations are never replayed. Acceptance must exercise both transport paths
and record which one was actually selected.

Controller-requested bridge shutdown marks the transport complete before closing
its provider channel. A connection loss observed earlier remains latched; closing
the native Git bridge after execution must not invent a transport failure.

Legacy sandbox cancellation stops the owned remote CLI process group or ACP
process session before waiting for run teardown and the final file flush. The
host sends a command-scoped cancellation marker for CLI execution; remote PIDs
are never passed to the host process killer. Cancellation is persisted before
stopping execution so its exit cannot admit an automatic retry. Scope registration
rechecks durable run status, and cancellation rechecks newly registered scopes
before acknowledgement, preventing cancelled startup work from dispatching.
The supervisor preserves externally delivered child termination signals. Failed stop
requests remain visible and can be retried explicitly. Local and native runner
cancellation retain their existing authorities.
Immediate recovery honors the same operator-cancellation attribution as periodic
recovery, so cancelling a run does not synthesize a continuation that restarts its
sandbox. Explicitly queued work can still run through normal promotion.
Native failure recovery also checks the durable cancellation intent under the run
lock before scheduling a retry. An interrupted turn without a semantic result
must preserve cancellation instead of reporting a provider failure. Terminal
cancellation clears stale retry retention flags so final flushing and sandbox
release still run.

Automated tests do not qualify a deployed runner image. Before merging, use a
new pinned staging stack with the branch's Cloud image and matching migrator.
The deployed harness must target that tenant URL without launching a local
server. Enumerate every sandbox-capable adapter/engine and native profile
exposed by the stack; missing credentials or skipped required profiles block
acceptance. Verify that standalone stored-file entry points are absent from
the UI, then enable experimental cached-file inspection and test the task
dialog's four scopes, previews, downloads, checkbox selection, trash, restoration,
and save feedback in the deployed browser. Record API/runner operations, two actual 180-second intervals,
short-run flushes, independent task checkouts, identity/privacy boundaries,
interrupted saves, and recovery without the original sandbox or app volume.

Repository acceptance must also read the private repository through the managed
Git launcher, for example with `git ls-remote origin HEAD`. Do not count a model's
PATH changes or credential workarounds as a pass. Native Git credential callbacks
use the internal API origin, as legacy callbacks do; the public Cloud tenant
origin requires a browser session.

Native continuation validates the full control-plane journal with the same
64 MiB bound as the runner transport. Tool output in that journal can exceed
2 MiB without invalidating its identity. Oversized, malformed, foreign-session,
and unverifiable state still fail closed and remain recoverable in quarantine.
The cached-file routes initialize storage once per router after authorization;
every request still checks current owner access. If a run ends while its save is
starting or in progress, the inspector reports the interruption and keeps the
previous successful save time visible, including across sandbox replacement.

Passing acceptance does not authorize a merge or mainline release. Both require
the user's explicit sign-off.

Cloud's `deploy:stack` tool can deploy an unpublished branch commit to an
explicit staging tenant. Run it from the Cloud checkout with the staging tenant
URL and full commit SHA. Pin the target stack first. Require the tool's migration
and readiness gates plus an authenticated tenant health response with the exact
SHA. This does not authorize a mainline release or a fleet-default promotion.

Staging migrator artifacts use an immutable object-storage prefix. The Docker
workflow's optional `staging_artifact_base_url` input builds DB/shared tarballs
and an integrity manifest as a GitHub Actions artifact; it has no release-write
permission. Supply `staging_lock_sha256` with the reviewed SHA-256 of the
resolved pnpm 9.15.4 lockfile. The migrator and both app-image builds verify
that digest before installing dependencies, failing if registry resolution
has changed. Transfer those artifacts to the staging bucket using conditional
creates, publishing the manifest last. Do not create GitHub releases or publish
npm packages for this flow.
The reusable Cloud build workflow receives those staging inputs explicitly;
splitting the workflow must not drop the app/migrator dependency-integrity gate.

Cloud enables this lane only in staging through
`CLOUD_HARNESS_STAGING_ARTIFACT_BASE_URL`. Resolve `preview:<full SHA>` through
its authenticated deployment API, then target the dedicated pinned stack.
The configured origin, commit identity, artifact integrity, migration coverage,
dependency lockfile and tenant readiness are checked before acceptance. Preview
artifacts cannot become the fleet default. Record both the build workflow and
the resulting object identities with the acceptance evidence.

On graceful app shutdown, idle native sandbox sessions are parked and checkpointed
before application services and the database close. The drain runs with bounded
concurrency and a 30-second deadline; failed or timed-out checkpoints are logged
as incomplete. Active native turns keep their existing restart/reattach behavior.
Local and SSH session shutdown behavior is unchanged. A hard process kill cannot
guarantee a provider-session checkpoint; scoped files and repository durability
remain limited to the last successfully published work-folder checkpoint.

Deployments must allow enough graceful shutdown time for that drain and other
server cleanup. On Railway, configure at least 60 seconds of draining time for
the service before testing an app redeployment; the platform default is zero.
This is a deployment prerequisite, not a fleet-default promotion. When upgrading
from a release without the idle-session drain, park warm native sessions and
verify their completed harness checkpoints before stopping the old app.

Native OpenCode binds each validated completion result to the current provider
process and turn before the controller can interrupt it. This matches the
semantic-tool response path. A shutdown interruption must preserve that exact
completed-turn authority so the session can be suspended and checkpointed.
Invalid results and conflicting identities still fail validation.

Warm native Codex attachment drains bounded informational deprecation notices
that arrive after the prior turn and its readiness probe. Notices naming another
turn, new work, and provider requests still block attachment.

The app checks the runner’s passive-notice capability before reusing an image
binary. An older binary is replaced with the app’s compatible artifact through
a temporary file and atomic rename, preserving image symlink targets and the
previous launcher on interrupted uploads. The durable checkpoint contract stays
at version 2 so existing native session backups remain restorable.

Warm continuity qualification reads the full run record before selecting the
persistence contract; company run listings omit the scoped-folder manifest.
Each completed scoped turn must have its own successful final save before the
harness reads cached bytes. The sync API exposes `finalCheckpointAt` from the
run manifest, distinct from periodic `lastSavedAt`. Qualification requires a
successful terminal run and finalization/save timestamps within that run; a
periodic save cannot substitute for completed finalization. Legacy host-workspace fallback is used only when
the full run record has no scoped manifest.

The three-turn fixture supplies a shell script that compares exact bytes before
appending and after writing. Missing or changed prior content fails without
repair; repeating the first turn cannot truncate existing work. This avoids
model-generated byte-count arithmetic while retaining independent per-turn
persistence checks and the same-sandbox, same-provider continuity requirements.

Native continuation retains its sandbox, runner-instance identity, provider
conversation, and files across runs. The existing GitHub identity contract
rotates the provider process for each run-scoped capability. Qualification
requires an explicit controller rotation event for that exact transition before
accepting a changed PID/process fingerprint; other process changes still fail.
See [GitHub execution identity](execution-github-identity.md) and the
[run-log contract](run-log-events.md#native-process-rotation).

Process metadata updates apply only while their run is active and unfinished.
Late callbacks from warm-session inspection or maintenance cannot rewrite a
completed run's process identity. Remote native process timestamps come from
the validated remote marker; an unrelated host process with the same PID must
not replace them. Active local execution retains its host process lookup.

### Claude conversations during sandbox upgrades

A sandbox Claude conversation can resume after an app upgrade refreshes shipped
Paperclip skill files or adds a built-in Paperclip MCP server. The generated agent
instructions must remain identical. Skill assignments and all non-shipped skill
contents remain part of the session compatibility fingerprint. Built-in MCP
comparison validates the exact Paperclip origin, endpoint path, name, and reserved
connection ID; assigned/external server identities must still match.

Older Claude codecs omitted remote and MCP identity fields. Migration uses the
previous successful run's company, agent, responsible user, task, workspace, and
same physical sandbox. Reconstructing an omitted assignment gateway additionally
requires the historical host invocation and its run-scoped gateway evidence.
Missing or ambiguous evidence does not authorize a builtin-only fallback. An old
prompt bundle without its newer compatibility fingerprint is eligible only when
its preserved instructions and skill symlinks prove the same shipped sources;
unknown historical third-party contents are not assumed unchanged.

Changes to the responsible identity, external grants, agent instructions, or
non-shipped skills retain the existing reset behavior. Local and SSH execution
keep their previous exact prompt-bundle and MCP comparisons. These compatibility
rules do not themselves constitute live upgrade acceptance; staging must verify
that the original provider conversation and saved work survive the transition.
