---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `odysseus run`

One-command bootstrap and start:

```sh
pnpm odysseus run
```

Does:

1. Auto-onboards if config is missing
2. Runs `odysseus doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm odysseus run --instance dev
```

## `odysseus onboard`

Interactive first-time setup:

```sh
pnpm odysseus onboard
```

If Paperclip is already configured, rerunning `onboard` keeps the existing config in place. Use `odysseus configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm odysseus onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm odysseus onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts Paperclip with that setup.

## `odysseus doctor`

Health checks with optional auto-repair:

```sh
pnpm odysseus doctor
pnpm odysseus doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration, including AWS Secrets Manager non-secret env
  config when selected
- Storage configuration
- Missing key files

## `odysseus configure`

Update configuration sections:

```sh
pnpm odysseus configure --section server
pnpm odysseus configure --section secrets
pnpm odysseus configure --section storage
```

`--section secrets` updates the deployment-level provider used as the fallback
for secrets that do not target a specific company vault. Per-company provider
vaults (named instances, default vault selection, multiple vaults per provider,
coming-soon GCP/Vault) live in the board UI under
`Company Settings → Secrets → Provider vaults` and the
`/api/companies/{companyId}/secret-provider-configs` API.

## `odysseus env`

Show resolved environment configuration:

```sh
pnpm odysseus env
```

This now includes bind-oriented deployment settings such as `ODYSSEUS_BIND` and `ODYSSEUS_BIND_HOST` when configured.

## `odysseus allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm odysseus allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.odysseus/instances/default/config.json` |
| Database | `~/.odysseus/instances/default/db` |
| Logs | `~/.odysseus/instances/default/logs` |
| Storage | `~/.odysseus/instances/default/data/storage` |
| Secrets key | `~/.odysseus/instances/default/secrets/master.key` |

Override with:

```sh
ODYSSEUS_HOME=/custom/home ODYSSEUS_INSTANCE_ID=dev pnpm odysseus run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm odysseus run --data-dir ./tmp/odysseus-dev
pnpm odysseus doctor --data-dir ./tmp/odysseus-dev
```
