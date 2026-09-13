# Sandbox work folders

The deployed acceptance entry point is `pnpm test:e2e:work-folders:deployed`.
Set `PAPERCLIP_DEPLOYED_STACK_MANIFEST` to a JSON manifest matching
`tests/runner-e2e/deployed-stack.ts`, `PAPERCLIP_DEPLOYED_STACK_AUTH` to a private
0600 JSON file containing `baseURL` and a normally authorized `boardApiToken`,
and `PAPERCLIP_DEPLOYED_STACK_EVIDENCE` to an absolute output directory.
The harness never launches a local server. It checks the deployed commit and
adapter inventory, exercises scoped file APIs, and starts real sandbox tasks
for every configured profile, including cold/warm Git state and real timed saves.
Engine coverage is derived from each live agent's configuration. A warm pass
requires the same host-recorded physical sandbox identity and a surviving cache
marker; restoring durable files into a replacement is tested separately.
The maintainer-approved matrix is Codex, Claude, OpenCode, and Pi in both runner
generations (11 CLI/ACP profiles). Only Cursor, Gemini, Grok, and Kimi are deferred
for this campaign. Missing required profiles fail the inventory gate.
Credentials are not recorded in Playwright reports. These API checks supplement
the required browser walkthrough, two real 180-second intervals, and recovery
scenarios; passing them alone is not staging acceptance.

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

Sandbox runs use the operating-system user's home directory. Both legacy
adapters and the native runner enter the same host-owned lifecycle before
dispatch. Local execution keeps its existing workspace and home behavior.
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
CLI state is separate from the four shared collections. A change of task,
agent, responsible user, or project cannot reuse a sandbox with another binding.

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

Outgoing checkpoints run every **180 seconds**, with at most one in flight,
and a final flush when execution stops. File signatures include content and
executable state. Unchanged stale working copies do not overwrite newer shared
files. Changed files use server-accepted last-write-wins. Operation IDs persist
before transfer so a lost response retries the same operation rather than
overwriting a later writer. A failed save remains visible and prevents lease
cleanup from destroying the working copy. Providers with resume support can
recover a retained lease on the next run with the same identity/configuration,
including a lease originally configured as ephemeral.

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
runtime state. Checkpoints reject in-progress Git locks and a tree that changes
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
acceptance. Verify that the removed stored-file entry points are absent from
the UI; browser-based file-management acceptance is deferred with the separate
inspection features. Record API/runner operations, two actual 180-second intervals,
short-run flushes, independent task checkouts, identity/privacy boundaries,
interrupted saves, and recovery without the original sandbox or app volume.

Passing acceptance does not authorize a merge or mainline release. Both require
the user's explicit sign-off.

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
