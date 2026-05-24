---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `valadrien-os run`

One-command bootstrap and start:

```sh
pnpm valadrien-os run
```

Does:

1. Auto-onboards if config is missing
2. Runs `valadrien-os doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm valadrien-os run --instance dev
```

## `valadrien-os onboard`

Interactive first-time setup:

```sh
pnpm valadrien-os onboard
```

If ValAdrien OS is already configured, rerunning `onboard` keeps the existing config in place. Use `valadrien-os configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm valadrien-os onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm valadrien-os onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts ValAdrien OS with that setup.

## `valadrien-os doctor`

Health checks with optional auto-repair:

```sh
pnpm valadrien-os doctor
pnpm valadrien-os doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration, including AWS Secrets Manager non-secret env
  config when selected
- Storage configuration
- Missing key files

## `valadrien-os configure`

Update configuration sections:

```sh
pnpm valadrien-os configure --section server
pnpm valadrien-os configure --section secrets
pnpm valadrien-os configure --section storage
```

`--section secrets` updates the deployment-level provider used as the fallback
for secrets that do not target a specific company vault. Per-company provider
vaults (named instances, default vault selection, multiple vaults per provider,
coming-soon GCP/Vault) live in the board UI under
`Company Settings → Secrets → Provider vaults` and the
`/api/companies/{companyId}/secret-provider-configs` API.

## `valadrien-os env`

Show resolved environment configuration:

```sh
pnpm valadrien-os env
```

This now includes bind-oriented deployment settings such as `VALADRIEN_OS_BIND` and `VALADRIEN_OS_BIND_HOST` when configured.

## `valadrien-os allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm valadrien-os allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.valadrien-os/instances/default/config.json` |
| Database | `~/.valadrien-os/instances/default/db` |
| Logs | `~/.valadrien-os/instances/default/logs` |
| Storage | `~/.valadrien-os/instances/default/data/storage` |
| Secrets key | `~/.valadrien-os/instances/default/secrets/master.key` |

Override with:

```sh
VALADRIEN_OS_HOME=/custom/home VALADRIEN_OS_INSTANCE_ID=dev pnpm valadrien-os run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm valadrien-os run --data-dir ./tmp/valadrien-os-dev
pnpm valadrien-os doctor --data-dir ./tmp/valadrien-os-dev
```
