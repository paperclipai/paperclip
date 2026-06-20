# Micro pod experiment registry schema and dependency-request queue

Status: proposed canonical record contract
Owner: Micro Research Director
Date: 2026-06-20
Issue: MIC-6

## Purpose

This document defines the minimum canonical records needed to run Micro as a disciplined research factory without turning Paperclip into the trading system. The registry is an audit/control-plane layer: it records hypotheses, pods, blockers, resource assignments, metrics, verdicts, evidence packs, and promotion requests. It does not execute experiments, allocate broker credentials, or bypass approval gates.

The schema is intentionally narrow and company-scoped. Every record must be traceable to a Paperclip issue, an agent owner, and a durable evidence artifact.

## Non-negotiable invariants

1. No experiment starts from an unregistered pod.
2. No pod moves to `approved_to_run` without an evidence-linked pre-registration and explicit dependency state.
3. No result can be promoted without a verdict, evidence pack, and promotion request.
4. Compute, data, and broker resources are assignments with owners and expiry, not free-text notes.
5. Dependency requests are queueable blockers: they route to platform roles, preserve provenance, and have terminal resolution states.
6. Micro remains propose-only unless a board-approved execution role explicitly owns the run.

## Entity overview

- `micro_experiments`: one hypothesis/test unit. Owns thesis, source, lifecycle state, metrics, verdict, evidence, promotion link, and resource assignments.
- `micro_pods`: bounded research pods that can contain one or more experiments pursuing the same thesis family or instrument class.
- `micro_dependency_requests`: platform/resource blockers raised by pods or experiments and routed to operational roles.
- `micro_resource_assignments`: immutable-ish assignment ledger for compute, data, and broker capabilities.
- `micro_metric_observations`: normalized metric snapshots used in verdicts and promotion review.
- `micro_evidence_packs`: durable bundle reference for preregistration, run outputs, notebooks/logs, adversarial review, and verdict.
- `micro_promotion_requests`: explicit request to move from research evidence to any deployment-facing next step.

## `micro_pods`

A pod is a constrained research container. It exists so the board can see capacity and blockers before experiments multiply.

Required fields:

- `pod_id`: UUID, primary key.
- `company_id`: UUID, required.
- `paperclip_issue_id`: UUID, required, parent/coordinating issue.
- `identifier`: stable human key, e.g. `MPOD-2026-06-WIDESPREAD-MAKER`.
- `title`: short descriptive name.
- `source`: enum: `paper | operator | ledger_gap | monitoring_signal | postmortem | external_request`.
- `thesis`: markdown/plain text statement of what would be true if the pod succeeds.
- `owner_agent_id`: UUID, required.
- `lifecycle_state`: enum below.
- `improvement_attempt_count`: integer default 0. Increment only when a new registered attempt is made after a non-GO verdict.
- `dependencies`: JSON array of dependency request ids or summarized dependency specs.
- `compute_assignment_id`: UUID nullable.
- `data_assignment_id`: UUID nullable.
- `broker_assignment_id`: UUID nullable.
- `evidence_pack_id`: UUID nullable.
- `promotion_request_id`: UUID nullable.
- `created_at`, `updated_at`, `closed_at`.

Lifecycle states:

- `draft`: idea exists, not yet preregistered.
- `preregistering`: preregistration being written/reviewed.
- `waiting_on_dependencies`: blocked on one or more open dependency requests.
- `ready_for_board_review`: preregistration and dependency plan ready; no execution approval yet.
- `approved_to_run`: board/operator approved run outside Micro propose-only mode.
- `running`: execution owner reports active run.
- `evidence_review`: run finished; verdict/evidence pack under review.
- `revision_requested`: board/adversarial pass requires a bounded revision.
- `killed`: pod hypothesis failed or violates kill-list/constraints.
- `promoted`: promotion request approved for downstream owner.
- `archived`: inactive historical pod.

Indexes:

- `(company_id, lifecycle_state)`.
- `(company_id, owner_agent_id, lifecycle_state)`.
- unique `(company_id, identifier)`.

## `micro_experiments`

An experiment is the falsifiable unit. One experiment has one frozen decision rule.

Required fields:

- `experiment_id`: UUID, primary key.
- `company_id`: UUID, required.
- `pod_id`: UUID, required.
- `paperclip_issue_id`: UUID, required, issue doing the work.
- `source`: enum: `paper | operator | ledger_gap | monitoring_signal | inherited_prereg | postmortem`.
- `source_ref`: text/JSON nullable; DOI/arXiv URL/ledger section/issue id.
- `thesis`: falsifiable hypothesis text.
- `preregistration_ref`: durable file/artifact/document reference.
- `decision_rule`: structured JSON with numeric GO/KILL/PARTIAL/INCONCLUSIVE thresholds.
- `lifecycle_state`: same state family as pods, but experiment-scoped.
- `improvement_attempt_count`: integer default 0.
- `dependencies`: JSON array of dependency request ids/specs.
- `compute_assignment_id`: UUID nullable.
- `data_assignment_id`: UUID nullable.
- `broker_assignment_id`: UUID nullable.
- `metrics`: JSON object containing latest normalized metrics and pointers to `micro_metric_observations`.
- `verdict`: enum nullable: `go | kill | partial | inconclusive | withdrawn`.
- `verdict_ref`: durable verdict doc/artifact reference nullable.
- `evidence_pack_id`: UUID nullable.
- `promotion_request_id`: UUID nullable.
- `created_by_agent_id`: UUID nullable.
- `approved_by_user_id`: text nullable.
- `approved_at`, `started_at`, `completed_at`, `created_at`, `updated_at`.

Decision-rule minimum shape:

```json
{
  "primary_metric": "net_ev_bps_after_fees",
  "go": [{ "metric": "net_ev_bps_after_fees", "op": ">=", "value": 0.0 }],
  "kill": [{ "metric": "min_cell_n", "op": ">=", "value": 800 }, { "metric": "net_ev_bps_after_fees", "op": "<", "value": 0.0 }],
  "partial": [{ "metric": "capacity_flag", "op": "=", "value": "limited" }],
  "inconclusive": [{ "metric": "min_cell_n", "op": "<", "value": 800 }],
  "toxicity_gates": ["adverse_selection_bps", "fill_rate", "cancel_rate"],
  "cost_model_ref": "fee schedule / harness version"
}
```

Indexes:

- `(company_id, pod_id)`.
- `(company_id, lifecycle_state)`.
- `(company_id, verdict)`.
- unique `(company_id, paperclip_issue_id)` when the issue is a primary experiment issue.

## `micro_dependency_requests`

Dependency requests are the queue that turns pod blockers into platform-role work. They should usually be represented as Paperclip issues too, but this registry record supplies the canonical state machine and routing metadata.

Required fields:

- `dependency_request_id`: UUID, primary key.
- `company_id`: UUID, required.
- `pod_id`: UUID nullable but expected.
- `experiment_id`: UUID nullable.
- `paperclip_issue_id`: UUID nullable; blocker/work issue if materialized.
- `requested_by_agent_id`: UUID required.
- `route_to_role`: enum: `platform_engineering | data_engineering | infra | broker_ops | quant_review | security | board | external_vendor`.
- `request_kind`: enum: `compute | data | broker | harness | permissions | review | clarification | external_access`.
- `title`: short blocker title.
- `body`: detailed request, including why it matters to the decision rule.
- `required_capability`: text/JSON; e.g. `hl_l2_memecoin_perps`, `cpu_backfill_8h`, `fusion_adversarial_pass`.
- `urgency`: enum: `critical | high | medium | low`.
- `status`: enum below.
- `blocking_state`: enum: `blocking_run | blocking_review | nonblocking | informational`.
- `owner_agent_id`: UUID nullable after assignment.
- `owner_user_id`: text nullable.
- `resolution_summary`: text nullable.
- `resolved_artifact_ref`: durable artifact/doc URL nullable.
- `created_at`, `updated_at`, `accepted_at`, `resolved_at`, `cancelled_at`.

Dependency request statuses:

- `requested`: created and awaiting triage.
- `triaged`: accepted as valid but unassigned.
- `assigned`: platform role/owner attached.
- `in_progress`: owner actively resolving.
- `waiting_external`: blocked outside Paperclip.
- `fulfilled`: dependency delivered and linked.
- `rejected`: dependency will not be supplied; must include reason.
- `superseded`: replaced by another request.
- `cancelled`: no longer needed.

Routing defaults:

- `compute` -> `infra` unless it requires harness changes, then `platform_engineering`.
- `data` -> `data_engineering`.
- `broker` -> `broker_ops`.
- `harness` -> `platform_engineering`.
- `review` -> `quant_review` or `board` depending on approval level.
- `permissions` -> `security` for credentials/secrets; `board` for policy exceptions.

Queue views:

- Role inbox: open statuses grouped by `route_to_role`, then urgency and age.
- Pod blocker view: all nonterminal requests for a `pod_id`.
- Experiment gate view: dependency requests with `blocking_state != nonblocking` and status not terminal.

Terminal statuses: `fulfilled | rejected | superseded | cancelled`.

## `micro_resource_assignments`

Assignments make resource usage auditable and revocable.

Required fields:

- `resource_assignment_id`: UUID, primary key.
- `company_id`: UUID, required.
- `pod_id`: UUID nullable.
- `experiment_id`: UUID nullable.
- `assigned_by_user_id`: text nullable.
- `assigned_by_agent_id`: UUID nullable.
- `resource_type`: enum: `compute | data | broker`.
- `resource_ref`: text/JSON. Must avoid raw secrets.
- `scope`: text/JSON describing allowed use.
- `limits`: JSON, e.g. max hours, symbols, date ranges, API quotas, sandbox/live boundary.
- `expires_at`: timestamp nullable, required for broker and paid data access.
- `status`: enum: `requested | assigned | active | exhausted | revoked | expired`.
- `created_at`, `updated_at`.

Invariant: broker assignments must explicitly state `sandbox`, `paper`, or `live`, and live must require a promotion/approval link.

## `micro_metric_observations`

Metrics are append-only observations; latest summaries are copied into `micro_experiments.metrics` for fast reading.

Required fields:

- `metric_observation_id`: UUID, primary key.
- `company_id`: UUID, required.
- `experiment_id`: UUID required.
- `metric_name`: text required.
- `metric_value`: numeric or text required.
- `unit`: text nullable, e.g. `bps`, `trades`, `usd`, `ratio`.
- `sample_count`: integer nullable.
- `cell_key`: text/JSON nullable.
- `harness_ref`: text nullable.
- `evidence_ref`: artifact/document/log reference.
- `observed_at`, `created_at`.

Minimum metric set for trading/microstructure experiments:

- `gross_ev_bps`.
- `fees_bps`.
- `net_ev_bps_after_fees`.
- `spread_bps`.
- `fill_rate`.
- `adverse_selection_bps`.
- `capacity_estimate_usd` or explicit `capacity_unknown`.
- `min_cell_n`.
- `toxicity_gate_status`.

## `micro_evidence_packs`

Evidence packs are the review bundle. They can point to Paperclip artifacts, issue documents, committed repo files, or external immutable refs.

Required fields:

- `evidence_pack_id`: UUID, primary key.
- `company_id`: UUID required.
- `pod_id`: UUID nullable.
- `experiment_id`: UUID nullable.
- `summary`: text.
- `preregistration_ref`: required for experiment packs.
- `run_manifest_ref`: nullable until execution.
- `metrics_ref`: nullable until execution.
- `verdict_ref`: nullable until verdict.
- `adversarial_review_ref`: nullable; required before acting on GO.
- `artifact_refs`: JSON array of durable refs.
- `integrity`: JSON nullable, e.g. hashes, git commit, harness version.
- `created_at`, `updated_at`.

## `micro_promotion_requests`

Promotion requests are the explicit boundary between research and action.

Required fields:

- `promotion_request_id`: UUID, primary key.
- `company_id`: UUID required.
- `pod_id`: UUID nullable.
- `experiment_id`: UUID required.
- `paperclip_issue_id`: UUID nullable, approval/review issue.
- `requested_by_agent_id`: UUID required.
- `requested_action`: enum: `rerun | expand_universe | allocate_more_data | sandbox_monitor | paper_trade | live_trade_review | archive_as_signal`.
- `justification`: text with decision-rule result and residual risks.
- `evidence_pack_id`: UUID required.
- `adversarial_review_required`: boolean default true.
- `adversarial_review_ref`: nullable until attached.
- `status`: enum: `draft | submitted | needs_adversarial_review | approved | rejected | withdrawn | superseded`.
- `decided_by_user_id`: text nullable.
- `decided_at`, `created_at`, `updated_at`.

Invariant: `requested_action` of `paper_trade` or `live_trade_review` is invalid unless verdict is `go`, evidence pack is complete, and adversarial review is attached.

## State transition gates

Draft to preregistering:

- Pod or experiment issue exists.
- Thesis and source are set.

Preregistering to ready_for_board_review:

- Pre-registration reference attached.
- Decision rule has numeric GO/KILL/PARTIAL/INCONCLUSIVE conditions.
- Dependency requests are either terminal or explicitly nonblocking.

Ready_for_board_review to approved_to_run:

- Board/operator approval recorded.
- Resource assignments are present and within scope.
- Execution owner is not the propose-only Micro role unless policy changes.

Running to evidence_review:

- Run manifest and raw evidence refs are attached.
- Required metrics are observed or explicitly missing with reason.

Evidence_review to killed/archived/promoted:

- Verdict ref exists.
- GO paths require adversarial review before promotion request approval.
- KILL paths update the kill-list or ledger if the result closes a reusable door.

## Dependency queue operations

Create request:

1. Pod/experiment agent identifies a blocker.
2. Agent creates `micro_dependency_requests` record with `requested` status.
3. If material, Paperclip issue is created/linked with relation blocking the pod/experiment issue.
4. Route defaults assign `route_to_role`.

Triage:

1. Routed owner validates request.
2. Status moves to `triaged`, `assigned`, or terminal `rejected`.
3. If the request requires board policy approval, route to `board` and keep pod in `waiting_on_dependencies`.

Fulfillment:

1. Owner attaches artifact/resource assignment/review note.
2. Status moves to `fulfilled`.
3. Pod/experiment gate recomputes open blocking dependencies.

Escalation:

- Any open `critical` request older than 24h should surface in CEO/board readiness views.
- Any `waiting_external` request older than its next-check timestamp should create or update a monitor comment/issue.

## API shape, when implemented

Initial read/write endpoints can stay internal or agent-facing:

- `GET /api/companies/:companyId/micro/pods?state=...`
- `POST /api/companies/:companyId/micro/pods`
- `GET /api/micro/pods/:podId`
- `PATCH /api/micro/pods/:podId`
- `POST /api/micro/pods/:podId/experiments`
- `GET /api/micro/experiments/:experimentId`
- `PATCH /api/micro/experiments/:experimentId`
- `POST /api/micro/dependency-requests`
- `PATCH /api/micro/dependency-requests/:dependencyRequestId`
- `GET /api/companies/:companyId/micro/dependency-requests?routeToRole=...&status=open`

Access rules mirror issue access: company-scoped, mutating actions logged, agent API keys limited to their company, and broker/secret details redacted.

## Minimal implementation sequence

1. Add shared constants and validators for lifecycle states, verdicts, request statuses, routing roles, and resource types.
2. Add DB tables and indexes for pods, experiments, dependency requests, resource assignments, metric observations, evidence packs, and promotion requests.
3. Add service methods that enforce state gates and same-company references.
4. Add REST routes for dependency queue and registry reads/writes.
5. Add tests for state transition gates, dependency terminal/nonterminal logic, and redaction of broker/resource refs.
6. Add board/CEO readiness surfaces only after the backend contract is stable.

## Acceptance criteria for MIC-6

- The canonical fields named in MIC-6 are represented: `experiment_id`, `pod_id`, `source`, `thesis`, `lifecycle_state`, `improvement_attempt_count`, `dependencies`, compute/data/broker assignments, `metrics`, `verdict`, `evidence_pack_id`, and `promotion_request_id`.
- Dependency requests have routing, status, owner, blocker state, terminal states, and escalation semantics.
- The contract preserves Micro propose-only boundaries by requiring approval/resource assignments before execution and adversarial review before acting on GO.
- The schema can be implemented in Paperclip without breaking company scoping or issue/work-product auditability.
