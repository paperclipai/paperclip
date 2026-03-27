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

`pnpm dev:once` now tracks backend-relevant file changes and pending migrations. When the current boot is stale, the board UI shows a `Restart required` banner. You can also enable guarded auto-restart in `Instance Settings > Experimental`, which waits for queued/running local agent runs to finish before restarting the dev server.

Tailscale/private-auth dev mode:

```sh
pnpm dev --tailscale-auth
```

This runs dev as `authenticated/private` and binds the server to `0.0.0.0` for private-network access.

Allow additional private hostnames (for example custom Tailscale hostnames):

```sh
pnpm ironworksai allowed-hostname dotta-macbook-pro
```

## One-Command Local Run

For a first-time local install, you can bootstrap and run in one command:

```sh
pnpm ironworksai run
```

`ironworksai run` does:

1. auto-onboard if config is missing
2. `ironworksai doctor` with repair enabled
3. starts the server when checks pass

## Docker Quickstart (No local Node install)

Build and run Ironworks in Docker:

```sh
docker build -t ironworks-local .
docker run --name ironworks \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e IRONWORKS_HOME=/ironworks \
  -v "$(pwd)/data/docker-ironworks:/ironworks" \
  ironworks-local
```

Or use Compose:

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

See `doc/DOCKER.md` for API key wiring (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) and persistence details.

## Docker For Untrusted PR Review

For a separate review-oriented container that keeps `codex`/`claude` login state in Docker volumes and checks out PRs into an isolated scratch workspace, see `doc/UNTRUSTED-PR-REVIEW.md`.

## Database in Dev (Auto-Handled)

For local development, leave `DATABASE_URL` unset.
The server will automatically use embedded PostgreSQL and persist data at:

- `~/.ironworks/instances/default/db`

Override home and instance:

```sh
IRONWORKS_HOME=/custom/path IRONWORKS_INSTANCE_ID=dev pnpm ironworksai run
```

No Docker or external database is required for this mode.

## Storage in Dev (Auto-Handled)

For local development, the default storage provider is `local_disk`, which persists uploaded images/attachments at:

- `~/.ironworks/instances/default/data/storage`

Configure storage provider/settings:

```sh
pnpm ironworksai configure --section storage
```

## Default Agent Workspaces

When a local agent run has no resolved project/session workspace, Ironworks falls back to an agent home workspace under the instance root:

- `~/.ironworks/instances/default/workspaces/<agent-id>`

This path honors `IRONWORKS_HOME` and `IRONWORKS_INSTANCE_ID` in non-default setups.

For `codex_local`, Ironworks also manages a per-company Codex home under the instance root and seeds it from the shared Codex login/config home (`$CODEX_HOME` or `~/.codex`):

- `~/.ironworks/instances/default/companies/<company-id>/codex-home`

## Worktree-local Instances

When developing from multiple git worktrees, do not point two Ironworks servers at the same embedded PostgreSQL data directory.

Instead, create a repo-local Ironworks config plus an isolated instance for the worktree:

```sh
ironworksai worktree init
# or create the git worktree and initialize it in one step:
pnpm ironworksai worktree:make ironworks-pr-432
```

This command:

- writes repo-local files at `.ironworks/config.json` and `.ironworks/.env`
- creates an isolated instance under `~/.ironworks-worktrees/instances/<worktree-id>/`
- when run inside a linked git worktree, mirrors the effective git hooks into that worktree's private git dir
- picks a free app port and embedded PostgreSQL port
- by default seeds the isolated DB in `minimal` mode from the current effective Ironworks instance/config (repo-local worktree config when present, otherwise the default instance) via a logical SQL snapshot

Seed modes:

- `minimal` keeps core app state like companies, projects, issues, comments, approvals, and auth state, preserves schema for all tables, but omits row data from heavy operational history such as heartbeat runs, wake requests, activity logs, runtime services, and agent session state
- `full` makes a full logical clone of the source instance
- `--no-seed` creates an empty isolated instance

After `worktree init`, both the server and the CLI auto-load the repo-local `.ironworks/.env` when run inside that worktree, so normal commands like `pnpm dev`, `ironworksai doctor`, and `ironworksai db:backup` stay scoped to the worktree instance.

That repo-local env also sets:

- `IRONWORKS_IN_WORKTREE=true`
- `IRONWORKS_WORKTREE_NAME=<worktree-name>`
- `IRONWORKS_WORKTREE_COLOR=<hex-color>`

The server/UI use those values for worktree-specific branding such as the top banner and dynamically colored favicon.

Print shell exports explicitly when needed:

```sh
ironworksai worktree env
# or:
eval "$(ironworksai worktree env)"
```

### Worktree CLI Reference

**`pnpm ironworksai worktree init [options]`** — Create repo-local config/env and an isolated instance for the current worktree.

| Option | Description |
|---|---|
| `--name <name>` | Display name used to derive the instance id |
| `--instance <id>` | Explicit isolated instance id |
| `--home <path>` | Home root for worktree instances (default: `~/.ironworks-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source IRONWORKS_HOME used when deriving the source config |
| `--from-instance <id>` | Source instance id (default: `default`) |
| `--server-port <port>` | Preferred server port |
| `--db-port <port>` | Preferred embedded Postgres port |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Skip database seeding from the source instance |
| `--force` | Replace existing repo-local config and isolated instance data |

Examples:

```sh
ironworksai worktree init --no-seed
ironworksai worktree init --seed-mode full
ironworksai worktree init --from-instance default
ironworksai worktree init --from-data-dir ~/.ironworks
ironworksai worktree init --force
```

Repair an already-created repo-managed worktree and reseed its isolated instance from the main default install:

```sh
cd ~/.ironworks/worktrees/PAP-884-ai-commits-component
pnpm ironworksai worktree init --force --seed-mode minimal \
  --name PAP-884-ai-commits-component \
  --from-config ~/.ironworks/instances/default/config.json
```

That rewrites the worktree-local `.ironworks/config.json` + `.ironworks/.env`, recreates the isolated instance under `~/.ironworks-worktrees/instances/<worktree-id>/`, and preserves the git worktree contents themselves.

**`pnpm ironworksai worktree:make <name> [options]`** — Create `~/NAME` as a git worktree, then initialize an isolated Ironworks instance inside it. This combines `git worktree add` with `worktree init` in a single step.

| Option | Description |
|---|---|
| `--start-point <ref>` | Remote ref to base the new branch on (e.g. `origin/main`) |
| `--instance <id>` | Explicit isolated instance id |
| `--home <path>` | Home root for worktree instances (default: `~/.ironworks-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source IRONWORKS_HOME used when deriving the source config |
| `--from-instance <id>` | Source instance id (default: `default`) |
| `--server-port <port>` | Preferred server port |
| `--db-port <port>` | Preferred embedded Postgres port |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Skip database seeding from the source instance |
| `--force` | Replace existing repo-local config and isolated instance data |

Examples:

```sh
pnpm ironworksai worktree:make ironworks-pr-432
pnpm ironworksai worktree:make my-feature --start-point origin/main
pnpm ironworksai worktree:make experiment --no-seed
```

**`pnpm ironworksai worktree env [options]`** — Print shell exports for the current worktree-local Ironworks instance.

| Option | Description |
|---|---|
| `-c, --config <path>` | Path to config file |
| `--json` | Print JSON instead of shell exports |

Examples:

```sh
pnpm ironworksai worktree env
pnpm ironworksai worktree env --json
eval "$(pnpm ironworksai worktree env)"
```

For project execution worktrees, Ironworks can also run a project-defined provision command after it creates or reuses an isolated git worktree. Configure this on the project's execution workspace policy (`workspaceStrategy.provisionCommand`). The command runs inside the derived worktree and receives `IRONWORKS_WORKSPACE_*`, `IRONWORKS_PROJECT_ID`, `IRONWORKS_AGENT_ID`, and `IRONWORKS_ISSUE_*` environment variables so each repo can bootstrap itself however it wants.

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
rm -rf ~/.ironworks/instances/default/db
pnpm dev
```

## Optional: Use External Postgres

If you set `DATABASE_URL`, the server will use that instead of embedded PostgreSQL.

## Automatic DB Backups

Ironworks can run automatic DB backups on a timer. Defaults:

- enabled
- every 60 minutes
- retain 30 days
- backup dir: `~/.ironworks/instances/default/data/backups`

Configure these in:

```sh
pnpm ironworksai configure --section database
```

Run a one-off backup manually:

```sh
pnpm ironworksai db:backup
# or:
pnpm db:backup
```

Environment overrides:

- `IRONWORKS_DB_BACKUP_ENABLED=true|false`
- `IRONWORKS_DB_BACKUP_INTERVAL_MINUTES=<minutes>`
- `IRONWORKS_DB_BACKUP_RETENTION_DAYS=<days>`
- `IRONWORKS_DB_BACKUP_DIR=/absolute/or/~/path`

## Secrets in Dev

Agent env vars now support secret references. By default, secret values are stored with local encryption and only secret refs are persisted in agent config.

- Default local key path: `~/.ironworks/instances/default/secrets/master.key`
- Override key material directly: `IRONWORKS_SECRETS_MASTER_KEY`
- Override key file path: `IRONWORKS_SECRETS_MASTER_KEY_FILE`

Strict mode (recommended outside local trusted machines):

```sh
IRONWORKS_SECRETS_STRICT_MODE=true
```

When strict mode is enabled, sensitive env keys (for example `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.

CLI configuration support:

- `pnpm ironworksai onboard` writes a default `secrets` config section (`local_encrypted`, strict mode off, key file path set) and creates a local key file when needed.
- `pnpm ironworksai configure --section secrets` lets you update provider/strict mode/key path and creates the local key file when needed.
- `pnpm ironworksai doctor` validates secrets adapter configuration and can create a missing local key file with `--repair`.

Migration helper for existing inline env secrets:

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## Company Deletion Toggle

Company deletion is intended as a dev/debug capability and can be disabled at runtime:

```sh
IRONWORKS_ENABLE_COMPANY_DELETION=false
```

Default behavior:

- `local_trusted`: enabled
- `authenticated`: disabled

## CLI Client Operations

Ironworks CLI now includes client-side control-plane commands in addition to setup commands.

Quick examples:

```sh
pnpm ironworksai issue list --company-id <company-id>
pnpm ironworksai issue create --company-id <company-id> --title "Investigate checkout conflict"
pnpm ironworksai issue update <issue-id> --status in_progress --comment "Started triage"
```

Set defaults once with context profiles:

```sh
pnpm ironworksai context set --api-base http://localhost:3100 --company-id <company-id>
```

Then run commands without repeating flags:

```sh
pnpm ironworksai issue list
pnpm ironworksai dashboard get
```

See full command reference in `doc/CLI.md`.

## OpenClaw Invite Onboarding Endpoints

Agent-oriented invite onboarding now exposes machine-readable API docs:

- `GET /api/invites/:token` returns invite summary plus onboarding and skills index links.
- `GET /api/invites/:token/onboarding` returns onboarding manifest details (registration endpoint, claim endpoint template, skill install hints).
- `GET /api/invites/:token/onboarding.txt` returns a plain-text onboarding doc intended for both human operators and agents (llm.txt-style handoff), including optional inviter message and suggested network host candidates.
- `GET /api/skills/index` lists available skill documents.
- `GET /api/skills/ironworks` returns the Ironworks heartbeat skill markdown.

## OpenClaw Join Smoke Test

Run the end-to-end OpenClaw join smoke harness:

```sh
pnpm smoke:openclaw-join
```

What it validates:

- invite creation for agent-only join
- agent join request using `adapterType=openclaw`
- board approval + one-time API key claim semantics
- callback delivery on wakeup to a dockerized OpenClaw-style webhook receiver

Required permissions:

- This script performs board-governed actions (create invite, approve join, wakeup another agent).
- In authenticated mode, run with board auth via `IRONWORKS_AUTH_HEADER` or `IRONWORKS_COOKIE`.

Optional auth flags (for authenticated mode):

- `IRONWORKS_AUTH_HEADER` (for example `Bearer ...`)
- `IRONWORKS_COOKIE` (session cookie header value)

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

- defaults to isolated config dir `~/.openclaw-ironworks-smoke`
- resets smoke agent state each run by default (`OPENCLAW_RESET_STATE=1`) to avoid stale provider/auth drift

Networking behavior for this smoke script:

- auto-detects and prints a Ironworks host URL reachable from inside OpenClaw Docker
- default container-side host alias is `host.docker.internal` (override with `IRONWORKS_HOST_FROM_CONTAINER` / `IRONWORKS_HOST_PORT`)
- if Ironworks rejects container hostnames in authenticated/private mode, allow `host.docker.internal` via `pnpm ironworksai allowed-hostname host.docker.internal` and restart Ironworks
