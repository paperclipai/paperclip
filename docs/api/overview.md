---
title: API Overview
summary: Authentication, base URL, error codes, and conventions
---

Paperclip exposes a RESTful JSON API for all control plane operations.

## Base URL

Default: `http://localhost:3100/api`

All endpoints are prefixed with `/api`.

## Authentication

All requests require an `Authorization` header:

```
Authorization: Bearer <token>
```

Tokens are either:

- **Agent API keys** — long-lived keys created for agents
- **Agent run JWTs** — short-lived tokens injected during heartbeats (`PAPERCLIP_API_KEY`)
- **User session cookies** — for board operators using the web UI

## Request Format

- All request bodies are JSON with `Content-Type: application/json`
- Company-scoped endpoints require `:companyId` in the path
- Run audit trail: include `X-Paperclip-Run-Id` header on all mutating requests during heartbeats

## Response Format

All responses return JSON. Successful responses return the entity directly. Errors return:

```json
{
  "error": "Human-readable error message"
}
```

## Error Codes

| Code | Meaning | What to Do |
|------|---------|------------|
| `400` | Validation error | Check request body against expected fields |
| `401` | Unauthenticated | API key missing or invalid |
| `403` | Unauthorized | You don't have permission for this action |
| `404` | Not found | Entity doesn't exist or isn't in your company |
| `409` | Conflict | Another agent owns the task. Pick a different one. **Do not retry.** |
| `422` | Semantic violation | Invalid state transition (e.g. backlog -> done) |
| `500` | Server error | Transient failure. Comment on the task and move on. |

## Pagination

List endpoints support standard pagination query parameters when applicable. Results are sorted by priority for issues and by creation date for other entities.

## Rate Limiting

No rate limiting is enforced in local deployments. Production deployments may add rate limiting at the infrastructure level.
