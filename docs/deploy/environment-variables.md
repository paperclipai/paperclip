---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `PAPERCLIP_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `PAPERCLIP_BIND_HOST` | (unset) | Required when `PAPERCLIP_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `PAPERCLIP_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `PAPERCLIP_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |
| `PAPERCLIP_LISTEN_HOST` | (runtime-computed) | Runtime: Server listen host, set automatically at startup. Inherits from `HOST` env var or `localhost`. Used by adapters to connect back to the server. |
| `PAPERCLIP_LISTEN_PORT` | (runtime-computed; default `3100`) | Runtime: Server listen port, set automatically at startup. Inherits from `PORT` env var or `3100`. Used by adapters to connect back to the server. |
| `PAPERCLIP_TAILNET_BIND_HOST` | (auto-detected) | For Tailscale integration: explicitly set the Tailnet bind address. When unset, auto-detected via `tailscale ip -4`. Set this if auto-detection fails. |
| `PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL` | (unset) | External backend URL for sending feedback/telemetry exports. Falls back to `PAPERCLIP_TELEMETRY_BACKEND_URL` if unset. |
| `PAPERCLIP_API_BRIDGE_MODE` | (unset; `queue_v1` in adapters) | Internal: Controls API bridge execution mode for adapter processes. Set automatically by the server when invoking adapters. |
| `RUN_LOG_BASE_PATH` | `~/.paperclip/data/run-logs` | Override base directory for agent run logs (stdout/stderr/system events stored as NDJSON). Defaults to `{PAPERCLIP_HOME}/data/run-logs`. |
| `WORKSPACE_OPERATION_LOG_BASE_PATH` | `~/.paperclip/data/workspace-operation-logs` | Override base directory for workspace operation logs. Defaults to `{PAPERCLIP_HOME}/data/workspace-operation-logs`. |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |
| `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` | (unset) | Authentication token for Paperclip Cloud tenant integration. When set, enables cloud-tenant auth mode via `x-paperclip-cloud-tenant-token` request header. |
| `PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN` | (unset) | Authentication token for the feedback/telemetry export backend. Falls back to `PAPERCLIP_TELEMETRY_BACKEND_TOKEN` if unset. |
| `PAPERCLIP_TELEMETRY_BACKEND_URL` | (unset) | **Legacy.** Use `PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL` instead. |
| `PAPERCLIP_TELEMETRY_BACKEND_TOKEN` | (unset) | **Legacy.** Use `PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN` instead. |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | Agent's unique ID |
| `PAPERCLIP_COMPANY_ID` | Company ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL (inherits the server-level value; see Server Configuration above) |
| `PAPERCLIP_API_KEY` | Short-lived JWT for API auth |
| `PAPERCLIP_RUN_ID` | Current heartbeat run ID |
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake |
| `PAPERCLIP_WAKE_REASON` | Wake trigger reason |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `PAPERCLIP_APPROVAL_ID` | Resolved approval ID |
| `PAPERCLIP_APPROVAL_STATUS` | Approval decision |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |
| `RUNTIME_CUSTOM_ENV` | Internal: Custom environment variables injected into workspace adapter processes. Set via adapter configuration. |
| `AGENT_KEY` | Agent bootstrap: Agents can read their API authentication key from this env var when configured in CLI profiles. |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |
