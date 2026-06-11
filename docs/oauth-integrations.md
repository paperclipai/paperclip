# OAuth Integrations — Operator Guide

## Overview

Paperclip ships with a built-in OAuth backbone supporting GitHub, Notion,
Slack, Linear, Atlassian, Google Workspace, and Microsoft Graph. Each
provider is opt-in: a provider is registered iff its `client_id` and
`client_secret` env vars are both set at startup. Providers with missing
credentials are skipped with a `WARN` log and never appear at
**Settings → Connections**.

## Setup per provider

For each provider you want to enable:

1. Register an OAuth app in the provider's developer console.
2. Configure the redirect URI as: `${PAPERCLIP_PUBLIC_URL}/api/oauth/callback/<provider-id>`
3. Set both env vars before starting the server:

   | Provider | client_id env | client_secret env |
   |---|---|---|
   | github | `GITHUB_OAUTH_CLIENT_ID` | `GITHUB_OAUTH_CLIENT_SECRET` |
   | notion | `NOTION_OAUTH_CLIENT_ID` | `NOTION_OAUTH_CLIENT_SECRET` |
   | slack | `SLACK_OAUTH_CLIENT_ID` | `SLACK_OAUTH_CLIENT_SECRET` |
   | linear | `LINEAR_OAUTH_CLIENT_ID` | `LINEAR_OAUTH_CLIENT_SECRET` |
   | atlassian | `ATLASSIAN_OAUTH_CLIENT_ID` | `ATLASSIAN_OAUTH_CLIENT_SECRET` |
   | google-workspace | `GOOGLE_OAUTH_CLIENT_ID` | `GOOGLE_OAUTH_CLIENT_SECRET` |
   | microsoft-graph | `MICROSOFT_OAUTH_CLIENT_ID` | `MICROSOFT_OAUTH_CLIENT_SECRET` |

4. Restart the server.
5. Tiles for that provider appear at **Settings → Connections**. Admins can connect.

## Adding a custom provider

The bundled YAML configs live at `server/oauth-providers/`. To add a custom
provider, drop a YAML file in that directory (or set
`PAPERCLIP_OAUTH_PROVIDERS_DIR` to a directory of your own and put the YAML
there — entries from that directory are loaded after and merged with the
bundled configs). Set the corresponding `client_id` and `client_secret` env
vars and restart the server. See `server/oauth-providers/github.yaml` for the
canonical example.

For providers with non-standard response shapes (Slack's `team` block,
Microsoft's `id_token` claim parsing, etc.), add a TypeScript shape module
under `server/src/oauth/shapes/` and wire it from the YAML's `shape:` field.
See `server/src/oauth/shapes/slack.ts` for the canonical example.

## Plugin-contributed providers

Plugins can ship OAuth providers via the `oauthProviders` block in the
plugin manifest. See `packages/plugins/sdk/src/define-oauth-provider.ts`
for the helper, and the plugin developer docs for the manifest schema.
A YAML entry with the same provider id always wins; plugin contributions
for a duplicate id are skipped with a `WARN` log.

## Operations

- **Refresh worker:** runs every 60s, leader-elected via Postgres
  advisory lock. No additional config needed.
- **Token storage:** OAuth tokens live in `company_secrets` /
  `company_secret_versions`, encrypted via the configured `SecretProvider`.
- **Logs:** all OAuth code paths emit structured pino logs with
  `component=oauth`. Token material is never logged — `access_token`,
  `refresh_token`, `id_token`, `code`, `code_verifier`, and `client_secret`
  are redacted at the logger level.
- **Metrics:** `oauth_refresh_total`, `oauth_refresh_duration_seconds`,
  `oauth_connections_by_status` (Prometheus, existing pattern).

## Troubleshooting

- **"Provider isn't configured":** check both env vars are set; restart
  to pick up changes.
- **"Refresh stalled":** check `last_error` on the connection row; usually
  provider-side (network blip). Manual `Refresh now` from the UI clears
  the backoff.
- **"Account mismatch":** user authorized a different account than the
  existing connection. Disconnect first, then reconnect.

## Known limitations

- **Linear `accountInfo`** uses `https://api.linear.app/oauth/userinfo`
  (Linear's OIDC userinfo endpoint). If Linear changes that endpoint, the
  YAML at `server/oauth-providers/linear.yaml` will need to update or grow
  a custom shape module.
- **Per-tenant rate limit** on `POST /oauth/connect/:providerId` is 50
  requests per 5 minutes (state-row flood guard). This is in addition to
  the existing per-user limit.
- **Refresh worker leader-election** uses
  `pg_try_advisory_xact_lock` inside a single transaction so the lock is
  released automatically at COMMIT/ROLLBACK regardless of which pool
  connection the underlying postgres-js client picked up. Multi-process
  deployments coordinate naturally through the shared lock.
- **`mark-revoked` middleware** is wired in `app.ts` and reads a Bearer
  run-JWT via `verifyLocalAgentJwt`. The endpoint returns 401 without a
  valid JWT carrying an `oauth.connectionIds` claim, 403 when the claim
  doesn't include the requested connection, 204 on success.
- **GitHub upstream revocation is best-effort.** GitHub's
  `/applications/{client_id}/grant` endpoint requires `DELETE` and a
  JSON body (`{"access_token": "..."}`), not RFC-7009's
  `POST` + form-encoded shape that `revokeUpstreamToken` uses. The
  upstream revoke call therefore always fails for GitHub — the local
  disconnect cleanup path swallows the error and proceeds, so the
  user's local state ends up correct, but the GitHub grant remains
  valid until natural expiry or until the user revokes it via the
  GitHub UI. A follow-up PR will add a per-provider `revokeStyle`
  field to handle non-RFC-7009 providers.
