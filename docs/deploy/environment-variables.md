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
| `PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD` | (unset) | Set to `1` to disable building and linking repository-bundled local plugins on server startup/plugin installation |
| `PAPERCLIP_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |
| `PAPERCLIP_DONE_GUARD_PROJECT_ID` | `c4525f28-55d1-4378-864c-aec26d51fc37` | Comma-separated list of Project IDs subject to the Done transition guard (which requires a merged linked PR and No Mistakes gate proof). Any project whose name contains "dark factory" (case-insensitive) is also automatically subject to this guard. Note: The server environment must have GitHub CLI (`gh`) installed and authenticated for repositories whose PRs are linked; otherwise, transitions fail with `422`. |
| `DARK_FACTORY_RUN_DIR` | (unset) | Custom path to the Dark Factory runs directory containing run subdirectories with `run-manifest.json`. Takes precedence over `FACTORY_RUNS_DIR`. |
| `FACTORY_RUNS_DIR` | (unset) | Path to the factory runs directory. If both `DARK_FACTORY_RUN_DIR` and `FACTORY_RUNS_DIR` are unset, defaults to `../../../../paperclip-data/factory-runs` resolved relative to the compiled route module (`server/src/routes/issues.ts`). |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

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
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (Note: host-level inheritance is blocked for `codex_local` agents to ensure company isolation; configure it directly on the agent's adapter environment or seed the managed Codex home instead) |
| `NOVITA_API_KEY` | Novita API key (Note: used as a host-level fallback when an environment config omits `apiKey`; per-environment secrets are preferred) |
