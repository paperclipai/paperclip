---
navigation: {"section":"Apps, channels, and extensions","sectionOrder":50,"order":50}
---

# Secrets and proposals

Operators manage company secret references, users supply their own credentials where required, and reviewers decide proposed secret changes without exposing secret values in ordinary UI evidence.

Implementation: [secrets page](../../ui/src/pages/Secrets.tsx), [personal secrets](../../ui/src/pages/secrets/MyUserSecretsTab.tsx), [proposals](../../ui/src/pages/secrets/ProposalsTab.tsx).

Agent access: [companion](../agent-access-map/secrets.md).

## Sub-features

- `company-secrets`: create/update secret references and control their bindings.
- `user-secrets`: define required user credentials and set a value for the current user.
- `proposals`: review proposed changes with the appropriate authority.
- `vault-import`: import eligible external-vault references through the offered flow.
- `runtime-delivery`: deliver only the secret references authorized for the run/actor. Agent-owned instance secrets stay in the trusted server runtime and are never delivered to an agent.

## How to get to it (user POV)

### `secret-management`

Open company Settings → Secrets and the company/personal secret views.

### `proposal-import`

Use the Proposals tab or Import from vault where available.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use dummy credentials in an isolated company, two user identities, and a test agent. Never print actual secret values in evidence.

### `secret-management`

Automated: [secrets service](../../server/src/__tests__/secrets-service.test.ts) and [user ownership](../../server/src/__tests__/secrets-service-user-secret-owner-scoped.test.ts) cover storage/access contracts. [Instance-secret tests](../../server/src/__tests__/agent-instance-secrets.test.ts) cover local encrypted storage, owner isolation, and exclusion from ordinary bindings.

Manual: Create a dummy secret reference, bind it through a supported field, and verify its use in a harmless run without logging the value. Update it and reload. Switch users and confirm personal values remain owner-scoped and missing credentials produce an actionable state.

### `proposal-import`

Automated: [proposal routes](../../server/src/__tests__/secret-proposals-routes.test.ts) and [vault import dialog](../../ui/src/pages/secrets/ImportFromVaultDialog.test.tsx) cover route/UI layers; a real vault integration needs live validation.

Manual: Review a dummy proposal, reject one and accept another, then inspect the resulting reference state and history. Preview a vault import, select only disposable entries, and verify imported references and denied-access errors after reload.

## Gotchas

- Vault import currently targets eligible AWS Secrets Manager providers.
  Organization-secret checks in local-trusted mode do not establish two-user
  personal-secret ownership or actual external-vault import.

- A displayed reference name is not proof that the actor can resolve its value at runtime.
- Company secrets and user-specific values have different ownership.
- Redaction needs verification in errors, activity, and run logs as well as the form.

### Storybook verification

#### `proposals`

Scope: ui
Storybook: Mount ProposalsTab pending secret/binding proposals, blocked authority, expired/resolved proposal, approval/rejection pending/error, and redacted metadata.
Production: GET /companies/{id}/secret-proposals and POST approve/reject must enforce company/admin/target authority, durable resolution and redaction; verified run-bound agent proposal creation is separate.
Sources: Source: [ProposalsTab.tsx](../../ui/src/pages/secrets/ProposalsTab.tsx), [secrets.ts](../../server/src/routes/secrets.ts), [secret-proposal-authorization.ts](../../server/src/services/secret-proposal-authorization.ts). Tests: [ProposalsTab.render.test.tsx](../../ui/src/pages/secrets/ProposalsTab.render.test.tsx), [secret-proposals-routes.test.ts](../../server/src/__tests__/secret-proposals-routes.test.ts)

### Documentation scope: Secrets and secret proposals

Company/user/proposal/vault and runtime-binding paths are mapped; every secret provider, rotation scenario, and delivery context needs separate validation.
