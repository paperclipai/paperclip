---
navigation: {"section":"Getting started and access","sectionOrder":10,"order":20}
---

# Login, invitations, and access

People and agents enter the correct instance and company with the permissions granted to their identity. Login, membership, resource access, and CLI authorization have separate controls.

Implementation: [auth page](../../ui/src/pages/Auth.tsx), [company members](../../ui/src/pages/CompanyAccess.tsx), [invitation](../../ui/src/pages/InviteLanding.tsx).

Agent access: [companion](../agent-access-map/access.md).

## Sub-features

- `login`: sign in or claim the board in the configured deployment mode.
- `invitations`: join through a valid invite and handle expired or already-used links.
- `membership`: review join requests and manage company/instance membership and permissions.
- `resources`: respect company and resource boundaries on deep links and mutations.
- `cli-auth`: authorize a CLI session and revoke or replace credentials.

## How to get to it (user POV)

### `login`

Open `/auth`; first-owner bootstrap uses `/board-claim/:token` when configured.

### `invite-members`

Open `/invite/:token`; operators manage members in company settings and join requests at `/inbox/requests`.
Create/revoke human links at Members → Invites
(`/company/settings/members?tab=invites`). Human invitees receive the chosen
role after sign-in; agent invitations still use join-request approval.

### `cli-authorization`

Start the CLI auth/connect flow and approve its `/cli-auth/:id` browser page; instance access is under Settings when visible.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). For login tests use authenticated mode and two test users; local-trusted mode does not prove session enforcement. Use two companies for isolation checks.

### `login`

Automated: [auth UI](../../ui/src/pages/Auth.test.tsx) and [session routes](../../server/src/__tests__/auth-session-route.test.ts) cover their respective layers.

Manual: Sign in, reload a company deep link, sign out, and revisit it. Confirm the browser requests authentication rather than showing cached company data. Test an invalid claim separately on disposable state.

### `invite-members`

Automated: [member UI](../../ui/src/pages/CompanyAccess.test.tsx) and [invite replay](../../server/src/__tests__/invite-accept-replay.test.ts) provide component and route evidence.

Manual: Accept an invite as the intended user, inspect the resulting company and permissions, then reuse and expire disposable invites. Change a member permission, reload as that member, and verify a denied operation on another company remains denied.

### `cli-authorization`

Automated: [board auth client](../../cli/src/__tests__/board-auth.test.ts) and [token commands](../../cli/src/__tests__/token.test.ts) cover the client contracts.

Manual: Authorize the intended CLI context, make a read-only company request, then revoke its token and retry. Verify failure is explicit and does not silently fall back to another identity.

Use `auth login`, `auth whoami`, and `auth revoke-current` with explicit context.
Retry with the same bearer to prove revocation; deleting local credentials with
logout alone does not establish that server revocation succeeded.

## Gotchas

- Settings visibility is not authorization; direct requests still need permission checks.
- An agent bearer key must not gain another company’s access.
- Never put invite tokens, session cookies, or API keys in verification evidence.

### Storybook verification

#### `login`

Scope: ui
Storybook: Sign-in form, pending and invalid credentials, deployment-mode claim gate, expired claim.
Production: Authenticate and reload company deep link; sign out and confirm session enforcement; reject invalid bootstrap claim.
Sources: Source: [Auth.tsx](../../ui/src/pages/Auth.tsx), [BoardClaim.tsx](../../ui/src/pages/BoardClaim.tsx), [board-claim.ts](../../server/src/board-claim.ts). Tests: [Auth.test.tsx](../../ui/src/pages/Auth.test.tsx), [auth-session-route.test.ts](../../server/src/__tests__/auth-session-route.test.ts), [board-claim.test.ts](../../server/src/__tests__/board-claim.test.ts)

#### `membership`

Scope: ui
Storybook: Member and join-request lists; editable versus read-only roles; pending change, rejected request, revoked invite.
Production: Persist role/membership changes; enforce actual actor authority, invite replay/expiry and cross-company denial.
Sources: Source: [CompanyAccess.tsx](../../ui/src/pages/CompanyAccess.tsx), [authz.ts](../../server/src/routes/authz.ts). Tests: [CompanyAccess.test.tsx](../../ui/src/pages/CompanyAccess.test.tsx), [invite-accept-replay.test.ts](../../server/src/__tests__/invite-accept-replay.test.ts), [multi-user-authenticated.spec.ts](../../tests/e2e/multi-user-authenticated.spec.ts)

#### `cli-auth`

Scope: ui
Storybook: CLI authorization approval, pending, expired/denied and already-authorized states.
Production: Authorize intended CLI identity/context, make scoped request, revoke current server token and retry same bearer; logout alone is insufficient.
Sources: Source: [CliAuth.tsx](../../ui/src/pages/CliAuth.tsx). Tests: [cli-auth-routes.test.ts](../../server/src/__tests__/cli-auth-routes.test.ts), [board-auth.test.ts](../../cli/src/__tests__/board-auth.test.ts), [token.test.ts](../../cli/src/__tests__/token.test.ts)
