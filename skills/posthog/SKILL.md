---
name: posthog
description: "Query PostHog analytics — events, insights, feature flags, persons, and HogQL queries. Use when asked about user behavior, product analytics, funnels, retention, feature flags, or session data."
---

# PostHog Analytics

Query viracue.ai product analytics via PostHog REST API.

**Project:** Default project (id: 260508)
**Host:** https://us.posthog.com

## Auth

Env vars injected at runtime:
- `POSTHOG_API_KEY` — personal API key (secret_ref)
- `POSTHOG_PROJECT_ID` — 260508
- `POSTHOG_HOST` — https://us.posthog.com

All requests use: `Authorization: Bearer $POSTHOG_API_KEY`

## HogQL Query (most powerful)

Run any analytics query using HogQL (PostHog's SQL dialect):

```bash
curl -sS -X POST "$POSTHOG_HOST/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "kind": "HogQLQuery",
      "query": "SELECT event, count() as cnt FROM events WHERE timestamp > now() - interval 7 day GROUP BY event ORDER BY cnt DESC LIMIT 20"
    }
  }'
```

### Common HogQL queries

**Event counts by day:**
```sql
SELECT toDate(timestamp) as day, count() as events FROM events WHERE timestamp > now() - interval 30 day GROUP BY day ORDER BY day
```

**Unique users by day:**
```sql
SELECT toDate(timestamp) as day, count(distinct distinct_id) as users FROM events WHERE timestamp > now() - interval 30 day GROUP BY day ORDER BY day
```

**Page views by URL:**
```sql
SELECT properties.$current_url as url, count() as views FROM events WHERE event = '$pageview' AND timestamp > now() - interval 7 day GROUP BY url ORDER BY views DESC LIMIT 20
```

**Funnel (pageview -> signup):**
```sql
SELECT count(distinct distinct_id) as users, event FROM events WHERE event IN ('$pageview', 'signed_up') AND timestamp > now() - interval 30 day GROUP BY event
```

## Events Query

```bash
curl -sS -X POST "$POSTHOG_HOST/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "kind": "EventsQuery",
      "select": ["event", "timestamp", "distinct_id", "properties.$current_url"],
      "where": ["event = '"'"'$pageview'"'"'"],
      "limit": 20,
      "orderBy": ["timestamp DESC"]
    }
  }'
```

## List Insights (saved reports)

```bash
curl -sS "$POSTHOG_HOST/api/projects/$POSTHOG_PROJECT_ID/insights/?limit=20" \
  -H "Authorization: Bearer $POSTHOG_API_KEY"
```

## Feature Flags

```bash
# List flags
curl -sS "$POSTHOG_HOST/api/projects/$POSTHOG_PROJECT_ID/feature_flags/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY"

# Get specific flag
curl -sS "$POSTHOG_HOST/api/projects/$POSTHOG_PROJECT_ID/feature_flags/FLAG_ID/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY"
```

## Persons

```bash
# Search persons
curl -sS "$POSTHOG_HOST/api/projects/$POSTHOG_PROJECT_ID/persons/?search=user@example.com" \
  -H "Authorization: Bearer $POSTHOG_API_KEY"
```

## Actions

```bash
curl -sS "$POSTHOG_HOST/api/projects/$POSTHOG_PROJECT_ID/actions/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY"
```

## Dashboards

```bash
curl -sS "$POSTHOG_HOST/api/projects/$POSTHOG_PROJECT_ID/dashboards/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY"
```

## Session Recordings

```bash
curl -sS "$POSTHOG_HOST/api/projects/$POSTHOG_PROJECT_ID/session_recordings/?limit=10" \
  -H "Authorization: Bearer $POSTHOG_API_KEY"
```

## Key event names

- `$pageview` — page view
- `$pageleave` — page leave
- `$autocapture` — auto-captured clicks/inputs
- `$identify` — user identification
- `signed_up` — custom signup event
- `$feature_flag_called` — feature flag evaluation

## Output

All output is JSON. Use `jq` for parsing or read directly.

## Safety

- Never expose `POSTHOG_API_KEY` in comments, logs, or screenshots
- Prefer read-only queries; confirm before creating/modifying flags or actions
- Use `limit` on all queries to avoid large result sets
