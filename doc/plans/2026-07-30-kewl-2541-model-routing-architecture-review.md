# KEWL-2541 Model-Routing Policy — Architecture Review

Date: 2026-07-30
Status: Merge-blocking review for KEWL-2529
Refs inspected: `master`, `kewl-2523-model-routing` (`9d10f44eb`), `kewl-2520-integration` (`a9c9fd0e6`)

## Recommended architecture

Keep model-routing enforcement company-scoped and disabled by default. Do not treat the current `codex`-only defaults as a simple typo: the live roster has 24 agents, split as `claude_local` 15, `codex_local` 8, and `hermes_gateway` 1, so routing implementation-heavy classes to Codex may be an intentional product policy. The merge decision needs an explicit operator choice between:

1. codex-preferred policy: keep coding/tests/inspection/routine QA on `codex`, but ship stronger fallback assignment workflows so non-Codex agents do not silently churn;
2. mixed-fleet policy: allow `sonnet` and/or `opus` for the high-volume classes the company currently assigns to Claude-lane agents;
3. opt-in-only policy: keep `DEFAULT_MODEL_ROUTING_POLICY.enabled = false` and prevent any seeded/materialized revision from enabling enforcement without a board action visible in activity.

The non-negotiable architecture change is bounded mismatch handling. A refused workload must create an operator-visible state, not only a skipped wake request and periodic activity rows. Recommended behavior:

- first mismatch: write one deduplicated activity event with the decision fields and mark the wake request skipped;
- repeated mismatch for the same issue/agent/policy/workload/lane tuple: cap retries after a small count or time window;
- cap exceeded: surface a first-class blocker or issue status reason naming the rejected lane, workload class, policy revision, and suggested remedies;
- board override: require explicit board authorization, stamp author/time/reason, and log the override as a mutation.

The classifier fallback should also be tightened before deployment. `unclassified -> deny` broke routine reassignment to Architecture Guardian. If `unclassified` stays deny-by-default, the board must see that classification at assignment time and be able to correct it before dispatch.

## Risks

- Security: Board override metadata must be server-stamped. Agents must not be able to self-authorize lane exceptions.
- Data integrity: Routing decisions must remain company-scoped and tied to the policy revision used at evaluation time.
- Operational: `onMismatch: queue` currently has no bounded retry or surfaced blocker, so a valid policy can still create an invisible dispatch outage.
- Product: Widening defaults to all Claude lanes may defeat the intended cost/control policy if codex-only routing was deliberate.

## Migration impact

- Files affected: `packages/db/src/schema/company_model_routing_policies.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/migrations/0196_company_model_routing_policies.sql`, `packages/db/src/migrations/0197_usage_governor_budget_provider.sql`, `packages/db/src/migrations/meta/_journal.json`.
- Downtime: no expected runtime downtime for additive tables, but deployment must not auto-apply out-of-sequence migration journals without an explicit reconciliation.
- Rollback plan:
  1. Before deploy, snapshot the production database and export the migration journal state.
  2. Confirm whether the production `company_model_routing_policies` row is neutralized or intentionally enabled.
  3. If the deployment causes refusals, immediately disable the company policy row or roll back the application to the last known-good build.
  4. If migrations were applied, do not drop routing/governor tables as the first rollback step; preserve data and remove only after a reviewed down-migration or manual retention decision.

## Files likely affected

- `packages/shared/src/model-routing-policy.ts`
- `server/src/services/model-routing-policy.ts`
- `server/src/services/heartbeat.ts`
- `server/src/routes/model-routing-policy.ts`
- `server/src/routes/issues.ts`
- `server/src/__tests__/model-routing-policy-routes.test.ts`
- `server/src/services/model-routing-policy.test.ts`
- `doc/MODEL-ROUTING-POLICY.md`
- `doc/DATABASE.md`
- `packages/db/src/migrations/meta/_journal.json`

## What must be tested

- Pre-deploy: Evaluate the policy against the live roster, not only fixtures. Current live roster evidence from the Paperclip API: 24 agents total; `claude_local` 15, `codex_local` 8, `hermes_gateway` 1.
- Pre-deploy: Replay the observed outage classes (`tests` and `coding`) against the agents that actually received work in the outage window and at least one Codex-lane agent. The corrected claim is that 473 of 473 evaluations that occurred were refused; it does not prove Codex-lane agents would be refused.
- Pre-deploy: Force a mismatch and verify what the board sees after the first refusal and after retry exhaustion.
- Pre-deploy: Force an `unclassified` assignment/reassignment and verify the board can see and correct the classification before dispatch is lost.
- Post-deploy: Watch activity for `route_mismatch` counts, skipped wake requests, issue status/blocker transitions, and any policy revision changes.
- Post-deploy: Verify the model-routing policy endpoint exposes the expected effective policy on the deployed code. On the rolled-back `master` server during this review, `/api/companies/:companyId/model-routing-policy` returned 404, so live policy rows cannot be inspected through that endpoint until KEWL-2529 code is deployed.

## Approval gates

- Jon must explicitly approve enabling a company model-routing policy in production.
- Jon must explicitly approve any production migration application or migration journal reconciliation.
- Jon must explicitly approve any default rule widening that changes the intended lane/cost policy.
- Jon must explicitly approve any cleanup or neutralization of an already-materialized production policy row if it mutates production state.

## Decision rationale

The safest merge posture is not "include Claude lanes everywhere" and not "keep codex-only and trust activity logs." The corrected roster data shows Codex is a meaningful lane, so the default may be intentional. The outage evidence shows the enforcement path is operationally unsafe because refused work can remain queued without a board-visible terminal or blocked condition. Therefore KEWL-2529 should be considered deployable only after mismatch handling is observable and bounded, the classifier fallback is visible/correctable, and the migration journal drift is reconciled.

Migration evidence:

- `master`: `_journal.json` has 145 entries; last tag `0146_routine_activity_gate`.
- `kewl-2523-model-routing` (`9d10f44eb`): `_journal.json` has 195 entries; last tag `0196_company_model_routing_policies`.
- `kewl-2520-integration` (`a9c9fd0e6`): `_journal.json` has 147 entries; last three tags are `0146_routine_activity_gate`, `0196_company_model_routing_policies`, `0197_usage_governor_budget_provider`.
- This confirms the integration branch appends `0196`/`0197` after `0146`, while another local routing ref contains the larger `0147` through `0196` journal sequence. That is enough drift to block merge until the intended migration lineage is named and reconciled.
