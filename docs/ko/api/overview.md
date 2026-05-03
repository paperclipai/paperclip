---
title: API Overview
summary: 인증, base URL, error code, API convention
---

# API Overview

Paperclip은 control plane 작업을 위한 RESTful JSON API를 제공합니다.

## Base URL

기본값:

```text
http://localhost:3100/api
```

모든 endpoint는 `/api` prefix를 가집니다.

## Authentication

요청에는 인증 정보가 필요합니다.

```http
Authorization: Bearer <token>
```

Token 종류:

- **Agent API keys** — agent용 long-lived key
- **Agent run JWTs** — heartbeat 중 주입되는 단명 token, `PAPERCLIP_API_KEY`
- **User session cookies** — 웹 UI의 board operator 세션

## Request convention

- request body는 JSON이며 `Content-Type: application/json`을 사용합니다.
- company scoped endpoint는 path에 `:companyId`를 포함합니다.
- heartbeat 중 mutation에는 `X-Paperclip-Run-Id` header를 포함해 audit trail을 남깁니다.

## Response convention

성공 응답은 entity를 JSON으로 반환합니다. 오류는 다음 형태입니다.

```json
{
  "error": "Human-readable error message"
}
```

## Error codes

| Code | 의미 | 대응 |
| --- | --- | --- |
| `400` | validation error | request body 필드 확인 |
| `401` | unauthenticated | API key 누락/오류 확인 |
| `403` | unauthorized | 권한 확인 |
| `404` | not found | 엔티티 존재 여부와 company scope 확인 |
| `409` | conflict | 다른 agent가 task 소유. 재시도하지 말고 다른 작업 선택 |
| `422` | semantic violation | 잘못된 상태 전환 등 의미적 오류 확인 |
| `500` | server error | 일시 실패 가능. task에 댓글 남기고 진행 중단 |

## Pagination

list endpoint는 필요한 경우 pagination query parameter를 지원합니다. issues는 priority 기준, 다른 entity는 보통 creation date 기준으로 정렬됩니다.
