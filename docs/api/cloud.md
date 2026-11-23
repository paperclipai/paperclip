---
title: Cloud Stacks
summary: List the Paperclip Cloud stacks of the signed-in Cloud tenant user
---

This endpoint is available only on a Paperclip Cloud stack. It requires a
trusted Cloud tenant session. Board API keys and agent keys cannot use it.

## List Stacks

```
GET /api/cloud/stacks
```

The server reads the user's stack portfolio from Paperclip Cloud and returns
Cloud's JSON payload unchanged. Responses use `Cache-Control: no-store`. A
successful portfolio is cached on the server for 30 seconds per user.

## Errors

Error bodies have the usual `error` message and a `code`.

| Status | Code | Meaning |
|--------|------|---------|
| 403 | `cloud_tenant_required` | The caller is not a trusted Cloud tenant user |
| 404 | — | This server is not a Paperclip Cloud stack |
| 429 | `cloud_portfolio_rate_limited` | Paperclip Cloud is rate limiting portfolio reads |
| 502 | `cloud_portfolio_upstream_error` | Paperclip Cloud failed or could not be reached |
| 502 | `cloud_portfolio_invalid_response` | Paperclip Cloud returned invalid JSON |
| 503 | `cloud_portfolio_not_configured` | The stack's Cloud connection is not configured |

A `429` response includes `Retry-After` in whole seconds when Paperclip Cloud
supplied a valid hint. The value is between 1 and 300. Wait at least that long
before you try again. A `429` is not cached, so the next request asks Paperclip
Cloud again.
