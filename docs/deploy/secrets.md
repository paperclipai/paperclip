---
title: Secrets Management
summary: Master key, encryption, and strict mode
---

Ironworks encrypts secrets at rest using a local master key. Agent environment variables that contain sensitive values (API keys, tokens) are stored as encrypted secret references.

## Default Provider: `local_encrypted`

Secrets are encrypted with a local master key stored at:

```
~/.ironworks/instances/default/secrets/master.key
```

This key is auto-created during onboarding. The key never leaves your machine.

## Configuration

### CLI Setup

Onboarding writes default secrets config:

```sh
pnpm ironworksai onboard
```

Update secrets settings:

```sh
pnpm ironworksai configure --section secrets
```

Validate secrets config:

```sh
pnpm ironworksai doctor
```

### Environment Overrides

| Variable | Description |
|----------|-------------|
| `IRONWORKS_SECRETS_MASTER_KEY` | 32-byte key as base64, hex, or raw string |
| `IRONWORKS_SECRETS_MASTER_KEY_FILE` | Custom key file path |
| `IRONWORKS_SECRETS_STRICT_MODE` | Set to `true` to enforce secret refs |

## Strict Mode

When strict mode is enabled, sensitive env keys (matching `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.

```sh
IRONWORKS_SECRETS_STRICT_MODE=true
```

Recommended for any deployment beyond local trusted.

## Migrating Inline Secrets

If you have existing agents with inline API keys in their config, migrate them to encrypted secret refs:

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

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
