---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `ODYSSEUS_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `ODYSSEUS_BIND_HOST` | (unset) | Required when `ODYSSEUS_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `ODYSSEUS_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `ODYSSEUS_HOME` | `~/.odysseus` | Base directory for all Paperclip data |
| `ODYSSEUS_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `ODYSSEUS_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `ODYSSEUS_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `ODYSSEUS_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `ODYSSEUS_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `ODYSSEUS_SECRETS_MASTER_KEY_FILE` | `~/.odysseus/.../secrets/master.key` | Path to key file |
| `ODYSSEUS_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `ODYSSEUS_AGENT_ID` | Agent's unique ID |
| `ODYSSEUS_COMPANY_ID` | Company ID |
| `ODYSSEUS_API_URL` | Paperclip API base URL (inherits the server-level value; see Server Configuration above) |
| `ODYSSEUS_API_KEY` | Short-lived JWT for API auth |
| `ODYSSEUS_RUN_ID` | Current heartbeat run ID |
| `ODYSSEUS_TASK_ID` | Issue that triggered this wake |
| `ODYSSEUS_WAKE_REASON` | Wake trigger reason |
| `ODYSSEUS_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `ODYSSEUS_APPROVAL_ID` | Resolved approval ID |
| `ODYSSEUS_APPROVAL_STATUS` | Approval decision |
| `ODYSSEUS_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |
