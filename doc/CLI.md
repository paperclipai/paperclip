# CLI Reference

Paperclip CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`, `env-lab`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm odysseus --help
```

First-time local bootstrap + run:

```sh
pnpm odysseus run
```

Choose local instance:

```sh
pnpm odysseus run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `odysseus onboard` and `odysseus configure --section server` set deployment mode in config
- server onboarding/configure ask for reachability intent and write `server.bind`
- `odysseus run --bind <loopback|lan|tailnet>` passes a quickstart bind preset into first-run onboarding when config is missing
- runtime can override mode with `ODYSSEUS_DEPLOYMENT_MODE`
- `odysseus run` and `odysseus doctor` still do not expose a direct low-level `--mode` flag

Canonical behavior is documented in `doc/DEPLOYMENT-MODES.md`.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm odysseus allowed-hostname dotta-macbook-pro
```

Bring up the default local SSH fixture for environment testing:

```sh
pnpm odysseus env-lab up
pnpm odysseus env-lab doctor
pnpm odysseus env-lab status --json
pnpm odysseus env-lab down
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.odysseus`:

```sh
pnpm odysseus run --data-dir ./tmp/odysseus-dev
pnpm odysseus issue list --data-dir ./tmp/odysseus-dev
```

## Context Profiles

Store local defaults in `~/.odysseus/context.json`:

```sh
pnpm odysseus context set --api-base http://localhost:3100 --company-id <company-id>
pnpm odysseus context show
pnpm odysseus context list
pnpm odysseus context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm odysseus context set --api-key-env-var-name ODYSSEUS_API_KEY
export ODYSSEUS_API_KEY=...
```

## Company Commands

```sh
pnpm odysseus company list
pnpm odysseus company get <company-id>
pnpm odysseus company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm odysseus company delete PAP --yes --confirm PAP
pnpm odysseus company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `ODYSSEUS_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `ODYSSEUS_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm odysseus issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm odysseus issue get <issue-id-or-identifier>
pnpm odysseus issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm odysseus issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm odysseus issue comment <issue-id> --body "..." [--reopen]
pnpm odysseus issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm odysseus issue release <issue-id>
```

## Agent Commands

```sh
pnpm odysseus agent list --company-id <company-id>
pnpm odysseus agent get <agent-id>
pnpm odysseus agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Paperclip agent:

- creates a new long-lived agent API key
- installs missing Paperclip skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `ODYSSEUS_API_URL`, `ODYSSEUS_COMPANY_ID`, `ODYSSEUS_AGENT_ID`, and `ODYSSEUS_API_KEY`

Example for shortname-based local setup:

```sh
pnpm odysseus agent local-cli codexcoder --company-id <company-id>
pnpm odysseus agent local-cli claudecoder --company-id <company-id>
```

## Secrets Commands

```sh
pnpm odysseus secrets list --company-id <company-id>
pnpm odysseus secrets declarations --company-id <company-id> [--include agents,projects] [--kind secret]
pnpm odysseus secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
pnpm odysseus secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
pnpm odysseus secrets doctor --company-id <company-id>
pnpm odysseus secrets migrate-inline-env --company-id <company-id> [--apply]
```

Secret listing and declarations never print secret values. `create` accepts
`--value-env` so shell history does not capture the value. `link` records
provider-owned references without copying the secret value into Paperclip.
For AWS-backed secrets, `secrets doctor` reports missing non-secret provider
env and the expected AWS SDK runtime credential source; do not store AWS
bootstrap credentials in Paperclip secrets.

Per-company provider vaults (multiple vault instances per provider, default
vault selection, coming-soon GCP/Vault) are configured from the board UI under
`Company Settings → Secrets → Provider vaults` or through
`/api/companies/{companyId}/secret-provider-configs`. There is no CLI surface
for vault management today. See the
[secrets deploy guide](../docs/deploy/secrets.md#provider-vaults) and
[API reference](../docs/api/secrets.md#provider-vaults) for the contract.

## Approval Commands

```sh
pnpm odysseus approval list --company-id <company-id> [--status pending]
pnpm odysseus approval get <approval-id>
pnpm odysseus approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm odysseus approval approve <approval-id> [--decision-note "..."]
pnpm odysseus approval reject <approval-id> [--decision-note "..."]
pnpm odysseus approval request-revision <approval-id> [--decision-note "..."]
pnpm odysseus approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm odysseus approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm odysseus activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm odysseus dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm odysseus heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Local Paperclip data lives under the selected instance root. `ODYSSEUS_HOME` chooses the home directory and `ODYSSEUS_INSTANCE_ID` chooses the instance.

```text
~/.odysseus/                                     # ODYSSEUS_HOME
└── instances/
    └── default/                                  # instance root (ODYSSEUS_INSTANCE_ID)
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

- config: `~/.odysseus/instances/default/config.json`
- embedded db: `~/.odysseus/instances/default/db`
- logs: `~/.odysseus/instances/default/logs`
- storage: `~/.odysseus/instances/default/data/storage`
- secrets key: `~/.odysseus/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
ODYSSEUS_HOME=/custom/home ODYSSEUS_INSTANCE_ID=dev pnpm odysseus run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm odysseus configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
