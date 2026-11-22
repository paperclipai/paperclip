# Worktree-local instances: reference

Reference for the `paperclipai worktree` commands. The quick start is in [DEVELOPING.md](DEVELOPING.md#worktree-local-instances).

## Dependency provisioning in worktrees

Worktree dependency provisioning records its fingerprint only after a successful
install. Frozen installs with outdated lockfiles or patched-dependency hash
mismatches retry once without `--frozen-lockfile`; other failures retain their
exit status. Patch contents are part of the install fingerprint. Generated
lockfile changes remain local to the worktree; the repository's lockfile bot
owns committed updates.

## Lean worktrees and deferred seeding

Seeding a worktree database is the heaviest part of `worktree init`. That work can be deferred so a worktree is cheap to create and only pays the seed cost the first time it is actually used — the CLI/dev-time analog of the server's lazy runtime provisioning (see the board-operator guide's "Lazy runtime provisioning" section).

Seeding state is tracked in `.paperclip/seed-manifest.json`. The versioned manifest records only non-secret evidence: source instance id/config path, target instance id, seed mode, snapshot time, migration revision, attempt timestamps, current phase, terminal state, and a bounded phase diagnostic history. It never stores database credentials or auth credential material. The legacy `seed-pending` and `seed-complete` files remain read-only compatibility signals for worktrees created before the manifest shipped.

The default `worktree init` still seeds eagerly. A lean worktree (created without an eager seed) has a `pending` manifest until something seeds it on demand:

- `pnpm paperclipai worktree ensure-seeded` performs the deferred seed **exactly once**. It is lock-guarded and idempotent: only a complete `verified` manifest short-circuits it, so it is safe to call repeatedly and from concurrent processes. Managed workspaces derive the source from the control-plane-provided base project workspace when it carries its own `.paperclip/config.json`, and otherwise from the control plane's own registered instance config; either way the workspace's manifest never selects it. Manual worktrees must pass `--from-config`.
- `paperclipai run` calls `ensureWorktreeSeeded` automatically before doctor/boot. Managed runs transparently seed a lean worktree from their registered base workspace; an unmanaged lean worktree must first run `worktree ensure-seeded --from-config <source-config>`.
- Managed git worktrees run a repository's `scripts/provision-worktree.sh` when the strategy omits `provisionCommand` and that file exists. The Paperclip repository deliberately does not ship a file at that path, so agent turns in Paperclip worktrees do not wait on dependency installs or instance setup. Its setup script is `scripts/setup-paperclip-worktree.sh`: run it by hand, or set it as the project's `provisionCommand` to opt in. When a registered source config exists, it creates the isolated config and pending manifest, then installs dependencies. Runtime startup still runs `scripts/provision-worktree-runtime.sh` automatically when no explicit runtime provision command is configured and the manifest is not verified; that script runs `scripts/setup-paperclip-worktree.sh` first when the worktree has no config. Explicitly configured provision commands still take precedence.
- An environment-configured server may have no local seed config. If neither the base checkout nor the default control-plane instance has one, a fresh worktree prepares its dependencies without creating a development instance. This also applies when `PAPERCLIP_CONFIG` names the default `$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID/config.json` path, as the Docker image does. Setup creates no config, environment file, or seed manifest and does not claim runtime or seed readiness. A later request for a seeded development runtime still needs a canonical registered source config. Once that source exists, provisioning the checkout again creates the development instance normally.
- A missing custom `PAPERCLIP_CONFIG`, rejected symlink, or non-regular source file still fails setup. An existing worktree with a config, environment file, or seed state also fails if its source disappears; setup never downgrades that instance to a plain checkout. Repair the source before retrying.
- The built-in deferred seed is recorded as its own terminal `workspace_seed` operation. A zero exit code is not enough for success: the operation succeeds only when `.paperclip/seed-manifest.json` contains complete verified evidence; failed, missing, or malformed manifests produce a failed operation with the seed phase in metadata.
- Worktrees created before lazy seeding shipped may have neither marker. Paperclip adopts them only after their configured database proves a compatible migration journal and the core Paperclip schema; otherwise managed startup creates a pending manifest and performs the normal verified seed. Manual markerless worktrees must provide `--from-config` so the source remains explicit.

Both `minimal` and `full` modes use the same terminal data-validation contract. Source validation accepts a migration journal that is a prefix of the checkout's journal and records the source revision in seed diagnostics; it rejects a source that is ahead of the checkout because that would require a downgrade. After restore, Paperclip applies pending migrations and requires the target journal to be current. Both validations also read an auth user with an instance administrator role, active company membership, and representative cloned company/issue pair. Authenticated instances additionally require that administrator to have a non-empty credential account. `local_trusted` instances accept the implicit local Board user without an account row because that mode intentionally has no human login flow. Restore, migrations, execution quarantine, routine pausing, workspace rebinding, and post-restore validation all run under the seed lock. An interruption leaves the exact active phase in terminal `failed` state; it cannot produce readiness evidence.

The seed process must own the target embedded PostgreSQL lifecycle for that entire sequence. It refuses to restore into a target postmaster that is already running, suppresses the embedded provider's process-global exit hooks, and stops its owned target only after validation or failure cleanup. A shutdown detected during restore is recorded as a target-database shutdown diagnostic rather than a generic restore failure.

The seed manifest never grants source-path authority. Its source path and instance are diagnostic assertions derived from the realpath-canonical registered source. Deferred seeding resolves registration independently before taking the seed lock; under that lock it replaces stale source diagnostics from the registered value and then revalidates the manifest before any backup, service stop, spawn, or database mutation. Missing registration, invalid registered paths, source/target identity collisions, target-instance mismatches, and company mismatches fail closed.

**Unverified-seed guard.** `pnpm dev` (the dev-runner) refuses to boot a worktree whose manifest is pending, running, failed, malformed, or missing required verification evidence and points you at the fix:

```
[paperclip] this worktree database is seed-pending. Run `pnpm paperclipai worktree ensure-seeded` before `pnpm dev`.
```

This guard (`isWorktreeSeedPending` in `server/src/dev-runner-worktree.ts`) prevents `pnpm dev` from starting the app against an empty or partially restored database — run `worktree ensure-seeded` once and re-run `pnpm dev`.

Provisioned git worktrees also pause seeded routines that still have enabled schedule triggers in the isolated worktree database by default. This prevents copied daily/cron routines from firing unexpectedly inside the new workspace instance during development without disabling webhook/API-only routines.

That repo-local env also sets:

- `PAPERCLIP_IN_WORKTREE=true`
- `PAPERCLIP_DB_BACKUP_ENABLED=false`
- `PAPERCLIP_WORKTREE_NAME=<worktree-name>`
- `PAPERCLIP_WORKTREE_COLOR=<hex-color>`

The server/UI use those values for worktree-specific branding such as the top banner and dynamically colored favicon.
Authenticated worktree servers also use the `PAPERCLIP_INSTANCE_ID` value to scope Better Auth cookie names.
Browser cookies are shared by host rather than port, so this prevents logging into one `127.0.0.1:<port>` worktree from replacing another worktree server's session cookie.

When Paperclip closes a server-managed git worktree, it also reclaims the isolated instance referenced by that worktree's repo-local `.paperclip/.env`. New server-managed worktrees use a collision-resistant instance id derived from the resolved absolute worktree path, and Paperclip persists the resulting instance root as execution-workspace ownership metadata. Cleanup requires the env pointer to match that persisted root, stops a running embedded PostgreSQL process, and then removes the instance directory. The deletion guard only accepts canonical instance paths below `PAPERCLIP_WORKTREES_DIR/instances/`; legacy or mismatched ownership, pointers to the default/live Paperclip home, and all other locations are logged and left untouched.

Print shell exports explicitly when needed:

```sh
paperclipai worktree env
# or:
eval "$(paperclipai worktree env)"
```

## Workspace login handoff and readiness

Opening a managed workspace board no longer depends on knowing which cloned password is current. `Open workspace` asks the main control plane for a short-lived, single-use ticket; the isolated workspace verifies it and creates its own instance-scoped Better Auth session.

- **Issue** — `POST /api/execution-workspaces/{id}/login-handoff` (board actors only). The ticket is bound to the caller's user id and email, the execution workspace id, the workspace's company id, the isolated instance id, the live runtime origin, a nonce, and a ~90 s expiry. Nothing in the request body influences that binding; only the landing path is caller-supplied and it is reduced to a same-origin path before signing.
- **Exchange** — `GET /api/auth/{workspace-handoff}/exchange?ticket=…` on the workspace itself, registered as a Better Auth plugin so session creation and cookie signing use Better Auth's own path. It verifies the signature, expiry, origin, instance, workspace, company, the cloned user's email, and an active membership **in that company**, records the nonce so a replay loses, and answers with an HTTP redirect — which is what keeps the ticket out of browser history. Request logs redact the `ticket` parameter.
- **Fallback** — direct email/password sign-in still works and the UI labels it accurately as *snapshot-local credentials*. A rejected ticket redirects to `/auth?workspaceHandoffError=<reason>` rather than failing opaquely.

Key material is derived, never shared. The control plane keeps a root secret (`PAPERCLIP_WORKSPACE_HANDOFF_SECRET`, or a domain-separated derivation from the instance's existing signing secret when that is unset) and injects only per-workspace values into the guest process:

| Variable | Purpose |
| --- | --- |
| `PAPERCLIP_WORKSPACE_HANDOFF_KEY` | Per-workspace ticket verification key. A guest cannot mint a ticket for a sibling workspace. |
| `PAPERCLIP_WORKSPACE_READINESS_TOKEN` | Bearer token the control plane presents to read this workspace's protected readiness. |
| `PAPERCLIP_EXECUTION_WORKSPACE_ID` | Execution workspace the guest was provisioned for, used for identity checks. |
| `PAPERCLIP_EXECUTION_WORKSPACE_COMPANY_ID` | Company whose board the guest represents. Scopes both the membership check and the readiness probes, so "some company in the clone is fine" cannot pass for the one being opened. |

Protected `/api/health` on a cloned workspace additionally carries a `workspace` block — `state`, `databaseReady`, `cloneDataReady`, `authHandoffReady`, `seedState`, `seedPhase`, `instanceId`, `executionWorkspaceId`, `failurePhase`. Public health stays redacted. Managed runtime start will not publish `running / healthy` unless that block agrees and names this exact instance and workspace, and runtime-service work products are refreshed from the live runtime row so a port change cannot leave a stale user-facing URL.

The workspace UI surfaces `Provisioning database`, `Validating clone`, `Ready`, `Degraded`, `Repairing`, and `Repair failed`, each with one safe action (open, start, repair, or read the log).

## Worktree CLI Reference

**`npx paperclipai worktree init [options]`** — Create repo-local config/env and an isolated instance for the current worktree.

| Option | Description |
|---|---|
| `--name <name>` | Display name used to derive the instance id |
| `--instance <id>` | Explicit isolated instance id |
| `--home <path>` | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source PAPERCLIP_HOME used when deriving the source config |
| `--from-instance <id>` | Source instance id (default: `default`) |
| `--server-port <port>` | Preferred server port |
| `--db-port <port>` | Preferred embedded Postgres port |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Defer database copying until first use |
| `--empty` | Create an empty instance with fresh signing secrets and disable automatic copying |
| `--force` | Replace existing repo-local config and isolated instance data |

Examples:

```sh
paperclipai worktree init --no-seed
paperclipai worktree init --seed-mode full
paperclipai worktree init --from-instance default
paperclipai worktree init --from-data-dir ~/.paperclip
paperclipai worktree init --force
```

Repair an already-created repo-managed worktree and reseed its isolated instance from the main default install. Point `--from-config` at the instance config:

```sh
cd /path/to/paperclip/.paperclip/worktrees/PAP-884-ai-commits-component
npx paperclipai worktree init --force --seed-mode minimal \
  --name PAP-884-ai-commits-component \
  --from-config ~/.paperclip/instances/default/config.json
```

That rewrites the worktree-local `.paperclip/config.json` + `.paperclip/.env`, recreates the isolated instance under `~/.paperclip-worktrees/instances/<worktree-id>/`, and preserves the git worktree contents themselves.

For an already-created worktree where you want the CLI to decide whether to rebuild missing worktree metadata or just reseed the isolated DB, use `worktree repair`.

**`npx paperclipai worktree repair [options]`** — Repair the current linked worktree by default, or create/repair a named linked worktree under `.paperclip/worktrees/` when `--branch` is provided. The command never targets the primary checkout unless you explicitly pass `--branch`.

| Option | Description |
|---|---|
| `--branch <name>` | Existing branch/worktree selector to repair, or a branch name to create under `.paperclip/worktrees` |
| `--home <path>` | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source `PAPERCLIP_HOME` used when deriving the source config |
| `--from-instance <id>` | Source instance id when deriving the source config (default: `default`) |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Repair metadata only when bootstrapping a missing worktree config |
| `--allow-live-target` | Override the guard that requires the target worktree DB to be stopped first |

Examples:

```sh
# From inside a linked worktree, rebuild missing .paperclip metadata and reseed it from the default instance.
cd /path/to/paperclip/.paperclip/worktrees/PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat
pnpm paperclipai worktree repair

# From the primary checkout, create or repair a linked worktree for a branch under .paperclip/worktrees/.
# This command repairs the local checkout, so run the checked-out CLI through the direct-exec form.
cd /path/to/paperclip
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts worktree repair --branch PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat
```

For an already-created worktree where you want to keep the existing repo-local config/env and only overwrite the isolated database, use `worktree reseed` instead. Stop the target worktree's Paperclip server first so the command can replace the DB safely.

**`npx paperclipai worktree reseed [options]`** — Re-seed an existing worktree-local instance from another Paperclip instance or worktree while preserving the target worktree's current config, ports, and instance identity.

| Option | Description |
|---|---|
| `--from <worktree>` | Source worktree path, directory name, branch name, or `current` |
| `--to <worktree>` | Target worktree path, directory name, branch name, or `current` (defaults to `current`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source `PAPERCLIP_HOME` used when deriving the source config |
| `--from-instance <id>` | Source instance id when deriving the source config |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `full`) |
| `--yes` | Skip the destructive confirmation prompt |
| `--allow-live-target` | Override the guard that requires the target worktree DB to be stopped first |
| `--backup-target` | Retain a recoverable full target-DB backup before reseeding |

Examples:

```sh
# From the main repo, reseed a worktree from the current default/master instance.
cd /path/to/paperclip
npx paperclipai worktree reseed \
  --from current \
  --to PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat \
  --seed-mode full \
  --yes

# From inside a worktree, reseed it from the default instance config.
cd /path/to/paperclip/.paperclip/worktrees/PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat
npx paperclipai worktree reseed \
  --from-instance default \
  --seed-mode full
```

Managed workspace repair uses this same verified full-reseed contract through `POST /api/execution-workspaces/:id/runtime-commands/repair`. The exclusive, audited operation stops managed services, writes a recoverable pre-repair database backup under the isolated instance's backup directory, performs the full seed/migration/quarantine/rebinding sequence, and restarts only after terminal manifest and service-health validation. It preserves the worktree filesystem. On failure, services remain stopped while the database backup, seed manifest, bounded phase diagnostics, and operation log are retained for inspection; repair never retries itself in a loop.

**`npx paperclipai worktree:make <name> [options]`** — Create `~/NAME` as a git worktree, then initialize an isolated Paperclip instance inside it. This combines `git worktree add` with `worktree init` in a single step.

| Option | Description |
|---|---|
| `--start-point <ref>` | Remote ref to base the new branch on (e.g. `origin/main`) |
| `--instance <id>` | Explicit isolated instance id |
| `--home <path>` | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source PAPERCLIP_HOME used when deriving the source config |
| `--from-instance <id>` | Source instance id (default: `default`) |
| `--server-port <port>` | Preferred server port |
| `--db-port <port>` | Preferred embedded Postgres port |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Defer database copying until first use |
| `--empty` | Create an empty instance with fresh signing secrets and disable automatic copying |
| `--force` | Replace existing repo-local config and isolated instance data |

Examples:

```sh
npx paperclipai worktree:make paperclip-pr-432
npx paperclipai worktree:make my-feature --start-point origin/main
npx paperclipai worktree:make experiment --no-seed
```

**`npx paperclipai worktree env [options]`** — Print shell exports for the current worktree-local Paperclip instance.

| Option | Description |
|---|---|
| `-c, --config <path>` | Path to config file |
| `--json` | Print JSON instead of shell exports |

Examples:

```sh
pnpm paperclipai worktree env
pnpm paperclipai worktree env --json
eval "$(npx paperclipai worktree env)"
```

For project execution worktrees, Paperclip can also run a project-defined provision command after it creates or reuses an isolated git worktree. Configure this on the project's execution workspace policy (`workspaceStrategy.provisionCommand`). The command runs inside the derived worktree and receives `PAPERCLIP_WORKSPACE_*`, `PAPERCLIP_PROJECT_ID`, `PAPERCLIP_AGENT_ID`, and `PAPERCLIP_ISSUE_*` environment variables so each repo can bootstrap itself however it wants.

An issue's partial `workspaceStrategy` inherits omitted fields from the enabled project's strategy when both use the same type. For example, an issue can override `baseRef` without losing the project's provision, runtime provision, or teardown commands. An explicit value, including `null` or an empty string, replaces the project value. Clearing a command restores the runtime's usual default behavior; use `provisionCommand: "true"` for an explicit no-op. A different strategy type or a disabled project policy does not supply these defaults. An issue's `existingBranch` pin also excludes the project's `branchTemplate`.

An issue can pin its isolated worktree to an exact pre-existing branch instead of a template-derived one — the contract PR-preparation tasks use. Set the issue's `executionWorkspaceSettings` to `{ "mode": "isolated_workspace", "workspaceStrategy": { "type": "git_worktree", "existingBranch": "<branch>" } }`. The validator requires isolated mode plus a `git_worktree` strategy and rejects `branchTemplate` alongside `existingBranch`. At dispatch the runtime attaches (never creates, renames, fast-forwards, or resets) that branch: it reuses a registered worktree that already has the branch checked out (including legacy `.worktrees/` paths), otherwise it attaches the branch under the managed worktree parent. A missing branch, an occupied worktree path on another branch, or a non-worktree strategy fails closed with a `workspace_validation_failed` error instead of falling back to the shared checkout or a derived branch, and an inherited `reuse_existing` workspace binding on a different branch is ignored in favor of realizing the pinned branch.

Heavier setup that is only needed by a managed runtime service can use `workspaceStrategy.runtimeProvisionCommand`. Paperclip runs this command lazily before spawning the first service in a start batch, serializes concurrent provisioning for the same workspace, and records the attempt as `workspace_runtime_provision`. The command receives the same workspace environment as `provisionCommand` and should be idempotent because later service-start batches invoke it again.

Managed runtime control actions (`start`, `stop`, `restart`, and job `run`) are mutually exclusive per execution workspace. An overlapping control is rejected with `409 workspace_runtime_control_in_progress` instead of racing the active operation, and authorization is still checked first, so the conflict never widens who may control a workspace.

Local managed runtime services write stdout and stderr directly to append-only
files under the instance's `runtime-service-logs/` directory. The child inherits
the file descriptors rather than supervisor-owned pipes, so request-logging
servers remain responsive and adoptable when the control plane restarts.

Every managed control reaches a terminal operation state. Each one stamps the owning server process and pid on its `workspace_operations` row and heartbeats while it runs, and each one carries a wall-clock ceiling (30 minutes for lifecycle controls, 4 hours for workspace jobs) so a hung provider or listener fails the operation rather than leaving it active. When a start fails part-way, Paperclip tears the workspace's runtime services down through the ordinary stop path and records a stopped desired state, so the lane is retryable and a startup reconcile will not resurrect a service that never came up.

Recovery of stranded controls is bounded and cannot steal a live operation. A `running` control is only terminalized when its owning process is gone, when the owning request in this process no longer exists, or after 60 seconds without a heartbeat; the terminalizing write is a compare-and-swap on `updated_at`, so an owner that heartbeats concurrently keeps its operation. Recovery runs on server startup and before each managed control, appends reconciliation evidence to the workspace-operation log, and stays inside the requested workspace's scope.

Readiness probes and port allocation are bounded for the same reason. Each HTTP readiness probe is aborted after at most 5 seconds (never past the service's readiness budget), so a foreign listener that accepts a connection but never answers cannot park a start forever. Auto-allocated loopback ports are reserved in-process for the duration of a start and re-checked for a live owner, and a configured port already claimed by another in-flight start fails that start terminally — so two isolated workspaces asking for the same app/HMR pair either get distinct healthy ports or one fails cleanly and retryably.

Beyond that in-flight guard, `start`, `stop`, and `restart` also take a durable exclusivity lease on the execution workspace (`execution_workspace_runtime_leases`). The lease is keyed by execution workspace and owned by the controlling issue (or, when a run has no issue in scope, by the run or agent), so it survives across calls, heartbeats, and server processes. The owning issue can keep operating; a different issue or run is rejected with `409 workspace_runtime_lease_conflict` before any workspace operation is recorded and before any runtime service is touched. Board/operator actions bypass the lease entirely and never take the lane away from an agent.

Lease recovery is bounded and explicit. Another issue may reclaim the lane once the owner becomes ineligible — the owning issue reaches a terminal status, is hidden, or is deleted; the owning run reaches a terminal status — or once the lease's 30-minute TTL elapses without the owner touching it. Archiving the execution workspace releases the lease outright. Conflict responses carry the owning issue/run ids and the lease expiry so an operator can tell who holds the lane.

For Tailscale HTTPS exposure, readiness includes stable listener-ownership checks for every requested loopback port (the app and, when configured, its Vite HMR companion). Each listener must belong to the spawned managed process group; an unrelated listener that races onto either reserved port fails the start closed before the broker is asked to expose it.

Managed `paperclip-dev` worktree services enable `PAPERCLIP_UI_DEV_MIDDLEWARE=true` by default, so newly started worktrees hot-reload UI source changes. Managed HTTPS services use this default only when they publish the Paperclip Vite HMR companion listener, which is the default exposure configuration. A service or adapter can explicitly set the variable to `false` when it intentionally needs to exercise the built UI bundle.

In Vite middleware mode, Paperclip gives HMR a dedicated HTTP server bound to the managed runtime's loopback host. The browser still derives the HMR hostname from the public HTTPS page, and exposed runtimes use secure WebSockets, so listener containment does not break remote hot reload.

When a workspace service runs Paperclip for browser OAuth QA, configure its `expose.urlTemplate` with the canonical URL the browser can reach. Paperclip preserves explicit `PAPERCLIP_PUBLIC_URL` or `BETTER_AUTH_URL` settings; otherwise it uses a valid exposed HTTPS origin (or loopback HTTP) as the managed runtime fallback for Better Auth and `/api/tools/oauth/callback`. Internal service names such as `http://paperclip-dev:<port>` are rejected unless that hostname is genuinely the browser route. Use a unique origin per isolated worktree. See [Execution Workspaces And Runtime Services](../docs/guides/board-operator/execution-workspaces-and-runtime-services.md#browser-reachable-origins-for-oauth-qa) for configuration and verification.
