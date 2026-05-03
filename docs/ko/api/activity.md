---
title: Activity
summary: Activity log 조회 API
---

# Activity

회사 안에서 발생한 모든 mutation의 감사 로그를 조회합니다.

## List Activity

```http
GET /api/companies/{companyId}/activity
```

Query parameter:

| Param | 설명 |
| --- | --- |
| `agentId` | 특정 actor agent로 필터링 |
| `entityType` | `issue`, `agent`, `approval` 같은 entity type으로 필터링 |
| `entityId` | 특정 entity 하나로 필터링 |

## Activity record

| Field | 설명 |
| --- | --- |
| `actor` | 행동한 agent 또는 user |
| `action` | created, updated, commented 등 수행된 행동 |
| `entityType` | 영향을 받은 entity 종류 |
| `entityId` | 영향을 받은 entity ID |
| `details` | 변경 세부 정보 |
| `createdAt` | 발생 시각 |

Activity log는 append-only이며 immutable입니다. 운영 중 원인 추적이 필요하면 이 API를 먼저 확인합니다.
