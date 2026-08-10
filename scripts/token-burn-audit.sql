-- Deterministic Paperclip token-burn report. Read-only: this script only runs
-- SELECT statements against the operational database.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/token-burn-audit.sql
--   psql "$DATABASE_URL" -v window="7 days" -v limit=10 \
--     -f scripts/token-burn-audit.sql

\set ON_ERROR_STOP on
\pset pager off
\pset null '(none)'

\if :{?window}
\else
  \set window '30 days'
\endif

\if :{?limit}
\else
  \set limit 20
\endif

\echo '=== Token totals ==='
WITH windowed AS (
  SELECT *, input_tokens::bigint + cached_input_tokens::bigint + output_tokens::bigint AS metered_tokens
  FROM cost_events
  WHERE occurred_at >= now() - :'window'::interval
)
SELECT
  count(*) AS cost_events,
  count(DISTINCT heartbeat_run_id) FILTER (WHERE heartbeat_run_id IS NOT NULL) AS heartbeat_runs,
  sum(input_tokens)::bigint AS input_tokens,
  sum(cached_input_tokens)::bigint AS cached_input_tokens,
  sum(output_tokens)::bigint AS output_tokens,
  sum(metered_tokens)::bigint AS metered_tokens,
  sum(cost_cents)::bigint AS reported_cost_cents,
  count(*) FILTER (WHERE cost_status <> 'reported') AS non_reported_cost_events
FROM windowed;

\echo '=== Daily burn ==='
SELECT
  occurred_at::date AS day,
  count(*) AS events,
  sum(input_tokens::bigint + cached_input_tokens::bigint + output_tokens::bigint) AS metered_tokens
FROM cost_events
WHERE occurred_at >= now() - :'window'::interval
GROUP BY 1
ORDER BY 1;

\echo '=== High-token run distribution ==='
WITH per_run AS (
  SELECT
    heartbeat_run_id,
    sum(input_tokens::bigint + cached_input_tokens::bigint + output_tokens::bigint) AS metered_tokens
  FROM cost_events
  WHERE occurred_at >= now() - :'window'::interval
    AND heartbeat_run_id IS NOT NULL
  GROUP BY heartbeat_run_id
)
SELECT
  count(*) AS runs_with_usage,
  count(*) FILTER (WHERE metered_tokens >= 250000) AS runs_ge_250k,
  count(*) FILTER (WHERE metered_tokens >= 1000000) AS runs_ge_1m,
  count(*) FILTER (WHERE metered_tokens >= 5000000) AS runs_ge_5m,
  count(*) FILTER (WHERE metered_tokens >= 10000000) AS runs_ge_10m,
  max(metered_tokens) AS max_run_tokens
FROM per_run;

\echo '=== Top models ==='
SELECT
  model,
  count(DISTINCT heartbeat_run_id) FILTER (WHERE heartbeat_run_id IS NOT NULL) AS runs,
  sum(input_tokens::bigint + cached_input_tokens::bigint + output_tokens::bigint) AS metered_tokens
FROM cost_events
WHERE occurred_at >= now() - :'window'::interval
GROUP BY model
ORDER BY metered_tokens DESC
LIMIT :limit;

\echo '=== Top companies ==='
SELECT
  c.name AS company,
  count(DISTINCT ce.heartbeat_run_id) FILTER (WHERE ce.heartbeat_run_id IS NOT NULL) AS runs,
  sum(ce.input_tokens::bigint + ce.cached_input_tokens::bigint + ce.output_tokens::bigint) AS metered_tokens
FROM cost_events ce
JOIN companies c ON c.id = ce.company_id
WHERE ce.occurred_at >= now() - :'window'::interval
GROUP BY c.id, c.name
ORDER BY metered_tokens DESC
LIMIT :limit;

\echo '=== Top agents ==='
SELECT
  c.name AS company,
  a.name AS agent,
  count(DISTINCT ce.heartbeat_run_id) FILTER (WHERE ce.heartbeat_run_id IS NOT NULL) AS runs,
  sum(ce.input_tokens::bigint + ce.cached_input_tokens::bigint + ce.output_tokens::bigint) AS metered_tokens
FROM cost_events ce
JOIN companies c ON c.id = ce.company_id
JOIN agents a ON a.id = ce.agent_id
WHERE ce.occurred_at >= now() - :'window'::interval
GROUP BY c.id, c.name, a.id, a.name
ORDER BY metered_tokens DESC
LIMIT :limit;

\echo '=== Top repeated issues ==='
SELECT
  i.identifier,
  i.title,
  count(DISTINCT ce.heartbeat_run_id) FILTER (WHERE ce.heartbeat_run_id IS NOT NULL) AS runs,
  sum(ce.input_tokens::bigint + ce.cached_input_tokens::bigint + ce.output_tokens::bigint) AS metered_tokens
FROM cost_events ce
JOIN issues i ON i.id = ce.issue_id
WHERE ce.occurred_at >= now() - :'window'::interval
GROUP BY i.id, i.identifier, i.title
ORDER BY metered_tokens DESC
LIMIT :limit;

\echo '=== Persisted context and log footprint ==='
SELECT
  count(*) AS runs,
  round(avg(pg_column_size(context_snapshot))) AS average_context_bytes,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY pg_column_size(context_snapshot)) AS p50_context_bytes,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY pg_column_size(context_snapshot)) AS p95_context_bytes,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY pg_column_size(context_snapshot)) AS p99_context_bytes,
  max(pg_column_size(context_snapshot)) AS max_context_bytes,
  sum(coalesce(log_bytes, 0))::bigint AS total_log_bytes,
  max(coalesce(log_bytes, 0))::bigint AS max_log_bytes
FROM heartbeat_runs
WHERE created_at >= now() - :'window'::interval;
