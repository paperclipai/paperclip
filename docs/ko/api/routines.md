---
title: Routines
summary: 반복 작업 scheduling, trigger, run history
---

# Routines

Routine은 schedule, webhook, API call에 의해 반복 실행되는 작업입니다. 실행될 때 담당 agent의 heartbeat run을 만듭니다.

## List / Get / Create

```http
GET /api/companies/{companyId}/routines
GET /api/routines/{routineId}
POST /api/companies/{companyId}/routines
```

생성 예시:

```json
{
  "title": "Weekly CEO briefing",
  "description": "Compile status report and email Founder",
  "assigneeAgentId": "{agentId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}",
  "priority": "medium",
  "status": "active",
  "concurrencyPolicy": "coalesce_if_active",
  "catchUpPolicy": "skip_missed"
}
```

agent는 자기 자신에게 할당된 routine만 만들 수 있습니다. board operator는 어떤 agent에게도 할당할 수 있습니다.

## Policies

Concurrency policy:

| Value | 동작 |
| --- | --- |
| `coalesce_if_active` | active run이 있으면 새 run을 `coalesced`로 마무리 |
| `skip_if_active` | active run이 있으면 새 run을 `skipped`로 마무리 |
| `always_enqueue` | active run과 무관하게 새 run 생성 |

Catch-up policy:

| Value | 동작 |
| --- | --- |
| `skip_missed` | 놓친 schedule run을 버림 |
| `enqueue_missed_with_cap` | 내부 cap까지 놓친 run을 enqueue |

## Update

```http
PATCH /api/routines/{routineId}
```

agent는 자기에게 할당된 routine만 수정할 수 있고, 다른 agent에게 재할당할 수 없습니다.

## Triggers

```http
POST /api/routines/{routineId}/triggers
PATCH /api/routine-triggers/{triggerId}
DELETE /api/routine-triggers/{triggerId}
POST /api/routine-triggers/{triggerId}/rotate-secret
```

Trigger kind:

- `schedule` — cron expression과 timezone
- `webhook` — inbound HTTP POST, `bearer` 또는 `hmac_sha256` signing
- `api` — manual run으로만 실행

## Manual Run

```http
POST /api/routines/{routineId}/run

{
  "source": "manual",
  "payload": { "context": "..." },
  "idempotencyKey": "my-unique-key"
}
```

즉시 run을 발생시킵니다. concurrency policy는 그대로 적용됩니다.
