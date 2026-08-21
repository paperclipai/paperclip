# Developing

This project can run fully in local dev without setting up PostgreSQL manually.

## Deployment Modes

For mode definitions and intended CLI behavior, see `doc/DEPLOYMENT-MODES.md`.

Current implementation status:

- canonical model: `local_trusted` and `authenticated` (with `private/public` exposure)

## Prerequisites

- Node.js 20+
- pnpm 9+

## Dependency Lockfile Policy

GitHub Actions owns `pnpm-lock.yaml`.

- Do not commit `pnpm-lock.yaml` in pull requests.
- Pull request CI validates dependency resolution when manifests change.
- Pushes to `master` regenerate `pnpm-lock.yaml` with `pnpm install --lockfile-only --no-frozen-lockfile`, commit it back if needed, and then run verification with `--frozen-lockfile`.

## Start Dev

From repo root:

```sh
pnpm install
pnpm dev
```

This starts:

- API server: `http://localhost:3100`
- UI: served by the API server in dev middleware mode (same origin as API)

`pnpm dev` runs the server in watch mode and restarts on changes from workspace packages (including adapter packages). Use `pnpm dev:once` to run without file watching.

`pnpm dev:once` auto-applies pending local migrations by default before starting the dev server.

`pnpm dev` and `pnpm dev:once` are now idempotent for the current repo and instance: if the matching Paperclip dev runner is already alive, Paperclip reports the existing process instead of starting a duplicate.

Issue execution may also use project execution workspace policies and workspace runtime services for per-project worktrees, preview servers, and managed dev commands. Configure those through the project workspace/runtime surfaces rather than starting long-running unmanaged processes when a task needs a reusable service.

### Mobile-friendly preview (`pnpm dev:mobile`)

The vite dev server serves an unbundled module graph. This is fast to reload on a local machine but too heavy for phones and tablets on slow links (airplane wifi, mobile data, distant tailnet peers). `pnpm dev:mobile` builds the UI once and serves the small production bundle on port `3101` via `vite preview`, proxying `/api` requests to the dev API on `3100`.

- `pnpm dev:mobile` — build the UI and start the preview server on `:3101`. Rebuild manually to pick up UI source changes.
- `pnpm dev:both` — run `pnpm dev` and `pnpm dev:mobile` together with prefixed output and shared signal handling.

The preview server binds `0.0.0.0` and accepts any Host, so a tailnet or LAN address (e.g. `http://<host>.ts.net:3101/`) works out of the box. The `/api` proxy sets `x-forwarded-host` and `x-forwarded-proto`, which the server's board mutation guard uses to trust the browser's Origin — mutations from `:3101` succeed against the API on `:3100` without further configuration. An HTTPS tunnel in front of the preview server (ngrok, tailscale funnel) is also supported: the tunnel's `x-forwarded-proto` header is preserved when set.

## Storybook

The board UI Storybook keeps stories and Storybook config under `ui/storybook/` so component review files stay out of the app source routes.

```sh
pnpm storybook
pnpm build-storybook
```

These run the `@paperclipai/ui` Storybook on port `6006` and build the static output to `ui/storybook-static/`.

The Storybook visual regression suite uses external PNG baselines instead of
committed screenshots:

```sh
pnpm test:storybook-visual
pnpm test:storybook-visual:update
```

`pnpm test:storybook-visual` downloads and verifies the baseline archive from
`tests/storybook-visual/baseline-manifest.json` before running Playwright.
Accepted visual changes should update the manifest metadata and publish a new
immutable archive with `pnpm storybook-visual:baseline pack` and
`pnpm storybook-visual:baseline upload`; do not commit generated PNG snapshots.

Known limitation: Storybook visual baselines are Linux/Ubuntu-only. The manifest
pins the capture environment to `ubuntu-24.04` and the Playwright suite uses
pixel-exact comparison, so local runs on macOS, Windows, or other non-matching
platforms can report false-positive diffs from font rasterization and subpixel
rendering. Use the `Storybook Visual` GitHub Actions workflow on `ubuntu-latest`
as the source of truth, or run locally in a matching Linux environment before
accepting or updating baselines.

PR visual checks are opt-in while the suite stabilizes. Add the
`storybook-visual` label to a PR, or run the `Storybook Visual` GitHub Actions
workflow manually, to produce downloadable Playwright report/test-result
artifacts. Normal PR visual runs use read-only repository permissions and do not
upload or mutate baseline objects.

## UI Fonts And Screenshots

The board UI ships its own sans-serif webfont assets in `ui/public/fonts/`.
`ui/src/index.css` declares Inter v4.1 variable regular and italic faces and wires
the Tailwind `font-sans` token to those bundled files before system fallbacks.
Linux screenshot or Storybook capture jobs should not install host Inter packages
or inject external font CSS to make Paperclip text render correctly.

Font assets live in Vite's public directory so `pnpm --filter @paperclipai/ui build`
emits them under `ui/dist/fonts/`. The server package copies the same output into
`server/ui-dist/fonts/` through `scripts/prepare-server-ui-dist.sh`.

Inspect or stop the current repo's managed dev runner:

```sh
pnpm dev:list
pnpm dev:stop
```

`pnpm dev:once` now tracks backend-relevant file changes and pending migrations. When the current boot is stale, the board UI shows a `Restart required` banner. You can also enable guarded auto-restart in `Instance Settings > Experimental`, which waits for queued/running local agent runs to finish before restarting the dev server.

## Hot-Restart Deploys

Primary-instance rebuilds that restart `paperclip.service` can request one-shot live-run adoption instead of using the normal graceful shutdown drain. Before restarting the service, write the marker from the newly staged app with the current service PID:

```sh
old_main_pid="$(systemctl show paperclip.service -p MainPID --value)"
pnpm --filter @paperclipai/server exec tsx ../scripts/request-hot-restart.ts --server-pid "$old_main_pid"
systemctl restart paperclip.service
```

The staged command records the target server's boot identity and operating
system process start time with the PID. It reads process metadata through
`/proc` on Linux, `ps` on macOS and BSD, and PowerShell on Windows. These
identities let a later request reclaim an abandoned marker after the operating
system recycles the numeric PID. Older markers stay compatible and use process
start metadata when available. When OS metadata is unavailable, the current
server's health-reported boot time can still prove that a legacy marker predates
the process now using its PID. Paperclip refuses to create a new request without
at least one identity source. Supported-platform process probes fail explicitly
instead of silently treating a live PID as either the original owner or a
recycled process when identity cannot be established.

Use `--drain-required` only when the deploy intentionally requires the old terminate-and-retry behavior. Without that flag, the old server verifies that the marker targets its own PID, stops new scheduler work, waits for any queue-claim callback already in flight, snapshots currently running heartbeat run IDs and child PIDs, and skips the shutdown drain so eligible detached local-agent processes can keep running. ACP-backed local runs use server-owned stdio and cannot survive their parent server, so the old server instead persists their complete snapshot, changes the marker to `drainRequired` with `drainReason: "active_acp_run"`, and drains only those runs to queued retries. Detached CLI runs remain eligible for adoption during the same mixed restart. If an ACP process terminates but its terminal run update does not persist, startup classifies it as lost with reason `selective_drain_not_finalized` rather than treating the drain as successful. On startup the new server writes `$PAPERCLIP_HOME/instances/${PAPERCLIP_INSTANCE_ID:-default}/hot-restart-report.json` with `previousServerPid`, `newServerPid`, `previousServerVersion`, `newServerVersion`, `drainReason`, `adoptedRunIds`, `finalizedWhileDownRunIds`, `lostRunIds`, and per-run classifications before the normal orphan reaper runs.

When Paperclip manages embedded PostgreSQL, it suppresses that dependency's eager
`SIGINT`/`SIGTERM` cleanup hooks. Paperclip owns signal ordering so the heartbeat
snapshot and any required drain complete while the database is still available;
the coordinated shutdown path stops embedded PostgreSQL afterward.

The request command records the preflight set of running heartbeat IDs and writes
an instance-scoped marker plus a PID-targeted legacy home-root handoff marker.
This lets a previous server version capture its snapshot at the old path while
the new server correlates that snapshot back to the authoritative instance
request. If any preflight run ID is absent from the shutdown snapshot, the
startup report includes it in `lostRunIds`; a missing snapshot therefore cannot
look like a zero-loss restart.

A healthy guarded deploy must compare the report against `/api/health` (`version` or `serverVersion`) and treat any `lostRunIds` entry as a continuity failure that needs recovery before marking deployment complete.

### Recovering a deploy blocked by missing process metadata

If the currently installed version already has a running local-agent heartbeat
whose `processPid` and `processGroupId` are both null, that pre-fix run cannot be
made adoptable retroactively. Cross that version boundary once with the normal
drain-and-retry path:

```sh
old_main_pid="$(systemctl show paperclip.service -p MainPID --value)"
pnpm --filter @paperclipai/server exec tsx ../scripts/request-hot-restart.ts \
  --server-pid "$old_main_pid" --drain-required
systemctl restart paperclip.service
```

After the fixed server starts, wait for the replacement `codex_local` heartbeat
to spawn, then confirm its run record has an identity (use an authenticated API
request in authenticated mode):

```sh
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -fsS "$PAPERCLIP_API_BASE/api/heartbeat-runs/$RUN_ID" \
  | jq -e '.status == "running" and (.processPid != null or .processGroupId != null)'
```

The next continuity check should use the ordinary marker without
`--drain-required`. After restart, require both an empty loss list and an
explicit outcome for the run that was live before restart:

```sh
jq -e --arg run "$RUN_ID" \
  '(.lostRunIds | length) == 0 and ((.adoptedRunIds + .finalizedWhileDownRunIds) | index($run) != null)' \
  "$PAPERCLIP_HOME/hot-restart-report.json"
```

An alive child appears in `adoptedRunIds`; a child that completed during the
restart window appears in `finalizedWhileDownRunIds`. Either is continuous. A
`lostRunIds` entry remains a failed deploy and must not be waived.

For a recovery from a version that can stop embedded PostgreSQL before writing
its shutdown snapshot, use `--drain-required` once to cross the broken boundary.
After the fixed server is live, perform another ordinary hot restart. Require
`lostRunIds` to be empty and every preflight run to appear in either
`adoptedRunIds` or `finalizedWhileDownRunIds`; an ACP-backed original should be
finalized and have a queued retry rather than be adopted.

Tailscale/private-auth dev mode:

```sh
pnpm dev --bind lan
```

This runs dev as `authenticated/private` with a private-network bind preset.
On a fresh authenticated/private instance, open the app, sign in or create an
account, and use the setup screen to claim the first instance admin from the
browser. The CLI fallback remains:

```sh
pnpm paperclipai auth bootstrap-ceo
```

For Tailscale-only reachability on a detected tailnet address:

```sh
pnpm dev --bind tailnet
```

Legacy aliases still map to the old broad private-network behavior:

```sh
pnpm dev --tailscale-auth
pnpm dev --authenticated-private
```

Allow additional private hostnames (for example custom Tailscale hostnames):

```sh
npx paperclipai allowed-hostname dotta-macbook-pro
```

## Test Commands

Use the cheap local default unless you are specifically working on browser flows:

```sh
pnpm test
```

`pnpm test` runs the Vitest suite only. For interactive Vitest watch mode use:

```sh
pnpm test:watch
```

Browser suites stay separate:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

These browser suites are intended for targeted local verification and CI, not the default agent/human test command.

For normal issue work, start with the smallest targeted check that proves the change. Reserve repo-wide typecheck/build/test runs for PR-ready handoff or changes broad enough that narrow checks do not cover the risk.

## One-Command Local Run

For a first-time local install, you can bootstrap and run in one command:

```sh
pnpm paperclipai run
```

> **Note: private npm registry `.npmrc` + first-run onboarding**
>
> The first-run experience often starts with `npx paperclipai onboard --yes` (before you have a repo checkout). If your global `~/.npmrc` sets `registry` to a private registry (for example GitHub Packages), `npx` may try to resolve `paperclipai` from that private registry and fail with `E404`.
>
> Diagnostic:
>
> ```sh
> npm config get registry
> ```
>
> Workaround (cross-platform; force the public npm registry for this command):
>
> ```sh
> npx --registry https://registry.npmjs.org paperclipai onboard --yes
> ```

`paperclipai run` does:

1. auto-onboard if config is missing
2. `paperclipai doctor` with repair enabled
3. starts the server when checks pass

## Docker Quickstart (No local Node install)

Build and run Paperclip in Docker:

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Or use Compose:

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

See `doc/DOCKER.md` for API key wiring (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) and persistence details.

## Docker For Untrusted PR Review

For a separate review-oriented container that keeps `codex`/`claude` login state in Docker volumes and checks out PRs into an isolated scratch workspace, see `doc/UNTRUSTED-PR-REVIEW.md`.

## Local Instance Layout

Every local install keeps runtime state directly under the selected instance root:

```text
~/.paperclip/instances/default/                  # instance root
  config.json                                    # runtime config
  .env                                           # instance env file
  db/                                            # embedded PostgreSQL data
  data/
    storage/                                     # local_disk uploads
    backups/                                     # automatic DB backups
  logs/
  runtime-services/                             # managed local-service registry
  runtime-service-logs/                         # append-only managed-service stdout/stderr
  secrets/master.key                             # local_encrypted master key
  workspaces/<agent-id>/                         # default agent workspaces
  projects/                                      # project execution workspaces
  companies/<company-id>/agents/<agent-id>/codex-home/
                                                   # per-agent codex_local home
```

`PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` override the home root and instance id respectively. `paperclipai onboard` echoes the resolved values in its banner (`Local home: <home> | instance: <id> | config: <path>`) so you can confirm where state will land before continuing.

Config updates preserve unrecognized top-level and nested keys so provider or
plugin extensions survive `configure` and worktree port repair. Likely
misspellings of known keys produce a warning but are not removed. If an
existing `config.json` is malformed, `onboard` and `configure` first create a
byte-for-byte sibling backup named `config.json.invalid-1` (then `-2`, and so
on). Repair from defaults requires an interactive confirmation; non-interactive
runs stop without replacing the original.

## Database in Dev (Auto-Handled)

For local development, leave `DATABASE_URL` unset.
The server will automatically use embedded PostgreSQL and persist data at:

- `~/.paperclip/instances/default/db`

Override home or instance:

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

No Docker or external database is required for this mode.

## Storage in Dev (Auto-Handled)

For local development, the default storage provider is `local_disk`, which persists uploaded images/attachments at:

- `~/.paperclip/instances/default/data/storage`

Configure storage provider/settings:

```sh
pnpm paperclipai configure --section storage
```

## Agent Artifact Uploads

When an agent generates a file that a board user or reviewer should inspect as
a deliverable, attach it to the issue before marking the task complete. Do not
rely on a local workspace path as the only access path.

Use the helper bundled with the Paperclip skill from the repo root:

```sh
skills/paperclip/scripts/paperclip-upload-artifact.sh dist/demo.mp4 \
  --title "Demo video render" \
  --summary "MP4 render for board review"
```

For WebM output:

```sh
skills/paperclip/scripts/paperclip-upload-artifact.sh out/walkthrough.webm \
  --title "Walkthrough video" \
  --summary "WebM walkthrough render"
```

The helper uploads the file as an issue attachment, creates an artifact work
product by default, and prints markdown links for the final issue comment. See
`doc/AGENT-ARTIFACTS.md` for the full completion pattern and direct API shape.
If a file intentionally remains workspace-only, create a work product with
`metadata.resourceRef.kind: "workspace_file"` and include the workspace-relative
path in the final comment. Use browse/search only as the fallback for recovering
that file, not as the main completion path for deliverables.

## Default Agent Workspaces

When a local agent run has no resolved project/session workspace, Paperclip falls back to an agent home workspace under the instance root:

- `~/.paperclip/instances/default/workspaces/<agent-id>`

This path honors `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` in non-default setups.

For `codex_local`, Paperclip assigns new and updated agents an isolated Codex home under the instance root and blocks shared host/company Codex homes:

- `~/.paperclip/instances/default/companies/<company-id>/agents/<agent-id>/codex-home`

Paperclip also persists an empty `OPENAI_API_KEY` override for those agents so a host-level `OPENAI_API_KEY` cannot leak into Codex runs through process inheritance. If an operator explicitly configures `adapterConfig.env.CODEX_HOME`, it must not point at the shared company `codex-home`, `$CODEX_HOME`, or `~/.codex`.

If the `codex` CLI is not installed or not on `PATH`, `codex_local` agent runs fail at execution time with a clear adapter error. Quota polling uses a short-lived `codex app-server` subprocess: when `codex` cannot be spawned, that provider reports `ok: false` in aggregated quota results and the API server keeps running (it must not exit on a missing binary).

Local adapters require their corresponding CLI/session setup on the machine running Paperclip. External adapters are installed through the adapter/plugin flow and should not require hardcoded imports in `server/` or `ui/`.

## Config Freshness

Agent, project, environment, secret, skill, and workspace config edits are sampled at the next run boundary. A heartbeat that is already running finishes with the config it started with.

When effective run config changes, Paperclip may intentionally skip a saved adapter session, refresh persisted workspace runtime config, replace a reused execution workspace, or avoid reusing a sandbox/environment lease. Fresh execution can lose adapter-specific session, workspace, or sandbox state; correctness of the next run's config takes priority over continuity. Plain environment values affect freshness through value hashes; run result JSON and workspace operation logs expose only the non-sensitive freshness decision categories, without storing secret values, full env maps, provider credentials, or private path details.

## Workspace Git Scan Protection

Paperclip applies one process-wide scheduler to expensive host-side workspace Git enumeration, including changed-file browsing, runtime/finalization cleanliness guards, and adapter sandbox-sync snapshots. The scheduler defaults to two active scans and a bounded queue of 32. Identical scans of the same canonical worktree share one subprocess, while successful changed-file listings are cached for 10 seconds. Correctness-sensitive runtime guards bypass the result cache.

The cache intentionally trades up to a few seconds of changed-file freshness for stable server latency. The file browser retains an explicit refresh action, does not start its query while the panel or browser tab is hidden, and presents overloads as retryable failures rather than an empty workspace. A full queue returns `503` with code `workspace_git_scan_saturated`; a scan exceeding its wall-clock limit returns `504` with code `workspace_git_scan_timeout`. Both responses include `Retry-After: 1`.

Environment overrides:

- `PAPERCLIP_WORKSPACE_GIT_SCAN_CONCURRENCY` (default `2`, range `1`–`16`)
- `PAPERCLIP_WORKSPACE_GIT_SCAN_QUEUE_CAPACITY` (default `32`, range `0`–`1024`)
- `PAPERCLIP_WORKSPACE_GIT_SCAN_TIMEOUT_MS` (default `8000`, range `100`–`120000`)
- `PAPERCLIP_WORKSPACE_GIT_SCAN_CACHE_TTL_MS` (default `10000`, range `0`–`60000`)

Structured `workspace_git_scan` logs expose the operation name, a non-reversible workspace-path hash, queue and execution durations, active/queued counts, cache and single-flight use, and terminal outcome. Saturation and timeout warnings are rate-limited so an overload does not create a second logging storm.

## Worktree-local Instances

When developing from multiple git worktrees, do not point two Paperclip servers at the same embedded PostgreSQL data directory.

Instead, create a repo-local Paperclip config plus an isolated instance for the worktree:

```sh
paperclipai worktree init
# or create the git worktree and initialize it in one step:
npx paperclipai worktree:make paperclip-pr-432
```

This command:

- writes repo-local files at `.paperclip/config.json` and `.paperclip/.env`
- creates an isolated instance under `~/.paperclip-worktrees/instances/<worktree-id>/`
- when run inside a linked git worktree, mirrors the effective git hooks into that worktree's private git dir
- picks a free app port and embedded PostgreSQL port
- disables automatic database backups for the isolated instance
- by default seeds the isolated DB in `minimal` mode from the current effective Paperclip instance/config (repo-local worktree config when present, otherwise the default instance) via a logical SQL snapshot

Seed modes:

- `minimal` keeps core app state like companies, projects, issues, comments, approvals, and auth state, preserves schema for all tables, but omits row data from heavy operational history such as heartbeat runs, wake requests, activity logs, runtime services, and agent session state
- `full` makes a full logical clone of the source instance
- `--no-seed` creates an empty isolated instance

Seeded worktree instances quarantine copied live execution by default for both `minimal` and `full` seeds. During restore, Paperclip disables copied agent timer heartbeats, resets copied `running` agents to `idle`, blocks and unassigns copied agent-owned `in_progress` issues, and unassigns copied agent-owned `todo`/`in_review` issues. This keeps a freshly booted worktree from starting agents for work already owned by the source instance. Pass `--preserve-live-work` only when you intentionally want the isolated worktree to resume copied assignments.

The same quarantine stops copied project/execution-workspace runtime desired states and clears copied runtime process claims. Without this reset, booting the cloned Paperclip database could restart a source workspace's dev service from the isolated instance, creating duplicate runners, port reassignment, and stale public URLs.

After `worktree init`, both the server and the CLI auto-load the repo-local `.paperclip/.env` when run inside that worktree, so normal commands like `pnpm dev`, `paperclipai doctor`, and `paperclipai db:backup` stay scoped to the worktree instance.

`pnpm dev` now fails fast in a linked git worktree when `.paperclip/.env` is missing, instead of silently booting against the default instance/port. If that happens, run `paperclipai worktree init` in the worktree first.

### Lean worktrees and deferred seeding

Seeding a worktree database is the heaviest part of `worktree init`. That work can be deferred so a worktree is cheap to create and only pays the seed cost the first time it is actually used — the CLI/dev-time analog of the server's lazy runtime provisioning (see the board-operator guide's "Lazy runtime provisioning" section).

Seeding state is tracked in `.paperclip/seed-manifest.json`. The versioned manifest records only non-secret evidence: source instance id/config path, target instance id, seed mode, snapshot time, migration revision, attempt timestamps, current phase, terminal state, and a bounded phase diagnostic history. It never stores database credentials or auth credential material. The legacy `seed-pending` and `seed-complete` files remain read-only compatibility signals for worktrees created before the manifest shipped.

The default `worktree init` still seeds eagerly. A lean worktree (created without an eager seed) has a `pending` manifest until something seeds it on demand:

- `pnpm paperclipai worktree ensure-seeded` performs the deferred seed **exactly once**. It is lock-guarded and idempotent: only a complete `verified` manifest short-circuits it, so it is safe to call repeatedly and from concurrent processes. Managed workspaces derive the source from the control-plane-provided base project workspace when it carries its own `.paperclip/config.json`, and otherwise from the control plane's own registered instance config; either way the workspace's manifest never selects it. Manual worktrees must pass `--from-config`.
- `paperclipai run` calls `ensureWorktreeSeeded` automatically before doctor/boot. Managed runs transparently seed a lean worktree from their registered base workspace; an unmanaged lean worktree must first run `worktree ensure-seeded --from-config <source-config>`.
- Managed Paperclip git worktrees default to the repository's `scripts/provision-worktree.sh` when the strategy omits `provisionCommand`, so the isolated config and pending manifest cannot be silently skipped. Runtime startup also runs `scripts/provision-worktree-runtime.sh` automatically when no explicit runtime provision command is configured and the manifest is not verified. Explicitly configured provision commands still take precedence.
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

### Workspace login handoff and readiness

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

### Worktree CLI Reference

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
| `--no-seed` | Skip database seeding from the source instance |
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
| `--no-seed` | Skip database seeding from the source instance |
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

In Vite middleware mode, Paperclip gives HMR a dedicated HTTP server bound to the managed runtime's loopback host. The browser still derives the HMR hostname from the public HTTPS page, so listener containment does not break remote hot reload.

When a workspace service runs Paperclip for browser OAuth QA, configure its `expose.urlTemplate` with the canonical URL the browser can reach. Paperclip preserves explicit `PAPERCLIP_PUBLIC_URL` or `BETTER_AUTH_URL` settings; otherwise it uses a valid exposed HTTPS origin (or loopback HTTP) as the managed runtime fallback for Better Auth and `/api/tools/oauth/callback`. Internal service names such as `http://paperclip-dev:<port>` are rejected unless that hostname is genuinely the browser route. Use a unique origin per isolated worktree. See [Execution Workspaces And Runtime Services](../docs/guides/board-operator/execution-workspaces-and-runtime-services.md#browser-reachable-origins-for-oauth-qa) for configuration and verification.

## App-Shipped Skills Catalog

The Paperclip app ships a curated catalog of company skills out of the box. The
catalog is a workspace package at `packages/skills-catalog`:

```text
packages/skills-catalog/
  catalog/
    bundled/<category>/<slug>/SKILL.md   # recommended defaults
    optional/<category>/<slug>/SKILL.md  # role/domain-specific
  generated/catalog.json                  # checked-in manifest
  scripts/
    build-catalog-manifest.ts             # regenerate generated/catalog.json
    validate-catalog.ts                   # validation only
  src/                                    # builder + types consumed by server/CLI
```

Server and CLI import the generated manifest; they do not crawl repository
paths at request time. Root `skills/` remains reserved for Paperclip runtime
skills and is not part of the catalog.

Validate the catalog without writing the manifest:

```sh
pnpm --filter @paperclipai/skills-catalog validate
```

Regenerate `generated/catalog.json` after editing any catalog `SKILL.md`,
frontmatter, file inventory, category, or slug:

```sh
pnpm --filter @paperclipai/skills-catalog build:manifest
```

The package's `build` script runs `build:manifest` and then `tsc`; tests live
under `pnpm --filter @paperclipai/skills-catalog test`. Validation fails when:

- a catalog entry is not under `catalog/bundled/<category>/<slug>` or
  `catalog/optional/<category>/<slug>`
- `SKILL.md` is missing or the frontmatter `name`/`description` is empty
- the frontmatter `key` disagrees with the generated canonical key
- two catalog entries share an `id`, `key`, or `slug`
- file inventory contains absolute paths, `..`, broken symlinks, or files
  outside the skill directory
- the regenerated manifest differs from the checked-in
  `generated/catalog.json`

Trust level is derived from inventory: `markdown_only` (markdown + references
only), `assets` (other non-script files), or `scripts_executables` (any
executable script). The build contract is documented in
`doc/plans/2026-05-26-skills-cli-catalog-contract.md`.

CI runs `pnpm --filter @paperclipai/skills-catalog validate` and the package's
vitest suite, so always regenerate the manifest in the same commit as the
catalog change.

## App-Shipped Teams Catalog

The team catalog package mirrors the skills catalog workflow for
agentcompanies/v1 team packages:

```text
packages/teams-catalog/
  catalog/
    bundled/<category>/<slug>/TEAM.md
    optional/<category>/<slug>/TEAM.md
  generated/catalog.json
  scripts/
    build-catalog-manifest.ts
    validate-catalog.ts
```

Validate without writing the manifest:

```sh
pnpm --filter @paperclipai/teams-catalog validate
```

Regenerate `generated/catalog.json` after editing catalog team files:

```sh
pnpm --filter @paperclipai/teams-catalog build:manifest
```

Team install/preview APIs enforce source policy. External skill sources require
explicit approval flags, and local-path skill sources are development-only
unless `allowLocalPathSources` is set by the caller.

## Quick Health Checks

In another terminal:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Expected:

- `/api/health` returns `{"status":"ok"}`
- `/api/companies` returns a JSON array

## Reset Local Dev Database

To wipe local dev data and start fresh:

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## Optional: Use External Postgres

If you set `DATABASE_URL`, the server will use that instead of embedded PostgreSQL.

## Automatic DB Backups

Paperclip can run automatic logical database backups on a timer. These backups cover
non-system database schemas, including migration history and plugin-owned database
schemas. Defaults:

- enabled
- every 60 minutes
- retain 30 days
- backup dir: `~/.paperclip/instances/default/data/backups`

Automatic backups are disabled for isolated worktree instances created with
`paperclipai worktree init` or `paperclipai worktree:make`. Existing worktree
configs are migrated to the disabled setting when their server next starts. The
main/default instance keeps the normal enabled-by-default behavior.

Configure these in:

```sh
pnpm paperclipai configure --section database
```

Run a one-off backup manually:

```sh
pnpm paperclipai db:backup
# or:
pnpm db:backup
```

Environment overrides:

- `PAPERCLIP_DB_BACKUP_ENABLED=true|false`
- `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=<minutes>`
- `PAPERCLIP_DB_BACKUP_RETENTION_DAYS=<days>`
- `PAPERCLIP_DB_BACKUP_DIR=/absolute/or/~/path`
- `PAPERCLIP_DB_BACKUP_MAX_AGE_HOURS=<hours>` controls the `/api/health`
  stale-backup warning threshold
- `PAPERCLIP_DB_BACKUP_ALERT_FILE=/path/to/failure-marker` lets external cron
  wrappers surface the last failed backup in `/api/health`
- `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS=<days>` sets how long the
  terminal-workspace reaper waits after an issue tree becomes terminal before it
  archives the execution workspace and deletes the worktree. A person can reopen
  the work inside this window. The default is `7`. A value of `0` disables the
  cooldown and restores immediate reaping. A negative or non-numeric value falls
  back to the default.

Without `PAPERCLIP_DB_BACKUP_ALERT_FILE`, health checks look for
`db-backup-to-s3.failure` in the backup directory, beside the backup directory,
and in the default sibling `health/` directory.

DB backups are not full instance filesystem backups. For full local disaster
recovery, also back up local storage files and the local encrypted secrets key if
those providers are enabled.

## Secrets in Dev

Agent env vars now support secret references. By default, secret values are stored with local encryption and only secret refs are persisted in agent config.

- Default local key path: `~/.paperclip/instances/default/secrets/master.key`
- Override key material directly: `PAPERCLIP_SECRETS_MASTER_KEY`
- Override key file path: `PAPERCLIP_SECRETS_MASTER_KEY_FILE`
- Back up the key file and database together; either one alone is not enough to restore local encrypted secrets.

Strict mode (recommended outside local trusted machines):

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

When strict mode is enabled, sensitive env keys (for example `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.
Authenticated deployments default strict mode on unless explicitly overridden.

CLI configuration support:

- `pnpm paperclipai onboard` writes a default `secrets` config section (`local_encrypted`, strict mode off, key file path set) and creates a local key file when needed.
- `pnpm paperclipai configure --section secrets` lets you update provider/strict mode/key path and creates the local key file when needed.
- `pnpm paperclipai doctor` validates secrets adapter configuration, can create a missing local key file with `--repair`, and reports missing AWS Secrets Manager bootstrap env when that provider is selected.
- Provider health is available at `GET /api/companies/:companyId/secret-providers/health` and reports local key permission warnings plus backup guidance.

Per-company provider vaults are configured in the board UI under
`Company Settings → Secrets → Provider vaults`, backed by
`/api/companies/{companyId}/secret-provider-configs`. The CLI does not own
vault lifecycle today. See `docs/deploy/secrets.md` (`Provider Vaults` section)
for the operator model.

Migration helper for existing inline env secrets:

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## Internal Connection Token Brokers

Connection token exchanges carry a resolved parent credential, so their URLs
are public-only by default even in local/private deployments. To intentionally
use an internal broker, configure an exact hostname allowlist:

```sh
PAPERCLIP_TOKEN_BROKER_ALLOWED_HOSTS=broker.internal.example,10.0.0.42
```

Entries are comma- or whitespace-separated exact hostnames (no wildcards). The
host configured by `PAPERCLIP_PAGES_API_URL` is included automatically. Every
broker hostname is resolved once and the request is pinned to the approved
address; IPv4 and IPv6 link-local destinations remain denied even when their
host is allowlisted.

## Company Deletion Toggle

Company deletion is intended as a dev/debug capability and can be disabled at runtime:

```sh
PAPERCLIP_ENABLE_COMPANY_DELETION=false
```

Default behavior:

- `local_trusted`: enabled
- `authenticated`: disabled

## CLI Client Operations

Paperclip CLI now includes client-side control-plane commands in addition to setup commands.

Quick examples:

```sh
npx paperclipai issue list --company-id <company-id>
npx paperclipai issue create --company-id <company-id> --title "Investigate checkout conflict"
npx paperclipai issue update <issue-id> --status in_progress --comment "Started triage"
```

Set defaults once with context profiles:

```sh
npx paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
```

Then run commands without repeating flags:

```sh
pnpm paperclipai issue list
pnpm paperclipai dashboard get
```

See full command reference in `doc/CLI.md`.

## Agent Invite Onboarding Endpoints

Agent-oriented invite onboarding now exposes machine-readable API docs:

The board UI generates agent onboarding prompts from the add-agent modal (`+` in the agent sidebar), so agent onboarding sits with the rest of agent creation rather than company member invite settings.

- `GET /api/invites/:token` returns invite summary plus onboarding and skills index links.
- `GET /api/invites/:token/onboarding` returns onboarding manifest details (registration endpoint, claim endpoint template, skill install hints).
- `GET /api/invites/:token/onboarding.txt` returns a plain-text onboarding doc intended for both human operators and agents (llm.txt-style handoff), including optional inviter message and suggested network host candidates.
- `GET /api/skills/index` lists available skill documents.
- `GET /api/skills/paperclip` returns the Paperclip heartbeat skill markdown.

Hermes gateway agents use this same generic agent invite flow with
`adapterType=hermes_gateway` and `agentDefaultsPayload.apiBaseUrl` /
`agentDefaultsPayload.apiKey`. See
[HERMES_GATEWAY_ONBOARDING.md](./HERMES_GATEWAY_ONBOARDING.md) for the full
operator path, including Hermes credentials, invite approval, key claim, and
fresh-state Docker smoke setup.

## OpenClaw Join Smoke Test

Run the end-to-end OpenClaw join smoke harness:

```sh
pnpm smoke:openclaw-join
```

What it validates:

- invite creation for agent-only join
- agent join request using `adapterType=openclaw_gateway`
- board approval + one-time API key claim semantics
- callback delivery on wakeup to a dockerized OpenClaw-style webhook receiver

Required permissions:

- This script performs board-governed actions (create invite, approve join, wakeup another agent).
- In authenticated mode, run with board auth via `PAPERCLIP_AUTH_HEADER` or `PAPERCLIP_COOKIE`.

Optional auth flags (for authenticated mode):

- `PAPERCLIP_AUTH_HEADER` (for example `Bearer ...`)
- `PAPERCLIP_COOKIE` (session cookie header value)

## PostHog MCP Live Smoke Test

The PostHog smoke targets an already-running authenticated Paperclip instance.
It is deliberately separate from `pnpm test` and `pnpm test:e2e` because it
uses a live vendor OAuth flow and creates a short-lived connection plus one
fresh-run proof issue.

```sh
INTEGRATIONS_POSTHOG_PAPERCLIP_E2E_EMAIL=operator@example.test \
INTEGRATIONS_POSTHOG_PAPERCLIP_DEV_LOGIN_PASSWORD='<environment-delivered>' \
INTEGRATIONS_POSTHOG_POSTHOG_PROJECT_ID=483530 \
pnpm smoke:posthog-live https://paperclip.example.test
```

The command fails before browser launch unless all three integration bindings
are present, and never prints their values. A Paperclip heartbeat derives the
target origin from its injected `PAPERCLIP_API_URL`; the positional URL (or
`--base-url <url>`) selects the running instance for a manual invocation. It
creates no trace, video, or HAR, begins
screenshots only after OAuth returns to Paperclip, enables read actions only,
installs the connection on `CodexCoderPro` only, runs `project-get` with `{}`
from the board Test panel and a fresh agent run, then removes the connection.
Sanitized JSON and PNG evidence defaults to `PAPERCLIP_RUN_SCRATCH_DIR` when the
command runs in a heartbeat; set `POSTHOG_EVIDENCE_DIR` for a different output
directory.

Run the focused harness checks without contacting Paperclip or PostHog:

```sh
node --test scripts/smoke/posthog-live.test.mjs
```

## OpenClaw Docker UI One-Command Script

To boot OpenClaw in Docker and print a host-browser dashboard URL in one command:

```sh
pnpm smoke:openclaw-docker-ui
```

This script lives at `scripts/smoke/openclaw-docker-ui.sh` and automates clone/build/config/start for Compose-based local OpenClaw UI testing.

Pairing behavior for this smoke script:

- default `OPENCLAW_DISABLE_DEVICE_AUTH=1` (no Control UI pairing prompt for local smoke; no extra pairing env vars required)
- set `OPENCLAW_DISABLE_DEVICE_AUTH=0` to require standard device pairing

Model behavior for this smoke script:

- defaults to OpenAI models (`openai/gpt-5.2` + OpenAI fallback) so it does not require Anthropic auth by default

State behavior for this smoke script:

- defaults to isolated config dir `~/.openclaw-paperclip-smoke`
- resets smoke agent state each run by default (`OPENCLAW_RESET_STATE=1`) to avoid stale provider/auth drift

Networking behavior for this smoke script:

- auto-detects and prints a Paperclip host URL reachable from inside OpenClaw Docker
- default container-side host alias is `host.docker.internal` (override with `PAPERCLIP_HOST_FROM_CONTAINER` / `PAPERCLIP_HOST_PORT`)
- if Paperclip rejects container hostnames in authenticated/private mode, allow `host.docker.internal` via `npx paperclipai allowed-hostname host.docker.internal` and restart Paperclip
