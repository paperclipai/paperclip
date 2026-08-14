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

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Environment Inheritance

An agent process inherits the environment of the Paperclip server process, then
adapter and agent config env applies on top. The server environment can hold
values that agents must not read. In `docker-compose.quickstart.yml`, for
example, `BETTER_AUTH_SECRET` and the database password are in the same env
block as the LLM provider keys.

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_AGENT_ENV_INHERIT` | `all` | `all` gives agent processes the full server environment. `allowlist` gives them only the toolchain keys they need, plus the keys in `PAPERCLIP_AGENT_ENV_ALLOW`. |
| `PAPERCLIP_AGENT_ENV_ALLOW` | (unset) | Comma-separated keys to add in `allowlist` mode. A trailing `*` matches a prefix, for example `ANTHROPIC_API_KEY,AWS_*`. |

In `allowlist` mode Paperclip inherits `PATH`, `HOME`, `PWD`, `SHELL`, `USER`,
`LOGNAME`, `TERM`, `TZ`, the temporary directory keys, `LANG` and `LC_*`,
`XDG_*`, the proxy and TLS trust-store keys, the Node.js toolchain keys, and the
Windows platform keys. It removes all other inherited keys and writes their
names, not their values, to the server log one time.

The proxy keys are inherited as routing information. If a proxy address embeds
credentials, as in `HTTPS_PROXY=http://user:password@proxy.internal:3128`, that
value is removed unless you name the key in `PAPERCLIP_AGENT_ENV_ALLOW`.

Adapter and agent config env is not affected. A variable that an agent declares
in its own config always reaches the agent process. If your deployment gives
provider keys to agents through the server environment, list those keys in
`PAPERCLIP_AGENT_ENV_ALLOW` before you set `allowlist`.

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

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Code adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex adapter) |
