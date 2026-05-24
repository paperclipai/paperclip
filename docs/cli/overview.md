---
title: CLI Overview
summary: CLI installation and setup
---

The ValAdrien OS CLI handles instance setup, diagnostics, and control-plane operations.

## Usage

```sh
pnpm valadrien-os --help
```

## Global Options

All commands support:

| Flag | Description |
|------|-------------|
| `--data-dir <path>` | Local ValAdrien OS data root (isolates from `~/.valadrien-os`) |
| `--api-base <url>` | API base URL |
| `--api-key <token>` | API authentication token |
| `--context <path>` | Context file path |
| `--profile <name>` | Context profile name |
| `--json` | Output as JSON |

Company-scoped commands also accept `--company-id <id>`.

For clean local instances, pass `--data-dir` on the command you run:

```sh
pnpm valadrien-os run --data-dir ./tmp/valadrien-os-dev
```

## Context Profiles

Store defaults to avoid repeating flags:

```sh
# Set defaults
pnpm valadrien-os context set --api-base http://localhost:3100 --company-id <id>

# View current context
pnpm valadrien-os context show

# List profiles
pnpm valadrien-os context list

# Switch profile
pnpm valadrien-os context use default
```

To avoid storing secrets in context, use an env var:

```sh
pnpm valadrien-os context set --api-key-env-var-name VALADRIEN_OS_API_KEY
export VALADRIEN_OS_API_KEY=...
```

Secret operations are available under `valadrien-os secrets`:

```sh
pnpm valadrien-os secrets declarations --company-id <company-id> --kind secret
pnpm valadrien-os secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
pnpm valadrien-os secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
pnpm valadrien-os secrets doctor --company-id <company-id>
pnpm valadrien-os secrets migrate-inline-env --company-id <company-id> --apply
```

Context is stored at `~/.valadrien-os/context.json`.

## Command Categories

The CLI has two categories:

1. **[Setup commands](/cli/setup-commands)** — instance bootstrap, diagnostics, configuration
2. **[Control-plane commands](/cli/control-plane-commands)** — issues, agents, approvals, activity
