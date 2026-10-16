## Context

Better Auth already runs the board (operator) sign-in path; agent/automation logins use bearer API keys and board-context logins are a separate auth path. The backend commit (d07f93c71) landed the data model, db plugin registration, and guarded migration 0284. What remains is wiring the UI layer and exposing the enabled-state flag on the profile contract so the settings surface can read it.

Constraint: the Better Auth twoFactor plugin enforces trusted-Origin on its mutating routes via sensitiveSessionMiddleware; the dev trusted origin is the app origin (127.0.0.1:3100).

## Goals / Non-Goals

**Goals:**
- Opt-in, zero-friction for non-2FA users
- Enroll / verify / disable UI surfaces with a copyable backup-code display
- twoFactorEnabled flag exposed on GET /api/auth/profile so the UI can read state

**Non-Goals:**
- Changing agent API-key auth or board-context logins
- Pushing 2FA to all users (strictly opt-in)
- Changing Better Auth plugin behavior (failure accounting, lockout, code counts)

## Decisions

1. **Use Better Auth twoFactor plugin, not a hand-rolled TOTP module.** The plugin provides enrollment, TOTP verification, backup-code consumption, and lockout accounting out of the box. We register it with issuer "Paperclip" and add it to the drizzle adapter schema map so its two_factor table is created by the same guarded migration.

2. **buildBetterAuthPlugins(db, config) refactor.** Previously the managed-workspace handoff plugin and (now) twoFactor were assembled inline. Extracting the assembly lets them coexist without a fork in the plugin list and keeps future plugin additions to a single site.

3. **twoFactorEnabled on currentUserProfileSchema, not a separate endpoint.** The profile contract already flows through the auth client; adding one boolean keeps the UI read path to a single fetch. The flag is added to packages/shared/src/validators/access.ts and the server loadCurrentUserProfile picks it up from the user row.

4. **Guarded migration 0284.** Uses IF NOT EXISTS / EXCEPTION WHEN duplicate_object so it replays safely on instances that already applied it under an earlier number; matches the repo convention for additive DDL.

## Risks / Trade-offs

- **Account lockout via wrong backup codes.** A wrong backup code consumes one of the 10; repeated failures can lock the account until locked_until. This is plugin behavior, not ours to change, but the UI should make the one-time nature of backup codes explicit at enrollment.

- **Trusted-Origin coupling.** The two-factor mutating routes require a trusted Origin header. In dev this is 127.0.0.1:3100; in production it must match the deployed app origin. If an operator misconfigures this, 2FA enable/verify/disable will 403 with no TOTP step available.

- **UI contract drift risk.** The twoFactorEnabled flag must be added to currentUserProfileSchema in packages/shared before the UI settings surface can render. If the shared contract is updated after the UI commit, a stale type will cause a compile error; ordering matters.
