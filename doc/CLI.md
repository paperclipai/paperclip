# CLI Reference

Ironworks CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm ironworksai --help
```

First-time local bootstrap + run:

```sh
pnpm ironworksai run
```

Choose local instance:

```sh
pnpm ironworksai run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `ironworksai onboard` and `ironworksai configure --section server` set deployment mode in config
- runtime can override mode with `IRONWORKS_DEPLOYMENT_MODE`
- `ironworksai run` and `ironworksai doctor` do not yet expose a direct `--mode` flag

Target behavior (planned) is documented in `doc/DEPLOYMENT-MODES.md` section 5.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm ironworksai allowed-hostname dotta-macbook-pro
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.ironworks`:

```sh
pnpm ironworksai run --data-dir ./tmp/ironworks-dev
pnpm ironworksai issue list --data-dir ./tmp/ironworks-dev
```

## Context Profiles

Store local defaults in `~/.ironworks/context.json`:

```sh
pnpm ironworksai context set --api-base http://localhost:3100 --company-id <company-id>
pnpm ironworksai context show
pnpm ironworksai context list
pnpm ironworksai context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm ironworksai context set --api-key-env-var-name IRONWORKS_API_KEY
export IRONWORKS_API_KEY=...
```

## Company Commands

```sh
pnpm ironworksai company list
pnpm ironworksai company get <company-id>
pnpm ironworksai company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm ironworksai company delete PAP --yes --confirm PAP
pnpm ironworksai company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `IRONWORKS_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `IRONWORKS_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm ironworksai issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm ironworksai issue get <issue-id-or-identifier>
pnpm ironworksai issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm ironworksai issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm ironworksai issue comment <issue-id> --body "..." [--reopen]
pnpm ironworksai issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm ironworksai issue release <issue-id>
```

## Agent Commands

```sh
pnpm ironworksai agent list --company-id <company-id>
pnpm ironworksai agent get <agent-id>
pnpm ironworksai agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Ironworks agent:

- creates a new long-lived agent API key
- installs missing Ironworks skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `IRONWORKS_API_URL`, `IRONWORKS_COMPANY_ID`, `IRONWORKS_AGENT_ID`, and `IRONWORKS_API_KEY`

Example for shortname-based local setup:

```sh
pnpm ironworksai agent local-cli codexcoder --company-id <company-id>
pnpm ironworksai agent local-cli claudecoder --company-id <company-id>
```

## Approval Commands

```sh
pnpm ironworksai approval list --company-id <company-id> [--status pending]
pnpm ironworksai approval get <approval-id>
pnpm ironworksai approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm ironworksai approval approve <approval-id> [--decision-note "..."]
pnpm ironworksai approval reject <approval-id> [--decision-note "..."]
pnpm ironworksai approval request-revision <approval-id> [--decision-note "..."]
pnpm ironworksai approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm ironworksai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm ironworksai activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm ironworksai dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm ironworksai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Default local instance root is `~/.ironworks/instances/default`:

- config: `~/.ironworks/instances/default/config.json`
- embedded db: `~/.ironworks/instances/default/db`
- logs: `~/.ironworks/instances/default/logs`
- storage: `~/.ironworks/instances/default/data/storage`
- secrets key: `~/.ironworks/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
IRONWORKS_HOME=/custom/home IRONWORKS_INSTANCE_ID=dev pnpm ironworksai run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm ironworksai configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
