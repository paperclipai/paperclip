# OAuth Backbone Design (Sub-project A of 3)

**Date:** 2026-05-09
**Status:** Design — pending implementation plan
**Authors:** Jannes Stubbemann + Claude
**Scope:** Sub-project A of a three-piece decomposition.
**Out of scope:** Sub-project B (Inbound MCP integration) and Sub-project C (SDK aggregator plugin) — separate spec cycles.

---

## 0. Context & Goals

### 0.1 Problem

Today, Paperclip agents that need to act in third-party services (GitHub, Notion, Slack, Linear, …) rely on operators creating personal access tokens by hand and storing them as opaque `company_secrets`. There is no interactive authorization flow, no token refresh, no UI affordance for users to "Connect to GitHub", and no provider-agnostic data model. As we expand the set of supported integrations, this scales linearly in operator toil and is the wrong primitive for cloud SaaS users who expect a "Connect" button.

### 0.2 Decomposition

The full request — "let users authorize Paperclip to act on their behalf in third-party services" — naturally splits into three independent sub-projects, each with its own spec cycle:

| | Sub-project | Summary |
|---|---|---|
| **A** | **OAuth backbone (this spec)** | OAuth 2.1 + PKCE flow, per-tenant connection storage, refresh worker, plugin-extensible provider registry. The credential layer that everything else consumes. |
| B | Inbound MCP integration | Per-connection MCP server attached to agent runtimes — turns an "active connection" into "tools the agent can call". Requires (A). |
| C | SDK aggregator plugin | Optional Composio/Nango-style fallback plugin that wraps a third-party aggregator's catalog. Requires (A). |

Doing (A) first means (B) and (C) become small, focused additions rather than entangled rewrites.

### 0.3 Goals for v1 of (A)

1. **Cloud + self-hosted parity** — same code path, behavior differs only via env config. Operators of self-hosted instances configure their own OAuth apps; cloud ships defaults.
2. **5–10 launch providers** — GitHub, Notion, Slack, Linear, Atlassian, Google Workspace, Microsoft Graph (and any subset operators choose to enable).
3. **Per-company connections, single connection per provider.** Multi-account-per-company is a known v2 ask.
4. **Plugin SDK extensibility** — third parties can ship their own provider definitions.
5. **File/directory-based config** — adding a provider should not require a DB migration.
6. **Compatibility with the existing secrets pipeline** — tokens are "secrets with a refresh policy". The runtime never gets a new token-fetching API.

### 0.4 Non-goals

- Inbound MCP integration (sub-project B).
- SDK aggregator integration (sub-project C).
- Multi-account-per-company connections.
- Per-user (vs per-company) connections.
- DPoP / mTLS / token introspection / device flow / client_credentials.
- Real-provider integration tests in CI.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser / Agent UI                                                  │
│   • Settings → Connections page                                     │
│   • Agent env editor binding picker (oauth_token type)              │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Paperclip server                                                    │
│                                                                     │
│  ┌─────────────────────┐   ┌──────────────────────────────────┐    │
│  │ Provider Registry   │   │ OAuth Flow Handler               │    │
│  │ (built at startup)  │◀──│   /api/oauth/connect/:p          │    │
│  │  • file YAML        │   │   /api/oauth/callback/:p         │    │
│  │  • plugin contribs  │   │   /api/oauth/connections[/:id]   │    │
│  │  • shape modules    │   │   /api/oauth/providers           │    │
│  └─────────┬───────────┘   └──────┬───────────────────────────┘    │
│            │                      │                                 │
│            ▼                      ▼                                 │
│       ┌──────────────────────────────────────┐                      │
│       │ oauth_connections (per-company)      │                      │
│       │ oauth_authorization_states (PKCE)    │                      │
│       └──────┬───────────────────────────────┘                      │
│              │ secret_id refs                                       │
│              ▼                                                      │
│       ┌──────────────────────────────────────┐                      │
│       │ company_secrets / _versions          │                      │
│       │   ↑ encrypted via SecretProvider     │                      │
│       │     (local_encrypted / aws / gcp /   │                      │
│       │      vault)                          │                      │
│       └──────────────────────────────────────┘                      │
│                                                                     │
│  ┌──────────────────────┐                                           │
│  │ Refresh Worker       │ — every 60s, leader-elected               │
│  │   • proactive scan   │                                           │
│  │   • per-row backoff  │                                           │
│  └──────────────────────┘                                           │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ secret_ref / oauth_token bindings
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Agent dispatch (existing)                                           │
│   resolveAdapterConfigForRuntime → ctx.config.env (plaintext)       │
│   → per-Job env Secret → adapter runtime in pod                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.1 Sub-pieces

1. **Provider registry** — startup loader scanning files + plugin contributions.
2. **OAuth flow handler** — start flow, validate callback, exchange code, persist tokens.
3. **`oauth_connections` table** — per-company structured metadata.
4. **Refresh worker** — proactive expiry-driven token refresh with backoff.
5. **Lazy refresh** — fallback path inside the resolver for tokens that slipped past the worker.
6. **Connect UI** — Settings → Connections page + binding picker integration in agent env editor.
7. **Plugin SDK extension** — `oauthProviders` block in plugin manifest.

### 1.2 Resolution path

When an agent dispatch evaluates an `oauth_token` binding inside `resolveAdapterConfigForRuntime`:

1. Look up the connection by `connectionId`. Fail fast if missing/`revoked`/`error`.
2. If `access_token_expires_at < now() + 60s` and refresh exists → lazy-refresh inline (Section 5.3).
3. Read latest `company_secrets` version for `access_token_secret_id`, decrypt via `SecretProvider`.
4. Return plaintext for `ctx.config.env` — same path as `secret_ref`.

---

## 2. Data Model

Three concerns: provider definition, per-tenant connection state, and in-flight authorization state. Token cipher reuses the existing `company_secrets` infrastructure so we don't reinvent encryption/rotation.

### 2.1 Provider definitions — file/plugin only, no DB table

Providers are declared in `oauth-providers/<id>.yaml` (cloud defaults shipped in repo) plus plugin manifests. Client `id`/`secret` resolve from env at startup (`<PROVIDER_ID>_OAUTH_CLIENT_ID`, `<PROVIDER_ID>_OAUTH_CLIENT_SECRET`); provider is registered iff both env vars are set.

We deliberately do **not** add a `cluster_oauth_providers` table in v1. Cloud operators manage credentials via IaC; if/when SaaS UX needs in-app credential editing, a future migration adds the table without changing the resolution interface.

### 2.2 New table: `oauth_connections`

```sql
CREATE TABLE oauth_connections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider_id              text NOT NULL,
  status                   text NOT NULL CHECK (status IN ('active','expired','revoked','error')),
  account_id               text,                          -- provider-stable id
  account_label            text,                          -- display label (email, workspace name)
  scopes                   text[] NOT NULL DEFAULT '{}',
  access_token_secret_id   uuid NOT NULL REFERENCES company_secrets(id),
  refresh_token_secret_id  uuid REFERENCES company_secrets(id),
  access_token_expires_at  timestamptz,
  last_refreshed_at        timestamptz,
  last_error               text,
  last_error_at            timestamptz,
  refresh_attempt_count    int  NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, provider_id)
);

CREATE INDEX oauth_connections_refresh_idx
  ON oauth_connections (access_token_expires_at)
  WHERE status = 'active' AND refresh_token_secret_id IS NOT NULL;
```

- Token ciphertext lives in `company_secret_versions`; refresh writes a *new version* of the same `company_secret` rather than rotating IDs.
- `account_id` lets us detect re-authorization with a different account and fail loudly instead of silently swapping.
- The partial index supports the refresh worker's "expiring soon" scan cheaply.
- **Insertion order** in the callback handler: create `company_secrets` rows for access + (optional) refresh first; then insert the `oauth_connections` row referencing them. The whole sequence runs in a single transaction so a failed token write rolls back the connection row.

### 2.3 New table: `oauth_authorization_states`

```sql
CREATE TABLE oauth_authorization_states (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider_id          text NOT NULL,
  code_verifier        text NOT NULL,
  redirect_uri         text NOT NULL,
  scopes_requested     text[] NOT NULL DEFAULT '{}',
  initiated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  return_url           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,           -- default created_at + 10 min
  consumed_at          timestamptz                     -- single-use enforcement
);

CREATE INDEX oauth_authorization_states_expiry_idx
  ON oauth_authorization_states (expires_at) WHERE consumed_at IS NULL;
```

The row's `id` doubles as the OAuth `state` parameter — no separate token to keep in sync.

### 2.4 Migration

Single migration `0086_oauth_connections.sql` adding both tables. Lands cleanly on top of M3b's `0085`.

### 2.5 Out of v1

- Audit log table for OAuth events (logs + `last_error*` are sufficient).
- `oauth_provider_overrides` per company (multi-account per provider).
- Webhook/notification dispatch on token expiry.

---

## 3. API Surface

All endpoints mount under `/api/oauth`. Auth uses the existing better-auth session middleware (company-scoped) except for the public callback, which validates via the `state` parameter.

### 3.1 Provider discovery

```
GET /api/oauth/providers              → 200 { providers: ProviderSummary[] }
GET /api/oauth/providers/:providerId  → 200 ProviderSummary | 404
```

`ProviderSummary` exposes only public fields: id, display name, icon URL, scopes-on-offer, doc URL. Never returns client_id/client_secret.

### 3.2 Flow initiation

```
POST /api/oauth/connect/:providerId
Body: { scopes?: string[], returnUrl?: string }
→ 200 { authorizeUrl: string, state: string }
```

Server generates PKCE `code_verifier`, derives `code_challenge` (S256), inserts an `oauth_authorization_states` row with `state = id`, builds the provider's authorize URL. The UI navigates `window.location = authorizeUrl`. `returnUrl` validated against an allowlist (Section 9.3). `scopes` defaults to provider's declared default scopes.

### 3.3 Callback (public, state-authenticated)

```
GET /api/oauth/callback/:providerId?code=...&state=...&error=...
→ 302 to returnUrl on success (with ?oauth_connected=<provider>)
→ 302 to returnUrl with ?oauth_error=... on failure
```

Handler steps (all-or-nothing per row):
1. Look up `oauth_authorization_states` by `state`. 404/410 if missing or `consumed_at` set.
2. Verify `expires_at > now()`.
3. Verify `provider_id` from URL matches the row.
4. If `error` query param present → mark `consumed_at`, redirect with `oauth_error`.
5. Exchange `code` + `code_verifier` at provider's token endpoint.
6. Fetch account identity (provider-specific call).
7. **Upsert** `oauth_connections` keyed by `(company_id, provider_id)`:
   - if existing row's `account_id` differs → reject `account_mismatch`
   - else write new secret version for access (and refresh if rotated), update metadata
8. Mark `consumed_at`.
9. Redirect to `returnUrl`.

### 3.4 Connection management (company-scoped)

```
GET    /api/oauth/connections                  → 200 { connections: ConnectionSummary[] }
GET    /api/oauth/connections/:id              → 200 ConnectionDetail
POST   /api/oauth/connections/:id/refresh      → 200 ConnectionDetail (429 if backoff active)
DELETE /api/oauth/connections/:id              → 204 (revokes upstream + deletes row + secrets)

# Internal — run-JWT-authed, called by the agent shim only
POST   /api/oauth/connections/:id/mark-revoked → 204
```

Response shapes never expose token material — only metadata, status, scopes, account label, expiry, last error.

The `mark-revoked` endpoint is the runtime-401 substitute for provider webhooks (Section 5.5). Authorization: the run JWT must include the connection id in its `oauth.connectionIds` claim, populated at dispatch time from the `oauth_token` bindings the resolver consumed. A run can only revoke connections it was actually granted access to.

### 3.5 Internal: secret-ref binding integration

No new endpoint. The existing agent env editor binding picker gains a third type:

```ts
type EnvBinding =
  | { type: "literal"; value: string }
  | { type: "secret_ref"; secretId: string; version?: SecretVersionSelector }
  | { type: "oauth_token"; connectionId: string; field: "access" };  // NEW
```

The runtime never sees a new token-fetching API. OAuth tokens flow through the existing per-Job env Secret pipeline.

### 3.6 Rate limits (reuse M3b limiter)

| Endpoint | Limit | Key |
|---|---|---|
| `POST /connect/:providerId` | 20/min | session userId |
| `GET /callback/:providerId` | 60/min | client IP |
| `POST /:id/refresh` | 5/min | connection id |

### 3.7 Out of v1

- Bulk operations (refresh-all).
- Per-user connections.
- Provider-side webhook receivers (lazy 401-driven revocation substitutes).

---

## 4. Provider Config DSL

Common case is a single declarative YAML file; provider quirks handled by an optional TypeScript "shape module" loaded by id.

### 4.1 File layout

```
oauth-providers/
  github.yaml       linear.yaml
  notion.yaml       atlassian.yaml
  slack.yaml        google-workspace.yaml
                    microsoft-graph.yaml
  shapes/
    slack.ts        microsoft.ts
```

Loaded once at server startup. Self-hosted operators get the same files baked into the Docker image. `PAPERCLIP_OAUTH_PROVIDERS_DIR` (extra dir) merges on top. Plugin contributions feed the same registry.

### 4.2 YAML schema (example: GitHub)

```yaml
id: github
displayName: GitHub
iconUrl: https://github.githubassets.com/images/icons/oauth.svg
docUrl: https://docs.paperclip.ai/integrations/github

clientCredentials:
  clientIdEnv: GITHUB_OAUTH_CLIENT_ID
  clientSecretEnv: GITHUB_OAUTH_CLIENT_SECRET

endpoints:
  authorize: https://github.com/login/oauth/authorize
  token:     https://github.com/login/oauth/access_token
  revoke:    https://api.github.com/applications/{client_id}/grant
  accountInfo: https://api.github.com/user

scopes:
  default: [repo, read:user, user:email]
  offered: [repo, read:user, user:email, workflow, write:packages]

pkce: required          # required | optional | unsupported
authMethod: post        # post | basic
responseFormat: json    # json | form

accountIdField: id              # dot-path into accountInfo response
accountLabelField: login

refresh:
  supported: false              # GitHub user-token refresh requires app-level toggle
  # When supported: true:
  # rotatesRefreshToken: true
  # expirySeconds: 28800

shape: ~                # optional shape module name
```

### 4.3 TypeScript type

```ts
export interface OAuthProviderConfig {
  id: string;
  displayName: string;
  iconUrl?: string;
  docUrl?: string;

  clientCredentials: {
    clientIdEnv: string;
    clientSecretEnv: string;
  };

  endpoints: {
    authorize: string;
    token: string;
    revoke?: string;            // {client_id} substitution supported
    accountInfo: string;
  };

  scopes: {
    default: string[];
    offered: string[];
  };

  pkce: "required" | "optional" | "unsupported";
  authMethod: "post" | "basic";
  responseFormat: "json" | "form";

  accountIdField: string;
  accountLabelField: string;

  refresh:
    | { supported: false }
    | { supported: true; rotatesRefreshToken: boolean; expirySeconds?: number };

  shape?: string;
}
```

Source of truth is a Zod schema; the TS type is derived from it.

### 4.4 Shape modules (escape hatch)

For providers whose response shape can't be expressed by dot-path fields:

```ts
export const slack: ProviderShape = {
  parseTokenResponse(raw) {
    if (raw.authed_user?.access_token) {
      return {
        accessToken: raw.authed_user.access_token,
        refreshToken: raw.authed_user.refresh_token,
        expiresInSeconds: raw.authed_user.expires_in,
        scope: raw.authed_user.scope?.split(",") ?? [],
      };
    }
    return {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      expiresInSeconds: raw.expires_in,
      scope: raw.scope?.split(",") ?? [],
    };
  },
  parseAccountInfo(raw) {
    return { accountId: raw.team?.id, accountLabel: raw.team?.name };
  },
};
```

`ProviderShape` is fully optional; default impl handles RFC-6749-shaped responses with the YAML's dot-paths.

### 4.5 Validation at startup

1. Read every `*.yaml`.
2. Validate against the Zod schema.
3. Resolve `clientCredentials` env vars — provider registered iff both are set, otherwise skipped with WARN.
4. Load referenced shape modules; missing module is fatal.
5. Build immutable in-memory `Map<providerId, RegisteredProvider>`.

No hot reload in v1.

### 4.6 Out of v1

- Per-tenant provider overrides (different client_id per company).
- JSON Schema export for editor tooling.
- Custom OAuth grants (device flow, client_credentials, JWT-bearer).

---

## 5. Refresh Strategy

Two cooperating paths: a proactive worker, and a lazy refresh inside the resolver.

### 5.1 Proactive worker

**Schedule:** every 60s, single-instance via the existing `pg_try_advisory_lock` leader-election pattern.

**Selection** runs in two passes — a cheap unfiltered scan to get candidates, then per-row backoff filtering in TS. The two-pass approach avoids defining a SQL stored proc for `backoffWindow` (whose definition lives in TS, Section 5.2):

```sql
SELECT id, refresh_attempt_count, last_error_at
FROM oauth_connections
WHERE status = 'active'
  AND refresh_token_secret_id IS NOT NULL
  AND access_token_expires_at IS NOT NULL
  AND access_token_expires_at < now() + interval '5 minutes'
ORDER BY access_token_expires_at ASC
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

Worker then drops rows where `last_error_at != null AND last_error_at + backoffWindow(refresh_attempt_count) > now()`. The cap of 100 candidates means the per-row filter cost is negligible.

Per-row sequential refresh:
1. Decrypt latest refresh token.
2. POST to provider's token endpoint per Section 4.
3. On 2xx: write new `company_secret_versions` for access (and refresh if rotated), update row, clear `last_error*`, reset `refresh_attempt_count`.
4. On 4xx with `invalid_grant`/`invalid_token`: status → `revoked`. No retry.
5. On 5xx/network: increment `refresh_attempt_count`, write `last_error*`. Status stays `active` until `access_token_expires_at` passes; then flips to `expired`.

### 5.2 Backoff

```ts
function backoffWindow(attempts: number): Interval {
  const seconds = Math.min(2 ** attempts * 30, 3600);  // 30s … 1h cap
  return Interval.fromSeconds(seconds);
}
```

Five consecutive failures → row stops being scheduled. Manual `POST /:id/refresh` or successful lazy refresh re-arms it.

### 5.3 Lazy refresh inside the resolver

Triggered when `access_token_expires_at < now() + 60s`:

1. `SELECT … FOR UPDATE SKIP LOCKED` the row. If we lose the lock, poll `last_refreshed_at` for up to 2s.
2. Otherwise run the same refresh body as the worker.
3. On success, return freshly written plaintext.
4. On failure with a still-valid token, return the old token; otherwise dispatch fails with `oauth_refresh_failed`.

The 60s window must exceed worst-case clock skew between replica and provider.

### 5.4 Concurrency invariants

- **Single in-flight refresh per row** — `FOR UPDATE SKIP LOCKED`.
- **Refresh-token rotation safety** — new refresh token is persisted in the same transaction as the new access token. Transaction rollback after rotation = `refresh_token_lost_after_rotation`, surfaces as `revoked` next tick.
- **Scope drift** — provider may return a different scope set than requested. Accept and store actual scopes; log WARN. Some providers (Google, Microsoft) silently drop user-declined scopes; failing closed would block valid logins.

### 5.5 Revocation handling

| Source | Trigger |
|---|---|
| Refresh | Provider returns `invalid_grant`/`invalid_token` |
| Runtime 401 | Agent-shim observes 401 from a known integration → calls `POST /api/oauth/connections/:id/mark-revoked` (run-JWT-authed, scoped to the connection ids the dispatch resolved) |
| Manual | `DELETE /api/oauth/connections/:id` |

The runtime-401 path is the cheap substitute for provider webhooks (deferred from v1).

### 5.6 Cleanup & metrics

- **State sweeper** in the same worker: deletes `oauth_authorization_states` where `expires_at < now() - 1d`.
- **Metrics** (Prometheus, existing pattern): `oauth_refresh_total{provider,result}`, `oauth_refresh_duration_seconds{provider}`, `oauth_connections_by_status{provider,status}`.

### 5.7 Out of v1

- Background pre-warming of newly created connections.
- Per-provider concurrency caps.

---

## 6. Plugin SDK Extension

Plugins are first-class providers via the `OAuthProviderConfig` shape.

### 6.1 Manifest extension

```ts
export interface PluginManifest {
  // existing fields…
  kind: "sandbox_provider" | "oauth_provider" | "composite";
  oauthProviders?: OAuthProviderContribution[];
}

export interface OAuthProviderContribution {
  config: OAuthProviderConfig;
  shape?: ProviderShape;
}
```

`kind: "oauth_provider"` for pure-OAuth plugins; `kind: "composite"` for plugins that ship a sandbox provider *and* an OAuth provider.

### 6.2 SDK helper

```ts
export function defineOAuthProvider(
  contribution: OAuthProviderContribution,
): OAuthProviderContribution {
  return contribution; // identity helper for type inference
}
```

Plugin entry point pattern:

```ts
import { definePlugin, defineOAuthProvider } from "@paperclipai/plugin-sdk";
import { hubspotShape } from "./shape.js";

export default definePlugin({
  kind: "oauth_provider",
  name: "@example/paperclip-plugin-hubspot",
  oauthProviders: [
    defineOAuthProvider({
      config: { /* OAuthProviderConfig */ },
      shape: hubspotShape,
    }),
  ],
});
```

### 6.3 Loading & precedence

Registry build at startup:
1. YAML files from `oauth-providers/` (in-repo defaults).
2. YAML files from `PAPERCLIP_OAUTH_PROVIDERS_DIR`.
3. Plugin contributions.
4. Merge into the map. **Conflict policy:** lower-numbered source wins. WARN on conflicts.

### 6.4 Manifest validation

Existing manifest validator gets a discriminated union on `kind`. `oauth_provider`/`composite` require `oauthProviders` non-empty. `sandbox_provider` plugins remain valid unchanged.

### 6.5 Plugin lifecycle

- **Install** — registry rebuilt at next server start (existing plugin install requires worker restart).
- **Disable** — provider removed; existing connections move to `error/provider_disabled`. Tokens stay encrypted in `company_secrets`. Re-enabling restores connections.
- **Uninstall** — same as disable, plus a deferred cleanup job that hard-deletes `oauth_connections` rows older than 30 days whose provider is still missing.

### 6.6 Plugin trust boundary

- Plugin-contributed providers can declare arbitrary URLs as `endpoints.token`. Plugin install requires admin role; we rely on the existing plugin-trust model. No new validation in v1.
- Shape modules execute in the server process, same as sandbox-provider modules.
- Documented as a known plugin-installation risk.

### 6.7 Out of v1

- Hot reload of plugin-contributed providers.
- Plugin-private OAuth credentials (plugin maintainer ships their own client_id/secret).
- Dedicated `paperclip plugin oauth list` CLI subcommand.

---

## 7. UI

Two surfaces touched, plus minor wiring.

### 7.1 Settings → Connections page

Route: `/settings/connections` (next to `/settings/secrets`).

Tile-based layout, driven by `GET /api/oauth/providers` × `GET /api/oauth/connections`. Tiles ordered: connected first (most-recently-refreshed), then unconnected alphabetical.

| State | Visual | Action |
|---|---|---|
| Available, not connected | Outline + provider name | `Connect →` |
| Connected, healthy | Filled + account label + "refreshed Xm ago" | `Manage` (drawer) |
| Connected, refresh stalled | Amber border + "Last refresh failed" | `Manage` shows error + retry |
| Connected, revoked | Red border + "Revoked — reconnect to use" | `Reconnect` |

**"Manage" detail drawer** (right-side slide-over, reused from Settings → Secrets):
- Account label, account id, scopes granted
- Last refresh timestamp + status
- "Refresh now" button
- "Disconnect" button (with confirmation warning about agents currently using the connection)

**Connect flow UX:** full-page redirect, not popup.
1. Click `Connect →`.
2. Frontend `POST /api/oauth/connect/:providerId` with `returnUrl: "/settings/connections"`.
3. Server returns `authorizeUrl`; UI sets `window.location = authorizeUrl`.
4. User authorizes upstream.
5. Provider redirects to `/api/oauth/callback/:providerId?code=…&state=…`.
6. Server processes, redirects to `returnUrl` with `?oauth_connected=<provider>` or `?oauth_error=…`.
7. UI reads the query param, shows toast, strips the param.

### 7.2 Empty / unconfigured states

- **No providers registered**: explanatory empty state, link to docs. Same page; never 404.
- **Some registered, none connected**: tiles render normally; tiles are themselves the CTA.
- **A provider went missing post-startup**: tiles disappear; existing connections move to `error/provider_unavailable` and surface "Provider no longer configured — contact your administrator".

### 7.3 Permission model

| Role | View tiles + status | Connect/Disconnect | Pick `oauth_token` bindings |
|---|---|---|---|
| Member | ✓ | ✗ | ✓ |
| Admin | ✓ | ✓ | ✓ |

For members, `Connect →` renders disabled with tooltip "Ask an admin to connect GitHub".

### 7.4 Agent env editor — binding picker

Existing `<BindingInput>` gets a third option: "Connection token".
- Dropdown of `status = 'active'` connections, labeled `<provider> · <account_label>`.
- Disabled-with-tooltip for non-active connections (with reason inline).
- Secondary `Field: [Access token ▼]` dropdown — single option in v1, structurally ready for `Refresh token`/`Account id` in v2 without UI rewrite.

Saved binding: `{ "type": "oauth_token", "connectionId": "uuid", "field": "access" }`.

If dispatch later finds the connection missing/revoked, it fails fast and surfaces a banner on the agent's run page: "Binding `GITHUB_TOKEN` requires a connected GitHub account — reconnect at Settings → Connections."

### 7.5 Visual & interaction reuse

- Tiles, drawer, dropdowns reused from Settings → Secrets / Settings → Adapters.
- No new design tokens.
- Loading: skeleton tiles.
- i18n strings added to existing `ui/src/locales/en.json`.

### 7.6 Out of v1

- Per-agent override of which connection backs a binding.
- In-app OAuth app credential editing for cloud operators.
- Audit timeline UI.

---

## 8. Error Handling

### 8.1 Flow initiation

| Failure | Code | Surface | Recovery |
|---|---|---|---|
| Provider not registered | `provider_not_found` | "GitHub isn't configured" | Operator sets env vars + restarts |
| Invalid scope | `invalid_scope` | UI inline form error | User narrows scopes |
| Existing connection, **same** account | (none) | Idempotent re-auth | — |
| Existing connection, **different** account | `account_mismatch_pre_flow` | Modal: "GitHub already connected as user@a.com — disconnect first?" | Disconnect, retry |

### 8.2 Callback

Always 302 back to a validated `returnUrl` (or hardcoded safe default `/settings/connections`).

| Failure | Query param |
|---|---|
| `state` missing/expired | `?oauth_error=invalid_state` |
| `state` already consumed | `?oauth_error=replay` |
| `state` provider mismatch | `?oauth_error=provider_mismatch` |
| Provider returned `error=access_denied` | `?oauth_error=user_cancelled` (silent toast) |
| Token exchange non-2xx | `?oauth_error=token_exchange_failed&detail=...` |
| Account info call failed | `?oauth_error=account_info_failed` (tokens not persisted) |
| `account_id` differs from existing row | `?oauth_error=account_mismatch` |

### 8.3 Refresh

(Specified in Section 5; user surfacing summary.)

- **Transient (5xx, network):** invisible while still pre-expiry. After expiry, status flips to `expired`; tile shows amber.
- **Permanent (`invalid_grant`):** status flips to `revoked` immediately; tile shows red + `Reconnect`.
- **Stuck (5 consecutive failures):** worker stops scheduling; tile shows "Stuck — auto-refresh paused".

### 8.4 Dispatch-time resolution

| Failure | Behavior |
|---|---|
| Connection deleted | `oauth_connection_missing` — banner: "Binding references a deleted connection" |
| Connection `revoked` | `oauth_connection_revoked` — banner: "Reconnect at Settings → Connections" |
| Connection `expired` and lazy refresh fails | `oauth_refresh_failed` — banner with `last_error` + retry button |
| Connection `error/provider_unavailable` | `oauth_provider_unavailable` — banner: "Provider is no longer configured" |
| `active` and refresh succeeds | Token returned to runtime; dispatch proceeds |

**Critical invariant:** dispatch never silently substitutes a stale or different token. Fail fast.

### 8.5 Provider downtime

- 30s timeout per provider HTTP call.
- 0 retries on 4xx.
- 2 retries with 200ms / 600ms backoff on 5xx + network errors.
- Refresh worker has its own per-row backoff (Section 5.2).

### 8.6 Startup errors

| Failure | Behavior |
|---|---|
| YAML schema invalid | Fatal — server fails to start |
| Shape module missing | Fatal |
| Provider env vars unset | WARN; provider skipped |
| Plugin/file id collision | WARN; plugin skipped (file wins) |
| Two plugins same id | WARN; second skipped (deterministic by install order) |

### 8.7 Cleanup-on-failure invariants

- Token exchange success but DB write failure → revoke upstream (best-effort).
- Disconnect: revoke upstream first (best-effort), then transactional delete of row + secret versions. Failed upstream revoke logs WARN, does not block local cleanup.
- Plugin disable while connections active: connections move to `error/provider_unavailable`, secrets retained.

### 8.8 Logging conventions

Every OAuth code path emits a structured pino log line with: `oauth.provider`, `oauth.connectionId` (when available), `oauth.flowStage` (`initiate`/`callback`/`refresh`/`resolve`/`disconnect`), `oauth.outcome` (`success`/`failure`/`skipped`), `oauth.errorCode`. Token material is never logged — explicit redaction filter on the OAuth logger child (Section 9.7).

### 8.9 Out of v1

- Automatic re-auth links via email.
- Per-error metric counters with provider-specific labels (cardinality discipline).

---

## 9. Security

### 9.1 PKCE — required, S256 only

- `code_verifier` is 64 random bytes, base64url-encoded; `code_challenge_method = S256` always.
- We never fall back to `plain` even if a provider's metadata advertises it; `pkce: optional` in YAML governs whether we send PKCE to providers that don't require it (we still always send it).
- `pkce: unsupported` requires explicit operator override + WARN log. No v1 launch provider needs it.
- `code_verifier` lives only in `oauth_authorization_states.code_verifier` and is swept after `consumed_at + 1d`.

### 9.2 State parameter — CSRF + single-use

- `state = oauth_authorization_states.id` (UUIDv4, 122 bits entropy). Same value as the row id — no drift between row and state.
- Single-use enforced by `consumed_at`.
- 10-minute TTL.
- Provider id from URL must match the row's `provider_id`.
- Initiating user recorded in `initiated_by_user_id` for audit; *not* enforced same-user-must-finish (mobile-then-desktop flows).

### 9.3 Redirect URI allowlists

**1. Provider redirect URI** (registered with each provider): single canonical value per deployment, `${PAPERCLIP_PUBLIC_URL}/api/oauth/callback/:providerId`. Not varied per-flow.

**2. `returnUrl`** (post-callback browser redirect): allowlist of relative paths under the deployment's own origin. Implementation: `new URL(returnUrl, PAPERCLIP_PUBLIC_URL)`, require `origin` matches and `pathname` starts with one of `["/settings/", "/agents/", "/runs/"]`. Anything else falls through to `/settings/connections`. `data:`/`javascript:` schemes caught by the URL parse.

### 9.4 Token storage at rest

- Stored as `company_secret_versions` rows, encrypted via the deployment's `SecretProvider`.
- **Discrimination via FK, not via a `kind` column.** The `oauth_connections.access_token_secret_id` and `.refresh_token_secret_id` foreign keys are the source of truth for which `company_secrets` rows hold OAuth tokens. (The earlier plan to extend a `company_secrets.kind` column was dropped during implementation: that column does not exist in this codebase, and FK-based discrimination is sufficient. Audit queries like "all OAuth access tokens last rotated > 30 days ago" join through `oauth_connections`.)
- Refresh writes a *new version* (atomic rollback on failure; preserves short history).

### 9.5 Token in transit

- All YAML-declared provider endpoints must be `https://`. Loader rejects non-https at startup.
- Cert pinning out of scope for v1 (matches existing webhook posture).
- Tokens never leave the server toward the frontend. Only consumer of plaintext is the agent runtime via `resolveAdapterConfigForRuntime`.

### 9.6 Client secret protection

- Resolved from env at startup; never written to disk; never persisted in DB.
- Logged once at startup as `client_secret: [REDACTED]` alongside the configured client_id.
- Future `cluster_oauth_providers` table will store via `SecretProvider`-encrypted columns.

### 9.7 Logging redaction

`oauthLogger` pino child with explicit redact paths covering every shape we route through it:

```
['*.access_token','*.refresh_token','*.id_token',
 '*.code','*.code_verifier','*.client_secret',
 'data.access_token','data.refresh_token','data.id_token']
```

Plus a custom serializer masking any string field whose key matches `/token|secret|credential/i`.

### 9.8 Tenant isolation

Every query against `oauth_connections` and `oauth_authorization_states` filters by `company_id` from the authenticated session. Resolver asserts `connection.companyId === ctx.companyId` before reading the secret — assertion failure logs ERROR and fails dispatch with 500.

### 9.9 Refresh-token rotation behavior

Per-provider, declared in YAML (`refresh.rotatesRefreshToken`):

- **`true`**: new refresh_token returned on every refresh; old invalidated. We persist new refresh in the same transaction as new access. Transaction rollback after rotation = unrefreshable; flagged `refresh_token_lost_after_rotation`.
- **`false`**: refresh keeps the same refresh_token; only access rotates.

No auto-detect — operators set this field per provider docs. Misconfigured rotation surfaces as repeated `invalid_grant` after the first refresh.

### 9.10 Scope minimization

- `scopes.default` = minimum for basic agent integration; `scopes.offered` = maximum the UI lets users opt into.
- `POST /connect/:providerId` accepts `scopes`; values must be a subset of `scopes.offered`. Excess scopes 400-rejected before redirect.

### 9.11 Provider response validation

The shape module (Section 4.4) and the default RFC-6749 parser are the only places we trust provider JSON. Both reject:
- Missing/non-string `access_token`.
- `expires_in` negative or > 1 year.
- `scope` containing non-printable characters.
- Non-string `account_id`/`account_label` after dot-path resolution.

Violations surface as `token_exchange_failed` with `detail: response_shape_violation`; raw response logged at server-side ERROR with token fields redacted.

### 9.12 Rate-limiting (defense-in-depth)

In addition to Section 3.6's per-route limits:
- **State row creation**: 50 rows / 5 min / company.
- **Failed callback attempts**: 30 / 5 min / IP.
- **Refresh failures**: per-row backoff (Section 5.2).

### 9.13 Plugin trust boundary

(Repeated from Section 6.6 for completeness.) Plugin-contributed providers can declare arbitrary token endpoints. Plugins are admin-installed and trusted; no per-provider URL allowlists for plugins in v1. Documented as known plugin-installation risk.

### 9.14 Out of v1

- DPoP / mTLS / sender-constrained tokens.
- Token introspection (RFC 7662).
- Per-tenant cipher keys.
- Webhook signature verification for provider revocation.

---

## 10. Testing Strategy

| Layer | Scope | Speed | Where |
|---|---|---|---|
| Unit | Validators, shape modules, dot-path, backoff math | <1s | `*.test.ts` next to source |
| Mock-provider integration | Full OAuth flow against in-process fixture server | seconds | `test/integration/oauth/` |
| Playwright E2E | Connect flow from tile click to toast | tens of seconds | `test/e2e/oauth.spec.ts` |

No real-provider tests in CI in v1.

### 10.1 Unit tests

| Module | Cases |
|---|---|
| `provider-config.ts` (Zod loader) | Valid YAML round-trips; missing required field rejected; non-https endpoint rejected; unknown PKCE mode rejected; conflicting `refresh.supported`/`rotatesRefreshToken` rejected |
| `dot-path.ts` | Top-level `id`; nested `team.id`; missing path → `null`; null-prototype object handling |
| `state-token.ts` | Generated state is base64url; `code_challenge` from known `code_verifier` matches RFC 7636 vector |
| `backoff.ts` | First call → 30s; 5th → 8m; 10th → 1h cap; never negative |
| `redirect-uri-allowlist.ts` | Allowed paths; cross-origin rejected; `javascript:`/`data:` rejected; missing `returnUrl` falls back to default |
| `refresh-token-rotation.ts` | `rotates: true` + new token → write new version; `rotates: true` + missing token → reject; `rotates: false` + new token → log WARN, store defensively |
| Each shape module | Paired test reading recorded fixture, asserting parsed shape |

### 10.2 Mock-provider integration tests

In-process Express fixture bound to an ephemeral port, configured per-test. Paperclip server under test starts with `mock-oauth.yaml` pointing at the fixture URL. No network egress.

`test/integration/oauth/mock-provider.test.ts`:

| # | Scenario | Assertion |
|---|---|---|
| 1 | Happy path | `status = 'active'`; `account_id` set; access secret retrievable |
| 2 | State replay | Second callback returns `?oauth_error=replay`; row not double-written |
| 3 | State expired (advance fake clock 11 min) | `?oauth_error=invalid_state` |
| 4 | Provider mismatch | `?oauth_error=provider_mismatch` |
| 5 | Account mismatch (re-auth different `account_id`) | `?oauth_error=account_mismatch`; existing row untouched |
| 6 | Token exchange returns 500 | `?oauth_error=token_exchange_failed`; row not written |
| 7 | Refresh worker rotates near-expiry token | New version written; old superseded |
| 8 | Refresh returns `invalid_grant` | `status = 'revoked'`; `last_error` set |
| 9 | Lazy refresh during dispatch (token < 60s to expiry) | Resolver returns refreshed token; advisory-lock test confirms no double-refresh |
| 10 | 5 consecutive refresh failures | `refresh_attempt_count = 5`; row no longer scheduled |
| 11 | Disconnect with revoke success | Row + secrets deleted; provider revoke called |
| 12 | Disconnect with revoke 500 | Row + secrets still deleted; WARN logged |
| 13 | Plugin contributes a provider; YAML with same id present | Plugin contribution skipped; WARN logged |
| 14 | Provider env vars unset at startup | Provider not registered; existing connections move to `error/provider_unavailable` |

Every numbered "Critical invariant"/"must" in Sections 3, 5, 8, 9 maps to one of these tests.

### 10.3 Playwright E2E

`test/e2e/oauth.spec.ts`:

1. **Connect happy path** — admin logs in, navigates to `/settings/connections`, clicks `Connect →` on mock tile, full HTTP redirect dance, lands back, asserts `oauth_connected=mock` toast + connected tile.
2. **User cancels at provider** — mock returns `error=access_denied`, asserts no toast + tile stays unconnected.
3. **Binding picker** — member opens agent env editor, picks "Connection token" binding to `mock` connection, runs agent (mock adapter that echoes env), asserts agent receives the resolved access token.

Scenario 3 proves end-to-end plumbing.

### 10.4 Security-flavored tests

- **Open-redirect regression**: parametrized test of `redirect-uri-allowlist.ts` with OWASP cheat-sheet vectors (`//evil`, `\\evil`, `https:%2F%2Fevil.example`, schema-relative URLs, double-encoded slashes).
- **Token redaction**: pino logger test asserts `oauthLogger.info({ access_token: 'abc', refresh_token: 'def' })` produces output containing neither `'abc'` nor `'def'`.
- **Cross-tenant isolation**: integration test seeds two companies with mock connections, asserts company A cannot read/refresh/disconnect company B's connection (404, not 403).
- **Scope escalation rejected**: `POST /connect/:provider` with `scopes` outside `offered` returns 400.
- **State row flooding**: 51 rapid `POST /connect/mock` from one company → 51st returns 429.

### 10.5 Out of v1

- Real provider integration in CI.
- Plugin install/uninstall lifecycle through OAuth path (existing plugin-host tests cover lifecycle).
- Browser-level CSRF tests beyond state-mismatch coverage.

### 10.6 CI integration

- Unit + mock-provider integration tests run in the existing `server` test job (~+15s).
- Playwright spec joins existing `ui-e2e` job (~+60s).
- No new CI workflow.

---

## 11. Migration Plan

Single migration `0086_oauth_connections.sql` adds two tables (Section 2.2, 2.3). No backfill: existing manually-managed PATs continue to live in `company_secrets` and remain bindable via `secret_ref` indefinitely.

---

## 12. Rollout

1. **Server-only deploy** with provider env vars unset → no behavioral change; route mounts but `GET /api/oauth/providers` returns `[]`. Migration runs.
2. **Operator sets first provider's env vars + restarts.** Tile appears in UI; admins can connect.
3. **Per-provider rollout** as operator OAuth-app paperwork completes.

No coordinated cross-component release; the OAuth backbone is purely additive.

---

## 13. Future Work (sub-projects B and C)

These are referenced for context only — separate spec cycles will own them.

- **Sub-project B (Inbound MCP integration):** turn an active `oauth_connections` row into an MCP server attached to the agent's runtime. Will likely add a per-provider MCP server config (alongside the current outbound-only `@paperclipai/mcp-server`) and a binding type `oauth_mcp` that resolves to `{mcp_server_url, oauth_token}` instead of just a token.

- **Sub-project C (SDK aggregator plugin):** ship a Composio/Nango-style plugin that wraps a third-party aggregator's catalog. Will live as a regular OAuth provider plugin (Section 6) plus an MCP server plugin.

- **Other v2 candidates:** multi-account-per-company, per-user connections, `cluster_oauth_providers` table for in-app credential editing, webhook-signed revocation, real-provider smoke harness, audit timeline, email re-auth notifications.
