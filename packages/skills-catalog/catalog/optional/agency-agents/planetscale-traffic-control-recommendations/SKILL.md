---
name: "planetscale-traffic-control-recommendations"
description: "Build a safe recommendation plan for PlanetScale Postgres Database Traffic Control budgets and rules without applying them."
key: "paperclipai/optional/agency-agents/planetscale-traffic-control-recommendations"
recommendedForRoles:
  - "engineer"
  - "designer"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "planetscale"
  - "traffic"
  - "control"
  - "recommendations"
defaultInstall: false
---
# Database Traffic Control recommendations

## Purpose

For PlanetScale Postgres, recommend Traffic Control budgets and rules that protect critical traffic from runaway queries, traffic spikes, batch jobs, agents, and third-party integrations. Do not create or change budgets without approval.

## Preconditions

Run this skill only for PlanetScale Postgres.

Before recommending rules, inspect:

- Current budgets and rules.
- Insights query patterns.
- Current query tags.
- Application routes and jobs.
- Known critical paths.
- Known expensive non-critical paths.
- Active incidents or recent anomalies.

If query tags are missing, recommend tagging first unless a fingerprint-specific rule is clearly needed for an immediate known offender.

## Candidate traffic slices

Look for:

- Exports.
- Reports.
- Search endpoints.
- Admin dashboards.
- Backfills.
- Workers and queues.
- Webhooks from third-party systems.
- BI tools.
- Agent-generated read queries.
- High-frequency polling.
- Known expensive query fingerprints.
- Customer-triggered endpoints with high variance.

## Budget modes

Recommend in this order:

1. `warn` mode first for normal rollout.
2. Observe warnings and false positives.
3. Tune tags, fingerprints, and thresholds.
4. Move to `enforce` only with explicit approval and an emergency rollback path.

Do not recommend starting directly in `enforce` unless there is an active incident and the operator explicitly asks for emergency mitigation.

## Rule strategy

Prefer tag-based rules when tags are stable and bounded:

- `source=agent`
- `source=bi`
- `feature=export`
- `feature=report`
- `route=/admin/reports`
- `job=DailyBackfill`
- `service=analytics-worker`

Use fingerprint rules when:

- A specific known query pattern is dangerous.
- Tagging is missing or unreliable.
- The query source is hard to attribute.

Use a separate budget for each materially different traffic class.

Do not combine unrelated traffic in one budget because it hides who is consuming the budget.

## Suggested default budgets

Use these as recommendation patterns, not as values to apply blindly.

### Agent budget

Target: queries tagged `source=agent` or `source=mcp`.

Intent: prevent agents from starving application traffic.

Mode: start in `warn`.

Recommendation: agents should prefer replicas and read-only scopes. Writes require human approval.

### Export/reporting budget

Target: `feature=export`, `feature=report`, or specific report route/job.

Intent: keep customer-triggered reporting from consuming all database resources.

Mode: start in `warn`; consider `enforce` after observation.

### Background job budget

Target: worker service, queue, or job tags.

Intent: prevent backfills and retries from starving interactive traffic.

Mode: `warn` first; enforce only after confirming queue backpressure behavior.

### Third-party integration budget

Target: `source=integration`, partner-specific bounded tags, or route templates for inbound integration calls.

Intent: isolate unpredictable partner behavior.

Mode: `warn` first.

### Known fingerprint budget

Target: specific expensive query fingerprint.

Intent: contain a known pathological query while code or schema fixes are developed.

Mode: `warn` first unless emergency.

## “Each tag value” strategy

When PlanetScale supports applying a budget separately for each unique value of a selected tag, recommend it for bounded tags such as:

- `application`
- `service`
- `route` when normalized
- `job`
- `feature`
- `source`

Do not recommend it for unbounded tags such as user IDs, request IDs, raw tenant IDs, emails, UUIDs, or raw URLs.

## Limits and caveats to include

Every recommendation must explain:

- Traffic Control limits resource use; it does not replace query tuning.
- It is not a web application firewall.
- It does not replace application-level rate limits.
- Limits are guardrails, not exact guarantees for every failure mode.
- Bad tags create bad rules.
- Enforce mode can reject queries and affect application behavior.

## Output format

For each proposed budget:

- Budget name.
- Target branch.
- Mode: off, warn, or enforce.
- Matched traffic slice.
- Rule type: tag, fingerprint, keyspace, query kind.
- Proposed tags or fingerprint.
- Limit rationale.
- Queries seen in Insights that justify it.
- Safety risk.
- Test/observe plan.
- Rollback plan.
- Approval requirement.

End with:

“No Traffic Control budgets or rules have been created, updated, deleted, or enforced.”
