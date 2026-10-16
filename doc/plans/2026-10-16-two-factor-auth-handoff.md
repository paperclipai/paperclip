# Two-Factor Auth (TOTP + backup codes) — handoff

**Date:** 2026-10-16
**Status:** Backend complete + live-tested. UI layer outstanding.
**Branch:** `hermes/v2026.901.0-upgrade`

## What this is

Adds per-account, **opt-in** two-factor authentication to Paperclip sign-in,
using Better Auth's built-in `twoFactor()` plugin (TOTP + backup codes). When
a user enables 2FA, a password-only sign-in is intercepted and returns a
challenge instead of a session; the session is only issued after a valid TOTP
code or a one-time backup code is verified. Agent/automation (API-key) and
board-context logins are untouched — 2FA applies to email/password only, and
only once a user opts in.

## What is committed (this feature)

| File | Change |
|------|--------|
| `packages/db/src/schema/auth.ts` | `two_factor` table (`id`, `user_id` FK cascade, `secret`, `backup_codes`, `verified`, `failed_verification_count`, `locked_until`) + `user.two_factor_enabled` boolean default false |
| `packages/db/src/schema/index.ts` | export `twoFactor` |
| `packages/db/src/migrations/0284_two_factor_auth.sql` | guarded DDL (`IF NOT EXISTS` / `EXCEPTION WHEN duplicate_object`) so it replays safely on instances that already applied it under an earlier number |
| `packages/db/src/migrations/meta/_journal.json` | append idx 284 |
| `server/src/auth/better-auth.ts` | register `twoFactor({ issuer: "Paperclip" })`; add `twoFactor` to the drizzle adapter schema map; refactor plugin assembly into `buildBetterAuthPlugins(db, config)` so the two-factor plugin coexists with the managed-workspace handoff plugin |

## Verified live (running instance, port 3100)

```
sign-in/email            200   2FA off -> normal session
two-factor/enable        200   returns totpURI (base32 secret, 52 char) + 10 backup codes
two-factor/verify-totp   200   enrollment flips account to enabled
two-factor (re-sign-in)  200   twoFactorRedirect=TRUE, methods=["totp"]  <- sign-in now GATED
two-factor/verify-totp   200   challenge completed, new session
get-session              200   session established via 2FA
two-factor/disable       200   back to password-only
```

TOTP codes computed with an RFC-6238 implementation matching Better Auth's
exact verification (SHA-1, 6 digits, 30 s period, RFC-4648 no-padding base32,
±1 window). The plugin's `verify-totp` accepted the code and gated/ungated
sign-in accordingly.

## Endpoints (Better Auth twoFactor plugin, mounted under `/api/auth`)

- `POST /api/auth/two-factor/enable` — `{ password, method: "totp" }` → `{ totpURI, backupCodes[] }`
- `POST /api/auth/two-factor/verify-totp` — `{ code }` → completes enrollment or the sign-in challenge
- `POST /api/auth/two-factor/disable` — `{ password }` → `{ status: true }`
- Backup codes: `POST /api/auth/verify-two-factor` — `{ code }` (one-time use; a wrong code burns the backup codes and locks the account)

Sign-in interception: `POST /api/auth/sign-in/email` returns
`{ twoFactorRedirect: true, twoFactorMethods: ["totp"] }` (HTTP 200, no session)
when the account has 2FA enabled.

## Outstanding (UI layer — NOT done)

Per the repo Definition of Done ("contracts synced across db/shared/server/ui"),
the feature is not user-facing yet. Remaining:

1. `ui/src/api/auth.ts` — add `enable` / `verifyTotp` / `disable` client methods
2. `ui/src/pages/Auth.tsx` — 6-digit TOTP step shown when sign-in returns
   `twoFactorRedirect: true`
3. `ui/src/pages/ProfileSettings.tsx` — enroll / show status / disable surface
   (show `totpURI` + backup codes at enrollment; allow disable)
4. `packages/shared/.../access.ts` — expose `twoFactorEnabled` on the current-
   user profile schema so the UI can read enabled-state (today `GET /api/auth/profile`
   does not surface the flag)

Note: the shared profile schema does not yet include `twoFactorEnabled`, so the
settings page currently cannot read enabled-state — that is the first UI step.

## Constraints / guardrails

- Strictly opt-in: no behavior change for accounts that never enable 2FA.
- Better Auth's `sensitiveSessionMiddleware` enforces a trusted `Origin` on the
  two-factor mutating routes; dev trusted origin is the app origin
  (`http://127.0.0.1:3100`).
- A wrong backup code consumes a backup code and can lock the account (plugin
  behavior, not ours to change).
