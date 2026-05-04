# Runs Stats API

`GET /api/companies/:companyId/runs/stats`

Aggregates heartbeat run failures over a time window for telemetry and post-incident analysis.

## Query params

- `since` (required): ISO timestamp start (inclusive)
- `until` (optional): ISO timestamp end (inclusive), defaults to now
- `status` (optional): one of `failed`, `timed_out`, `cancelled`
- `agentId` (optional): filter to one agent
- `groupBy` (optional): one of `agentId`, `failureReason`, `day`

## Response

```json
{
  "window": { "since": "2026-04-12T00:00:00.000Z", "until": "2026-04-19T00:00:00.000Z" },
  "total": 42,
  "groups": [{ "key": "process_lost", "count": 31 }],
  "topRecoverySources": [{ "identifier": "SUP-1756", "count": 9 }]
}
```

Notes:

- `groups` is omitted when `groupBy` is not provided.
- `topRecoverySources` is limited to top 5 source issue identifiers.
- Route-level guardrails enforce auth scope and a conservative rate limit (30 requests/min per actor+company).
- `since`/`until` window is capped at 31 days.

## Example queries

```bash
# Total failed runs over the last 7 days
curl -H "Authorization: Bearer <token>" \
  "/api/companies/<companyId>/runs/stats?since=2026-04-22T00:00:00.000Z&status=failed"

# Group by failure reason
curl -H "Authorization: Bearer <token>" \
  "/api/companies/<companyId>/runs/stats?since=2026-04-22T00:00:00.000Z&until=2026-04-29T00:00:00.000Z&groupBy=failureReason"

# Group by day for one agent
curl -H "Authorization: Bearer <token>" \
  "/api/companies/<companyId>/runs/stats?since=2026-04-22T00:00:00.000Z&agentId=<agentId>&groupBy=day"
```
