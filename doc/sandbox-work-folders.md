# Sandbox work folders

Shared folders can contain saved files from several sandboxes. The cached-file inspector keeps earlier run failures visible with a **View failed run** link, separately from the last successful save time and direct file-operation errors.

Finalization runs once per execution, including its file flush and session-state
publication. Repeated error cleanup keeps the original failure visible. A later
authorized run recovers unsaved edits from the retained sandbox before loading
incoming shared files; it does not rewrite the failed run as successful.

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

Tasks that have already completed a sandbox run without work-folder persistence
keep their original workspace, adapter file-sync/restore behavior, and provider
session directories. Upgrading does not move, clean, or replace those files. This
compatibility mode persists across turns and sandbox expiry; it does not claim
the new scoped-folder or repository-checkpoint durability guarantee for old tasks.
New tasks enter the scoped lifecycle below. Automatic migration of an old task's
working tree into scoped folders is not performed.

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
whose cached handles still say running. Failure to stop a reusable sandbox is
reported and retained for retry; it never falls back to deletion or orphan cleanup.
This applies to both runner generations and leaves distinct task/user bindings
isolated.
The new scoped-shell startup setting is not added to an existing unscoped Codex
session's protected launch arguments. Its durable provider profile remains
unchanged during attachment.

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
Native Codex ACP selects the provider's `agent-full-access` initial mode only
inside a validated external work-folder sandbox with an explicit `approve-all`
binding. This avoids starting an unsupported nested network namespace. Local
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
and ACPX runs verify the sandbox's installed pack against this manifest; if it
differs, the host stages its complete pack before launch. The pack is built
from the app revision, includes the production lockfile and artifact hashes,
and must pass its provider-launch checks during the image build. It belongs to
the app image, not the workspace volume or a scoped file collection. Ordinary
local execution is unchanged.

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
