---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Ironworks uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `HOST` | `127.0.0.1` | Server host binding |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `IRONWORKS_HOME` | `~/.ironworks` | Base directory for all Ironworks data |
| `IRONWORKS_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `IRONWORKS_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `IRONWORKS_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `IRONWORKS_SECRETS_MASTER_KEY_FILE` | `~/.ironworks/.../secrets/master.key` | Path to key file |
| `IRONWORKS_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `IRONWORKS_AGENT_ID` | Agent's unique ID |
| `IRONWORKS_COMPANY_ID` | Company ID |
| `IRONWORKS_API_URL` | Ironworks API base URL |
| `IRONWORKS_API_KEY` | Short-lived JWT for API auth |
| `IRONWORKS_RUN_ID` | Current heartbeat run ID |
| `IRONWORKS_TASK_ID` | Issue that triggered this wake |
| `IRONWORKS_WAKE_REASON` | Wake trigger reason |
| `IRONWORKS_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `IRONWORKS_APPROVAL_ID` | Resolved approval ID |
| `IRONWORKS_APPROVAL_STATUS` | Approval decision |
| `IRONWORKS_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |
