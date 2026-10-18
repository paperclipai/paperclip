## Context

Paperclip's board sign-in is built on Better Auth v1.7.2 (`server/src/auth/better-auth.ts`), already wired to the drizzle adapter with the `auth_users`/`auth_sessions`/`auth_accounts`/`auth_verifications`/`two_factor` tables and the `twoFactor()` plugin. Better Auth's catch-all handler is mounted at `/api/auth/{*authPath}` (`server/src/app.ts:664`), so any route the auth instance registers is automatically served. Better Auth ships a built-in `google()` social provider (`better-auth/social-providers`) on top of its generic OAuth core: `POST /sign-in/social` (with `providerId: "google"`) initiates the OAuth2 Authorization Code + PKCE flow, and `GET /callback/google` completes it, exchanging the code, verifying the `id_token` (signature, `iss`, `aud`, `exp`, `nonce`), upserting the user, and linking the account row.

The sign-in page (`ui/src/pages/Auth.tsx`) is currently email/password-only (plus a 2FA TOTP step and a cloud-tenant variant). It has no way to know which social providers are enabled on the server.

Constraints:
- Better Auth's social sign-in endpoints are registered only for providers present in the instance's plugin list at construction time — there is no runtime on/off toggle.
- The Better Auth handler catches all `/api/auth/*` paths, so "not registered" surfaces as Better Auth's own 404/400 response, not a route we must register.
- Trusted-origin enforcement (`trustedOrigins` + sensitive-session middleware) is already in place for the whole handler.

## Goals / Non-Goals

**Goals:**
- Enable Google SSO with two env vars; zero behavior change when unset.
- Sign-in page offers "Sign in with Google" only when the provider is enabled, and the social sign-in/clear-flow redirects through the Better Auth core endpoints.
- First-time upsert by Google `sub` with email-based linking into existing `auth_users` rows, stored in `authAccounts`.
- Feature discovery: the UI learns whether Google SSO is enabled through the API (both UI and APIs are in scope).
- Existing auth paths (email/password, 2FA, agent API keys, board keys, cloud-tenant headers) are unchanged.

**Non-Goals:**
- No Google SSO for agent/API-key auth or cloud-tenant header auth.
- No instance-settings UI for the client ID/secret in v1 (env vars only; instance-settings entries are a future extension).
- No `hd` (hosted-domain) restriction in v1.
- No 2FA step on the social sign-in path (Better Auth default; documented trade-off in the spec).
- No new DB tables — `authAccounts` is already in the drizzle adapter schema map.

## Decisions

1. **Conditional plugin registration via env vars** — `server/src/auth/better-auth.ts` gains `buildGoogleSsoPlugin()`: returns the `google()` plugin when both `PAPERCLIP_GOOGLE_CLIENT_ID` and `PAPERCLIP_GOOGLE_CLIENT_SECRET` are non-empty, otherwise `undefined`. `buildBetterAuthPlugins` includes it when present.
   - *Why not instance settings:* the auth instance is built once at startup before settings services exist; env vars keep the "no behavior change when unset" guarantee trivially true and match how `BETTER_AUTH_SECRET` is already sourced.
   - *Alternative considered:* always register the plugin with a guard inside the sign-in handler — rejected, because Better Auth's route table is static per instance and the spec requires `GET /api/auth/callback/google` to 404 when the provider is not registered.

2. **Provider options** — `google({ clientId, clientSecret, scopes: ["openid","email","profile"], prompt: "select_account" })` via the `additionalParams`/`ProviderOptions` surface of the 1.7.2 provider. PKCE S256 is the generic-OAuth core's default (code-verifier state is held in the session cookie); `id_token` verification (signature/iss/aud/exp/nonce) is the plugin's built-in `idToken` block. `hd` is not set (future option).
   - *Why S256:* the spec fixes it; the core OAuth2 flow in this version of Better Auth issues the code verifier and stores it in the `state` cookie, so no extra work is needed.

3. **UI feature discovery: dedicated `GET /api/auth/providers` endpoint** (new route in `server/src/routes/auth.ts`), returning `{ googleSsoEnabled: boolean, ssoProviders: ["google"] | [] }`.
   - *Why not health:* the health endpoint's shape is shared across cloud/managed/local surfaces and has visibility rules; a small public endpoint on the auth router matches the existing `authRoutes(db)` mount (`/api/auth`) and is easy to test. It is public (pre-auth) by design — it reveals only the *existence* of a provider, never its configuration.
   - The UI calls `authApi.getProviders()` (`ui/src/api/auth.ts`); when `googleSsoEnabled` is true and the mode is `sign_in`, the Auth page renders a "Sign in with Google" button that `POST /api/auth/sign-in/social` with `{ providerId: "google", callbackURL, successRedirectURL }` via fetch and follows the redirect (`Location`), then reloads the session on return.

4. **Post-callback session pickup** — the sign-in page already re-queries `authApi.getSession()` (existing `queryKeys.auth.session` query) and navigates to `nextPath` when a session exists, so the redirect back from Google lands on the sign-in URL, the callback sets the session cookie, and the running page completes without a full-page reload of the app shell. The button handler also preserves `return_to`/`next` in `successRedirectURL` so the existing `tenantSignInReturnPath` logic applies.

5. **Open-redirect guard on `return_to`/`successRedirectURL`** — a small exported helper `isSafeReturnTo(value)` (single leading `/`, rejects `//`, `\`, protocol-relative `:`, `javascript:`, and any absolute URL) in `ui/src/lib/google-sso.ts` (or colocated in the auth api module). The UI applies it before building the social sign-in body; the server-side callback already validates redirects via Better Auth's `trustedOrigins`/safe-URL handling, so a rejected `return_to` falls back to `/`.
   - *Alternative considered:* server-side query-param pass-through — rejected because Better Auth's built-in flow does not carry a custom `return_to` through the `state` cookie; the UI-side redirect to `successRedirectURL` after session pickup is the sanctioned path.

6. **Tests** — server: plugin registration matrix in `server/src/__tests__/better-auth.test.ts` (unset → no plugin; both set → `google` plugin present, `id: "google"`, S256 verifier configured); new route test for `GET /api/auth/providers` (public, reflects env). UI: `ui/src/api/auth.test.ts` for `getProviders()` + `signInGoogle()`, and an `Auth` page test asserting button visibility is driven by the providers query and that clicking triggers the social sign-in POST. A unit test for `isSafeReturnTo` covering the spec's reject cases.

## Risks / Trade-offs

- **2FA not enforced on social sign-in** (Better Auth default) → mitigated by documenting it in the spec + operator docs; 2FA still guards the email/password path, and an operator who needs MFA-only sign-in gets it from Google itself.
- **Env-var-only configuration** → no hot-reload; operator must restart the server to change credentials. Accepted for v1; settings-based config is a follow-up.
- **`authAccounts` upsert semantics depend on Better Auth's email-linking** (same email → link to existing user) → verified against the 1.7.2 source; no schema change needed. Risk: an attacker knowing a victim's email plus a Google account with that email could link to the existing user — inherent to the "existing user with same email is linked" requirement; the spec accepts it (Google verified-email is a trust boundary Google enforces).
- **Callback 404 shape** when the provider is unregistered is Better Auth's own error (not our 404) → acceptable; the spec only requires "not registered", and the UI never renders the button in that state.
- **PKCE state replay across tabs** → state is random per sign-in and cookie-scoped per instance prefix; no change needed.

## Migration Plan

No data migration: no schema changes (`authAccounts` already exists and is mapped). Rollback = unset the two env vars and restart; existing Google-linked accounts remain in the DB and keep working via email/password.

## Open Questions

None — the provider-options surface (scopes/prompt/PKCE) and the discovery endpoint are fixed by this design; the spec's requirements are all covered by tasks below.
