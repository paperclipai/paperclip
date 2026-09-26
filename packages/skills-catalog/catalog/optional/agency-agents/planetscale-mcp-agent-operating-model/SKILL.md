---
name: "planetscale-mcp-agent-operating-model"
description: "Configure safe agent behavior around PlanetScale MCP, Insights, schema recommendations, and repository work without autonomous production mutation."
key: "paperclipai/optional/agency-agents/planetscale-mcp-agent-operating-model"
recommendedForRoles:
  - "product"
tags:
  - "agency-agents"
  - "product"
  - "planetscale"
  - "mcp"
  - "agent"
  - "operating"
  - "model"
defaultInstall: false
---
# MCP agent operating model

## Purpose

Define how agents should use PlanetScale MCP safely. Agents should use production telemetry to generate useful work while avoiding autonomous production changes.

## Default MCP choice

Use the PlanetScale MCP insights-only server when the task only needs Insights and Schema Recommendations.

Use the full PlanetScale MCP server only when the task explicitly requires database/schema access beyond Insights. Prefer read-only scopes.

The full MCP server has query execution tools. Treat write query tools as disabled unless the operator explicitly approves a specific non-production action or a carefully reviewed production action.

## AGENTS.md guidance

Two different documents both named `AGENTS.md` serve different purposes:

1. **CLI agent guide** — shipped with `pscale` (`AGENTS.md` in the
   [planetscale/cli](https://github.com/planetscale/cli) repo, or
   `pscale agent-guide --format json`). Covers auth, `--format json`, flag
   placement, and `pscale sql`. Load skill `14-pscale-cli-automation` for the
   same conventions inside this skills pack.

2. **Project agent guide** — your application repository's `AGENTS.md` (or
   equivalent). Covers database targeting and approval policy for *this* app.

When working inside a repository, recommend adding a **project** database
targeting section to `AGENTS.md` or equivalent project instructions:

- PlanetScale organization.
- Database.
- Branch.
- Engine: Vitess or Postgres.
- Production branch name.
- Whether agents may use MCP insights-only or full MCP.
- Whether write queries are forbidden.
- Required approval protocol for schema, Traffic Control, webhooks, roles, and network changes.

Do not edit `AGENTS.md` without approval.

## Safe autonomous tasks

Allowed by default:

- Read Insights.
- Read schema recommendations.
- Read schema metadata.
- Read existing webhooks and Traffic Control configuration.
- Read branch metadata.
- Inspect repository code.
- Correlate query patterns with code.
- File issues.
- Open pull requests.
- Create development branches.
- Apply DDL and migrations to non-production development branches.
- Open deploy requests into branches protected by a review workflow.
- Draft Traffic Control budget proposals.
- Draft webhook receiver requirements.

Where a PR + deploy-request workflow exists, the default deliverable for a
schema recommendation is the complete reviewable unit: development branch
with the DDL applied, PR with evidence (fingerprint, metrics, expected
effect), and an open deploy request. The human action is the merge/deploy
decision, not shepherding the proposal into existence.

Not allowed by default (the review-gate actions and non-reviewable mutations):

- Execute write SQL against production.
- Execute DDL directly against production branches.
- Deploy a deploy request / apply schema to production.
- Merge pull requests.
- Create webhooks.
- Create or enforce Traffic Control budgets.
- Rotate credentials.
- Change roles.
- Change IP restrictions or private connectivity.
- Restore or promote branches.

## Agent loops

### Daily recommendation loop

1. Read open schema recommendations.
2. Read top Insights regressions.
3. Correlate with repository code.
4. Generate ranked issues or PRs.
5. Human reviews.
6. Human approves any database-affecting action.

### Anomaly loop

1. Receive or inspect anomaly.
2. Gather affected query patterns and tags.
3. Identify source route/job/deploy.
4. Produce incident note and proposed remediation.
5. If code fix is obvious, open PR.
6. If database change is needed, create a proposed change set only.

### Traffic Control loop

1. Identify unsafe traffic slice from Insights/tags.
2. Draft `warn` budget proposal.
3. Human approves creation.
4. Observe warnings.
5. Human approves enforce mode only after validation.

## Scheduled loops (cron / Automations)

The loops above run interactively. They can also run on a schedule with no
human in the loop, in two tiers. Tier 2 requires a standing authorization
per `../13-autonomous-execution-mode/SKILL.md`; Tier 1 requires none.

Every scheduled loop, both tiers: re-read authorization at run start,
stream status to a configured delivery channel, persist a run log, and
avoid filing duplicates (do not re-file an issue that is already open
for the same fingerprint/recommendation ID).

### Tier 1 — propose through the review workflow (no authorization needed)

- **Recommendation-to-PR loop** (daily): list open schema recommendations
  via MCP; for each new one matching the workflow (additive or destructive
  — the PR review is the gate), create a development branch, apply the
  DDL, open a PR with fingerprint, metrics, and expected effect, and open
  the deploy request. The reviewable unit is complete when a human can
  ship it with one merge/deploy action. Output: branch + PR + deploy
  request per recommendation.
- **Regression watch** (hourly or per-deploy): compare top patterns
  against a stored baseline (p50/p99, rows read, execution count); on
  material regression, identify the deploy SHA from query tags and file
  a report linking pattern to commit range. Output: report.
- **Tag coverage audit** (weekly): measure percentage of query time
  carrying tags; list untagged high-cost patterns with likely code
  paths; open or update a single tracking issue. Output: issue.
- **Anomaly triage** (webhook-triggered, not polled): on `branch.anomaly`,
  gather affected patterns, classify probable cause, post triage note to
  the incident channel. Output: triage note.
- **Posture drift check** (daily): diff current safe-migrations flags,
  webhook config, role list, and backup schedule against the last
  assessment report; report any drift. Output: report.

### Tier 2 — execute the review-gate action (standing authorization required)

- **Recommendation deployer** (daily, after the PR loop): deploy open
  deploy requests that match the allowlist — typically "additive DDL,
  PR approved or authored from an open recommendation, deploy with revert
  window, max N per run" — then verify via schema read-back and an
  Insights follow-up on the target fingerprint. Destructive DDL deploys
  autonomously only when the authorization states a runtime-verifiable
  bound (e.g. "drop only indexes with zero reads in 30 days, confirmed
  via Insights at run time"). Where the org requires PR approval before
  deploy, an approved PR satisfies the review gate and the authorization
  covers only the mechanical deploy.
- **Branch hygiene** (weekly): delete development branches older than the
  authorized age bound with no open deploy request; never touch
  production or protected branches. 
- **Warn-budget gardener** (weekly): create warn-mode Traffic Control
  budgets for newly identified expensive slices matching the allowlist;
  report warn counts on existing budgets. Enforce mode is never entered
  autonomously unless the authorization names the specific budget.
- **Credential expiry enforcement** (daily): delete or flag passwords
  past the authorized max age, only where the authorization lists the
  affected roles and a rotation runbook exists.

### Loop anti-patterns

- Polling MCP on a cron for events webhooks already deliver — use the
  webhook as the trigger; use cron for baselines, sweeps, and audits.
- A Tier 2 loop whose allowlist is an intent ("keep things healthy")
  rather than bounded operations.
- Loops that mutate without a delivery channel for status.
- Unbounded fan-out: one run applying every open recommendation at once
  with no per-run cap.

## Query execution safeguards

For read queries:

- Prefer replicas when available.
- `planetscale_execute_read_query` routes reads to replicas by default when a
  branch has replicas configured (`use_replica: true`). Set
  `use_replica: false` only when the task needs primary-read semantics, such
  as checking immediately-after-write state or primary-only behavior.
- Add source tags/comments for agent work.
- Avoid unbounded scans.
- Avoid `EXPLAIN ANALYZE` on production unless explicitly approved.
- Limit result sizes.
- Avoid querying sensitive columns unless required and approved.
- For Postgres tables with row-level security, remember that the MCP read role
  uses `pg_read_all_data` and does not bypass RLS. If a read query returns zero
  rows or a zero count and the MCP response warns that RLS may be filtering
  results, treat the result as policy-filtered/unknown until confirmed through
  an approved path; do not conclude the table is empty.
- When debugging high CPU on Postgres, use Insights data sorted by CPU
  usage (via MCP where available, or `sort=cpuTime` on the Insights API).
  CPU time metrics are Postgres-only; do not ask for the same CPU-sorted
  view on Vitess.

For write queries:

- Default is forbidden.
- If approved, prefer non-production branch.
- Require exact SQL review.
- Require rollback plan.
- Require branch and database name confirmation.

## Output

Return:

- Recommended MCP server choice.
- Required scopes.
- AGENTS.md instructions to add.
- Allowed autonomous work.
- Disallowed work.
- Proposed agent loops.
- Approval gates.

End with:

“No MCP write tools or database mutations have been used.”
