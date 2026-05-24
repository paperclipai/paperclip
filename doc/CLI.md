# CLI Reference

ValAdrien OS CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`, `env-lab`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm valadrien-os --help
```

First-time local bootstrap + run:

```sh
pnpm valadrien-os run
```

Choose local instance:

```sh
pnpm valadrien-os run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `valadrien-os onboard` and `valadrien-os configure --section server` set deployment mode in config
- server onboarding/configure ask for reachability intent and write `server.bind`
- `valadrien-os run --bind <loopback|lan|tailnet>` passes a quickstart bind preset into first-run onboarding when config is missing
- runtime can override mode with `VALADRIEN_OS_DEPLOYMENT_MODE`
- `valadrien-os run` and `valadrien-os doctor` still do not expose a direct low-level `--mode` flag

Canonical behavior is documented in `doc/DEPLOYMENT-MODES.md`.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm valadrien-os allowed-hostname dotta-macbook-pro
```

Bring up the default local SSH fixture for environment testing:

```sh
pnpm valadrien-os env-lab up
pnpm valadrien-os env-lab doctor
pnpm valadrien-os env-lab status --json
pnpm valadrien-os env-lab down
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.valadrien-os`:

```sh
pnpm valadrien-os run --data-dir ./tmp/valadrien-os-dev
pnpm valadrien-os issue list --data-dir ./tmp/valadrien-os-dev
```

## Context Profiles

Store local defaults in `~/.valadrien-os/context.json`:

```sh
pnpm valadrien-os context set --api-base http://localhost:3100 --company-id <company-id>
pnpm valadrien-os context show
pnpm valadrien-os context list
pnpm valadrien-os context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm valadrien-os context set --api-key-env-var-name VALADRIEN_OS_API_KEY
export VALADRIEN_OS_API_KEY=...
```

## Company Commands

```sh
pnpm valadrien-os company list
pnpm valadrien-os company get <company-id>
pnpm valadrien-os company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm valadrien-os company delete PAP --yes --confirm PAP
pnpm valadrien-os company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `VALADRIEN_OS_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `VALADRIEN_OS_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm valadrien-os issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm valadrien-os issue get <issue-id-or-identifier>
pnpm valadrien-os issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm valadrien-os issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm valadrien-os issue comment <issue-id> --body "..." [--reopen]
pnpm valadrien-os issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm valadrien-os issue release <issue-id>
```

## Agent Commands

```sh
pnpm valadrien-os agent list --company-id <company-id>
pnpm valadrien-os agent get <agent-id>
pnpm valadrien-os agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a ValAdrien OS agent:

- creates a new long-lived agent API key
- installs missing ValAdrien OS skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `VALADRIEN_OS_API_URL`, `VALADRIEN_OS_COMPANY_ID`, `VALADRIEN_OS_AGENT_ID`, and `VALADRIEN_OS_API_KEY`

Example for shortname-based local setup:

```sh
pnpm valadrien-os agent local-cli codexcoder --company-id <company-id>
pnpm valadrien-os agent local-cli claudecoder --company-id <company-id>
```

## Secrets Commands

```sh
pnpm valadrien-os secrets list --company-id <company-id>
pnpm valadrien-os secrets declarations --company-id <company-id> [--include agents,projects] [--kind secret]
pnpm valadrien-os secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
pnpm valadrien-os secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
pnpm valadrien-os secrets doctor --company-id <company-id>
pnpm valadrien-os secrets migrate-inline-env --company-id <company-id> [--apply]
```

Secret listing and declarations never print secret values. `create` accepts
`--value-env` so shell history does not capture the value. `link` records
provider-owned references without copying the secret value into ValAdrien OS.
For AWS-backed secrets, `secrets doctor` reports missing non-secret provider
env and the expected AWS SDK runtime credential source; do not store AWS
bootstrap credentials in ValAdrien OS secrets.

Per-company provider vaults (multiple vault instances per provider, default
vault selection, coming-soon GCP/Vault) are configured from the board UI under
`Company Settings → Secrets → Provider vaults` or through
`/api/companies/{companyId}/secret-provider-configs`. There is no CLI surface
for vault management today. See the
[secrets deploy guide](../docs/deploy/secrets.md#provider-vaults) and
[API reference](../docs/api/secrets.md#provider-vaults) for the contract.

## Approval Commands

```sh
pnpm valadrien-os approval list --company-id <company-id> [--status pending]
pnpm valadrien-os approval get <approval-id>
pnpm valadrien-os approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm valadrien-os approval approve <approval-id> [--decision-note "..."]
pnpm valadrien-os approval reject <approval-id> [--decision-note "..."]
pnpm valadrien-os approval request-revision <approval-id> [--decision-note "..."]
pnpm valadrien-os approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm valadrien-os approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm valadrien-os activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm valadrien-os dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm valadrien-os heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Local ValAdrien OS data lives under the selected instance root. `VALADRIEN_OS_HOME` chooses the home directory and `VALADRIEN_OS_INSTANCE_ID` chooses the instance.

```text
~/.valadrien-os/                                     # VALADRIEN_OS_HOME
└── instances/
    └── default/                                  # instance root (VALADRIEN_OS_INSTANCE_ID)
        ├── config.json                           # runtime config
        ├── .env                                  # instance env file
        ├── db/                                   # embedded PostgreSQL data
        ├── data/
        │   ├── storage/                          # local_disk uploads
        │   └── backups/                          # automatic DB backups
        ├── logs/
        ├── secrets/
        │   └── master.key                        # local_encrypted master key
        ├── workspaces/                           # default agent workspaces
        ├── projects/                             # project execution workspaces
        ├── companies/                            # per-company adapter homes (e.g. codex-home)
        └── codex-home/                           # per-instance codex home (when not company-scoped)
```

Default paths for the canonical install:

- config: `~/.valadrien-os/instances/default/config.json`
- embedded db: `~/.valadrien-os/instances/default/db`
- logs: `~/.valadrien-os/instances/default/logs`
- storage: `~/.valadrien-os/instances/default/data/storage`
- secrets key: `~/.valadrien-os/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
VALADRIEN_OS_HOME=/custom/home VALADRIEN_OS_INSTANCE_ID=dev pnpm valadrien-os run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm valadrien-os configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
