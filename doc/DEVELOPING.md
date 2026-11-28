# Developing

How to set up, run, and test Paperclip locally. The project runs fully in local
dev without setting up PostgreSQL manually.

This file holds setup, commands, and everyday workflow only. Notes on how a
subsystem behaves belong in that subsystem's doc; see
[More documentation](#more-documentation).

## Prerequisites

- Node.js 24.11+
- pnpm 9+

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

`pnpm dev` and `pnpm dev:once` are idempotent for the current repo and instance: if the matching Paperclip dev runner is already alive, Paperclip reports the existing process instead of starting a duplicate.

To run against a separate local state root, pass `--data-dir`. The dev runner
translates it to an isolated `PAPERCLIP_HOME` before migration checks or server
startup, so embedded PostgreSQL and other default instance state live under that
directory:

```sh
pnpm dev --data-dir ./tmp/paperclip-dev
```

Pass the same option to the service-management commands so they use the
isolated runtime-service registry:

```sh
pnpm dev:list --data-dir ./tmp/paperclip-dev
pnpm dev:stop --data-dir ./tmp/paperclip-dev
```

Issue execution may also use project execution workspace policies and workspace runtime services for per-project worktrees, preview servers, and managed dev commands. Configure those through the project workspace/runtime surfaces rather than starting long-running unmanaged processes when a task needs a reusable service.

Inspect or stop the current repo's managed dev runner:

```sh
pnpm dev:list
pnpm dev:stop
```

`pnpm dev:once` tracks backend-relevant file changes and pending migrations. When the current boot is stale, the board UI shows a `Restart required` banner. You can also enable guarded auto-restart in `Instance Settings > Experimental`, which waits for queued/running local agent runs to finish before restarting the dev server.

### Mobile-friendly preview (`pnpm dev:mobile`)

The vite dev server serves an unbundled module graph. This is fast to reload on a local machine but too heavy for phones and tablets on slow links (airplane wifi, mobile data, distant tailnet peers). `pnpm dev:mobile` builds the UI once and serves the small production bundle on port `3101` via `vite preview`, proxying `/api` requests to the dev API on `3100`.

- `pnpm dev:mobile` — build the UI and start the preview server on `:3101`. Rebuild manually to pick up UI source changes.
- `pnpm dev:both` — run `pnpm dev` and `pnpm dev:mobile` together with prefixed output and shared signal handling.

The preview server binds `0.0.0.0` and accepts any Host, so a tailnet or LAN address (e.g. `http://<host>.ts.net:3101/`) works out of the box. The `/api` proxy sets `x-forwarded-host` and `x-forwarded-proto`, which the server's board mutation guard uses to trust the browser's Origin — mutations from `:3101` succeed against the API on `:3100` without further configuration. An HTTPS tunnel in front of the preview server (ngrok, tailscale funnel) is also supported: the tunnel's `x-forwarded-proto` header is preserved when set.

Static UI mode compresses built JavaScript, CSS, and HTML with Brotli or gzip
when the browser supports it. Hashed assets retain their immutable cache policy;
byte-range responses retain their original representation. This reduces initial
page downloads through bandwidth-limited HTTPS tunnels such as Tailscale Funnel.
API responses and MCP transports keep their existing compression behavior.

## Quick Health Checks

In another terminal:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Expected:

- `/api/health` returns `{"status":"ok"}`
- `/api/companies` returns a JSON array

On `*.staging.paperclip.app`, the account menu shows the running server's
short commit SHA below the user's email. Hover over it for the full SHA,
or follow the link to inspect the commit on GitHub.
Opening the menu refreshes `/api/health` so the label reflects recent deploys.
The label is hidden on other hosts and when commit metadata is unavailable.

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

### One-command isolated manual test drive

Use `test-drive` when you want to exercise the UI from a fresh checkout or SHA
without completing onboarding by hand:

```sh
ANTHROPIC_API_KEY=... node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts test-drive
OPENAI_API_KEY=... node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts test-drive --harness codex --model gpt-5.4
OPENROUTER_API_KEY=... node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts test-drive \
  --harness opencode \
  --model openrouter/anthropic/claude-sonnet-4.5
```

The command creates a trusted-loopback instance in a unique OS temporary data
directory, prints the absolute directory, runs onboarding and doctor
non-interactively, creates `Test Company` with a `CEO` agent, then opens the
browser. It runs in the foreground, does not install a background service, and
does not create a goal, project, issue, task, or first heartbeat. Temporary
directories are retained for inspection. Use `--data-dir <path>` to reuse one
or `--no-browser` to suppress browser opening. Reused directories must use the
embedded database: the command rejects database URL environment overrides and
configs with `database.mode: postgres`, suppresses the invocation directory's
`.env` when the server starts, and keeps the normal managed-service collision
guard. The selected instance's own environment file still loads. The command
selects the first available loopback port at or above `3100`.

Source-checkout startup builds the shared and plugin SDK packages when needed
and prints build progress. The command stays in the foreground after printing
its ready URL; use Ctrl-C to stop it. An interrupted build is detected and
rebuilt on the next start.

Claude uses `ANTHROPIC_API_KEY`; Codex uses `OPENAI_API_KEY`; OpenCode uses
`OPENROUTER_API_KEY` and requires an `openrouter/...` model. `--api-key-env`
can name a different source variable while the agent still receives the
canonical variable. `--api-key <value>` is also supported and is mutually
exclusive with `--api-key-env`; Paperclip redacts it from its own output, but
also removes it from the JavaScript argument view before telemetry, diagnostics,
or server startup. Wrappers, operating-system process listings, and shell
history may still expose argument values. This is an explicit local test-drive
tradeoff; use an environment-backed input when that exposure is not acceptable. In a
linked Git worktree the command sets worktree runtime mode and safely arms
**Run tasks in this worktree** for the current isolated instance. Primary
checkouts and non-Git directories leave that experimental setting unchanged.

If the selected data directory already contains any company, `test-drive`
preserves all companies, agents, and secrets and ignores the bootstrap flags.
The worktree execution setting is the only value it may reconcile in that
case.

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

## Reset Local Dev Database

To wipe local dev data and start fresh:

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## Optional: Use External Postgres

If you set `DATABASE_URL`, the server will use that instead of embedded PostgreSQL.

## Storage in Dev (Auto-Handled)

For local development, the default storage provider is `local_disk`, which persists uploaded images/attachments at:

- `~/.paperclip/instances/default/data/storage`

Configure storage provider/settings:

```sh
pnpm paperclipai configure --section storage
```

## Secrets in Dev

Agent env vars support secret references. By default, secret values are stored with local encryption and only secret refs are persisted in agent config.

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
`Company Settings → Secrets → Vaults`, backed by
`/api/companies/{companyId}/secret-provider-configs`. The CLI does not own
vault lifecycle today. See `docs/deploy/secrets.md` (`Provider Vaults` section)
for the operator model.

Migration helper for existing inline env secrets:

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## Deployment Modes

For mode definitions and intended CLI behavior, see `doc/DEPLOYMENT-MODES.md`.

For sandbox file synchronization, lock ownership, and the required upgrade
procedure from directory locks, see [Workspace restore locks](workspace-restore-locks.md).

Current implementation status:

- canonical model: `local_trusted` and `authenticated` (with `private/public` exposure)

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
- `--no-seed` defers database copying until the worktree is first used
- `--empty` creates an empty isolated instance, with fresh signing secrets and no deferred copy; use this for synthetic test drives

`--empty` persists a `.paperclip/seed-empty` marker before writing the instance config.
The CLI and managed runtime provisioner honor it even when a registered source
instance is present. An explicit successful `worktree reseed`, or a replacement
`worktree init --force` without `--empty`, clears the choice.
While that marker exists, startup uses the instance's saved JWT and tool-action
signing keys even if the shell inherited another instance's keys. Better Auth
uses its saved key or the fresh instance JWT key. Missing saved keys stop startup.

Seeded worktree instances quarantine copied live execution by default for both `minimal` and `full` seeds. During restore, Paperclip disables copied agent timer heartbeats, resets copied `running` agents to `idle`, blocks and unassigns copied agent-owned `in_progress` issues, and unassigns copied agent-owned `todo`/`in_review` issues. This keeps a freshly booted worktree from starting agents for work already owned by the source instance. Pass `--preserve-live-work` only when you intentionally want the isolated worktree to resume copied assignments.

The same quarantine stops copied project/execution-workspace runtime desired states and clears copied runtime process claims. Without this reset, booting the cloned Paperclip database could restart a source workspace's dev service from the isolated instance, creating duplicate runners, port reassignment, and stale public URLs.

After `worktree init`, both the server and the CLI auto-load the repo-local `.paperclip/.env` when run inside that worktree, so normal commands like `pnpm dev`, `paperclipai doctor`, and `paperclipai db:backup` stay scoped to the worktree instance.

`pnpm dev` fails fast in a linked git worktree when `.paperclip/.env` is missing, instead of silently booting against the default instance/port. If that happens, run `paperclipai worktree init` in the worktree first.

See [the worktree reference](worktrees.md) for deferred seeding, reseeding,
repair, and every `paperclipai worktree` option.

## Test Commands

The [feature map](../maps/feature-map/README.md) is an optional reference for user
entry points, targeted tests, manual verification recipes, and coverage gaps.
Its generated page inventory lists current source references. The documented journeys have separate
verification steps and do not run automatically from the map.

The sibling [agent access map](../maps/agent-access-map/README.md) describes API
and agent reachability for the same capabilities. The [map contract](../maps/README.md)
defines synchronization, permissions and evidence. After map edits, run
`node scripts/check-maps.mjs` for structural/reference checks; it does not start an
instance or qualify access as an agent.

### Agent worktree preflight

Prepare a new or updated agent worktree with one command:

```sh
node scripts/agent-preflight.mjs
```

It does what `pnpm install --frozen-lockfile`, the plugin SDK's `ensure-build-deps`,
the Runner's `ensure:eval-build-deps`, `build:rust`, `build` and
`build:runner-binaries` did, and skips work whose inputs are unchanged:

- **install** is skipped when the lockfile, every `package.json`, `patches/`, Node
  and pnpm match this worktree's last install.
- **plugin SDK build** runs `scripts/ensure-plugin-build-deps.mjs`, which builds
  `@paperclipai/plugin-sdk` and its `@paperclipai/shared` dependency and skips
  them when their content fingerprints match the last build. Like the Runner and
  the eval kernel, the SDK is imported through its built `dist` (plugin workers
  load it under plain Node), so the server and the restart-chaos harness cannot
  start without it. Both compile in about two seconds, so they do not use the
  shared cache.
- **Runner build** is skipped when the Runner's build stamp is current. When another
  worktree built the same inputs (the build-input digest described under
  [Reused Runner build in the server build](test-infrastructure.md#reused-runner-build-in-the-server-build),
  plus the compiler), the Runner and eval
  kernel `dist` are cloned from the shared cache. A restore skips the build's lint
  checks; CI runs them.
- **Runner debug binaries** (`runner/target/debug`) are reused the same way, keyed
  by every file the Rust build reads.
- A worktree without `runner/target` starts from a clone of a shared cargo seed
  that holds only third-party crates, so cargo compiles only the Runner crate.

The cache lives in `~/.cache/paperclip/agent-build` (`PAPERCLIP_AGENT_CACHE_DIR`
moves it, `PAPERCLIP_AGENT_CACHE=0` or `--no-cache` turns it off). Entries are
keyed by content and toolchain, never by path or mtime, are written once with an
atomic rename, and are restored as APFS clones, so concurrent worktrees can share
them. The seed never holds the Runner crate: cargo records its out-of-package
includes by absolute path, so units from another checkout cannot be trusted. Keep
the cache on the worktrees' volume so clones stay cheap. `--explain` prints each
step's decision; `--skip-rust-debug` skips the debug binaries.

Do not share `CARGO_TARGET_DIR` between worktrees: cargo serializes builds on its
lock, and the Runner crate's absolute-path dependency records would make one
worktree's freshness check read another's files. The preflight disables the cache
when `CARGO_TARGET_DIR` is set.

### Incremental local verification

Use the local verification entry point for ordinary issue work:

```sh
pnpm verify
pnpm verify --explain
pnpm verify --base origin/master
```

The command compares the actual working tree with the merge base of the supplied
local ref, including committed, staged, unstaged, deleted, renamed, and untracked
paths. The default ref is local `origin/master`, falling back to `master`; it does
not fetch. Tests read the current working-tree bytes. CI must still verify the
final committed revision. The task/input policy, conservative import and file-read
graph, exact Vitest specifications, and stable test runner are shared with CI.
Serialized server tests retain their owner. Native server tests remain in local
coverage. Selected chat tests retain six sequential isolated line shards.

When the change touches `packages/shared/src`, `packages/plugins/sdk/src`, or an
SDK build input such as `pnpm-lock.yaml`, the command first checks the committed
SDK public input pins (`tests/runner-e2e/source-sdk-public-inputs.json`) against
the working tree. If they are stale it exits 1 and prints the refresh command:
commit the change, run
`node tests/runner-e2e/source-sdk-public-inputs.mjs $(git rev-parse HEAD) --write`,
and commit the updated registry. Otherwise the Runner support suite fails in CI.

Successful selected checks with complete input graphs are reusable in this
worktree. Opaque filesystem, subprocess, network, generated/untracked-module, and
unreviewed dependency consumers continue to run fresh. A selected pass never
satisfies a full run. Non-isolated projects and uncertain selection require broader
verification. The command prints the local test scope and remaining CI lanes.

An unchanged repeat can reuse both graph discovery and passing checks. Keys include
actual tracked and non-ignored file contents (including dirty and untracked files),
the shared audited-prose exclusions, dotenv files, lockfile, installation metadata,
dependency bindings and installed package contents, the complete effective child environment, Node/pnpm/Rust toolchains,
platform, checkout path, comparison, and selection. Values from the environment
are hashed, not written to results. External database/live-test settings and
out-of-checkout source symlinks disable reuse. Cache state lives under the ignored
`.turbo/local-verify/` directory and is not shared across worktrees or machines.
Installed package content digests are memoized against file identity, size, mode,
and nanosecond modification/change times; every check rescans the installation.
Generated Vite/cache directories are excluded. The first run after installation
reads package contents; unchanged repeats avoid reading those bytes again.
`last-run.json` retains the latest completed execution's status and scope. Failed/interrupted
attempts do not publish passes. Inputs changed during a run invalidate its result.

Exit 2 reports a broad input, incomplete graph, or unsupported selection. It does
not silently launch the full suite or claim affected coverage passed. Use focused
checks and required CI to close that gap, or explicitly request a broad local run:

```sh
pnpm verify --full
pnpm verify --no-cache
```

`--full` executes the complete existing Vitest path with fresh integration coverage.
`--no-cache` bypasses pass/plan reuse and does not save passes. A fresh failed or
interrupted attempt removes its old reusable pass. Required CI on the final tested
revision may supply broad typecheck/build/test coverage for a PR handoff; do not
repeat a full local suite solely because a chat resumed or a PR is ready. Keep
release checks and any real browser, provider, local-platform or acceptance proof.

The full local Vitest commands remain available:

```sh
pnpm test
```

`pnpm test` runs the Vitest suite only. Its default chat integration coverage runs
first in six sequential, exact-cover child processes, each with its own home,
config and embedded PostgreSQL. The remaining server invocation excludes that
chat file once and retains the native Runner suites. This bounds shared fixture
and process lifetime without increasing concurrency or changing case assertions
or timeouts. An explicit `PAPERCLIP_TEST_DATABASE_URL` retains the original
single, serial database path. Explicit `--group` invocations and CI shard routing
are unchanged.

For interactive Vitest watch mode use:

```sh
pnpm test:watch
```

Browser suites stay separate:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

These browser suites are intended for targeted local verification and CI, not the default agent/human test command.

The default E2E configuration builds the UI into `server/ui-dist` before starting
its throwaway instance and serves that build with
`PAPERCLIP_UI_DEV_MIDDLEWARE=false`. This exercises the
shipped assets, including service-worker takeover and reload, without traversing
the development server's unbundled module graph on each navigation. Browser
assertion deadlines and retries remain unchanged. Use `pnpm dev` separately when
verifying Vite/HMR behavior.

For normal issue work, start with the smallest targeted check that proves the change.
Use the incremental command above and required final-revision CI for PR handoff.
Run broad local checks when an unresolved risk or explicit qualification needs them.

## Storybook

The board UI Storybook keeps stories and Storybook config under `ui/storybook/` so component review files stay out of the app source routes.

Stories are grouped in `ui/storybook/stories/<feature-area>/`. Feature recipe
navigation controls the sidebar. Shared fixtures live in `ui/storybook/support/`.
Keep each suite's explicit meta `id` when changing titles or locations so existing
review links remain valid. Author capability associations, implementation/data
classification and durable limitations in the story's `parameters.paperclip`.

Storybook start/build generates the catalog, feature Overview pages, and literal
sidebar order from the checked-out sources. `ui/storybook/generated/` and
`ui/storybook/.storybook/preview.tsx` are ignored build outputs. Shared preview
fixtures and decorators live in `preview-base.tsx`; generation never edits it.
UI typechecking also generates the inputs on a fresh checkout.

Run `node scripts/storybook-catalog.mjs` to assemble the local Markdown indexes,
verification routes and page inventory under `maps/generated/`. Use `--check`
for validation without writes. These outputs are not committed. Use Git diffs to
select affected sources for review; do not maintain review fingerprints or append
a shared review journal. Record executed evidence in the PR, issue, or CI result.

The [Storybook map contract](../maps/storybook-map/README.md) describes annotations
and the [published guide](https://d1p6rlowie26tp.cloudfront.net/storybook/branches/master/?path=/story/overview-storybook-guide--coverage-guide).
Use `maintain-storybook` for source alignment and `review-storybook` for rendering
and interactions. Generated guides, example counts and structural checks do not
establish production behavior. Feature recipes retain optional verification
scope guidance; the feature/access structural check needs no Storybook runtime.

```sh
pnpm storybook
pnpm build-storybook
```

These run the `@paperclipai/ui` Storybook on port `6006` and build the static output to `ui/storybook-static/`.

Run one story suite's browser checks against a running Storybook with:

```sh
STORYBOOK_TEST_BASE_URL=http://localhost:6006 pnpm exec playwright test <name>.spec.ts --config=tests/storybook-visual/playwright.config.ts --project=stories
```

To publish a branch's Storybook, see
[Publish a branch Storybook](STORYBOOK-DEPLOYMENT.md#publish-a-branch-storybook).

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

## CLI Client Operations

Paperclip CLI includes client-side control-plane commands in addition to setup commands.

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

## More documentation

Background on how each area works. These can be out of date; the code and its
tests are the source of truth.

| Area | Doc |
| --- | --- |
| Schema, migrations, DB clients | [DATABASE.md](DATABASE.md), [database-backups.md](database-backups.md) |
| CI routing, trusted PR workflow, lockfiles, typecheck lane | [ci-workflows.md](ci-workflows.md) |
| Test tooling internals, typecheck memory, benchmarks, smoke tests | [test-infrastructure.md](test-infrastructure.md) |
| Worktree commands and seeding | [worktrees.md](worktrees.md) |
| Restarts and deploys | [hot-restart-deploys.md](hot-restart-deploys.md) |
| Heartbeat service and background workers | [heartbeat-internals.md](heartbeat-internals.md) |
| Paperclip Runner | [RUNNER-INTEGRATION-PLAYBOOK.md](RUNNER-INTEGRATION-PLAYBOOK.md), [runner-internals.md](runner-internals.md) |
| Workspace directories, repositories, caches | [workspace-repositories.md](workspace-repositories.md) |
| Managed-cloud and remote workspace storage | [workspace-storage.md](workspace-storage.md) |
| Skills and teams catalogs | [skills-and-teams-catalog.md](skills-and-teams-catalog.md) |
| Board UI internals, saved read cache | [ui-internals.md](ui-internals.md) |
| Storybook publishing | [STORYBOOK-DEPLOYMENT.md](STORYBOOK-DEPLOYMENT.md) |
| Cases experiment | [case-handoffs.md](case-handoffs.md) |
| Slack chat in local dev, connector diagnostics | [chat-connector-development.md](chat-connector-development.md) |
| Environment switches and Cloud startup configuration | [instance-configuration.md](instance-configuration.md) |
| Small integration API contracts | [integration-api-notes.md](integration-api-notes.md) |
| Private tasks and projects | [ISSUE-PRIVACY.md](ISSUE-PRIVACY.md) |
| Agent deliverables | [AGENT-ARTIFACTS.md](AGENT-ARTIFACTS.md) |

## Codex Run-Home Recovery

Local Codex runs use a private home under
`<company-dir>/acp-engine/agents/<agent-id>/codex-run-homes/<run-id>/home`.
This preserves the restricted-run isolation boundary.
Paperclip keeps sanitized session JSONL after the runtime closes. It then removes
the raw run home. Successful retention writes an atomic
`retention-complete.json` manifest, including for valid zero-session runs. If
retention or runtime close fails, Paperclip removes partial retained output,
preserves the home, and writes a sibling `<run-id>.quarantine` marker.

The orphan sweeper is dry-run only unless `--delete` is present:

```sh
npx tsx packages/adapter-utils/src/acpx-engine/run-home-sweeper.ts \
  --company-dir /path/to/companies/<company-id>
```

Set `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` for both modes. The sweeper fails
closed unless it can prove that the heartbeat run is terminal, the home has no
open file handles, the home is older than the grace window, and a sanitized
retention counterpart has proof of completion. New counterparts require a valid
completion manifest. Legacy counterparts require a contained, non-empty JSONL
artifact. Empty, unreadable, or symlinked counterparts fail closed. A quarantine
marker records an incident. It does not permit deletion of the only raw copy.

Review the JSON manifest before you add `--delete`. Keep the default 24-hour
grace period unless the operator has approved a different recovery window.
