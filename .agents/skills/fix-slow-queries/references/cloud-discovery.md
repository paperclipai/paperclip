# From a slow workspace to its queries

Use this reference for hosted Paperclip investigations. Resolve current resources
and credentials from the authorized environment; the examples describe lookup
shapes, not fixed account, stack, or project IDs.

## Resolve the cross-service identity

1. Start with the reported workspace URL and affected user action. Record UTC
   observation times, environment, and a representative slow request. A fast
   health endpoint does not establish that task/run endpoints are fast.
2. Open the authorized Paperclip Cloud fleet-admin stack record matching that
   URL. Match its domain and workspace identity, not only a friendly name.
3. In stack details, inspect the database provider resources and **Open in Neon**
   link. Record project, branch, endpoint/compute, database, and runtime role.
   Provider refs may be CloudOps-only. Do not infer them when they are redacted.
4. Record the application provider's project, environment, service, active
   deployment/revision, and region. On Railway these identify the logs and
   metrics to compare with Neon. A stack can move after reprovisioning.
5. Confirm the database connection's actual database and role before querying.
   Keep private mapping details in restricted evidence, not public PR bodies.

Use available provider connectors or CLIs first; the authenticated browser is
useful for fleet-admin resource links and Neon monitoring. If tool access is
missing, inspect the authorized `paperclip-cloud` checkout and its instructions.
Relevant files, relative to that repository:

- `docs/cloud-harness-app-paperclip-cloud-runbook.md`: provider credentials and
  secret-store rules.
- `src/providers/neon.ts`: project/branch/role mapping and connection URI lookup.
- `src/providers/railway.ts`: provider API and metrics/log access.
- `web/src/admin/routes/StackDetail.tsx`: displayed provider resource mapping.

Discover its path from the current project context; do not assume a developer's
home directory or copy their AWS profile. Verify the account/environment against
the current runbook. Staging and production secret stores are distinct.

## Open a bounded read-only diagnostic connection

Prefer the scoped runtime connection secret already recorded for the stack.
When authorized operator access is needed, the provider's connection lookup uses
`GET /projects/{projectId}/connection_uri` with `branch_id`, `endpoint_id`,
`database_name`, `role_name`, and `pooled=true`; verify against the current provider
implementation. Pass returned credentials directly in memory to the client.

Load only necessary secret fields. Never print connection URIs, secret values,
or credential-bearing error objects; never put them in command arguments,
repository `.env` files, evidence, or PRs. Query text and parameters can also
contain tenant data. Keep full SQL privately only when necessary and sanitize
before publishing; simple literal replacement is not complete redaction.

Set a recognizable diagnostic `application_name`, connection timeout, short
statement/lock timeouts, and read-only transactions. Example session:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';
SELECT current_database(), current_user, version();
SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements';
COMMIT;
```

Do not install extensions, reset shared statistics, change capacity, or run
schema/data changes as a side effect of diagnosis. `EXPLAIN ANALYZE` executes
the query; keep that work on the local fixture unless the live execution has
been separately justified and authorized. Plain `EXPLAIN` is the lighter live
option when permitted. Read-only SQL can still impose load; bound each probe.

## Obtain historical and current evidence

In Neon, select the confirmed branch, endpoint, and database, then inspect
**Monitoring → Query performance** and **Monitoring → Metrics**. UI labels can
change; use the observed navigation. Preserve the source link and capture time.

When SQL access to `pg_stat_statements` is available, this supplies a first cut:

```sql
SELECT userid, dbid, queryid, calls, total_exec_time, mean_exec_time,
       max_exec_time, rows, shared_blks_hit, shared_blks_read,
       temp_blks_written, query
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY total_exec_time DESC
LIMIT 20;
```

Do not interpret an absent/inaccessible SQL extension as proof that the Neon
console has no query history. During this investigation the console supplied
history when the runtime connection could not query `pg_stat_statements`.
Without either source, take bounded samples of `pg_stat_activity` and scoped
application timings; label them samples, not complete historical attribution.

For interval statistics, save two snapshots in separate transactions. Match
database, user, query ID and, where exposed, top-level status. Compute
`delta_total_exec_time / delta_calls` only for positive calls and compatible
reset epochs. Counter decreases, resets, or evicted/reappearing entries invalidate
that interval comparison. Record `pg_stat_statements_info.stats_reset` when
available. Mean/max values do not provide p95; p95 needs individual samples.

Useful supporting observations:

| Surface | Read | Interpretation |
| --- | --- | --- |
| Neon metrics | CPU allocation/usage, RAM, cache/working set, pooler wait, connection count | Correlate with the slow-request window before attributing capacity pressure |
| `pg_stat_activity`, `pg_locks` | Active query age, wait events, blockers, transaction age | Lock waits and long transactions need caller attribution |
| `pg_stat_database` | Transaction, block, temporary-file and deadlock deltas; stats reset | Cumulative counters need an interval; reported I/O time depends on tracking settings |
| `pg_stat_user_tables` | Scans, rows visited, live/dead estimates, analyze/vacuum times | Investigate broad reads and stale statistics; estimates are not exact row counts |
| Railway/app logs | Endpoint duration, background-job frequency, deployment | Separate request work from recurring maintenance |
| Traces/error system | SQL spans, pool/connect waits, errors scoped to the stack | Missing traces are not proof of zero database time |

Measure connection establishment separately from several `SELECT 1` round trips.
These show network/pool overhead; they do not measure a business query. Likewise,
low total container CPU does not exclude Node event-loop saturation, and a busy
background query does not prove it caused a particular slow page.

Produce a short ranked table: caller/query family, calls or call rate, mean SQL
time, total SQL time, observation window/reset caveat, suspected cause, and next
local experiment. Choose the bounded batch from this table.
