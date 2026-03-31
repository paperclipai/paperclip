---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

Examples on this page use the installed `penclip` command. If you are running without installing first, prefix the command with `npx`.

## `penclip run`

One-command bootstrap and start:

```sh
penclip run
```

Does:

1. Auto-onboards if config is missing
2. Runs `penclip doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
penclip run --instance dev
```

## `penclip onboard`

Interactive first-time setup:

```sh
penclip onboard
```

If Paperclip is already configured, rerunning `onboard` keeps the existing config in place. Use `penclip configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
penclip onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
penclip onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts Paperclip with that setup.

## `penclip doctor`

Health checks with optional auto-repair:

```sh
penclip doctor
penclip doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration
- Storage configuration
- Missing key files

## `penclip configure`

Update configuration sections:

```sh
penclip configure --section server
penclip configure --section secrets
penclip configure --section storage
```

## `penclip env`

Show resolved environment configuration:

```sh
penclip env
```

## `penclip allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
penclip allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.paperclip/instances/default/config.json` |
| Database | `~/.paperclip/instances/default/db` |
| Logs | `~/.paperclip/instances/default/logs` |
| Storage | `~/.paperclip/instances/default/data/storage` |
| Secrets key | `~/.paperclip/instances/default/secrets/master.key` |

Override with:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev penclip run
```

Or pass `--data-dir` directly on any command:

```sh
penclip run --data-dir ./tmp/paperclip-dev
penclip doctor --data-dir ./tmp/paperclip-dev
```
