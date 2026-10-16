## Purpose

Provides per-account, opt-in two-factor authentication for email/password sign-in so that a leaked password alone cannot grant board (operator) access to an agent company.

## ADDED Requirements

### Requirement: Two-factor enrollment
A board user with a valid password and an active session may enroll in two-factor authentication. Enrollment generates a TOTP secret and a set of one-time backup codes, and the account is only marked two-factor-enabled after the user verifies a code generated from the new secret.

#### Scenario: Enroll and verify
- **WHEN** an enabled user sends POST /api/auth/two-factor/enable with the password and method totp and then POST /api/auth/two-factor/verify-totp with a valid TOTP code
- **THEN** the enable response contains totpURI (base32 secret in an otpauth URI) and 10 backup codes, and after verification user.two_factor_enabled is true

#### Scenario: Invalid password is rejected
- **WHEN** a user calls enable with an incorrect password
- **THEN** the request fails with an auth error and no enrollment state is created

### Requirement: Sign-in interception when two-factor is enabled
When an account has two-factor enabled, a password-only sign-in must not issue a session.

#### Scenario: Password sign-in returns a challenge
- **WHEN** a two-factor-enabled user submits POST /api/auth/sign-in/email with correct credentials
- **THEN** the response is HTTP 200 with twoFactorRedirect true and twoFactorMethods listing totp and no session is issued

#### Scenario: TOTP verification completes sign-in
- **WHEN** the user completes the challenge with POST /api/auth/two-factor/verify-totp and a valid TOTP code
- **THEN** a session is issued and GET /api/auth/get-session returns it

#### Scenario: Accounts without two-factor are unaffected
- **WHEN** a user without two-factor enabled signs in with correct email and password
- **THEN** a session is issued normally and no challenge is returned

### Requirement: Backup codes
Enrollment issues 10 one-time backup codes that substitute for TOTP at the sign-in challenge.

#### Scenario: A backup code completes a sign-in challenge
- **WHEN** a gated user submits a valid unused backup code via POST /api/auth/verify-two-factor
- **THEN** the challenge completes, the code is consumed, and a session is issued

#### Scenario: A wrong backup code consumes quota and can lock the account
- **WHEN** a gated user repeatedly submits wrong codes via POST /api/auth/verify-two-factor
- **THEN** each failure consumes a backup code and failure accounting may lock the account until locked_until passes (plugin behavior)

### Requirement: Two-factor disable
A user may disable two-factor authentication by re-proving their password.

#### Scenario: Disable with password
- **WHEN** a user calls POST /api/auth/two-factor/disable with the correct password
- **THEN** two-factor is disabled, user.two_factor_enabled is false, and subsequent sign-ins are password-only

### Requirement: Opt-in scope and unaffected auth paths
Two-factor applies only to board accounts that opt in; agent/automation and board-context auth paths are unchanged.

#### Scenario: Agent API-key auth is unaffected
- **WHEN** an agent authenticates with a bearer API key (agent_api_keys)
- **THEN** no two-factor challenge is involved and access is governed by API-key auth and company scoping as before

#### Scenario: Mutating two-factor routes require trusted origin
- **WHEN** a two-factor mutating request (enable/verify/disable) is sent without a trusted Origin header
- **THEN** the request is rejected by the sensitive-session middleware (dev trusted origin is the app origin)

#### Scenario: TOTP codes follow RFC 6238
- **WHEN** a TOTP code is verified
- **THEN** it is verified per RFC 6238 (SHA-1, 6 digits, 30-second period, RFC-4648 base32 without padding) with a plus-or-minus 1 period window
