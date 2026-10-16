## 1. Contract sync: twoFactorEnabled on the profile schema

- [x] 1.1 Add two_factor table + user.two_factor_enabled to packages/db/src/schema/auth.ts and export twoFactor from packages/db/src/schema/index.ts
- [x] 1.2 Generate guarded migration 0284_two_factor_auth.sql (IF NOT EXISTS / duplicate_object guard)
- [x] 1.3 Add twoFactorEnabled: z.boolean() to currentUserProfileSchema in packages/shared/src/validators/access.ts
- [x] 1.4 Add twoFactorEnabled to loadCurrentUserProfile in server/src/routes/auth.ts (read from the user row)
- [x] 1.5 Run pnpm -r typecheck to confirm the shared/server contract sync

## 2. UI auth client

- [x] 2.1 Add enableTotp(password), verifyTotp(code), disableTotp(password) to ui/src/api/auth.ts
- [x] 2.2 Update the signInEmail return type to surface twoFactorRedirect and twoFactorMethods
- [x] 2.3 Add unit tests in ui/src/api/auth.test.ts for the new methods

## 3. Sign-in TOTP step

- [x] 3.1 In ui/src/pages/Auth.tsx, when signInEmail returns twoFactorRedirect true, render a 6-digit TOTP input step instead of navigating away
- [x] 3.2 On successful verifyTotp, refetch the session (authApi.getSession) before routing
- [x] 3.3 Add a backup-code fallback link (POST /api/auth/verify-two-factor) in the TOTP step
- [x] 3.4 Add a visual test in ui/src/pages/Auth.test.tsx covering the gated sign-in flow

## 4. Settings: enroll / status / disable surface

- [x] 4.1 In ui/src/pages/ProfileSettings.tsx (or equivalent settings page), render 2FA status from the twoFactorEnabled flag on the current-user profile
- [x] 4.2 Enroll flow: call enableTotp, display totpURI (QR-style or copyable) and the 10 backup codes with a one-time-use warning
- [x] 4.3 Disable flow: call disableTotp(password), refresh profile flag
- [x] 4.4 Add a visual test covering the enroll and disable states

## 5. Verification and hand-off

- [x] 5.1 Live end-to-end: enable → verify → sign-in gated → verify → disable, confirm all 200s
- [x] 5.2 Run pnpm check:token-gates if any UI changes touch ui/src/components or ui/src/pages
- [x] 5.3 Run pnpm test:run (Vitest) on the affected packages before committing
- [ ] 5.4 Fill in the PR template (.github/PULL_REQUEST_TEMPLATE.md) including Model Used
