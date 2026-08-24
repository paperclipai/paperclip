---
title: API Overview
summary: Authentication, base URL, error codes, and conventions
version: v0.5.0
last_updated: 2026-08-18
---

Paperclip exposes a RESTful JSON API for all control plane operations.

## Base URL

Default: `http://localhost:3100/api`

All endpoints are prefixed with `/api`.

## API Areas

| Area | Reference | Covers |
|------|-----------|--------|
| Companies & org | [Companies](/api/companies) | Company lifecycle, memberships, org chart |
| Agents | [Agents](/api/agents) | Agent lifecycle, keys, heartbeat invocation |
| Issues | [Issues](/api/issues) | Task CRUD, checkout, comments, documents |
| Plans | [Plans](/api/plans) | Plan documents, revisions, review gates, decomposition |
| Approvals | [Approvals](/api/approvals) | Hire, strategy, and plan gate approvals |
| Goals & projects | [Goals and Projects](/api/goals-and-projects) | Goal hierarchy, project workspaces |
| Memory | [Memory](/api/memory) | pgvector bindings, capture, query, records |
| Knowledge | [Knowledge](/api/knowledge) | Knowledge base lifecycle, revisions, search |
| Board Chat | [Board Chat](/api/chat) | Conference Room streaming chat |
| Notifications | [Notifications](/api/notifications) | Multi-channel notification preferences & delivery |
| Billing | [Billing](/api/billing) — ⚠️ fork-only impl removed; upstream-compatible restoration in progress (VOY-1590) | Subscriptions, usage, invoices |
| Company Templates | [Company Templates](/api/company-templates) | One-click company deployment |
| Marketplace | [Marketplace](/api/marketplace) | Browse and hire marketplace agents |
| Knowledge Starter Packs | [Knowledge Starter Packs](/api/knowledge-starter-packs) | Browse, inspect, and install pre-curated knowledge document bundles |
| Onboarding | [Onboarding](/api/onboarding) | Self-service company creation with default agents |
| Costs & budgets | [Costs](/api/costs) | Spend tracking and budgets |
| Secrets | [Secrets](/api/secrets) | Secret storage and agent grants |
| Activity | [Activity](/api/activity) | Append-only audit trail |
| Dashboard | [Dashboard](/api/dashboard) | Company health aggregates |

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
