## Why

Paperclip sign-in currently relies on a single email/password credential, and board access is treated as full-control operator context. A stolen or leaked password therefore grants immediate, unimpeded control of an agent company. Better Auth ships a battle-tested `twoFactor()` plugin (TOTP + one-time backup codes), so we can add opt-in two-factor authentication without a new auth system — protecting operator accounts while leaving agent/automation (API-key) logins and board-context logins untouched.

## What Changes

- New **opt-in two-factor (TOTP) sign-in** for email/password board accounts. When a user enables 2FA, a password-only sign-in is intercepted and returns a challenge; a session is only issued after a valid TOTP code or one-time backup code is verified.
- Enrollment flow: enable → user proves possession of the authenticator → account flips to 2FA-enabled.
- Disable flow: password-gated deactivation, restoring password-only sign-in.
- Backup codes: 10 one-time codes issued at enrollment; each wrong use consumes a code and the account can be locked by the plugin's failure accounting.
- Accounts that never opt in see zero behavior change. Agent API-key auth and board-context logins are unaffected.

## Capabilities

### New Capabilities
- `two-factor-auth`: Opt-in TOTP two-factor authentication for email/password sign-in, including enrollment, sign-in challenge verification (TOTP and backup codes), backup-code lifecycle, and disable.

### Modified Capabilities

## Impact

- **DB** — new `two_factor` table (`secret`, `backup_codes`, `verified`, `failed_verification_count`, `locked_until`) and `user.two_factor_enabled` boolean (default false); guarded migration `0284_two_factor_auth.sql`.
- **Server** — `server/src/auth/better-auth.ts`: registers `twoFactor({ issuer: "Paperclip" })`, adds `twoFactor` to the drizzle adapter schema map, and refactors plugin assembly into `buildBetterAuthPlugins(db, config)` so 2FA coexists with the managed-workspace handoff plugin.
- **API** — new Better Auth endpoints under `/api/auth`: `POST /two-factor/enable`, `POST /two-factor/verify-totp`, `POST /two-factor/disable`, `POST /verify-two-factor` (backup codes). `POST /sign-in/email` gains a `twoFactorRedirect: true` + `twoFactorMethods: ["totp"]` response shape when the account is gated.
- **Security** — Better Auth's `sensitiveSessionMiddleware` enforces a trusted `Origin` on the two-factor mutating routes; dev trusted origin is the app origin.
- **Out of scope (UI)** — the UI layer (auth client methods, sign-in TOTP step, settings enroll/disable surface, `twoFactorEnabled` on the profile contract) is tracked in this change's task list; the backend is committed and live-tested (enable → verify → sign-in-gated → verify → disable, all HTTP 200).
