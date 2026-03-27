---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `ironworksai run`

One-command bootstrap and start:

```sh
pnpm ironworksai run
```

Does:

1. Auto-onboards if config is missing
2. Runs `ironworksai doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm ironworksai run --instance dev
```

## `ironworksai onboard`

Interactive first-time setup:

```sh
pnpm ironworksai onboard
```

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm ironworksai onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm ironworksai onboard --yes
```

## `ironworksai doctor`

Health checks with optional auto-repair:

```sh
pnpm ironworksai doctor
pnpm ironworksai doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration
- Storage configuration
- Missing key files

## `ironworksai configure`

Update configuration sections:

```sh
pnpm ironworksai configure --section server
pnpm ironworksai configure --section secrets
pnpm ironworksai configure --section storage
```

## `ironworksai env`

Show resolved environment configuration:

```sh
pnpm ironworksai env
```

## `ironworksai allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm ironworksai allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.ironworks/instances/default/config.json` |
| Database | `~/.ironworks/instances/default/db` |
| Logs | `~/.ironworks/instances/default/logs` |
| Storage | `~/.ironworks/instances/default/data/storage` |
| Secrets key | `~/.ironworks/instances/default/secrets/master.key` |

Override with:

```sh
IRONWORKS_HOME=/custom/home IRONWORKS_INSTANCE_ID=dev pnpm ironworksai run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm ironworksai run --data-dir ./tmp/ironworks-dev
pnpm ironworksai doctor --data-dir ./tmp/ironworks-dev
```
