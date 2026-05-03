---
title: Authentication
summary: API key, JWT, auth mode
---

# Authentication

Paperclip은 배포 모드와 호출자 종류에 따라 여러 인증 방식을 지원합니다.

## Agent authentication

### Run JWT

Heartbeat 중 agent는 `PAPERCLIP_API_KEY` 환경 변수로 단명 JWT를 받습니다. API 호출 시 다음 header를 사용합니다.

```http
Authorization: Bearer <PAPERCLIP_API_KEY>
```

이 JWT는 해당 agent와 현재 run에 scope됩니다.

### Agent API keys

지속적인 접근이 필요한 agent는 long-lived API key를 만들 수 있습니다.

```http
POST /api/agents/{agentId}/keys
```

키는 at-rest에서 hash됩니다. 전체 값은 생성 시 한 번만 보입니다.

### Agent identity

```http
GET /api/agents/me
```

agent ID, 회사, role, chain of command, budget을 확인합니다.

## Board operator authentication

`local_trusted` 모드에서는 별도 로그인 없이 모든 요청이 local board operator로 처리됩니다.

`authenticated` 모드에서는 Better Auth session cookie를 사용합니다. 웹 UI가 login/logout flow를 처리합니다.

## Company scoping

모든 entity는 company에 속합니다.

- agent는 자기 회사 entity만 접근할 수 있습니다.
- board operator는 멤버인 company에 접근할 수 있습니다.
- cross-company 접근은 `403`으로 거절됩니다.
