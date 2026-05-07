---
title: Secrets Management
summary: Master key, encryption, and strict mode
---

Paperclip encrypts secrets at rest using a local master key. Agent environment variables that contain sensitive values (API keys, tokens) are stored as encrypted secret references.

## Default Provider: `local_encrypted`

Secrets are encrypted with a local master key stored at:

```
~/.paperclip/instances/default/secrets/master.key
```

This key is auto-created during onboarding. The key never leaves your machine.

## Configuration

### CLI Setup

Onboarding writes default secrets config:

```sh
pnpm paperclipai onboard
```

Update secrets settings:

```sh
pnpm paperclipai configure --section secrets
```

Validate secrets config:

```sh
pnpm paperclipai doctor
```

### Environment Overrides

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | 32-byte key as base64, hex, or raw string |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | Custom key file path |
| `PAPERCLIP_SECRETS_STRICT_MODE` | Set to `true` to enforce secret refs |

## Strict Mode

When strict mode is enabled, sensitive env keys (matching `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

Recommended for any deployment beyond local trusted.

## Migrating Inline Secrets

If you have existing agents with inline API keys in their config, migrate them to encrypted secret refs:

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## Rekeying the Local Master Key

Use the supported rekey command before replacing a `local_encrypted` master key that already has encrypted secret versions in the database. Directly replacing the key file makes existing versions undecryptable.

1. Stop Paperclip so no heartbeats or operators can create or rotate secrets during the rekey.
2. Back up the database and the current master key file.
3. Generate a new master key file in a permission-restricted location:

```sh
pnpm paperclipai secrets generate-local-master-key \
  --output ~/.paperclip/instances/default/secrets/master.key.next
```

4. Run a dry-run preflight. It decrypts existing local-encrypted versions with the old key and reports counts only:

```sh
pnpm paperclipai secrets rekey-local-master-key \
  --new-key-file ~/.paperclip/instances/default/secrets/master.key.next
```

5. Apply the rekey after confirming backups exist:

```sh
pnpm paperclipai secrets rekey-local-master-key \
  --new-key-file ~/.paperclip/instances/default/secrets/master.key.next \
  --apply \
  --confirm-backup \
  --activate-new-key
```

`--activate-new-key` backs up the previous active key file with a `.before-rekey-...` suffix, then replaces it with the new key after the database transaction commits. The command does not print secret values or key material.

Failure handling:

- If the dry run fails, keep the old key file and do not apply.
- If apply fails before activation, the database transaction rolls back and the old key still decrypts existing versions.
- If activation fails after a successful apply, install the `--new-key-file` contents as the active master key before restarting Paperclip.
- To roll back after a successful apply, restore both the database backup and the previous master key file backup as a pair.

After restart, run `pnpm paperclipai doctor` and start a heartbeat or resolve a known fake/test secret reference to confirm the instance can read encrypted versions.

## Secret References in Agent Config

Agent environment variables use secret references:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "8f884973-c29b-44e4-8ea3-6413437f8081",
      "version": "latest"
    }
  }
}
```

The server resolves and decrypts these at runtime, injecting the real value into the agent process environment.
