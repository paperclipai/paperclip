# Secrets, personal credentials, and proposals

Operators manage company secret references, users supply their own credentials where required, and reviewers decide proposed secret changes without exposing secret values in ordinary UI evidence.

Implementation: [secrets page](../ui/src/pages/Secrets.tsx), [personal secrets](../ui/src/pages/secrets/MyUserSecretsTab.tsx), [proposals](../ui/src/pages/secrets/ProposalsTab.tsx).

## Sub-features

- `company-secrets`: create/update secret references and control their bindings.
- `user-secrets`: define required user credentials and set a value for the current user.
- `proposals`: review proposed changes with the appropriate authority.
- `vault-import`: import eligible external-vault references through the offered flow.
- `runtime-delivery`: deliver only the secret references authorized for the run/actor.

## How to get to it (user POV)

### `secret-management`

Open company Settings → Secrets and the company/personal secret views.

### `proposal-import`

Use the Proposals tab or Import from vault where available.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use dummy credentials in an isolated company, two user identities, and a test agent. Never print actual secret values in evidence.

### `secret-management`

Automated: [secrets service](../server/src/__tests__/secrets-service.test.ts) and [user ownership](../server/src/__tests__/secrets-service-user-secret-owner-scoped.test.ts) cover storage/access contracts.

Manual: Create a dummy secret reference, bind it through a supported field, and verify its use in a harmless run without logging the value. Update it and reload. Switch users and confirm personal values remain owner-scoped and missing credentials produce an actionable state.

### `proposal-import`

Automated: [proposal routes](../server/src/__tests__/secret-proposals-routes.test.ts) and [vault import dialog](../ui/src/pages/secrets/ImportFromVaultDialog.test.tsx) cover route/UI layers; a real vault integration needs live validation.

Manual: Review a dummy proposal, reject one and accept another, then inspect the resulting reference state and history. Preview a vault import, select only disposable entries, and verify imported references and denied-access errors after reload.

## Gotchas

- A displayed reference name is not proof that the actor can resolve its value at runtime.
- Company secrets and user-specific values have different ownership.
- Redaction needs verification in errors, activity, and run logs as well as the form.
