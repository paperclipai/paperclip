---
name: "planetscale-webhook-automation-recommendations"
description: "Recommend webhook subscriptions and safe automation patterns for PlanetScale alerts, anomalies, schema recommendations, deploy requests, and agent workflows."
key: "paperclipai/optional/agency-agents/planetscale-webhook-automation-recommendations"
recommendedForRoles:
  - "operations"
tags:
  - "agency-agents"
  - "operations"
  - "planetscale"
  - "webhook"
  - "automation"
  - "recommendations"
defaultInstall: false
---
# Webhook automation recommendations

## Purpose

Review and recommend PlanetScale webhooks that notify humans and trigger safe automation. Do not create or update webhooks without approval.

## Webhook design principle

Webhooks may trigger automation, but automation must produce recommendations, issues, branches, or pull requests by default. It must not directly mutate production databases or production application behavior without explicit human approval.

## Events to evaluate

### General and Postgres

- `branch.anomaly`: new Insights anomaly.
- `branch.out_of_memory`: Postgres out-of-memory event.
- `branch.primary_promoted`: primary failover/promotion.
- `branch.ready`: branch created and ready.
- `branch.sleeping`: branch sleeping.
- `branch.start_maintenance`: maintenance starting.
- `cluster.storage`: storage threshold or growth event.
- `database.access_request`: access request.
- `branch.schema_recommendation`: schema recommendation event when available.
- `webhook.test`: test event.

### Vitess deploy lifecycle

- `deploy_request.opened`
- `deploy_request.queued`
- `deploy_request.in_progress`
- `deploy_request.pending_cutover`
- `deploy_request.schema_applied`
- `deploy_request.errored`
- `deploy_request.reverted`
- `deploy_request.closed`
- `keyspace.storage`

## Recommended routing

### Human alerting

Send these to incident or operations channels:

- `branch.anomaly`
- `branch.out_of_memory`
- `branch.primary_promoted`
- `branch.start_maintenance`
- `cluster.storage`
- `keyspace.storage`
- `deploy_request.errored`
- `deploy_request.reverted`

### Engineering notification

Send these to Slack, Linear/Jira, or deployment channels:

- `deploy_request.opened`
- `deploy_request.queued`
- `deploy_request.in_progress`
- `deploy_request.pending_cutover`
- `deploy_request.schema_applied`
- `deploy_request.closed`
- `branch.schema_recommendation`

### Agent intake queue

Send these to an agent-safe workflow:

- `branch.anomaly`
- `branch.schema_recommendation`
- `deploy_request.errored`
- `cluster.storage`
- `keyspace.storage`

Agent output may include, without approval:

- Triage summary, probable cause, linked Insights/query patterns.
- Recommended schema, code, Traffic Control, or operational change.
- Pull request against application code.
- Development branch with DDL or migration applied.
- Open deploy request into a review-protected branch.
- Issue or ticket.

Agent output must not cross the review gate on its own: no production
deploys, PR merges, Traffic Control enforcement, credential rotation, or
network changes — those require human action or a standing authorization
per `../13-autonomous-execution-mode/SKILL.md`.

## Webhook receiver requirements

Recommend only receivers that meet these requirements:

- HTTPS endpoint.
- Fast 2xx response; expensive work is queued asynchronously.
- No dependency on following redirects.
- Signature verification using PlanetScale webhook signature header and the webhook secret.
- Idempotency by event ID or timestamp/resource tuple.
- Dead-letter queue or retry-safe logging.
- Human-readable audit trail.
- Clear owner and escalation path.
- Secret rotation procedure.

## Recommended automation flows

### Anomaly to PR flow

1. Receive `branch.anomaly`.
2. Verify signature.
3. Queue job.
4. Fetch anomaly details and relevant Insights query patterns.
5. Locate code path by SQLCommenter tags and repository search.
6. Classify as schema, code, Traffic Control, or unknown.
7. Generate report and optional PR.
8. Ask human to approve database-affecting work.

### Schema recommendation to branch/deploy flow

For Vitess:

1. Receive `branch.schema_recommendation`.
2. Fetch recommendation details.
3. Apply the DDL to a development branch.
4. Open a pull request with fingerprint, metrics, and expected effect.
5. Open the deploy request — the DR and PR together are the reviewable
   unit; opening them requires no approval.
6. Deploy on human approval, or autonomously under a standing
   authorization that allowlists this deploy class
   (`../13-autonomous-execution-mode/SKILL.md`).

For Postgres:

1. Receive `branch.schema_recommendation`.
2. Fetch recommendation details.
3. Convert DDL to application migration.
4. Test on a non-production branch and record the result in the PR.
5. Open PR.
6. Apply to production on merge via the deployment pipeline, or on
   explicit approval where no pipeline exists.

### Deploy request lifecycle flow for Vitess

- Notify when opened.
- Validate owner and linked application PR.
- Alert when queued or in progress.
- Alert strongly when errored or reverted.
- Notify pending cutover and require owner acknowledgement for gated deployments.
- Record schema applied and correlate with application deploy.

## Anti-patterns to block

Do not recommend:

- Webhook directly runs production DDL, bypassing the PR/deploy-request
  workflow. (Driving the DDL through a branch, PR, and deploy request is
  the supported pattern, not an anti-pattern.)
- Webhook applies schema recommendations straight to production with no
  reviewable artifact.
- Webhook directly enforces Traffic Control.
- Webhook directly changes IP restrictions.
- Webhook directly rotates credentials.
- Webhook posts secrets or raw SQL with literals into public Slack channels.
- Webhook receiver ignores signature verification.
- Webhook receiver does long-running work before returning 2xx.

## Output

Return:

- Existing webhook inventory.
- Missing recommended subscriptions.
- Destination quality review.
- Signature verification status.
- Automation opportunities.
- Unsafe automation risks.
- Proposed webhook changes requiring approval.

End with:

“No webhooks or automation endpoints have been created, updated, or deleted.”
