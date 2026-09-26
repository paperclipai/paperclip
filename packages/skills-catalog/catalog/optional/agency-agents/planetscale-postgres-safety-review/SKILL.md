---
name: "planetscale-postgres-safety-review"
description: "Review PlanetScale Postgres for Traffic Control, query tags, roles, pg_strict, backups/PITR, private connectivity, webhooks, branches, and safe agent operation."
key: "paperclipai/optional/agency-agents/planetscale-postgres-safety-review"
recommendedForRoles:
  - "generalist"
tags:
  - "agency-agents"
  - "generalist"
  - "planetscale"
  - "postgres"
  - "safety"
  - "review"
defaultInstall: false
---
# Postgres safety review

## Purpose

Recommend best practices for a PlanetScale Postgres database. Focus on availability protection, application isolation, recovery, safe automation, and observability. Do not apply changes.

## Branch and schema workflow

PlanetScale Postgres branches do not use Vitess-style deploy requests. Schema changes are made directly to each branch, and production schema changes should be managed through the application’s normal migration workflow with a branch validation step.

Check:

- Whether a development or test branch exists.
- Whether branches are empty or restored from backup.
- Whether migrations are tested against a branch before production.
- Whether application migrations are reversible or have a documented rollback strategy.
- Whether production DDL is manually reviewed.

Recommend:

- Create or use a non-production branch for migration testing.
- Run migration validation and application tests against that branch.
- Treat production migration application as an explicit human-approved deployment step.
- Use PITR/backup restore branches for incident recovery, not as an automatic rollback mechanism.

Do not create branches, run migrations, or restore backups without approval.

## Roles and least privilege

Check whether the application connects with the default role. Flag this as a safety gap.

Recommend:

- Use user-defined application roles, not the default role, for application servers.
- Separate roles by service, environment, and access pattern.
- Use read-only roles for analytics, dashboards, reporting, and agents that do not need writes.
- Use short-lived or purpose-limited roles for automation.
- When Terraform manages PlanetScale Postgres roles, prefer
  `planetscale_postgres_redacted_branch_role` for roles whose password should
  stay out of Terraform state; reset the password through the API or dashboard
  and store it in the team's secret manager.
- Document credential rotation without application downtime.

Do not create, reset, delete, or rotate roles without approval.

## pg_strict

Check whether pg_strict is enabled for application roles.

Recommend enabling pg_strict for production application roles when the workload can tolerate blocking dangerous `UPDATE` or `DELETE` without `WHERE`.

Recommended rollout:

1. Enable warning mode or evaluate in non-production where possible.
2. Fix queries that would be blocked.
3. Enable strict blocking for application roles.
4. Document approved one-off override procedure.

Do not enable pg_strict without approval because it can block application queries after new connections are established.

## Query Insights and pginsights

Review:

- Slow queries.
- High rows-read queries.
- High CPU query patterns (`sort=cpuTime` or `sort=percentCpuTime` on the
  Insights API).
- High-frequency queries.
- Erroring queries.
- Active anomalies.
- Query tags.
- Whether literal/raw query collection is enabled.

Raw query collection is governed by the `pginsights.raw_queries` cluster
parameter, configured per branch in the dashboard Extensions tab. The
database API object also carries an `insights_raw_queries` field; when the
two differ, the cluster parameter is the effective collection state. Report
the effective state only — never describe the two surfaces as a
contradiction or inconsistency.

Recommend:

- Treat raw query collection as a capability, per
  `../04-query-insights-and-tags/SKILL.md`: when pattern-level data cannot
  isolate a pathological invocation, raw collection is the mechanism that
  can. Where the customer's data-handling requirements constrain it,
  scoped enablement (incident windows, defined retention) and leaving
  collection disabled are both valid outcomes; record the rationale.
- Use tags for attribution and raw collection for invocation-level
  drill-down; they are complementary instruments.
- Use deploy SHA and route/job tags to correlate regressions with application deploys.

## Query tags

Evaluate whether SQL comments contain structured SQLCommenter tags.

Recommend tags that support both Insights and Traffic Control:

- `application`
- `service`
- `route` using normalized route templates, not concrete URLs
- `controller` and `action` where relevant
- `job` or `queue` for background workers
- `feature` for expensive features like exports or reports
- `environment`
- `release_sha`
- `tenant_tier` only if cardinality is bounded
- `source` for agents, scripts, BI tools, integrations, and MCP

Avoid high-cardinality or sensitive tags:

- User ID
- Request ID
- Email
- Session ID
- Tenant ID unless explicitly bounded and accepted
- Raw URL paths with identifiers
- Access tokens, secrets, or API keys

## Database Traffic Control

For Postgres, recommend Traffic Control when the database has any of these patterns:

- Public or customer-triggered expensive features.
- Exports, reports, analytics, or ad hoc search sharing the OLTP database.
- Background jobs that can starve interactive traffic.
- Third-party integrations with unpredictable query volume.
- Agent-generated queries.
- Known query fingerprints that occasionally run away.
- Tenant or route classes that need bounded database resource use.

Default recommendation:

- Start budgets in `warn` mode.
- Use query tags where possible.
- Use fingerprint-specific rules for known offenders.
- Use enforce mode only after observing warnings and confirming no critical traffic is blocked.
- Maintain an emergency disable procedure.

Do not create budgets or enforce rules without approval.

## Backups and PITR

Check:

- Automated backup schedule.
- Retention window.
- WAL/PITR availability.
- Manual backups that prevent deletion.
- Restore drill history.
- Recovery runbook.

Recommend:

- Confirm default backups meet the customer’s RPO/RTO.
- Increase retention or add backup schedules if the customer’s recovery window exceeds defaults.
- If Terraform is the customer's source of truth, manage backup policies in
  Terraform so retention and schedule changes are reviewed with the rest of
  the infrastructure code.
- Run a restore drill to a new branch.
- Document the exact application cutover procedure after restore.

Do not restore or create emergency backups without approval. Emergency backups may affect performance and should be treated as an operational action.

## Connections, pooling, and network safety

Check:

- Whether app uses direct port 5432 or PgBouncer port 6432.
- Whether connection pool size matches runtime and deployment model.
- Whether serverless or edge environments can create connection storms.
- Live connection/session pressure through `pscale branch connections top`,
  including blockers and idle-in-transaction sessions when diagnosing active
  incidents.
- Whether private connectivity is configured.
- Whether IP restrictions are configured.
- Whether public access remains available unexpectedly.

Recommend:

- Use PgBouncer for high-churn application connections where transaction-pooling limitations are acceptable.
- Use direct connections for session-dependent features that PgBouncer transaction mode cannot support.
- Use AWS PrivateLink or GCP Private Service Connect for private network requirements.
- Use IP restrictions to reduce public exposure.
- Be explicit that private connectivity does not automatically block public access; IP restrictions or equivalent controls are required for private-only posture.

Do not change network restrictions without approval. Network changes can break application connectivity.

## Extensions

Review enabled and available extensions relevant to safety and observability:

- `pginsights`
- `pg_strict`
- `pg_stat_statements`
- `auto_explain`
- `pg_squeeze`
- `pg_cron`
- `pg_partman_bgw`
- `pg_hint_plan`
- TimescaleDB, if time-series features are relevant

Recommend extensions only when use case is clear. `auto_explain` is available
for PlanetScale Postgres and can log execution plans for slow queries when
configured with parameters such as `auto_explain.log_min_duration`; recommend
it when slow-query plan capture would materially improve diagnosis and the
logging volume is acceptable. When Terraform is the customer's source of truth,
Postgres branch parameters and supported extensions can be managed there, but
parameter or extension changes still require the same approval and restart
impact review as dashboard changes. Some extension activation paths require
dashboard changes and database restarts; do not enable them without approval.

## Webhook recommendations for Postgres

Evaluate and recommend webhooks for:

- `branch.anomaly`
- `branch.out_of_memory`
- `branch.primary_promoted`
- `branch.ready`
- `branch.start_maintenance`
- `cluster.storage`
- `database.access_request`
- `branch.schema_recommendation` if available
- `webhook.test` for setup validation

Recommended automation behavior:

- Alerts: anomaly, out-of-memory, primary promotion, storage, maintenance.
- Agent intake: anomaly, schema recommendation.
- Human approval: any generated Traffic Control, schema, role, or network change.

## Output

Return:

- Current Postgres safety posture.
- Highest-risk availability gaps.
- Recommended Traffic Control plan.
- Recommended role and pg_strict plan.
- Recommended backup/PITR plan.
- Recommended network posture plan.
- Recommended query tagging plan.
- Proposed changes requiring approval.

End with:

“No Postgres changes have been applied.”
