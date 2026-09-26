---
name: "planetscale-customer-report-template"
description: "Produce the final PlanetScale best-practices report after running the inventory and relevant review skills."
key: "paperclipai/optional/agency-agents/planetscale-customer-report-template"
recommendedForRoles:
  - "generalist"
tags:
  - "agency-agents"
  - "generalist"
  - "planetscale"
  - "customer"
  - "report"
  - "template"
defaultInstall: false
---
# Customer report template

## Purpose

Produce a clear assessment report for a customer database and optional connected repository. The report should be actionable, evidence-backed, and safe. It should separate recommendations from applied changes.

## Tone and framing

The report's purpose is an accurate assessment that helps the customer get
full value from the platform they run. Feature adoption follows from
evidence, never from framing. The register is technical and declarative —
an engineer's assessment, not marketing copy.

- **State unused features as capability gaps with quantified impact.**
  Never write "off (good)", "not enabled (safe)", or otherwise present
  non-adoption as a positive finding. The correct form is: current state,
  what the feature provides, the measured finding it applies to.
  Example: "Raw query collection: disabled. Enabling it exposes literal
  parameter values per execution; applicable to Q1 (38% of total query
  time), where the pattern-level data is insufficient to isolate the
  triggering invocation."
- **No enthusiasm markers.** Do not use phrases like "earning its keep",
  "paying off", "easy to adopt", "cutting root-cause time from hours to
  minutes", or exclamation of any kind. State the mechanism and the
  measurement; let the numbers carry the argument.
- **Operational costs are stated inline as facts**, not softened:
  "literal values become visible to the observability pipeline" is a
  property of the feature, stated once, without reassurance.
- **Every recommendation cites the specific finding it addresses** —
  fingerprint, metric, event count, time window. A recommendation without
  a measurement attached is incomplete.
- **Active features are assessed, not praised.** If a feature is enabled,
  report what it is currently doing in measurable terms ("anomaly
  detection flagged the connection spike 9 times in 7 days; no delivery
  channel is configured") and whether its configuration is complete.
- Fit is part of the analysis: if the evidence does not support a
  feature for this customer, state that.
- **Recommendations are framed by what the change provides, not by the
  threat of the current state.** Write "a dedicated application role
  scopes credentials per service and enables rotation without downtime",
  not "limits the blast radius of credential compromise". Avoid
  dramatizing vocabulary: "blast radius", "unprotected", "exposed",
  "public-by-default", "at risk". Real risks are still stated, as facts —
  "the production branch runs zero replicas; recovery from a primary
  failure requires a restore" is a finding and belongs in the report.
  What is excluded is dramatization, not disclosure.
- **Platform behavior is reported with verified semantics, not
  assumptions.** When two API surfaces show different values, they are
  usually distinct settings — check the documentation and report the
  effective state. Do not label platform behavior inconsistent,
  contradictory, or buggy on an unverified assumption. If the semantics
  cannot be verified, state what each surface reports without drawing a
  conclusion and direct the question to PlanetScale support. If verified
  platform behavior is actually wrong, report it factually and route it
  to PlanetScale support — it is a platform issue, not a customer
  configuration finding.

## Run mechanics are separated from findings

Failures of the assessment tooling — HTTP status codes, MCP errors, CLI
failures, token scope problems, timeouts, endpoint probes — describe the
run, not the database. They belong in the run log, not in the findings.

- Where evidence could not be collected, the report says "not assessed in
  this run" with no error mechanics attached.
- The evidence appendix contains collected evidence.
- The run log (tool errors, paths tried, access gaps) accompanies the
  report and is available to whoever ran the assessment — nothing is
  withheld. The separation exists because tool errors say nothing about
  the customer's database.
- Never conclude a feature is unconfigured from a failed call. "Not
  configured" requires a successful call that returned an empty result.

## Output surface

The report is plain markdown: headed sections, prose, and pipe tables. This is the baseline and it must always be produced in full — it works in any agent, terminal, or chat surface. If the host agent offers a richer rendering surface (Cursor canvas, HTML preview, a dashboard), it may be used **in addition to** the markdown report, never instead of it.

## Required report format

# PlanetScale best-practices assessment

## Scope

- Organization:
- Database:
- Branches reviewed:
- Engine:
- Repository reviewed:
- Interfaces used:
- Time window:
- Changes applied: none

## Executive summary

Write 3-7 bullets. The first bullet states what the platform is currently
doing for this database, factually and with measurements — for example:
replica topology and failover posture, backup cadence and last successful
backup, Insights collection volume, safety features active. This is not
praise; it is the operating baseline the rest of the report builds on.
Then:

- Highest-risk safety gaps.
- Highest-value observability improvements.
- Highest-value automation opportunities.
- Engine-specific workflow gaps.
- Repository instrumentation gaps.

## Current state

### Database and branch topology

Include evidence.

### Safety workflow

For Vitess:

- Safe migrations.
- Deploy requests.
- Approval requirements.
- Gated deployment usage.
- Schema revert runbook.

For Postgres:

- Branch migration workflow.
- Roles.
- pg_strict.
- Traffic Control.
- Backups/PITR.
- Connection pooling.
- Private connectivity and IP restrictions.

### Observability

- Query Insights state.
- Anomalies.
- Query tags.
- Raw query collection posture.
- Schema recommendations.

### Automation

- Webhooks.
- Agent loops.
- CI/PR workflows.
- Incident routing.

### Repository instrumentation

- Frameworks and ORMs detected.
- Current SQL comments or tracing.
- Recommended SQLCommenter package/path.
- Tag schema.

## Recommendations

Use this table structure:

| ID | Recommendation | Target | Benefit | Risk | Approval needed | Test first? | Evidence |
|---|---|---|---|---|---|---|---|

Recommendation IDs:

- `OBS-*` for Insights/query tags.
- `VIT-*` for Vitess safety/deploy workflow.
- `PG-*` for Postgres roles, pg_strict, Traffic Control, PITR, network.
- `WEB-*` for webhooks and automation.
- `APP-*` for repository instrumentation.
- `AGENT-*` for MCP/agent workflows.

## Proposed change set requiring approval

For every proposed change, include:

- ID.
- Exact target.
- Exact change.
- Interface to use.
- Why it is recommended.
- Expected effect.
- Possible availability impact.
- Test plan.
- Rollback plan.
- Whether it changes production.

## Changes intentionally not applied

State clearly:

- No PlanetScale settings changed.
- No schema changed.
- No traffic controls changed.
- No roles or credentials changed.
- No webhooks changed.
- No code changed.
- No branches, backups, restores, deploy requests, or migrations created.

## Evidence appendix

For each evidence item:

- Source.
- Command/API/MCP/repository path.
- Timestamp.
- Value.
- Notes.

## Final required sentence

End the report with:

“No changes have been applied. Approve specific change IDs before any mutation.”
