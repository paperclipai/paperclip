---
name: "planetscale-schema-recommendations-agent-loop"
description: "Safely triage PlanetScale schema recommendations and turn them into reviewed branches, migrations, issues, or pull requests without applying production changes."
key: "paperclipai/optional/agency-agents/planetscale-schema-recommendations-agent-loop"
recommendedForRoles:
  - "product"
tags:
  - "agency-agents"
  - "product"
  - "planetscale"
  - "schema"
  - "recommendations"
  - "agent"
  - "loop"
defaultInstall: false
---
# Schema recommendations agent loop

## Purpose

Use PlanetScale schema recommendations as high-quality input to agents. Convert recommendations into safe implementation plans, issues, branches, migrations, or pull requests. Do not apply recommendations directly.

## Inputs

Collect:

- Open schema recommendations.
- Recommendation type.
- Affected table, keyspace, schema, and query pattern.
- Suggested DDL.
- Supporting Insights evidence.
- Application repository and migration system.
- Engine: Vitess or Postgres.
- Target branch.

## Recommendation types to recognize

- Add index for inefficient query.
- Remove redundant index.
- Prevent primary key ID exhaustion.
- Drop unused table.
- Upgrade legacy charset or collation.
- Other DDL recommendation.

## Triage questions

For each recommendation, answer:

- Is this still open and relevant?
- Which query patterns triggered it?
- Which application code paths generate those queries?
- Is the recommendation safely expressible in the application’s migration framework?
- Does the ORM/schema source of truth need to change?
- Can it be tested on a non-production branch?
- What is the expected impact on reads, writes, storage, and deploy time?
- Is there a rollback or revert path?
- Is there a competing recommendation or migration?

## Engine-specific implementation path

### Vitess

Recommended path:

1. Create or use a development branch.
2. Apply the schema change to that branch only after approval.
3. Open a deploy request only after approval.
4. Use deploy request review to inspect schema, shard impact, data-loss warnings, lint errors, and conflicts.
5. Use normal safe migration path unless instant deployment is explicitly justified.
6. Deploy only after approval.
7. Monitor Insights and anomaly state after deployment.

Default output before approval: issue or PR with migration proposal, not a live deploy request.

### Postgres

Recommended path:

1. Convert DDL into the application’s migration framework where possible.
2. Test against a non-production branch.
3. Run application tests and relevant query checks.
4. Open PR.
5. Apply production migration only after approval.
6. Use backups/PITR runbook as recovery plan, not as a substitute for migration review.

Default output before approval: migration PR or issue, not production DDL.

## Codebase correlation

When a repository is available:

- Search for the table and column names.
- Search for ORM model definitions.
- Search for migrations.
- Search for query fingerprints, route tags, job names, and controller/action names from Insights.
- Identify whether the recommendation should be implemented in database DDL, ORM schema, raw migration, or application query code.

## Safety checks before proposing implementation

Block direct application when:

- The recommendation is stale or already addressed.
- The affected table is small enough that the benefit is unclear.
- The index would be redundant with an existing index.
- The index would hurt write-heavy workloads without enough read benefit.
- The table appears unused but repository references are ambiguous.
- Dropping a table or index lacks owner confirmation.
- The migration framework has a different schema source of truth.
- The recommendation targets production and no branch/test plan exists.

## Output

For each recommendation, produce:

- Recommendation ID/number.
- Type.
- Severity and expected benefit.
- Evidence from Insights.
- Affected schema.
- Suggested DDL.
- Application code owner or likely location.
- Safe implementation path.
- Validation plan.
- Rollback/revert plan.
- Approval requirement.

End with:

“No schema recommendations have been applied.”
