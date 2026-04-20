# CLI Reference

AiTeamCorp CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm aiteamcorp --help
```

First-time local bootstrap + run:

```sh
pnpm aiteamcorp run
```

Choose local instance:

```sh
pnpm aiteamcorp run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `aiteamcorp onboard` and `aiteamcorp configure --section server` set deployment mode in config
- server onboarding/configure ask for reachability intent and write `server.bind`
- `aiteamcorp run --bind <loopback|lan|tailnet>` passes a quickstart bind preset into first-run onboarding when config is missing
- runtime can override mode with `AITEAMCORP_DEPLOYMENT_MODE`
- `aiteamcorp run` and `aiteamcorp doctor` still do not expose a direct low-level `--mode` flag

Canonical behavior is documented in `doc/DEPLOYMENT-MODES.md`.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm aiteamcorp allowed-hostname dotta-macbook-pro
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.aiteamcorp`:

```sh
pnpm aiteamcorp run --data-dir ./tmp/aiteamcorp-dev
pnpm aiteamcorp issue list --data-dir ./tmp/aiteamcorp-dev
```

## Context Profiles

Store local defaults in `~/.aiteamcorp/context.json`:

```sh
pnpm aiteamcorp context set --api-base http://localhost:3100 --company-id <company-id>
pnpm aiteamcorp context show
pnpm aiteamcorp context list
pnpm aiteamcorp context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm aiteamcorp context set --api-key-env-var-name AITEAMCORP_API_KEY
export AITEAMCORP_API_KEY=...
```

## Company Commands

```sh
pnpm aiteamcorp company list
pnpm aiteamcorp company get <company-id>
pnpm aiteamcorp company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm aiteamcorp company delete PAP --yes --confirm PAP
pnpm aiteamcorp company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `AITEAMCORP_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `AITEAMCORP_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm aiteamcorp issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm aiteamcorp issue get <issue-id-or-identifier>
pnpm aiteamcorp issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm aiteamcorp issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm aiteamcorp issue comment <issue-id> --body "..." [--reopen]
pnpm aiteamcorp issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm aiteamcorp issue release <issue-id>
```

## Agent Commands

```sh
pnpm aiteamcorp agent list --company-id <company-id>
pnpm aiteamcorp agent get <agent-id>
pnpm aiteamcorp agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a AiTeamCorp agent:

- creates a new long-lived agent API key
- installs missing AiTeamCorp skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `AITEAMCORP_API_URL`, `AITEAMCORP_COMPANY_ID`, `AITEAMCORP_AGENT_ID`, and `AITEAMCORP_API_KEY`

Example for shortname-based local setup:

```sh
pnpm aiteamcorp agent local-cli codexcoder --company-id <company-id>
pnpm aiteamcorp agent local-cli claudecoder --company-id <company-id>
```

## Approval Commands

```sh
pnpm aiteamcorp approval list --company-id <company-id> [--status pending]
pnpm aiteamcorp approval get <approval-id>
pnpm aiteamcorp approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm aiteamcorp approval approve <approval-id> [--decision-note "..."]
pnpm aiteamcorp approval reject <approval-id> [--decision-note "..."]
pnpm aiteamcorp approval request-revision <approval-id> [--decision-note "..."]
pnpm aiteamcorp approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm aiteamcorp approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm aiteamcorp activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm aiteamcorp dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm aiteamcorp heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Default local instance root is `~/.aiteamcorp/instances/default`:

- config: `~/.aiteamcorp/instances/default/config.json`
- embedded db: `~/.aiteamcorp/instances/default/db`
- logs: `~/.aiteamcorp/instances/default/logs`
- storage: `~/.aiteamcorp/instances/default/data/storage`
- secrets key: `~/.aiteamcorp/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
AITEAMCORP_HOME=/custom/home AITEAMCORP_INSTANCE_ID=dev pnpm aiteamcorp run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm aiteamcorp configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
