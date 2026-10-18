## 1. Server: Google SSO provider registration

- [x] 1.1 Add `buildGoogleSsoPlugin()` to `server/src/auth/better-auth.ts`: returns the Better Auth `google()` social provider (`better-auth/social-providers`) configured from the two Google SSO env vars documented in `specs/google-sso/spec.md`, with scopes `openid email profile` and prompt `select_account`; returns `undefined` when either env var is unset. Verify: `pnpm -r typecheck` passes with no new deps.
- [x] 1.2 Wire `buildBetterAuthPlugins()` to include the Google plugin when present, with a doc comment explaining the conditional registration (unregistered provider means Better Auth's catch-all handler 404s `/api/auth/sign-in/social` for google and `/api/auth/callback/google`). Verify: `pnpm -r typecheck` passes.
- [x] 1.3 Add tests in `server/src/__tests__/better-auth.test.ts`: (a) env vars unset = plugin list has no `google` entry; (b) both env vars set = plugin list includes a `google` provider with S256 PKCE and the `openid email profile` scopes. Verify: targeted vitest run passes.

## 2. Server: provider discovery endpoint

- [x] 2.1 Add `GET /api/auth/providers` to `server/src/routes/auth.ts` (public, no auth gate): returns `{ ssoProviders: ["google"], googleSsoEnabled: true }` when the Google provider is registered (both env vars set), else `{ ssoProviders: [], googleSsoEnabled: false }`. Export a small `isGoogleSsoEnabled()` helper from `server/src/auth/better-auth.ts` as the shared source of truth. Verify: `pnpm -r typecheck` passes.
- [x] 2.2 Add a route test for `GET /api/auth/providers` covering the enabled/disabled env states (public: reachable without a session). Verify: targeted vitest run passes.

## 3. UI: auth API client

- [x] 3.1 Add `getProviders()` (GET `/api/auth/providers`) and `signInGoogle({ successRedirectUrl })` (POST `/api/auth/sign-in/social` with `providerId: "google"`, following the redirect `Location` to `/api/auth/callback/google`) to `ui/src/api/auth.ts`, with types. Verify: `pnpm -r typecheck` passes.
- [x] 3.2 Add unit tests in `ui/src/api/auth.test.ts` for `getProviders()` response normalization and `signInGoogle()` POST body/redirect handling. Verify: ui vitest run passes.

## 4. UI: sign-in page integration

- [x] 4.1 Add `isSafeReturnTo(value)` helper (accept only single-leading-`/` relative paths; reject `//`, backslash, protocol-relative, `javascript:`, and absolute URLs) plus unit tests covering the spec's reject cases. Verify: unit test passes.
- [x] 4.2 In `ui/src/pages/Auth.tsx` (sign-in mode only): fetch providers, and when Google SSO is enabled show a "Sign in with Google" button that calls `authApi.signInGoogle({ successRedirectUrl: isSafeReturnTo(nextPath) ? nextPath : "/" })`; show an error banner when returned with `google_error=callback_failed`. Verify: page test asserts button visibility driven by the providers query and the click behavior; `pnpm check:token-gates` passes for the UI change.

## 5. Verification and hand-off

- [x] 5.1 Run `pnpm -r typecheck`, targeted `pnpm test:run` for server + ui, `pnpm build`, and `pnpm check:token-gates`; report anything not run and why (full Google round-trip e2e requires real Google credentials; report as not run).
- [x] 5.2 Update docs: document the Google SSO env vars (and the new endpoint + sign-in button) in `doc/DEVELOPING.md` and `doc/SPEC-implementation.md` where the auth section lives. Verify: grep finds the env vars in both docs.
- [ ] 5.3 Fill in the PR template (`.github/PULL_REQUEST_TEMPLATE.md`) including Model Used.
