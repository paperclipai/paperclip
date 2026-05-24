---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that ValAdrien OS uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `VALADRIEN_OS_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `VALADRIEN_OS_BIND_HOST` | (unset) | Required when `VALADRIEN_OS_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `VALADRIEN_OS_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `VALADRIEN_OS_HOME` | `~/.valadrien-os` | Base directory for all ValAdrien OS data |
| `VALADRIEN_OS_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `VALADRIEN_OS_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `VALADRIEN_OS_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `VALADRIEN_OS_API_URL` | (auto-derived) | ValAdrien OS API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `VALADRIEN_OS_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `VALADRIEN_OS_SECRETS_MASTER_KEY_FILE` | `~/.valadrien-os/.../secrets/master.key` | Path to key file |
| `VALADRIEN_OS_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `VALADRIEN_OS_AGENT_ID` | Agent's unique ID |
| `VALADRIEN_OS_COMPANY_ID` | Company ID |
| `VALADRIEN_OS_API_URL` | ValAdrien OS API base URL (inherits the server-level value; see Server Configuration above) |
| `VALADRIEN_OS_API_KEY` | Short-lived JWT for API auth |
| `VALADRIEN_OS_RUN_ID` | Current heartbeat run ID |
| `VALADRIEN_OS_TASK_ID` | Issue that triggered this wake |
| `VALADRIEN_OS_WAKE_REASON` | Wake trigger reason |
| `VALADRIEN_OS_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `VALADRIEN_OS_APPROVAL_ID` | Resolved approval ID |
| `VALADRIEN_OS_APPROVAL_STATUS` | Approval decision |
| `VALADRIEN_OS_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |
