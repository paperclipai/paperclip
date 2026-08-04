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
| `PAPERCLIP_HUMAN_AUTH_PROVIDER` | `better_auth` | When `deploymentMode=authenticated`: `better_auth` (email/password via Better Auth) or `gateway` (trust oauth2-proxy / Keycloak headers). Ignored in `local_trusted`. |
| `PAPERCLIP_GATEWAY_AUTH_SECRET` | (unset) | Required when `PAPERCLIP_HUMAN_AUTH_PROVIDER=gateway`. Shared secret; requests must include the matching `X-Paperclip-Gateway-Token` header (or override via `PAPERCLIP_GATEWAY_HEADER_TOKEN`). |
| `PAPERCLIP_GATEWAY_ADMIN_ROLES` | `paperclip-admin` | Comma-separated Keycloak/oauth2-proxy group names mapped to instance admin + default company owner |
| `PAPERCLIP_GATEWAY_MEMBER_ROLES` | `paperclip-dev` | Comma-separated group names mapped to default company membership (non–instance-admin) |
| `PAPERCLIP_GATEWAY_DEFAULT_COMPANY_NAME` | `Workforce` | Auto-created platform company name for gateway users |
| `PAPERCLIP_GATEWAY_DEFAULT_COMPANY_ID` | (derived) | Optional fixed UUID for the default gateway company |
| `PAPERCLIP_GATEWAY_HEADER_EMAIL` | `X-Forwarded-Email` | Header carrying the authenticated user email (oauth2-proxy) |
| `PAPERCLIP_GATEWAY_HEADER_USER` | `X-Forwarded-User` | Header carrying the display username |
| `PAPERCLIP_GATEWAY_HEADER_GROUPS` | `X-Forwarded-Groups` | Header carrying OIDC groups/roles (configure oauth2-proxy with `--oidc-groups-claim=roles`) |
| `PAPERCLIP_GATEWAY_HEADER_TOKEN` | `X-Paperclip-Gateway-Token` | Header that must match `PAPERCLIP_GATEWAY_AUTH_SECRET` |
| `PAPERCLIP_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |

### Gateway auth (Keycloak + oauth2-proxy)

When using `PAPERCLIP_HUMAN_AUTH_PROVIDER=gateway`:

1. Do **not** expose the Paperclip container port publicly; only the oauth2-proxy front door should be reachable.
2. Configure oauth2-proxy with `--oidc-groups-claim=roles` so realm roles reach `X-Forwarded-Groups`.
3. Inject `X-Paperclip-Gateway-Token` with the same value as `PAPERCLIP_GATEWAY_AUTH_SECRET` (sidecar, edge proxy, or custom middleware). Paperclip rejects gateway identity headers when the token is missing or wrong.
4. Paperclip health is at `/api/health` (not `/health`). If you use `--skip-auth-regex` on oauth2-proxy, match `^/api/health$` only when you intentionally want unauthenticated health checks.
5. Browser sign-out uses oauth2-proxy at `/oauth2/sign_out` (handled automatically by the UI when `humanAuthProvider=gateway`).

Example `paperclip-app` environment:

```yaml
PAPERCLIP_DEPLOYMENT_MODE: authenticated
PAPERCLIP_HUMAN_AUTH_PROVIDER: gateway
PAPERCLIP_GATEWAY_AUTH_SECRET: ${PAPERCLIP_GATEWAY_AUTH_SECRET}
PAPERCLIP_GATEWAY_ADMIN_ROLES: paperclip-admin
PAPERCLIP_GATEWAY_MEMBER_ROLES: paperclip-dev
PAPERCLIP_GATEWAY_DEFAULT_COMPANY_NAME: Workforce
BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}
HOST: "0.0.0.0"
```

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
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Code adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex adapter) |
