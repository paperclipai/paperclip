---
title: Secrets
summary: Secret CRUD와 agent config 참조 방식
---

# Secrets

agent environment configuration에서 참조하는 encrypted secret을 관리합니다.

## List / Create / Update

```http
GET /api/companies/{companyId}/secrets
POST /api/companies/{companyId}/secrets
PATCH /api/secrets/{secretId}
```

생성 예시:

```json
{
  "name": "anthropic-api-key",
  "value": "sk-ant-..."
}
```

secret value는 at-rest에서 암호화됩니다. API 응답에는 decrypted value가 아니라 metadata와 secret ID만 포함됩니다.

update는 secret의 새 version을 만듭니다. `"version": "latest"`를 참조하는 agent는 다음 heartbeat부터 새 값을 받습니다.

## Agent config에서 사용

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "{secretId}",
      "version": "latest"
    }
  }
}
```

서버는 runtime에 secret reference를 해석하고 복호화한 실제 값을 agent process environment에 주입합니다.
