---
name: "planetscale-best-practices-matrix"
description: "A concise feature matrix for deciding which PlanetScale safety, observability, and automation recommendations apply by engine."
key: "paperclipai/optional/agency-agents/planetscale-best-practices-matrix"
recommendedForRoles:
  - "operations"
tags:
  - "agency-agents"
  - "operations"
  - "planetscale"
  - "best"
  - "practices"
  - "matrix"
defaultInstall: false
---
# Best-practices matrix

## Purpose

Map database findings to recommended PlanetScale features. Use this to ensure the assessment does not miss major safety and operational surfaces.

## Cross-engine recommendations

### Query Insights

Recommend for every production database:

- Review slow, expensive, high-frequency, and erroring query patterns.
- For Postgres, sort Insights by CPU (`sort=cpuTime` on the Insights API)
  when diagnosing CPU pressure.
- For sharded Vitess, review vindex usage per query pattern and the usage
  trend after index or routing changes.
- Correlate regressions with deploys.
- Use tags/comments to map queries back to code.
- Use tag filtering/navigation in Query Insights: the tags API
  (`insights/tags`, `insights/tags/summaries`) on both engines, plus
  `tag:key:value` filtering and per-execution tag drill-down in the Vitess
  dashboard.
- Use anomalies as alert and automation inputs.

### Webhooks

Recommend for operational events:

- Anomalies.
- Storage pressure.
- Branch readiness/sleeping.
- Primary promotion.
- Maintenance.
- Schema recommendations where available.
- Deploy request lifecycle for Vitess.

### MCP and agents

Recommend:

- Use insights-only MCP for most autonomous analysis.
- Use full MCP only with narrow scopes and read-only default.
- Put database targeting and safety rules in `AGENTS.md`.
- Agents generate PRs/issues/change plans; humans approve database changes.

### SQLCommenter / query tags

Recommend:

- Add framework-native SQLCommenter-compatible instrumentation.
- Use low-cardinality tags.
- Include application, service, route/job, feature, source, and release SHA.
- Avoid PII and unbounded IDs.

### Schema recommendation workflow

Recommend:

- Triage open recommendations.
- Correlate with code and Insights.
- Convert into migrations or branch changes.
- Test before production.
- Apply only through approved workflow.

## Vitess-specific recommendations

### Safe migrations

Recommend for production branches and staging branches that accept deploy requests.

### Deploy requests

Recommend for schema changes into protected branches.

### Force cutover discipline

Recommend documenting who may use "force cutover now" for deploy requests
delayed by long-running transactions. It stops running transactions to finish
schema cutover, so frequent use should trigger workload review before enabling
aggressive cutover as the database default.

### Admin approval

Recommend for production deploy requests in multi-admin organizations.

In a single-admin organization, approval alone is not a guard against agents: that admin can
open and approve the same deploy request. Prefer a separate agent identity, or a service token
that cannot approve deploy requests.

### Gated deployments

Recommend when cutover timing and human control matter.

### Schema revert runbook

Recommend documenting revert responsibilities and the application rollback relationship.

### Branch strategy

Recommend production, staging, and short-lived development branches with safe migrations on protected targets.

### Sharding/keyspace review

Recommend when query patterns or growth suggest shard-awareness problems. Do not reshard automatically.

## Postgres-specific recommendations

### User-defined roles

Recommend for application servers instead of default role. If roles are managed
by Terraform and passwords should stay outside Terraform state, prefer
`planetscale_postgres_redacted_branch_role` plus a separate password reset and
secret-manager storage path.

### pg_strict

Recommend for application roles after evaluation, especially to block accidental full-table update/delete mistakes.

### Traffic Control

Recommend for resource isolation of agents, exports, reports, workers, integrations, BI, and known expensive fingerprints.

### Backups and PITR

Recommend verifying retention and restore drill coverage.
If Terraform is the customer's source of truth, recommend managing backup
policies there so backup posture changes are reviewed as infrastructure code.

### PgBouncer and connection pooling

Recommend where connection churn or serverless/edge behavior creates pressure, subject to transaction-pooling limitations.

### Private connectivity and IP restrictions

Recommend for customers requiring private network posture or reduced public exposure. Treat changes as production-risking.

### Extensions

Recommend only when use case is clear and restart/activation impact is accepted.
Include `auto_explain` when automatic plan logging for slow queries would
materially improve diagnosis and the resulting log volume is acceptable.
If Terraform manages Postgres branch parameters or supported extensions, keep
that source of truth aligned with approved dashboard/API changes.

### Live connections

Recommend inspecting `pscale branch connections top` during active connection
pressure incidents to identify sessions, blockers, and idle-in-transaction
roots without relying on normal database connection capacity.

## Output

For each matrix item, mark:

- Applies: yes/no/unknown.
- Current state.
- Gap.
- Value: the specific measured finding this feature addresses (query
  fingerprint, anomaly count, incident, metric). State the mechanism and
  the measurement. Gaps are capability gaps with quantified impact, not
  risks safely avoided.
- Recommendation ID.
- Approval requirement.

End with:

“No changes have been applied.”
