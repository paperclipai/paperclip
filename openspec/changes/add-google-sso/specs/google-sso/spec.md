## Purpose

Provides optional Google SSO sign-in for board operator accounts so that operators in corporate environments can authenticate with their existing Google identity. When enabled via `PAPERCLIP_GOOGLE_CLIENT_ID` and `PAPERCLIP_GOOGLE_CLIENT_SECRET`, the sign-in page offers a "Sign in with Google" button. The flow uses OAuth2 Authorization Code + PKCE S256, issues a Better Auth session cookie on success, and upserts the user by Google `sub` on first login.

## ADDED Requirements

### Requirement: Google SSO provider configuration
Google SSO is optional and per-instance. It is enabled only when both `PAPERCLIP_GOOGLE_CLIENT_ID` and `PAPERCLIP_GOOGLE_CLIENT_SECRET` are set in the server environment. When either is unset, the Google SSO provider is not registered, the sign-in button is not rendered, and the callback route is not registered.

#### Scenario: Provider is not registered when env vars are unset
- **WHEN** the server starts without `PAPERCLIP_GOOGLE_CLIENT_ID` set
- **THEN** the Better Auth instance does not register the Google social provider, the sign-in page does not show a Google button, and `GET /api/auth/callback/google` returns 404

#### Scenario: Provider is registered when both env vars are set
- **WHEN** the server starts with `PAPERCLIP_GOOGLE_CLIENT_ID` and `PAPERCLIP_GOOGLE_CLIENT_SECRET` both set to valid values
- **THEN** the Better Auth instance registers the Google social provider, the sign-in page shows a "Sign in with Google" button, and `GET /api/auth/callback/google` is registered

### Requirement: Google sign-in flow (Authorization Code + PKCE S256)
A user who clicks "Sign in with Google" is redirected to Google's OAuth2 authorization endpoint with `response_type=code`, `code_challenge_method=S256`, scopes `openid email profile`, and `prompt=select_account`. After the user consents, Google redirects back to `/api/auth/callback/google` with a `code` and `state` query param.

#### Scenario: Successful Google sign-in
- **WHEN** a user clicks "Sign in with Google", completes the Google consent screen, and Google redirects to `/api/auth/callback/google?code=...&state=...`
- **THEN** the server exchanges the code for an `id_token`, verifies the token (signature, `aud`, `iss`, `exp`, `nonce`), upserts the user, issues a Better Auth session cookie, and redirects to the app root or a validated `return_to` destination

#### Scenario: Callback without a valid state fails
- **WHEN** `GET /api/auth/callback/google` is called with a `state` that does not match the server-held in-flight state, or no state is present
- **THEN** the callback redirects to the sign-in page with a `?google_error=callback_failed` query param and no session is issued

#### Scenario: PKCE verifier mismatch is rejected
- **WHEN** the token exchange is attempted with a `code_verifier` that does not match the `code_challenge` sent to Google
- **THEN** Google returns an error and the callback redirects to the sign-in page with `?google_error=callback_failed`

### Requirement: First-time user upsert
On the first successful Google sign-in for a Google `sub` that has no existing `auth_users` row, a new `auth_users` row is created. The Google social link is stored in `authAccounts` with `provider: "google"`.

#### Scenario: New Google user is created
- **WHEN** a Google user with a `sub` that has no `auth_users` row completes a successful sign-in
- **THEN** a new `auth_users` row is created (populated from the `id_token` `email`, `name`, and `picture` claims), and an `authAccounts` row links the user to the Google `sub`

#### Scenario: Existing user with same email is linked
- **WHEN** a Google user with a `sub` that has no `auth_users` row but whose `email` matches an existing `auth_users` row completes a successful sign-in
- **THEN** the existing `auth_users` row is reused and a new `authAccounts` row links it to the Google `sub`; the user does not get a duplicate account

#### Scenario: User signs in again with the same Google account
- **WHEN** a Google user who already has an `authAccounts` row with `provider: "google"` completes a sign-in
- **THEN** the existing user and account are reused; no new rows are created

### Requirement: Company membership requirement
Signing in with Google does not auto-grant company membership. After a successful Google sign-in, the user must have an active `company_memberships` row (or an instance-admin role) to access any company board.

#### Scenario: New Google user without membership sees no board
- **WHEN** a user completes a first-time Google sign-in and has no active `company_memberships` row
- **THEN** the session is valid but the user is shown a "no active company" state (or redirected to a join-request flow), not a company board

#### Scenario: Existing member signs in with Google
- **WHEN** a user who already has an active `company_memberships` row signs in with Google (via the same email)
- **THEN** the user's session includes the same company access as before, and no membership change is made

### Requirement: Open-redirect guard
The `return_to` query param on the sign-in request is validated before being carried through the OAuth2 flow. Only relative paths beginning with a single `/` are accepted; `//`, `:`, `\`, and absolute URLs are rejected.

#### Scenario: Valid return_to is carried through
- **WHEN** a user initiates a Google sign-in with `?return_to=/companies/abc123`
- **THEN** after a successful callback, the user is redirected to `/companies/abc123`

#### Scenario: Open-redirect attempt is rejected
- **WHEN** a user initiates a Google sign-in with `?return_to=//evil.com` or `?return_to=https://evil.com`
- **THEN** the `return_to` is rejected (falls back to the app root) and the user is not redirected to the external URL

### Requirement: Unaffected auth paths
Google SSO is additive. All existing auth paths are unchanged when Google SSO is enabled.

#### Scenario: Email/password sign-in is unaffected
- **WHEN** Google SSO is enabled and a user signs in with email and password
- **THEN** the sign-in succeeds exactly as before; no Google-specific logic is involved

#### Scenario: 2FA challenge is unaffected
- **WHEN** Google SSO is enabled and a 2FA-enabled user signs in with Google
- **THEN** the Google sign-in issues a session directly (2FA is not applied to social sign-in by default in Better Auth; this is a documented trade-off — 2FA applies to email/password sign-in only)

#### Scenario: Agent API-key auth is unaffected
- **WHEN** Google SSO is enabled and an agent authenticates with a bearer API key (`agent_api_keys`)
- **THEN** the auth path is unchanged; no Google-specific logic is involved

#### Scenario: Board API-key auth is unaffected
- **WHEN** Google SSO is enabled and a board key is used for board-context login
- **THEN** the auth path is unchanged; no Google-specific logic is involved

#### Scenario: Cloud tenant header auth is unaffected
- **WHEN** Google SSO is enabled and a cloud tenant request carries `x-paperclip-cloud-*` headers
- **THEN** the trusted-header auth path is unchanged; no Google-specific logic is involved

### Requirement: Session issuance
On successful Google sign-in, a Better Auth session cookie is issued. The session is equivalent to one issued via email/password sign-in.

#### Scenario: Session cookie is set after Google sign-in
- **WHEN** a user completes a successful Google sign-in
- **THEN** a Better Auth session cookie (HttpOnly, Secure, SameSite=Lax, prefixed `paperclip-<instanceId>`) is set, and subsequent `GET /api/auth/get-session` requests return the session

#### Scenario: Session is invalidated on sign-out
- **WHEN** a user who signed in with Google signs out
- **THEN** the Better Auth session is revoked and `GET /api/auth/get-session` returns 401

### Requirement: Trusted-Origin enforcement on social sign-in routes
The social sign-in and callback routes are protected by Better Auth's `sensitiveSessionMiddleware`, which enforces a trusted `Origin` header on mutating requests.

#### Scenario: Social sign-in with valid Origin succeeds
- **WHEN** a social sign-in request is sent with a trusted `Origin` header matching the app origin
- **THEN** the request is processed normally

#### Scenario: Social sign-in without a trusted Origin is rejected
- **WHEN** a social sign-in request is sent without a trusted `Origin` header (or with a non-trusted origin)
- **THEN** the request is rejected with a 403 by the `sensitiveSessionMiddleware`
