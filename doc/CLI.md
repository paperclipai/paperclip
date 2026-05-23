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

API base resolution order:

1. `--api-base <url>`
2. `PAPERCLIP_API_URL`
3. selected context profile `apiBase`
4. local Paperclip config server port
5. `http://localhost:3100`

Connection failures include the attempted URL and a `GET /api/health` check hint.

## Connect Wizard

```sh
pnpm paperclipai connect
```

`connect` confirms the resolved API base, verifies `GET /api/health`, authenticates board access when needed, and saves a persona-aware profile:

- `persona=board` for board operator profiles
- `persona=agent` with `agentId` and `agentName` for agent profiles

Profiles store token env-var names, not plaintext tokens. The wizard prints shell exports for the newly created token.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.paperclip`:

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai issue list --data-dir ./tmp/paperclip-dev
```

## Context Profiles

Store local defaults in `~/.paperclip/context.json`:

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
pnpm paperclipai context set --persona agent --agent-id <agent-id> --api-key-env-var-name PAPERCLIP_API_KEY
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

## Project Commands

```sh
pnpm paperclipai project list --company-id <company-id>
pnpm paperclipai project get <project-id-or-shortname> [--company-id <company-id>]
pnpm paperclipai project create --company-id <company-id> --name "Launch Site" [--goal-ids <id1,id2>] [--lead-agent-id <id>]
pnpm paperclipai project update <project-id-or-shortname> [--status in_progress] [--company-id <company-id>]
pnpm paperclipai project delete <project-id-or-shortname> --yes [--company-id <company-id>]
```

Advanced project fields accept JSON:

```sh
pnpm paperclipai project create --company-id <company-id> --name "Ops" --env-json '{"OPENAI_API_KEY":{"kind":"secret","secretName":"openai-api-key"}}'
pnpm paperclipai project update <project-id> --execution-workspace-policy-json '{"enabled":true,"defaultMode":"shared_workspace"}'
```

## Goal Commands

```sh
pnpm paperclipai goal list --company-id <company-id>
pnpm paperclipai goal get <goal-id>
pnpm paperclipai goal create --company-id <company-id> --title "Grow revenue" [--level company] [--status active]
pnpm paperclipai goal update <goal-id> [--title "..."] [--status achieved]
pnpm paperclipai goal delete <goal-id> --yes
```

## Agent Commands

```sh
pnpm paperclipai agent list --company-id <company-id>
pnpm paperclipai agent get <agent-id>
pnpm paperclipai agent me
pnpm paperclipai agent inbox
pnpm paperclipai agent inbox-mine --user-id <board-user-id>
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

## Token Commands

Agent API keys are scoped to one company and one agent. Plaintext tokens are printed once at creation.

```sh
pnpm paperclipai token agent create --company-id <company-id> --agent <agent-id-or-name> --name external-worker
pnpm paperclipai token agent list --company-id <company-id> --agent <agent-id-or-name>
pnpm paperclipai token agent revoke --company-id <company-id> --agent <agent-id-or-name> <key-id>
```

Named board API keys use the board authorization model, support revocation and expiration metadata, and are audited server-side.

```sh
pnpm paperclipai token board create --company-id <company-id> --name external-admin
pnpm paperclipai token board create --name short-lived --ttl-days 7
pnpm paperclipai token board list
pnpm paperclipai token board revoke <key-id>
```

## Prompt Handoff

Prompt handoff creates Paperclip work. It does not create a chat session.

```sh
pnpm paperclipai agent-prompt <agent-name-or-id> <agent-api-key> "Prompt here"
pnpm paperclipai agent prompt --agent <agent-name-or-id> --api-key-env PAPERCLIP_API_KEY "Prompt here"
pnpm paperclipai agent prompt --profile my-agent "Prompt here"
pnpm paperclipai board prompt --company-id <company-id> --agent <agent-name-or-id> "Prompt here"
```

By default the command creates a `todo` issue assigned to the target agent and wakes the agent. Use `--issue <issue-id>` to add a comment to existing work, and `--no-wake` to skip the wakeup.

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

Local Paperclip data lives under the selected instance root. `PAPERCLIP_HOME` chooses the home directory and `PAPERCLIP_INSTANCE_ID` chooses the instance.

```text
~/.paperclip/                                     # PAPERCLIP_HOME
└── instances/
    └── default/                                  # instance root (PAPERCLIP_INSTANCE_ID)
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

- config: `~/.paperclip/instances/default/config.json`
- embedded db: `~/.paperclip/instances/default/db`
- logs: `~/.paperclip/instances/default/logs`
- storage: `~/.paperclip/instances/default/data/storage`
- secrets key: `~/.paperclip/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm paperclipai configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
