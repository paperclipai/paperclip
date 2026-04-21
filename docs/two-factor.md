# Two-Factor Authentication

Paperclip supports optional **TOTP-based two-factor authentication (2FA)** for email/password sign-in. TOTP (Time-based One-Time Password) works with any authenticator app — Google Authenticator, 1Password, Authy, Bitwarden, Microsoft Authenticator, etc. — and requires no email or SMS infrastructure.

## For users

### Enabling 2FA

1. Go to **Settings → Security** (`/instance/settings/security`).
2. Click **Enable** on the "Two-factor authentication" card.
3. Confirm your password.
4. Scan the QR code with your authenticator app, or copy the setup key manually.
5. Enter the 6-digit code from your app to confirm.
6. Save the 10 backup codes shown. Each is usable once, for recovery if you lose your device. **They are not shown again.**

### Signing in with 2FA

After entering your email and password, you will be redirected to `/2fa`. Enter the 6-digit code from your authenticator app. You may check "Trust this device for 60 days" to skip the 2FA prompt on that browser.

If you've lost your authenticator app, click **Use a backup code instead** and enter one of your saved codes.

### Regenerating backup codes

On the Security settings page, enter your password and click **Regenerate backup codes**. Your old codes will stop working.

### Disabling 2FA

On the Security settings page, click **Disable** and confirm your password.

## For admins

The v1 implementation is **opt-in per user**. Admins cannot force enrollment in this release.

Enforcement toggles (instance-wide and per-company) are tracked as a follow-up. See [issue #4170](https://github.com/paperclipai/paperclip/issues/4170) for status.

## For operators / deployment

### Infrastructure

No new infrastructure is required. TOTP secrets and backup codes are stored in the `two_factor` table in the same Postgres database as Better Auth's existing tables.

### Migration

The 2FA schema is added by migration `0060_two_factor_auth.sql`:

- Adds `user.two_factor_enabled` (boolean, default false)
- Creates `two_factor` table (id, secret, backup_codes, user_id)

Existing users are unaffected — the column defaults to `false`.

### Configuration

No environment variables. The Better Auth `twoFactor` plugin is enabled by default in `server/src/auth/better-auth.ts`. The TOTP issuer defaults to `"Paperclip"`.

## Security notes

- TOTP secrets are stored server-side; clients never see another user's secret.
- Backup codes are one-time use and invalidated when regenerated.
- "Trust this device" uses Better Auth's session-level trusted-device tracking.
- Passwords are re-verified before enabling, disabling, or regenerating backup codes.

## Roadmap

The following are explicit follow-up items (not shipped in v1):

- **Email OTP** as a second-factor option (the `twoFactor` plugin supports this via `otpOptions.sendOTP`; installs with SMTP configured can plug this in).
- **SMS OTP** as a second-factor option.
- **Admin enforcement toggles** (instance-wide and per-company "Require 2FA for members").
- **WebAuthn / passkeys** as a second-factor option.

Contributions welcome.
