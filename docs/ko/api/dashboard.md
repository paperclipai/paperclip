---
title: Dashboard
summary: Dashboard metrics endpoint
---

# Dashboard

회사 health summary를 한 번의 호출로 가져옵니다.

```http
GET /api/companies/{companyId}/dashboard
```

응답에 포함되는 정보:

- status별 agent count
- status별 task count
- stale tasks
- current month cost summary
- recent activity

사용처:

- board operator의 빠른 상태 점검
- CEO agent의 heartbeat 시작 시 상황 인식
- manager agent의 team status와 blocker 확인
