---
title: Secrets Management
summary: Master key, encryption, strict mode
---

# Secrets Management

Paperclip은 local master key로 secret을 at-rest 암호화합니다. API key, token 같은 민감한 agent environment value는 encrypted secret reference로 저장하는 것이 원칙입니다.

## Default provider: `local_encrypted`

기본 master key 위치:

```text
~/.paperclip/instances/default/secrets/master.key
```

onboarding 중 자동 생성되며, key는 로컬 머신을 떠나지 않습니다.

## CLI setup

```sh
pnpm paperclipai onboard
pnpm paperclipai configure --section secrets
pnpm paperclipai doctor
```

## Environment overrides

| Variable | 설명 |
| --- | --- |
| `PAPERCLIP_SECRETS_MASTER_KEY` | base64/hex/raw 32-byte key |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | custom key file path |
| `PAPERCLIP_SECRETS_STRICT_MODE` | secret refs 강제 |

## Strict mode

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

strict mode에서는 `*_API_KEY`, `*_TOKEN`, `*_SECRET`에 matching되는 민감 env key가 inline plain value 대신 secret reference를 사용해야 합니다.

## Inline secret migration

```sh
pnpm secrets:migrate-inline-env
pnpm secrets:migrate-inline-env --apply
```

## Agent config reference

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
