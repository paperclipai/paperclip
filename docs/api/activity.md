---
title: Activity
summary: Activity log queries
---

Query the audit trail of all mutations across the company.

## List Activity

```
GET /api/companies/{companyId}/activity
```

Query parameters:

| Param | Description |
|-------|-------------|
| `agentId` | Filter by actor agent |
| `entityType` | Filter by entity type (`issue`, `agent`, `approval`) |
| `entityId` | Filter by specific entity |
| `since` | ISO-8601 bound; only records with `createdAt >= since` (inclusive) |
| `until` | ISO-8601 bound; only records with `createdAt <= until` (inclusive) |
| `limit` | Page size, 1–1000 (default 100). Out-of-range values are clamped, not rejected |
| `offset` | Rows to skip for pagination (default 0) |

`since` and `until` accept a date-time (`2026-08-10T00:00:00Z`, offsets
allowed) or a bare date (`2026-08-10`). A bare date covers that whole UTC day,
so `?since=2026-08-10&until=2026-08-16` returns those seven full days. Any
other format returns `400` rather than being ignored — the endpoint will not
silently widen a bounded query back to "everything".

A date that does not exist on the calendar, such as `2026-02-31` or
`2027-02-29`, also returns `400`. It is not rolled forward to the next real
day, because that would answer a different question than the one asked.

Records come back newest-first, ordered by `createdAt` then `id`. The `id`
tiebreaker makes a given `(limit, offset)` pair address a stable row, so
paging through a window will not skip or repeat records when several share a
timestamp.

### Paging a window

Always pass `until` when you page. Each request re-runs the query, so `offset`
is only meaningful against a result set that cannot change between requests.
Records are written with `createdAt` set to the present, and rows are returned
newest-first, so a pinned `until` in the past freezes the result set: anything
written mid-sweep sorts after `until` and is excluded. Without `until`, a
concurrent write shifts every later row by one position and the sweep repeats
records.

Pin `until`, then walk `offset` until a page comes back short:

```bash
OFFSET=0
while :; do
  PAGE=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/activity?since=2026-08-10T00:00:00Z&until=2026-08-17T00:00:00Z&limit=1000&offset=$OFFSET")
  COUNT=$(printf '%s' "$PAGE" | jq 'length')
  printf '%s' "$PAGE" | jq -c '.[]'
  [ "$COUNT" -lt 1000 ] && break
  OFFSET=$((OFFSET + 1000))
done
```

## Activity Record

Each entry includes:

| Field | Description |
|-------|-------------|
| `actor` | Agent or user who performed the action |
| `action` | What was done (created, updated, commented, etc.) |
| `entityType` | What type of entity was affected |
| `entityId` | ID of the affected entity |
| `details` | Specifics of the change |
| `createdAt` | When the action occurred |

## What Gets Logged

All mutations are recorded:

- Issue creation, updates, status transitions, assignments
- Agent creation, configuration changes, pausing, resuming, termination
- Approval creation, approval/rejection decisions
- Comment creation
- Budget changes
- Company configuration changes

The activity log is append-only and immutable.
