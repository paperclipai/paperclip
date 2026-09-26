---
name: "planetscale-readonly-inventory"
description: "Collect read-only evidence about PlanetScale org, database, branches, webhooks, backups, roles, Insights, recommendations, and traffic configuration."
key: "paperclipai/optional/agency-agents/planetscale-readonly-inventory"
recommendedForRoles:
  - "engineer"
  - "researcher"
tags:
  - "agency-agents"
  - "engineer"
  - "researcher"
  - "planetscale"
  - "readonly"
  - "inventory"
defaultInstall: false
---
# Read-only inventory

## Purpose

Build an evidence-backed inventory of a PlanetScale database without making changes.

## Allowed actions

Allowed by default:

- List organizations, databases, branches, keyspaces, regions, and sizes.
- Read branch metadata.
- Read webhook configuration.
- Read schema recommendations.
- Read Query Insights, anomalies, and query patterns through MCP or API.
- Read traffic budgets and rules.
- Read Postgres roles and non-secret role metadata.
- Read backup schedules and restore metadata.
- Read branch schema.
- Inspect live connection/session metadata with the Connections CLI view.
- Inspect repository files for frameworks, ORMs, migrations, SQL tagging, and connection config.
- Inspect Terraform or other infrastructure-as-code definitions for
  PlanetScale roles, backups, backup policies, Postgres parameters, and
  supported extensions.

Not allowed without explicit approval:

- Any create, update, delete, enable, disable, reset, deploy, restore, promote, enforce, or apply operation.
- Any SQL mutation.
- Any command that emits new credentials unless the operator explicitly asked for credential work.

## Interfaces and documentation grounding

Ground every command and endpoint in the official documentation instead of
guessing. PlanetScale publishes agent-readable docs:

- Docs index: https://planetscale.com/docs/llms.txt
- Any docs page as markdown: append `.md` to its URL
- API reference: https://planetscale.com/docs/openapi.yaml (OpenAPI 3.0)

Verify an endpoint path in the API reference before calling it. A 404 from
an unverified path is a wrong path, not a finding; do not record it as
platform state and do not conclude "not configured" from it.

Verified interface notes (recheck against the docs when a command fails):

- `pscale database show <database> --org <org>` — the org is a flag, not a
  positional argument.
- `pscale api <path>` takes org-relative paths such as
  `organizations/{org}/databases/{db}/branches/{branch}` — there is no
  `get` subcommand and no `/v1/` prefix. Pass query parameters with
  `-Q key=value` flags; embedding `?`/`&` in the path breaks under shell
  globbing.
- `pscale webhook list <database> --org <org>` — the database is a
  positional argument. `pscale backup list <database> <branch>` requires
  the branch.
- `pscale branch connections top <database> <branch>` — live read-only
  session inventory works for Postgres and Vitess over a reserved
  administrative connection. Do not cancel queries or terminate connections
  unless the operator explicitly approves that operational action.
- Query Insights is public API. Live query telemetry:
  `.../branches/{branch}/insights` (per-pattern statistics; supports
  `from`/`to`/`period`, `q`, `sort`, `dir`, `tablet_type`, `type`,
  `fields`, and pagination). Related endpoints under the same branch path:
  `insights/errors`, `insights/anomalies`, `insights/tags`,
  `insights/tags/summaries`, `insights/{fingerprint}` (individual
  executions), `insights/{fingerprint}/summary`, and
  `insights/{fingerprint}/traffic/budgets`. The `query-patterns` path
  returns generated report metadata, not live patterns.
- Traffic budgets: `.../branches/{branch}/traffic/budgets`. The CLI has no
  `pscale traffic-control budget list`; use the API for inventory.
- Postgres roles: list via `.../branches/{branch}/roles`; fetch a single
  role by ID, not name (`pscale role get <db> <branch> <role-id>`).
- IP restrictions: database-level
  `organizations/{org}/databases/{db}/cidrs`. Branch-level IP-restriction
  paths are not valid.
- Schema recommendations: database-level
  `.../databases/{db}/schema-recommendations` (the branch-level path is
  not valid). Requesting `page=2` currently returns 404 even when the
  response reports `next_page`; use the database object's
  `open_schema_recommendations_count` as the authoritative total, treat
  the returned page as a sample, and state in the report when the itemized
  list covers only part of the total.
- PITR state and branch-level backup policies have no verified read path;
  record backup posture from `pscale backup list` and the database-level
  backup policy, and mark PITR "not assessed in this run" rather than
  probing paths.
- List endpoints paginate; follow the pagination parameters until
  exhausted before reporting counts (except the schema-recommendations
  case above).

Record access failures (403s, missing token scopes, timeouts) in the
internal run log for the operator. They are not findings and do not enter
the customer report (see `../10-customer-report-template/SKILL.md`).

## Inventory checklist

### Database identity

Record:

- Organization.
- Database.
- Branch.
- Engine: Vitess or Postgres.
- Region and cloud provider.
- Production/development branch status.
- Branch protection and safe workflow state.
- Size and cluster shape.

### Branches and schema workflow

For Vitess, record:

- Production branch.
- Whether safe migrations are enabled for production and staging branches.
- Open deploy requests.
- Deploy request approval setting.
- Pending schema changes.
- Whether branch strategy has a staging branch with safe migrations enabled.

For Postgres, record:

- Branch list.
- Whether branches were created from backup or empty.
- Whether schema changes are managed manually, through migrations, or through an ORM.
- Whether a separate branch is used for migration testing.
- Whether the team expects Vitess-style deploy requests; if yes, flag that Postgres branches do not use deploy requests in the same way.

### Observability

Record:

- Insights availability.
- Whether query tags are present.
- Which tags appear.
- Whether high-cardinality tags are present.
- Whether complete/raw query collection is enabled.
- Active anomalies.
- Query patterns with high latency, high rows read, high error rate, or high execution count.
- Postgres CPU-heavy query patterns and Vitess vindex-usage data when exposed
  by the Insights interface in use.
- Whether application deploy identifiers are visible in comments or tags.

### Recommendations

Record:

- Open schema recommendations.
- Recommendation type.
- Affected table/query.
- Proposed DDL or action.
- Whether a branch/deploy workflow exists to evaluate it safely.
- Whether the recommendation can be implemented as application code, ORM migration, or database DDL.

### Webhooks and automation

Record:

- Configured webhooks.
- Subscribed events.
- Enabled state.
- Last delivery success or failure.
- Destination category: Slack, PagerDuty, internal automation, CI, agent queue, unknown.
- Whether webhook signature verification is documented or implemented.
- Whether webhook handling is idempotent and asynchronous.

### Postgres Traffic Control

For Postgres only, record:

- Existing budgets and rules.
- Budget modes: off, warn, enforce.
- Limits: rate, capacity, burst, concurrency, warning threshold.
- Rules by fingerprint, keyspace, query kind, or tags.
- Whether rules are tied to meaningful SQLCommenter tags.
- Whether any production budget is in enforce mode.

### Postgres safety

For Postgres only, record:

- Application role usage.
- Whether apps use the default role.
- Whether app roles are least-privilege.
- Whether pg_strict is enabled for application roles.
- Whether PgBouncer is used for appropriate workloads.
- Whether live connections show blockers, idle-in-transaction sessions, or
  connection saturation during an active incident.
- Whether private connectivity and IP restrictions are configured.
- Whether backup retention and PITR meet the customer’s recovery expectations.

### Vitess safety

For Vitess only, record:

- Safe migrations state.
- Deploy request workflow.
- Admin approval requirement.
- Gated deployment usage.
- Schema revert availability.
- Branch and keyspace topology.
- Sharding/vschema status.
- Whether sharded query patterns use relevant vindexes.
- Backups and restore posture.

## Evidence format

For every finding, include evidence:

- Source: MCP, CLI, API, dashboard-observed, SQL read-only, repository file.
- Path or command used.
- Timestamp.
- Raw value or concise excerpt.
- Confidence: high, medium, low.

## Output

Return:

- Inventory table.
- Missing evidence table.
- Risk flags.
- Recommended next skills to run.

End with:

“No changes have been applied.”
