# SSO / OIDC Configuration

Paperclip supports Single Sign-On (SSO) via any OAuth 2.0 / OpenID Connect identity provider.
SSO is only active when `deploymentMode` is `authenticated`.

Related documents:

- Implementation plan: [`doc/plans/2026-04-07-sso-oidc-support.md`](plans/2026-04-07-sso-oidc-support.md)
- Deployment modes: [`doc/DEPLOYMENT-MODES.md`](DEPLOYMENT-MODES.md)
- Humans and permissions: [`doc/plans/2026-02-21-humans-and-permissions.md`](plans/2026-02-21-humans-and-permissions.md)

## Quick Start

SSO is configured entirely through the Paperclip web UI:

1. Sign in as an instance admin
2. Navigate to **Instance Settings → SSO**
3. Toggle **Enable SSO** on
4. Add one or more SSO providers with their connection details
5. Click **Save SSO Settings**

Changes take effect immediately — no server restart required. The Better Auth OAuth
handler is rebuilt on the fly when SSO settings are saved.

## Provider Configuration

### Common Fields

| Field          | Required | Description                                          |
|----------------|----------|------------------------------------------------------|
| `providerId`   | Yes      | Unique identifier for this provider                  |
| `type`         | Yes      | One of: `keycloak`, `auth0`, `okta`, `microsoft_entra_id`, `oidc` |
| `clientId`     | Yes      | OAuth client ID registered with the IdP              |
| `clientSecret` | Yes      | OAuth client secret                                  |
| `displayName`  | No       | Label shown on the login button (defaults to type)   |
| `scopes`       | No       | Override default OAuth scopes                        |

### Keycloak

| Field    | Required | Example                                                |
|----------|----------|--------------------------------------------------------|
| `issuer` | Yes      | `https://keycloak.example.com/realms/your-realm`       |

### Auth0

| Field    | Required | Example                    |
|----------|----------|----------------------------|
| `domain` | Yes*     | `your-tenant.auth0.com`    |
| `issuer` | Yes*     | `https://your-tenant.auth0.com` |

*Either `domain` or `issuer` is required.

### Okta

| Field    | Required | Example                        |
|----------|----------|--------------------------------|
| `issuer` | Yes      | `https://your-org.okta.com`    |

### Microsoft Entra ID (Azure AD)

| Field      | Required | Example            |
|------------|----------|--------------------|
| `tenantId` | Yes      | `your-tenant-id`   |

### Generic OIDC

Any provider that publishes `/.well-known/openid-configuration`:

| Field          | Required | Example                                                        |
|----------------|----------|----------------------------------------------------------------|
| `discoveryUrl` | Yes      | `https://idp.example.com/.well-known/openid-configuration`     |

## Callback URL

Register this callback URL in your identity provider:

```
{PAPERCLIP_PUBLIC_URL}/api/auth/oauth2/callback/{providerId}
```

For example, if `PAPERCLIP_PUBLIC_URL=https://paperclip.example.com` and `providerId=keycloak`:

```
https://paperclip.example.com/api/auth/oauth2/callback/keycloak
```

## Multiple Providers

You can configure multiple SSO providers in the UI. Each appears as a separate button on the login page.

## Role-Based Access Restriction

You can restrict SSO login to users who have specific roles in their identity provider. When `requiredRoles` is configured, Paperclip inspects the token claims during the OAuth callback and rejects users who lack a matching role.

### Configuration

Add `requiredRoles` to any SSO provider config in the UI:

| Field | Required | Description |
|---|---|---|
| `claimPath` | Yes | Dot-separated path into the JWT payload to locate the roles claim |
| `roles` | Yes | Array of role values; user must have **at least one** to be allowed in |

### How it works

1. After the IdP returns tokens, Paperclip decodes the JWT payload (without cryptographic verification — the IdP already validated the token during the OAuth exchange).
2. It first checks the `id_token`. If the roles are not found there, it falls back to checking the `access_token`. This fallback is important because some IdPs (notably Keycloak) include client roles only in the access token by default.
3. It resolves the claim at `claimPath` using dot notation (e.g. `resource_access.paperclip.roles` navigates to `token.resource_access.paperclip.roles`).
4. If the resolved value is an array, it checks whether any element matches one of the configured `roles`.
5. If the resolved value is a string, it checks for an exact match.
6. If no match is found in either token, the login is rejected and a warning is logged.

### Provider-specific claim paths

| Provider | Claim path | Notes |
|---|---|---|
| Keycloak | `resource_access.<clientId>.roles` | Client roles |
| Keycloak | `realm_access.roles` | Realm roles |
| Auth0 | `https://your-namespace/roles` | Custom claims via Auth0 Rules/Actions |
| Okta | `groups` | Group membership (add `groups` to scopes) |
| Azure AD | `roles` | App roles |
| Generic OIDC | Varies by provider | Check your IdP's token documentation |

### Disabling role restriction

Omit `requiredRoles` from the provider config. When not set, all authenticated SSO users are allowed in.

## Account Linking

When SSO is enabled, account linking is automatically activated. If a user signs in via SSO with an email that matches an existing email/password account, the SSO identity is linked to the existing user. The user can then sign in with either method.

## Login Page Behavior

- **SSO disabled** (default): Standard email/password sign-in and sign-up page.
- **SSO enabled**: SSO provider buttons appear on the sign-in page. Email/password sign-in remains available. The sign-up option is hidden (new users are provisioned via SSO).
- In `local_trusted` mode, SSO is ignored (no login required).
- SSO users receive the same `board` actor type and permissions as email/password users.
- Company memberships and permissions are identity-method-agnostic.

## Local Dev with Keycloak (Docker Compose)

A Docker Compose stack is provided for testing SSO locally with Keycloak.

### Prerequisites

- Docker and Docker Compose
- The repo checked out and built (`pnpm install && pnpm build`)

### Start the stack

```sh
docker compose -f docker/docker-compose.sso.yml up --build -d
```

This starts three services:

| Service    | URL                          | Purpose                                |
|------------|------------------------------|----------------------------------------|
| `db`       | `localhost:5432`             | Postgres 17 database                   |
| `keycloak` | `http://localhost:8080`      | Keycloak 26.2 identity provider        |
| `server`   | `http://localhost:3100`      | Paperclip in authenticated mode        |

### Bootstrap the instance

Run the bootstrap script to create an admin user and activate the instance:

```sh
./scripts/bootstrap-sso-dev.sh
```

The script:

1. Waits for Paperclip to become healthy
2. Creates an admin user (`admin@paperclip.dev` / `paperclip-admin-123` by default)
3. Generates a bootstrap CEO invite via the CLI
4. Accepts the invite to promote the user to instance admin

Override defaults with environment variables:

```sh
ADMIN_EMAIL=me@example.com ADMIN_PASSWORD=secret123 ./scripts/bootstrap-sso-dev.sh
```

### Configure SSO via the UI

After bootstrapping, SSO is **not** enabled by default. To set up the Keycloak SSO provider:

1. Sign in at `http://localhost:3100` with `admin@paperclip.dev` / `paperclip-admin-123`
2. Go to **Instance Settings → SSO**
3. Toggle **Enable SSO** on
4. Add a provider with these settings:

| Field | Value |
|---|---|
| Provider ID | `keycloak` |
| Type | `keycloak` |
| Client ID | `paperclip` |
| Client Secret | `paperclip-sso-secret` |
| Issuer | `http://localhost:8080/realms/paperclip` |
| Display Name | `Keycloak SSO` |
| Required Roles → Claim Path | `resource_access.paperclip.roles` |
| Required Roles → Roles | `human` |

5. Click **Save SSO Settings**

> **Important**: The issuer URL must use `localhost:8080` (not `keycloak:8080`),
> because the browser needs to reach Keycloak directly. The server container uses
> `extra_hosts: ["localhost:host-gateway"]` so that `localhost` inside the container
> resolves to the Docker host, allowing it to reach the Keycloak port mapping.

### Test the SSO flow

1. Sign out of Paperclip
2. The login page now shows a **Keycloak SSO** button
3. Click it and authenticate in Keycloak with one of the pre-configured users:

| Username   | Password   | Email                      | Client role `human` | Can sign in? |
|------------|------------|----------------------------|---------------------|--------------|
| `admin`    | `admin`    | `admin@paperclip.local`    | Yes                 | Yes          |
| `operator` | `operator` | `operator@paperclip.local` | Yes                 | Yes          |
| `viewer`   | `viewer`   | `viewer@paperclip.local`   | No                  | No (rejected by `requiredRoles`) |

4. After authentication, users with the `human` client role are redirected back to Paperclip with an active session. The `viewer` user is rejected because the config requires `resource_access.paperclip.roles` to contain `human`.

### Keycloak admin console

Access Keycloak admin at `http://localhost:8080/admin` (credentials: `admin` / `admin`).

The pre-imported `paperclip` realm contains:

- OIDC client: `paperclip` (secret: `paperclip-sso-secret`)
- Redirect URI: `http://localhost:3100/api/auth/oauth2/callback/keycloak`
- Default scopes: `openid`, `email`, `profile`, `roles`
- Client role: `human` (used for role-based access restriction)
- Protocol mapper: `paperclip-client-roles-idtoken` (includes client roles in `id_token`)

### Clean up

```sh
docker compose -f docker/docker-compose.sso.yml down -v
```

## Legacy: Environment Variable Configuration

The `PAPERCLIP_SSO_PROVIDERS` environment variable and `auth.ssoProviders` config file
option still work as a fallback for pre-configuring OAuth providers at startup. However,
the recommended approach is to use the Instance Settings UI.

When SSO is not enabled via Instance Settings, providers from the env var are registered
in Better Auth (so OAuth callbacks work) but are **not shown** on the login page. Enable
SSO in Instance Settings to make providers visible and functional.

## Production Deployment

### Secret management

SSO credentials (`clientSecret`) are stored in the database. For production:

- Use Paperclip's secrets provider (`PAPERCLIP_SECRETS_PROVIDER`) for encryption at rest when available
- Ensure database backups are encrypted

### Trusted origins

Better Auth validates the `Origin` header on auth requests. In `authenticated` mode, Paperclip automatically derives trusted origins from:

- `auth.publicBaseUrl` (when `auth.baseUrlMode` is `explicit`)
- `server.allowedHostnames` entries
- `BETTER_AUTH_TRUSTED_ORIGINS` env var (comma-separated)

Ensure your production domain is covered by one of these.

### HTTPS requirement

Production SSO deployments should use HTTPS. When `PAPERCLIP_PUBLIC_URL` starts with `https://`, Better Auth enables secure cookies. When it starts with `http://`, secure cookies are disabled (appropriate only for local development).

## Environment Variable Reference

| Variable                       | Description                              |
|--------------------------------|------------------------------------------|
| `PAPERCLIP_PUBLIC_URL`         | Base URL for callback URL construction   |
| `BETTER_AUTH_SECRET`           | Required for authenticated mode          |
| `BETTER_AUTH_TRUSTED_ORIGINS`  | Additional trusted origins (comma-separated) |
| `PAPERCLIP_SSO_PROVIDERS`      | Legacy: JSON array of SSO provider configs (use UI instead) |

## Technical Reference

### API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/auth/sso-providers` | GET | Returns configured provider metadata (no secrets); empty when SSO disabled |
| `/api/auth/sign-in/oauth2` | POST | Initiates SSO flow; body: `{ providerId, callbackURL }` |
| `/api/auth/oauth2/callback/{providerId}` | GET | OAuth2 callback; exchanges code for tokens |
| `/api/instance/settings/sso` | GET | Read SSO settings (instance admin) |
| `/api/instance/settings/sso` | PATCH | Update SSO settings and rebuild auth (instance admin) |

### Implementation files

| Layer | File | Role |
|---|---|---|
| Shared | `packages/shared/src/config-schema.ts` | `SsoProviderConfig` type and Zod validation |
| Server | `server/src/auth/better-auth.ts` | Better Auth instance, OAuth plugin wiring, dynamic rebuild via `BetterAuthManager` |
| Server | `server/src/app.ts` | SSO providers endpoint, auth handler proxy |
| Server | `server/src/routes/instance-settings.ts` | SSO settings CRUD, triggers auth rebuild on save |
| Server | `server/src/services/instance-settings.ts` | DB read/write for SSO settings |
| UI | `ui/src/api/auth.ts` | `getSsoProviders()`, `signInSso()` |
| UI | `ui/src/pages/Auth.tsx` | SSO button rendering |
