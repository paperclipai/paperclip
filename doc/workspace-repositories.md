# Workspace repositories and checkouts

How task workspaces get their directories and repository checkouts, and how caches and finished worktrees are cleaned up.

## Workspace metadata reads

Task detail, heartbeat context, and closed-workspace admission guards read stored
workspace metadata. They do not inspect Git or refresh live runtime health.
Task context includes persisted runtime service state; delivery state is unknown
until an explicit close-readiness or lifecycle inspection computes it. Workspace
detail reads also return unknown delivery state without running Git or contacting
a storage provider. Use close-readiness for current Git safety checks.

## Default Agent Workspaces

When a local agent run has no resolved project/session workspace, Paperclip falls back to an agent home workspace under the instance root:

- `~/.paperclip/instances/default/workspaces/<agent-id>`

This path honors `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` in non-default setups.

For `codex_local`, Paperclip assigns new and updated agents an isolated Codex home under the instance root and blocks shared host/company Codex homes:

- `~/.paperclip/instances/default/companies/<company-id>/agents/<agent-id>/codex-home`

Paperclip also persists an empty `OPENAI_API_KEY` override for those agents so a host-level `OPENAI_API_KEY` cannot leak into Codex runs through process inheritance. If an operator explicitly configures `adapterConfig.env.CODEX_HOME`, it must not point at the shared company `codex-home`, `$CODEX_HOME`, or `~/.codex`.

Codex shell commands keep sandbox-injected certificate-trust variables (for
example `SSL_CERT_FILE` and `GIT_SSL_CAINFO`) even though the shell environment
allowlist is constructed before the sandbox injects them. See
[Codex shell certificate trust](sandbox-shell-environment.md).

If the `codex` CLI is not installed or not on `PATH`, `codex_local` agent runs fail at execution time with a clear adapter error. Quota polling uses a short-lived `codex app-server` subprocess: when `codex` cannot be spawned, that provider reports `ok: false` in aggregated quota results and the API server keeps running (it must not exit on a missing binary).

Local adapters require their corresponding CLI/session setup on the machine running Paperclip. Self-hosted instances can install external adapters through the adapter/plugin flow without hardcoded imports in `server/` or `ui/`.

Cloud-managed instances use only adapter implementations supplied by the release image. A tenant server token or the presence of `PAPERCLIP_MANAGED_CONFIG` enforces this boundary. Startup and UI parser requests do not read external adapter registrations or packages. Install, reinstall, reload, remove, and override operations return `403` with `adapter_install_platform_managed`, including for instance admins. Legacy `adapter-plugins.json` files stay untouched and do not change the built-in registry.

### Filesystem access boundary (2026-10-20)

Filesystem isolation belongs to the OS, execution environment, and storage layout.
Paperclip authorizes the current task/run, company, explicitly selected configuration,
execution policy, and repository credentials. It does not infer file permissions from
other tasks or agents that previously used the same directory, overlapping roots,
symlink aliases, or shared Git storage. Existing files under an authorized task root
may be read subject to OS access and API path containment.

Private task records, comments, attachments, run logs, full workspace metadata, and
operation logs retain their app authorization. Workspace `_issuePrivacySources` and
operation privacy metadata protect app-record disclosure; they do not grant or deny
filesystem execution or task-bound file browsing. Current trust and sandbox policy,
publication receipts, binding checks, and lifecycle locks remain authoritative.

## Project Repository Checkouts

Tasks use every distinct repository attached to their project, including repository-only sources with no local folder. Paperclip creates a managed checkout when no local folder is configured. The selected repository remains at the task workspace root. Other project repositories have editable Git checkouts under `.paperclip-repositories/<name>-<key>`. Workspace hints expose each checkout path to the agent. A repository without a configured local folder is checked out as a Git worktree of one shared managed clone per project and repository URL, on its own `paperclip/<id>/<branch>` branch tracking `origin/<branch>`, so its objects are stored once; see [Recoverable disk cleanup](recoverable-disk-cleanup.md#nested-project-repository-worktrees). Existing standalone checkouts keep working.

When an additional repository has a configured local checkout, Paperclip seeds the task copy from its current commit and uncommitted files. Git-ignored files stay out of that copy. Subsequent task edits stay in the task copy. They do not overwrite the configured source folder. Existing task copies retain their work across runs.

Sandbox staging, including Daytona, transfers each repository's Git history and working files. Restore merges files and commits back into each local task checkout independently. Durable sandbox recovery keeps the same repository snapshots. Normal ignore and workspace exclusion rules still apply. A clone failure stops task preparation with an error so the agent does not start with only part of the project.

An interrupted legacy run can retain a file recovery hold after its automatic
replay decision is resolved. The task's recovery notice remains authoritative.
After recovering and verifying files from the original workspace, a board member
with runtime access can record the evidence in that notice. This operation checks
the exact source run and stop receipts, leaves the task status unchanged, and does
not start another run. A chat reply cannot clear the file recovery hold.

Staging preserves relative symlink targets in secondary repositories, including skill links such as `.claude/skills/demo -> ../../skills/demo`. It does not rewrite them to host temporary paths or copy their target contents in place of the link. Daytona still rejects outbound archives with absolute or escaping link targets before extraction.

If a repository is detached or its source configuration changes, its previous task copy is retained under `.paperclip-runtime/detached-repositories/` and excluded from future sandbox transfers. Referenced projects continue to use the separate read-only multi-project workspace behavior.

### Isolated repository object cache

Fresh task-private GitHub HTTPS sources use a pristine upstream object cache at
`<instance root>/repository-object-cache/<company>/<opaque scope>`. The scope
includes the repository URL and current credential fingerprint. Credentials
are not stored in the cache. Other remote providers retain the ordinary clone
path. Existing task sources and local dirty source copies keep their current
behavior.

Every new checkout still contacts the remote with current Git credentials.
`git clone --reference-if-able --dissociate` reuses objects but selects the
remote's current refs and creates independent storage. An unavailable or denied
remote cannot fall back to cached files. A failed reference clone retries once
without the cache and resolves credentials again. Task commits and dirty files
never populate this cache. Reproducibility checks continue to use a fresh upstream object store for
their independent proof; they do not use this cache.

Cache publication is optional and never waits for another publisher. It keeps
at most 64 entries and 4 GiB per company, with 2 GiB per entry. Temporary cache
construction can use one additional entry's space; the existing manifest free
space reserve applies. Priming uses a five-second cooperative work budget and
a 4,096-entry scan allowance; individual filesystem calls and cleanup can
exceed that time. Existing entries and abandoned pending entries count
against capacity. A full, corrupt or unavailable cache leaves ordinary cloning
available. No cache eviction is performed. Credential rotation selects another
scope and can reduce reuse after capacity is exhausted. There is no link from
an admitted task checkout back to this cache, so cache removal cannot remove
task Git objects.

## Workspace Git Scan Protection

Paperclip applies one process-wide scheduler to expensive host-side workspace Git enumeration, including changed-file browsing, runtime/finalization cleanliness guards, and adapter sandbox-sync snapshots. The scheduler defaults to two active scans and a bounded queue of 32. Identical buffered scans of the same canonical worktree share one subprocess, while successful changed-file listings are cached for 10 seconds. Streaming snapshot scans have caller-owned sinks, so they use separate jobs in the same queue and are never cached or coalesced. Correctness-sensitive runtime guards bypass the result cache.

The shared scan subprocess sets `GIT_OPTIONAL_LOCKS=0`, including when a caller supplies an environment. This prevents background `git status` from rewriting the index's stat cache and competing with workspace writers. Git still computes current tracked and untracked changes. Required write locks remain enforced; existing lock files are never removed or treated as stale by a scan. This avoids optional index refresh work but may make later scans repeat stat checks. See Git's [background refresh guidance](https://git-scm.com/docs/git-status#_background_refresh).

Workspace snapshots list ignored paths with `git ls-files --others --ignored --exclude-standard --directory -z` so ignored directory contents do not require a full status walk. Changed, untracked, deleted, and ignored filename lists stream into private SQLite manifests. There is no total filename-list byte limit. The parser and each sink chunk are limited to 64 KiB, and each SQLite connection uses a 1 MiB page cache with disk-backed temporary storage. Records must be complete NUL-delimited UTF-8 paths. Invalid, oversized, or incomplete records fail the scan. Explicit file selection excludes files created after the scan. Buffered browser/guard and referenced-source scan bounds stay unchanged. Snapshot failures retain their typed cause instead of becoming a non-Git-folder result. During pre-provider setup, scan timeouts and queue saturation use the existing two automatic failure retries with a 30-second delay. Cancellation, output limits, and other Git errors stop with specific recovery guidance.


Snapshot scans default to a 30-minute execution deadline, including disk backpressure, rather than the short interactive scan deadline. Set `PAPERCLIP_WORKSPACE_GIT_SNAPSHOT_TIMEOUT_MS` to allow slower storage or larger trees (1 second to 24 hours). Disk capacity, filesystem path limits, Git's own resource use, and this execution budget remain practical limits. Each manifest is admitted with a page allowance equal to one quarter of the available bytes above the host reserve at creation. SQLite enforces that allowance before page allocation, so one snapshot cannot consume all available storage. This is a disk-capacity admission policy, not a fixed filename-list byte or record limit. Nested repository and baseline manifests receive separate allowances from the remaining capacity. Manifest writers also check available disk space before creation and at most every 1 MiB of input thereafter. They stop below a 256 MiB free-space reserve. `PAPERCLIP_WORKSPACE_MANIFEST_MIN_FREE_BYTES` can raise or lower the reserve, with a 64 MiB minimum. Concurrent writers can consume space between checks; filesystem quota and write errors still fail the operation. The scheduler keeps the active slot until the child, pipes, and pending sink write finish. Snapshot failures cancel sibling producers and settle all started producers before removing temporary storage.

Workspace baselines, nested-repository subsets, and merge lookups also use disk-backed manifests. Local archive input uses NUL list files. Deletion replay uploads a NUL manifest and runs bounded argument batches with ancestor symlink checks. Git ignored paths are literal indexed exclusions for staging, baseline capture, and the host merge. Restore transport uses the fixed/configured archive exclusions; it can transfer a remotely created ignored file, but the host merge excludes it. The v2 native recovery descriptor contains manifest references, not file arrays. Recovery checks controller-owned paths and content digests before reading records. Existing v1 descriptors remain readable. Transient manifests are removed on preparation failure and restore completion; native manifests remain until the durable recovery lifecycle is cleaned up.

These bounds apply to application filename storage, not total process memory. Repository metadata scales with the number of managed repositories; directory iteration retains bounded buffers per nesting level. Git, tar, and provider SDKs have their own memory use. Some provider transfer APIs still return entire archive buffers. Legacy v1 recovery and the separately bounded referenced-source ignore resolver retain their older arrays. This change does not claim constant memory for those paths.

Workspace preparation resolves an existing root symlink before reading the snapshot and uses that resolved directory for the rest of the operation. Overlay staging checks the captured root identity and each selected path's ancestors before and after copying. A replaced root or a symlink in an ancestor directory stops staging before upload. A missing source file can be skipped; other source inspection errors stop staging. Selected symlink entries remain symlinks.

Execution-workspace close-readiness and branch-reconciliation status checks allow up to 32 MiB of buffered output. This accommodates nested task worktrees while preserving exact untracked-file counts. Larger output fails the scan and blocks destructive cleanup. Other buffered scan bounds stay unchanged.

Heartbeat configuration, environment selection, and finalization read persisted
workspace records through the company-scoped `getStoredById` service method.
Those reads do not inspect Git, refresh runtime service health, or resolve PR
delivery. Workspace detail responses still load live display state, and the
execution and cleanup boundaries retain their live branch and cleanliness
guards. Close readiness derives ancestry from its existing ahead/behind
comparison, avoiding a second history walk with `merge-base`.

Measure the avoided reads on synthetic workspaces with
`pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-workspace-record-reads.ts`.
The benchmark checks identical persisted fields and reports wall time and actual
Git command counts. Use `--resident-mib=1536` to exercise a large Node process on
Linux. It measures workspace reads, not end-to-end agent latency.

The cache intentionally trades up to a few seconds of changed-file freshness for stable server latency. The file browser retains an explicit refresh action, does not start its query while the panel or browser tab is hidden, and presents overloads as retryable failures rather than an empty workspace. A full queue returns `503` with code `workspace_git_scan_saturated`; a scan exceeding its wall-clock limit returns `504` with code `workspace_git_scan_timeout`. Both responses include `Retry-After: 1`.

Sandbox Git sync treats only the selected repository root as a clone source. A selected subfolder uses directory sync within that folder, applies the enclosing repository's ignore rules, and does not transfer parent files or Git history.

Environment overrides:

- `PAPERCLIP_WORKSPACE_GIT_SCAN_CONCURRENCY` (default `2`, range `1`–`16`)
- `PAPERCLIP_WORKSPACE_GIT_SCAN_QUEUE_CAPACITY` (default `32`, range `0`–`1024`)
- `PAPERCLIP_WORKSPACE_GIT_SCAN_TIMEOUT_MS` (default `8000`, range `100`–`120000`, buffered scans)
- `PAPERCLIP_WORKSPACE_GIT_SNAPSHOT_TIMEOUT_MS` (default `1800000`, range `1000`–`86400000`, streaming snapshots)
- `PAPERCLIP_WORKSPACE_GIT_SCAN_CACHE_TTL_MS` (default `10000`, range `0`–`60000`)

Structured `workspace_git_scan` logs expose the operation name, a non-reversible workspace-path hash, queue and execution durations, active/queued counts, cache and single-flight use, and terminal outcome. Saturation and timeout warnings are rate-limited so an overload does not create a second logging storm.

## Reconstructable Git cache expiration

The terminal-workspace worker can expire Paperclip-owned isolated Git worktrees
24 hours after every task in their tree is done or cancelled, independently of
PR merge or delivery status. Enable it with
`PAPERCLIP_GIT_CACHE_EXPIRATION_ENABLED=true`. It defaults to dry run; set
`PAPERCLIP_GIT_CACHE_EXPIRATION_DRY_RUN=false` after inspecting the structured
`execution_workspace.git_cache_expiration` logs. Logs report candidate and
reclaimed bytes, base removal, and skip reasons. The existing bounded lifecycle
sweep supplies scheduling and shutdown cancellation.

The eligibility query first rejects paths shared with another execution or
project checkout. This prevents a known shared-path veto from scanning retained
run contexts. Unshared paths still require every existing task, run, recovery,
lease, service and filesystem check in the same lifecycle lock.

Before deletion the worker fetches the exact commit into a fresh object store
using the company's normal Git identity (anonymously when no identity resolves
outside an agent run, which still proves public repositories; a private
repository that cannot be verified keeps its workspace) and commits a versioned restoration
recipe to workspace metadata. Current runs, previews, pending reopening,
unresolved recovery, dirty/untracked files, unknown ignored files, unproven
ownership, and unsupported or unique Git state prevent deletion. Ignored files
can be discarded only when they are repository-ignored regenerable output,
ignored `.claude/settings.local.json` saved as an encrypted snapshot of at most
64 KiB, or a managed project checkout under `.paperclip-repositories/<repo>-<hash>`
whose exact commit, branch, and source identity are saved in the restoration recipe.
Tracked settings, oversized settings, symbolic links, and unknown files remain protected. A checkout qualifies only when its name maps back to one of
the project's repositories and it passes the same checks as the worktree
(clean tree, no hidden index flags, allowed local config, no in-progress
state), stock Git storage (no custom hooks), no linked worktrees, no
unreachable objects, and every commit reachable from its refs or reflogs is
reachable from a current upstream branch or tag, read fresh from the project
repository's URL with the company's Git identity. A checkout that is a worktree of the project's shared clone is
checked against its own `HEAD`, `HEAD` reflog, index and branches under its
`paperclip/<id>/` prefix instead of the clone's storage and other tasks' refs.
Task repositories
(`task-repo-*`) always prevent deletion. Inspection runs Git with
`core.fsmonitor` disabled, so a repository's local config cannot make it run a
command. Standard linked-worktree `FETCH_HEAD` records are retained unless every
referenced commit is an ancestor of the saved HEAD or passes a fresh upstream fetch.
Malformed records, symbolic links, and more than 32 distinct fetched commits prevent
expiration.
Deletion first renames the worktree to recorded trash; restart and reopening
finish that cleanup under the same source/lifecycle locks.

`PAPERCLIP_GIT_BASE_EXPIRATION_ENABLED=true` additionally permits removal of an
owned isolated remote-source base after all consumers expire and all remaining
refs and files are verified reproducible. Shared project clones remain intact.
Normal authorized reopening recreates a missing source and checks out the saved
commit, including nested project repositories, even after upstream advances.
Settings bytes and permissions restore before provisioning; their encrypted payloads
are bound to the company, workspace, and relative path and require the instance
secrets master key. The worker rechecks the complete saved contents before deletion.
A changed workspace is retained and made usable instead of deleting newer work.
Interrupted settings publication and partial nested restoration are retryable.
Normal preparation retains the saved nested repository selection when project
ref or path settings change. A durable contents checkpoint lets provisioning
retry without overwriting files it changed. Expiration records ownership before
publishing native Git locks; restart recovery removes only those owned locks.
Inaccessible upstream produces an explicit
retryable restoration failure. It never substitutes the default branch.
Reopening failures reject the consuming request with HTTP 409 before saving a
comment or changing its task. The response preserves the restoration message, so
the composer keeps an editable draft and permits retry after access is restored.
It also carries `diagnostic: { step, kind }`, and the server log records the same
pair. Both are closed values: `step` names the failed stage (for example
`source_materialize`, `restore_point` or `saved_commit`), and `kind` names the
failure class (`remote_unavailable`, `auth_rejected`, `commit_unavailable`,
`timeout`, `verification`, `filesystem`, `git_command` or `unknown`). They never
contain paths, repository URLs or Git output.
Nested checkout failures retain their original restore step. The checkout
wrapper keeps process error codes and timeout flags privately for classification;
it does not attach the raw command error as a cause or add those flags to the
public error object.

Both enable switches default off. Rollback disables further expiration while
leaving saved recipes and restoration support intact. Recovery archives, runner
backups, non-Git workspaces, and immutable skill snapshots are unaffected.

## Isolated repository source re-home

Workspaces created with a private per-issue clone under
`isolated-repository-sources/` can be moved onto the project's shared managed
clone, after which the private clone is deleted. Enable it with
`PAPERCLIP_ISOLATED_SOURCE_REHOME_ENABLED=true`; it runs only when
`PAPERCLIP_GIT_CACHE_EXPIRATION_ENABLED=true` and defaults off. Set
`PAPERCLIP_ISOLATED_SOURCE_REHOME_DRY_RUN=true` to log candidates without changing
anything. Each attempt logs `execution_workspace.isolated_source_rehome` with its
outcome, skip reason and reclaimed bytes. See
[recoverable disk cleanup](recoverable-disk-cleanup.md#isolated-repository-sources)
for the conditions and the verification it performs.

## Nested clone migration

Tasks prepared before nested project repositories became worktrees of a shared
clone still hold a full standalone clone in each `.paperclip-repositories/`
checkout. Enable `PAPERCLIP_NESTED_CLONE_MIGRATION_ENABLED=true` (default off) to
let the terminal workspace reaper convert those checkouts in open tasks into
worktrees of the project's shared clone, keeping their exact state and local
history, and delete the standalone clones. Set
`PAPERCLIP_NESTED_CLONE_MIGRATION_DRY_RUN=true` to log candidates without changing
anything. Each attempt logs `execution_workspace.nested_clone_migration` with its
outcome, skip reason and reclaimed bytes. See
[recoverable disk cleanup](recoverable-disk-cleanup.md#converting-existing-standalone-nested-clones)
for the conditions, verification and crash recovery.

## Terminal workspace compaction

A finished task often keeps its worktree for a long time: the reaper archives a
worktree only when its delivery is merged and its files are clean, and then only
after the cooldown. Most of a worktree's size is installed dependencies and build
output, not work. Compaction removes those files and keeps everything else, so a
finished task does not hold gigabytes while it waits for the reaper (or forever,
when it has no merged pull request or has leftover files).

The reaper compacts a workspace once per terminal cycle, after
`PAPERCLIP_WORKSPACE_COMPACTION_DELAY_HOURS`. Server startup waits for the
reaper's first sweep, so that sweep never compacts; later sweeps do. A workspace
qualifies when all of these hold:

- the workspace is an isolated linked Git worktree (never a shared workspace or a
  project's main checkout);
- every issue in its tree is done or cancelled;
- no queued or running heartbeat run works on the tree or the workspace;
- no runtime service runs from the workspace.

Compaction removes only directories that have a regenerable name
(`node_modules`, `dist`, `build`, `coverage`, `storybook-static`, `target`,
`.cache`, `.next`, `.nuxt`, `.parcel-cache`, `.svelte-kit`, `.turbo`, `.vite`),
that the repository's own `.gitignore` files ignore (a negated pattern, a global
excludes file, or `.git/info/exclude` does not count), and that hold no tracked
file. A directory with such a name
that does not qualify (for example a tracked `build/`) is searched in turn, so
ignored dependencies inside it still go. It never enters `.git` or
`.paperclip`, and it never follows a symlink. It checks each directory's ignore
status on its own, so dependencies below an ignored parent (for example
`vendor/tool/node_modules`) are found. Its Git reads have a deadline and stop
when the sweep stops. Tracked files, uncommitted changes,
untracked files, other ignored files (such as `.env` or local data), the branch,
and its commits all stay. The workspace row stays active.

The removal is a rename into `.paperclip-compaction-trash` beside the worktree,
made while the reaper holds the workspace lifecycle lock. The reaper checks the
conditions above before the rename and again after it, in the same transaction.
If the task reopened or a run started in between, the directories move back.
Otherwise the trash is deleted. Trash that an interrupted compaction or a failed
delete leaves behind is deleted by a later sweep once it is more than an hour
old. The sweep checks each worktree parent directory at most every 30 minutes,
whether or not anything is left to compact.

A compacted worktree is in the same state as a freshly created one, so when the
task resumes, whatever produced those files the first time produces them again:
reuse runs the workspace provision command (or a repository's
`scripts/provision-worktree.sh`), which can reinstall dependencies when
`node_modules` is missing. Repositories without
a provision command rely on the agent's own install step, as they do for a new
worktree.

## Remote repository admission saves

Remote admission validates each registered repository against its current sandbox,
origin, and pinned commit. A matching descriptor in the committed snapshot receipt
allows admission without another archive upload. New repositories and legacy
repositories without that receipt require one workspace snapshot for the admission
batch. Repository ready receipts publish after the snapshot commits. An upload
failure remains retryable even when the clone directory already exists. Later
workspace saves retain repository coverage only for directories present in the
captured archive. Deleted checkouts lose coverage and can be acquired again.
A failed batch upload marks the affected repository rows as needing repair.
