---
name: "planetscale-query-insights-and-tags"
description: "Use PlanetScale Insights and SQLCommenter-style query tags to attribute database load, identify risky queries, and prepare safe Traffic Control or schema recommendations."
key: "paperclipai/optional/agency-agents/planetscale-query-insights-and-tags"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "planetscale"
  - "query"
  - "insights"
  - "and"
  - "tags"
defaultInstall: false
---
# Query Insights and tags

## Purpose

Use PlanetScale Insights to understand query behavior, then recommend SQLCommenter-compatible tags that make future diagnosis and Traffic Control possible. Do not change database settings or repository code without approval.

## What to inspect

### Query behavior

For the selected database and branch, inspect:

- Top queries by total time.
- Top queries by time per execution.
- Top queries by rows read.
- Top queries by execution count.
- For Postgres, top queries by CPU usage (`sort=cpuTime` or
  `sort=percentCpuTime` on the Insights API).
- Queries with errors.
- Notable queries and active anomalies.
- Query patterns affected by recent deploys.
- Query patterns attached to schema recommendations.
- For sharded Vitess databases, vindex usage for each query pattern: the
  percentage of traffic using relevant vindexes and the vindex-usage trend
  over time. The API exposes per-pattern `index_usages` and
  `routing_index_usages`; get the trend from the dashboard Vindexes tab or
  by comparing API windows. Treat missing or declining relevant-vindex
  usage as an indexing or routing investigation input, not as proof that a
  new index is required.

### Insights API surface

Query Insights is public API: read-only GET endpoints under
`organizations/{org}/databases/{db}/branches/{branch}`, authorized by a
service token or OAuth token with `read_databases`/`read_database`.

- `/insights` — aggregated statistics per query pattern over the requested
  window. Set the window with `from`/`to` (ISO 8601) or `period` (for
  example `1h`, `24h`); search SQL patterns with `q`; sort server-side with
  `sort` and `dir` — sort keys include `count`, `errorCount`, `rowsRead`,
  `totalTime`, `cpuTime`, `ioTime`, `percentTime`, `percentCpuTime`,
  `p50Latency`, `p99Latency`, `maxLatency`, `egressBytes`, and the
  `trafficControlWarnings`/`trafficControlThrottled` family. Filter with
  `tablet_type` (`primary`, `replica`, `rdonly`) and `type` (`SELECT`,
  `INSERT`, `UPDATE`, `DELETE`); trim responses with `fields`; paginate
  with `page`/`per_page`.
- `/insights/{fingerprint}` — individual collected executions for a
  pattern (timestamps, duration, rows, username, client address, error
  message). Available regardless of raw query collection; raw collection
  adds literal parameter values to these records.
  `/insights/{fingerprint}/summary` returns the single-pattern aggregate;
  `/insights/queries/{id}` fetches one execution.
- `/insights/errors` — error fingerprints with counts and messages (`q`
  searches the error message; sort by `count`, `lastRun`, `totalTime`, or
  `timePerQuery`). `/insights/errors/{fingerprint}` lists the failing
  executions behind one error fingerprint.
- `/insights/anomalies` and `/insights/anomalies/{id}` — anomaly windows
  with per-query correlation coefficients identifying which patterns moved
  with the anomaly.
- `/insights/tags` — tag keys with observed values (`values_limit`,
  `literal_values_only`, and `fingerprint`/`keyspace` filters);
  `/insights/tags/{tag}` for a single key. `/insights/tags/summaries`
  groups the full statistics schema by one or more tag keys via the `tags`
  parameter — use it to attribute load to routes, jobs, or features
  without client-side aggregation.
- `/insights/{fingerprint}/traffic/budgets` — the Traffic Control budgets
  and rules that affect a fingerprint (Postgres).

Aggregates cover the requested window. Duration fields use names like
`sum_total_duration_millis`, with explicit share-of-window percent fields
(`sum_total_duration_percent`); both totals and percentages are reliable
for the window requested.

The response schema is shared across engines, but some fields are
engine-specific: CPU/IO durations and block-cache statistics
(`sum_cpu_duration_millis`, `blocks_read`, `block_cache_hit_ratio`, …) are
populated for Postgres; shard queries, keyspaces, `tablet_type`, and
routing-index (vindex) usage are populated for Vitess.

### Tag coverage

For each expensive or anomalous query, determine:

- Is it tagged?
- Which service produced it?
- Which route, job, controller, or action produced it?
- Which deployment SHA produced it?
- Is the tag cardinality safe?
- Are tags consistent across frameworks and languages?
- Use the tags API to answer these questions: `/insights/tags` shows which
  keys and values are present, and `/insights/tags/summaries?tags=...`
  attributes load per tag value. In the Vitess dashboard, filter the query
  table with `tag:key:value` and drill into query details to see tags on
  individual executions. Built-in query metadata and SQLCommenter tags are
  both valid attribution sources.

### Raw query collection

Check whether raw query / complete query collection is enabled. On
Postgres the effective state is the `pginsights.raw_queries` cluster
parameter (per branch, dashboard Extensions tab, default `false`); the
database API object's `insights_raw_queries` field is a separate surface.
When the two differ, report the cluster parameter as the effective state
and do not describe the difference as an inconsistency. On Vitess there
is no cluster parameter; the database API's `insights_raw_queries` field
is the effective state.

Report it as a capability state, not a risk posture. Raw query collection
records literal parameter values per execution, which pattern-level Insights
data does not provide. It is the mechanism for isolating which specific
invocation of a pattern is pathological. Execution-level records are
retrievable from `/insights/{fingerprint}` with or without raw collection;
raw collection adds the literal parameter values to those records.

When it is disabled, the finding is a capability gap: identify the query
patterns in this assessment where pattern-level data is insufficient
(unexplained latency variance within a fingerprint, tenant- or
parameter-dependent behavior) and state that raw collection would resolve
them. State the operational property once, as fact: literal values become
visible to the observability pipeline. Where the customer's data-handling
requirements constrain this, scoped enablement (incident windows, defined
retention) and leaving collection disabled are both valid outcomes —
record the rationale rather than a default judgment in either direction.

Tags and raw collection are complementary instruments: tags attribute a
pattern to a code path; raw collection identifies the specific invocation.
Assessments should evaluate both.

## SQLCommenter tag schema

Recommend this baseline tag set:

- `application`: stable app name.
- `service`: service or process name.
- `environment`: production, staging, development.
- `route`: normalized route template, for example `/accounts/:id/orders`, not `/accounts/123/orders`.
- `controller`: framework controller name where applicable.
- `action`: framework action name where applicable.
- `job`: background job class or worker name.
- `queue`: background queue.
- `feature`: bounded feature name for traffic classes like export, report, search, billing, checkout.
- `release_sha`: short git SHA or deploy identifier.
- `source`: app, worker, script, agent, mcp, bi, integration.
- `tenant_tier`: free, pro, enterprise, internal, only if bounded.

Do not recommend these tags by default:

- `user_id`
- `request_id`
- `tenant_id`
- `email`
- `session_id`
- raw URL
- unbounded GraphQL operation text
- access token
- secret

If the customer needs tenant-level isolation, recommend a bounded abstraction first, such as tenant tier, cell, shard, or customer class. Tenant ID is only acceptable with explicit approval after cardinality and privacy review.

## Cardinality rules

Flag a tag as unsafe when:

- Values are unbounded.
- Values include IDs, UUIDs, emails, slugs, or raw paths.
- The same query pattern emits many unique tag combinations.
- The tag would make Insights or Traffic Control aggregation noisy.

Recommend normalizing at the application boundary.

## Analysis output

For each top query pattern, produce:

- Fingerprint or normalized query.
- Current metrics.
- Current tags.
- Missing tags.
- Likely source in application code.
- Whether it is a schema recommendation candidate.
- Whether it is a Traffic Control candidate.
- Whether it is an application optimization candidate.

## Recommendation classes

### Add tags

Recommend SQLCommenter instrumentation when query attribution is weak.

### Improve tag normalization

Recommend replacing high-cardinality tags with bounded values.

### Add Traffic Control warning budget

For Postgres only, recommend `warn` mode budgets for expensive but important routes, jobs, analytics, exports, or third-party integrations.

### Add schema recommendation workflow

For Vitess, recommend turning open schema recommendations into branch/deploy-request work. For Postgres, recommend turning them into reviewed migrations against a non-production branch.

### Fix code path

Recommend a repository PR when the expensive query is caused by N+1, missing pagination, accidental eager load, unbounded export, broad search, or polling.

## Safety rules

Do not:

- Enable raw query collection.
- Add tags to code.
- Change Traffic Control budgets.
- Apply schema recommendations.
- Run production EXPLAIN ANALYZE on expensive queries.

Without explicit approval.

## Output

Return:

- Query risk table.
- Tag coverage table.
- Bad/high-cardinality tag table.
- Recommended tag schema for this application.
- Candidate Traffic Control slices.
- Candidate schema and code changes.
- Proposed changes requiring approval.

End with:

“No Insights, tag, repository, or Traffic Control changes have been applied.”
