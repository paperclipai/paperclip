## Why

Paperclip's board (operator) sign-in currently relies on email/password plus opt-in 2FA. Operators in corporate environments need to sign in with their existing Google identity (SSO), either because their org enforces MFA via Google or because a Google-managed account is the only credential available. The Glory EV rental reverse-engineering (Obsidian: Projects/ev_group/reverse-engineer/google-sso/) documents a production-grade OAuth2 Authorization Code + PKCE pattern that maps directly onto the Better Auth stack Paperclip already uses. Better Auth v1.7.2 ships a built-in `google()` social-provider plugin, so we can add Google sign-in without a new auth system — protecting operator accounts while leaving agent/automation (API-key) logins, board-context logins, and cloud-tenant header auth untouched.

## What Changes

- New **optional Google SSO sign-in** for board operator accounts. An operator enables a Google client ID/secret in instance settings; thereafter the sign-in page offers a "Sign in with Google" button alongside email/password.
- OAuth2 Authorization Code flow with PKCE (S256), scopes `openid email profile`, `prompt=select_account` — matching the pattern validated in the Glory EV reference.
- Better Auth `google()` social-provider plugin handles the `/api/auth/sign-in/social` and `/api/auth/callback/google` routes, state/nonce management, and id_token verification out of the box.
- First-time Google login upserts the user by email (or sub) into the existing `auth_users` table; the user then needs an active company membership (or admin grant) to access a board.
- Open-redirect guard: Better Auth's `trustedOrigins` + `reject-redirects.ts` (already in the dependency tree) validate callback redirects; no unvalidated `return_to` is carried.
- Accounts that never enable SSO see zero behavior change. Agent API-key auth, board-context logins, and cloud-tenant header auth are unaffected.

## Capabilities

### New Capabilities
- `google-sso`: Optional Google OAuth2 sign-in for board operator accounts, including provider configuration, sign-in flow (Authorization Code + PKCE S256), first-time upsert, and session issuance consistent with the existing Better Auth session model.

### Modified Capabilities

## Impact

- **DB** — Better Auth's `authAccounts` table (already present, managed by drizzleAdapter) stores the social link per user/provider. No new tables required; `authAccounts` is already in the drizzleAdapter schema map.
- **Server** — `server/src/auth/better-auth.ts`: add `google()` to the Better Auth instance plugin list, wire the social-provider config (client ID/secret from env or instance settings), extend `trustedOrigins` to include the Google callback URL.
- **API** — Better Auth social-provider endpoints under `/api/auth`: `POST /sign-in/social` (Google), `GET /callback/google` (OAuth2 redirect target). No new custom endpoints.
- **UI** — sign-in page gains a "Sign in with Google" button when the Google provider is configured; the existing `authApi` client gains a `signInGoogle()` method that triggers the redirect flow.
- **Config** — new `PAPERCLIP_GOOGLE_CLIENT_ID` and `PAPERCLIP_GOOGLE_CLIENT_SECRET` env vars (or instance-settings entries) to enable the provider. Disabled by default; zero behavior change when unset.
- **Security** — Better Auth's `sensitiveSessionMiddleware` enforces trusted `Origin` on social sign-in routes (same as 2FA routes). PKCE S256 ensures the authorization code cannot be replayed without the server-held verifier. id_token verification (signature, `aud`, `iss`, `exp`, `nonce`) is handled by the plugin.

## Reference

- Obsidian: `Projects/ev_group/reverse-engineer/google-sso/` — 00-INDEX through 04-implementation.
- Better Auth docs: `social` plugin / `google()` provider.
- Existing pattern: `openspec/changes/add-two-factor-auth/` (same Better Auth plugin integration approach).
