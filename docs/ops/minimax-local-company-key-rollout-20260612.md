# MiniMax Local company-wide key rollout — 2026-06-12

## Status

MiniMax Local is deployed and verified for Paperclip.

Verified runtime facts:

- Adapter: `minimax_local`
- Model: `MiniMax-M3`
- Provider: `minimax`
- Credential source: server-level `MINIMAX_API_KEY_FILE`
- Base URL: `https://api.minimax.io/v1`
- Live server image at capture time: `paperclip-prod:minimax-local-hostbuilt-startfix-20260612T170919Z`
- Git tag for this documentation update: `minimax-local-company-key-20260612T191814Z`

## Credential policy

Do not commit MiniMax API key material.

The production key lives in a server-mounted file:

```text
/paperclip/instances/default/companies/<company-id>/minimax-token-plan.key
```

The server environment provides:

```text
MINIMAX_API_KEY_FILE=/paperclip/instances/default/companies/<company-id>/minimax-token-plan.key
MINIMAX_BASE_URL=https://api.minimax.io/v1
```

## DB guard policy

Two runtime guards are installed in production:

- `paperclip_minimax_company_env_guard_tg`
- `paperclip_block_minimax_company_secret_ref_tg`

Purpose:

1. Keep `minimax_local` agent configs normalized to `MiniMax-M3`, the MiniMax base URL, fresh sessions, and safe workspace paths.
2. Strip per-agent `MINIMAX_API_KEY` / `MINIMAX_API_KEY_FILE` fields so the server-level key-file fallback is used.
3. Block stale `env.MINIMAX_API_KEY` secret bindings from overriding the known-good company key file.

## Validation evidence

- Direct wrapper smoke with the company key file returned `OK`.
- Customer Support Lead canary run `c792f16e-e1df-432e-a337-62bb142213be` succeeded on `minimax_local` / `MiniMax-M3`.
- Proof files are stored on the server under:

```text
/home/ubuntu/paperclip-safe-backups/safe-18claude-2codex-20260611T043019Z/
```

## Operational note

The UI can still display redacted credential placeholders. Do not persist placeholder credential values. For this deployment, MiniMax credentials are intentionally company/server-level, not per-agent.
