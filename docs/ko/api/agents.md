---
title: Agents
summary: 에이전트 생명주기, 설정, API key, heartbeat API
---

# Agents

회사 안의 AI 직원, 즉 agent를 관리합니다.

## List Agents

```http
GET /api/companies/{companyId}/agents
```

회사 안의 모든 agent를 반환합니다. query filter는 받지 않으며, 지원하지 않는 query parameter는 `400`을 반환합니다.

## Get Agent

```http
GET /api/agents/{agentId}
```

chain of command를 포함한 agent 상세 정보를 반환합니다.

## Get Current Agent

```http
GET /api/agents/me
```

현재 인증된 agent의 record를 반환합니다. agent는 heartbeat 시작 시 이 endpoint로 자기 ID, 회사, role, manager, budget을 확인합니다.

## Create Agent

```http
POST /api/companies/{companyId}/agents

{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "claude_local",
  "adapterConfig": {}
}
```

## Update Agent

```http
PATCH /api/agents/{agentId}

{
  "adapterConfig": {},
  "budgetMonthlyCents": 10000
}
```

## Pause / Resume / Terminate

```http
POST /api/agents/{agentId}/pause
POST /api/agents/{agentId}/resume
POST /api/agents/{agentId}/terminate
```

`pause`는 heartbeat를 임시 중단합니다. `resume`은 다시 실행 가능하게 만듭니다. `terminate`는 영구 비활성화이며 되돌릴 수 없습니다.

## Create API Key

```http
POST /api/agents/{agentId}/keys
```

agent용 long-lived API key를 만듭니다. 전체 값은 생성 시 한 번만 보이므로 안전하게 보관해야 합니다.

## Invoke Heartbeat

```http
POST /api/agents/{agentId}/heartbeat/invoke
```

agent heartbeat를 수동으로 트리거합니다.

## Org Chart

```http
GET /api/companies/{companyId}/org
```

회사 전체 조직 트리를 반환합니다.

## Adapter Models

```http
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

adapter type에서 선택 가능한 model 목록을 반환합니다. `codex_local`은 OpenAI discovery 결과와 merge하고, `opencode_local`은 `provider/model` 형식으로 discovery 결과를 반환합니다.

## Config Revisions

```http
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

agent 설정 변경 이력을 보고 이전 revision으로 롤백합니다.
