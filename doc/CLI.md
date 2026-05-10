# CLI Reference

Paperclip CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`, `env-lab`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm paperclipai --help
```

First-time local bootstrap + run:

```sh
pnpm paperclipai run
```

Choose local instance:

```sh
pnpm paperclipai run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `paperclipai onboard` and `paperclipai configure --section server` set deployment mode in config
- server onboarding/configure ask for reachability intent and write `server.bind`
- `paperclipai run --bind <loopback|lan|tailnet>` passes a quickstart bind preset into first-run onboarding when config is missing
- runtime can override mode with `PAPERCLIP_DEPLOYMENT_MODE`
- `paperclipai run` and `paperclipai doctor` still do not expose a direct low-level `--mode` flag

Canonical behavior is documented in `doc/DEPLOYMENT-MODES.md`.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

Bring up the default local SSH fixture for environment testing:

```sh
pnpm paperclipai env-lab up
pnpm paperclipai env-lab doctor
pnpm paperclipai env-lab status --json
pnpm paperclipai env-lab down
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.paperclip`:

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai issue list --data-dir ./tmp/paperclip-dev
```

## Context Profiles

Store local defaults in `~/.paperclip/context.json`:

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
pnpm paperclipai context show
pnpm paperclipai context list
pnpm paperclipai context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

## Company Commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>
pnpm paperclipai company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm paperclipai company delete PAP --yes --confirm PAP
pnpm paperclipai company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `PAPERCLIP_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `PAPERCLIP_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm paperclipai issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm paperclipai issue get <issue-id-or-identifier>
pnpm paperclipai issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm paperclipai issue release <issue-id>
```

## Agent Commands

```sh
pnpm paperclipai agent list --company-id <company-id>
pnpm paperclipai agent get <agent-id>
pnpm paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Paperclip agent:

- creates a new long-lived agent API key
- installs missing Paperclip skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `PAPERCLIP_API_URL`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`, and `PAPERCLIP_API_KEY`

Example for shortname-based local setup:

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

## Secrets Commands

```sh
pnpm paperclipai secrets list --company-id <company-id>
pnpm paperclipai secrets declarations --company-id <company-id> [--include agents,projects] [--kind secret]
pnpm paperclipai secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
pnpm paperclipai secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
pnpm paperclipai secrets doctor --company-id <company-id>
pnpm paperclipai secrets migrate-inline-env --company-id <company-id> [--apply]
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
pnpm paperclipai approval list --company-id <company-id> [--status pending]
pnpm paperclipai approval get <approval-id>
pnpm paperclipai approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]
pnpm paperclipai approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm paperclipai activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm paperclipai dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Local Paperclip data is split between an instance root and one or more spaces inside it. The default install creates a single space called `default` under `spaces/default`.

```text
~/.paperclip/                                     # PAPERCLIP_HOME
└── instances/
    └── default/                                  # instance root (PAPERCLIP_INSTANCE_ID)
        ├── config.json                           # space registry (activeSpaceId, known spaces)
        └── spaces/
            └── default/                          # active space root (PAPERCLIP_SPACE_ID)
                ├── config.json                   # runtime config for this space
                ├── .env                          # space-scoped env file
                ├── db/                           # embedded PostgreSQL data
                ├── data/
                │   ├── storage/                  # local_disk uploads
                │   └── backups/                  # automatic DB backups
                ├── logs/
                ├── secrets/
                │   └── master.key                # local_encrypted master key
                ├── workspaces/                   # default agent workspaces
                ├── projects/                     # project execution workspaces
                ├── companies/                    # per-company adapter homes (e.g. codex-home)
                └── codex-home/                   # per-instance codex home (when not company-scoped)
```

Default paths for the canonical install:

- instance registry: `~/.paperclip/instances/default/config.json`
- space config: `~/.paperclip/instances/default/spaces/default/config.json`
- embedded db: `~/.paperclip/instances/default/spaces/default/db`
- logs: `~/.paperclip/instances/default/spaces/default/logs`
- storage: `~/.paperclip/instances/default/spaces/default/data/storage`
- secrets key: `~/.paperclip/instances/default/spaces/default/secrets/master.key`

The instance root holds only cross-space metadata. All runtime state — database, storage, secrets, logs, agent workspaces — lives inside the active space.

Override base home, instance, or active space with env vars:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
PAPERCLIP_SPACE_ID=staging pnpm paperclipai run        # use an alternate space inside the same instance
```

`PAPERCLIP_SPACE_ID` overrides whatever `activeSpaceId` is recorded in the instance registry. When unset, Paperclip resolves the active space from `instances/<id>/config.json` and falls back to `default`.

## Migrating a Legacy Default-Space Install

Earlier Paperclip versions stored default-space data directly at the instance root (for example `~/.paperclip/instances/default/db`). Those installs continue to start through a compatibility resolver, but new code paths assume `spaces/default`. Migrate explicitly with:

```sh
# Stop Paperclip first; the migration refuses to run while a local server is up.
pnpm paperclipai spaces migrate-default

# Preview the move without touching files.
pnpm paperclipai spaces migrate-default --dry-run

# Operate on a non-default instance.
pnpm paperclipai spaces migrate-default --instance dev
```

The command:

- detects a legacy root-shaped install by inspecting `instances/<id>/config.json`
- preflight-checks `http://<server.host>:<server.port>/api/health` and refuses to run when the server responds
- refuses to merge if the destination already contains conflicting paths under `spaces/default/`
- moves only known space-owned paths: `config.json`, `.env`, `db`, `data`, `logs`, `secrets`, `workspaces`, `projects`, `companies`, and the legacy top-level `codex-home`
- rewrites absolute paths inside the migrated `config.json` from the instance root to the new space root (`embeddedPostgresDataDir`, backup `dir`, `logging.logDir`, `storage.localDisk.baseDir`, `secrets.localEncrypted.keyFilePath`)
- writes the registry/marker back at `instances/<id>/config.json` recording `activeSpaceId`, the migration timestamp, and the moved paths

Available flags:

| Option | Description |
|---|---|
| `-i, --instance <id>` | Local instance id (default: `default`) |
| `--dry-run` | Show the migration plan without moving files |
| `--skip-server-check` | Skip the `/api/health` preflight (only for offline installs) |

Restart Paperclip after a successful migration. Subsequent commands resolve the active space root from the new registry automatically.

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm paperclipai configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
