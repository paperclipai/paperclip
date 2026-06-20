# Micro evidence pack schema and verdict package

Status: canonical planning artifact for MIC-59, referenced by MIC-7
Owner role: Evidence Archivist
Date: 2026-06-20
Safety mode: planning/read-only only. This artifact does not approve CPS, Vast, paid APIs, broker calls, order simulation, paper/live trading, credential checks, promotion approval, or external claims.

## Scope

This document defines the canonical evidence pack fields and verdict package checklist for the two current seed micro experiments:

- `MEXP-FX-6E-EURUSD-LEADLAG-001`
  - Registry experiment id: `06d93b08-911a-4b90-ab8b-7b9109046477`
  - Pod: `MPOD-FX-LEAD-LAG` / `9e331e76-1dba-4e67-a51e-7df8601b0fea`
  - Prereg: `file:///root/cli/micro-addon/research-loop/PREREG-MEXP-FX-6E-EURUSD-LEADLAG-001-2026-06-20.md`
  - Existing draft evidence pack record: `9320c444-db31-4e8b-a81d-6264d7cba735`
- `MEXP-PAPER-INTRADAY-REVERSAL-001`
  - Registry experiment id: `8bb4c3da-e9c2-478f-bd0b-5d12b6b71b84`
  - Pod: `MPOD-ACADEMIC-PAPER-REPLICATION` / `c6a1bf44-bbbf-442c-abfc-a45532634afd`
  - Prereg: `file:///root/cli/micro-addon/research-loop/PREREG-MEXP-PAPER-INTRADAY-REVERSAL-001-2026-06-20.md`
  - Existing draft evidence pack record: `0a89d503-e03c-4b26-acb6-2cf5bbe16662`

It turns MIC-7 into a concrete artifact contract: source, hypothesis, lineage, config, metrics, improvement attempts, shadow/paper metrics, risk notes, verdict, and artifact links are all mandatory before a result can be reviewed.

## Non-negotiable rules

1. Pre-registration must be frozen before any result-grade data/evaluation run.
2. The evidence pack must be self-auditing: every result references commands, timestamps, code version, input artifacts, output artifacts, and decision-rule mapping.
3. Backtest/shadow/paper are distinct evidence tiers. A higher tier may not borrow artifacts from a lower tier as if they prove fills, costs, or execution safety.
4. A GO is never permission to trade. It creates a review requirement: fusion(opus4.8-gpt5.5) adversarial pass, CRO risk gate, and operator approval.
5. Capacity, toxicity, spread/cost realism, and data lineage are gates, not appendix notes.
6. Kill-list compliance must be explicit. Neither seed may reopen killed Hyperliquid liquid-major directional alpha or HL wide-spread maker capture.

## Canonical evidence pack fields

Every evidence pack should be represented in the Paperclip micro registry as `micro_evidence_packs` plus a durable markdown/JSON artifact. The artifact must contain these fields.

### 1. Identity and provenance

Required fields:

- `evidence_pack_id`: registry UUID once created.
- `company_id`: Paperclip company UUID.
- `experiment_identifier`: stable key, e.g. `MEXP-FX-6E-EURUSD-LEADLAG-001`.
- `experiment_id`: registry UUID.
- `pod_identifier` and `pod_id`.
- `paperclip_issue_ids`: issue(s) that authorized the evidence work and any dependency gates.
- `owner_agent_or_role`: role responsible for assembly.
- `created_at_utc`, `updated_at_utc`.
- `status`: one of `draft`, `ready_for_review`, `needs_revision`, `accepted`, `superseded`, `invalid`.
- `safety_mode`: e.g. `read_only_shadow`, `readiness_only`, `paper_only_after_approval`.

### 2. Source and hypothesis

Required fields:

- `source_kind`: `operator`, `paper`, `ledger_gap`, `monitoring_signal`, or other registry value.
- `source_refs`: immutable paper URLs, repo docs, issue IDs, and/or ledger sections.
- `source_claim`: concise claim being tested.
- `hypothesis`: copied from the registry/prereg, not rewritten post-result.
- `kill_list_triage`: which killed routes are avoided and what binding constraint this experiment tests instead.
- `open_lever_mapping`: cross-venue/cross-asset signal, non-trading monitoring, or other approved lever.

Seed-specific notes:

- FX lead-lag maps to cross-venue/cross-asset microstructure with friendlier costs. It tests 6E -> EURUSD price discovery, not liquid-major crypto momentum.
- Intraday reversal maps to non-trading microstructure monitoring / execution-cost measurement unless a later separately approved run proves post-cost economics.

### 3. Pre-registration and decision rule

Required fields:

- `preregistration_ref`: durable path/URI.
- `preregistration_hash`: SHA-256 or git blob hash when available.
- `freeze_time_utc`.
- `decision_rule`: frozen GO/KILL/PARTIAL/INCONCLUSIVE thresholds, including sample-size floors.
- `allowed_commands_or_harnesses`: exact command families allowed after approval.
- `forbidden_actions`: explicit no CPS/Vast/paid data/broker/order/promotion list.
- `operator_approval_ref`: required before any run beyond readiness/source packaging.

### 4. Data lineage

Required fields:

- `input_sources`: local paths, vendor/source names, symbols/universe, and role (feature/label/health/reference).
- `data_access_mode`: local recorded, public metadata, approved vendor, broker paper, etc.
- `date_range` and session window.
- `timezone_policy`, holiday/early-close/rollover handling.
- `row_counts`: raw, filtered, usable, OOS.
- `first_last_timestamps` by source.
- `freshness_or_completeness_metrics`.
- `missing_data_policy` and any fail-closed exclusions.
- `lineage_integrity`: file hashes, manifest refs, or immutable artifact links where practical.

Seed-specific minimums:

- FX: IC Markets `EURUSD`, IBKR `6E`, and IBKR `EURUSD` local tapes; >=3 London/NY overlap sessions; >=800 OOS label events per horizon/cell; >=80% quote freshness <=2s.
- Intraday reversal: point-in-time NYSE cross-section or fixed approved adaptation universe; >=60 regular sessions; >=95% expected half-hour intervals; spread proxy coverage >=90% for economic timing claims.

### 5. Code, config, and environment

Required fields:

- `repo_path` and git commit/hash at run time.
- `git_status_summary` and relevant diff summary.
- `harness_refs`: scripts/modules used.
- `config`: all horizons, costs, windows, universes, filters, seed values, fold definitions, embargo settings.
- `runtime_environment`: Python/node versions only if material to reproducibility.
- `command_log`: exact shell commands, UTC start/end timestamps, exit codes, stdout/stderr artifact refs.
- `known_limitations`: placeholder cost models, sparse feeds, unsupported fields, or non-verdict-grade caveats.

### 6. Metrics and diagnostics

Required fields for any result-grade pack:

- `gross_ev_bps` where economic evaluation is authorized.
- `fees_or_costs_bps` with named cost model.
- `net_ev_bps_after_fees` or explicit `not_applicable_monitoring_only`.
- `spread_bps` diagnostics: median/p90/p99/max when spread matters.
- `fill_rate`, `cancel_rate`, `slippage_bps`, and `adverse_selection_bps` for paper/fill evidence; must be `not_applicable` for pure shadow/readiness.
- `capacity_estimate` or `capacity_unknown_with_reason`.
- `min_cell_n` and per-cell sample counts.
- `toxicity_gate_status` for maker/paper/promotion contexts.
- `baseline_metrics` and `candidate_metrics`.
- `incremental_lift`: candidate minus baseline, not just absolute candidate score.
- `session_or_day_stability`: result split by session/day/symbol as relevant.
- `confidence_interval_method` and CI values.
- `artifact_refs`: JSON/CSV/markdown tables used to produce each metric.

Seed-specific metric requirements:

- FX: health status, frame rows, OOS events, folds, baseline/full/incremental R2 and IC, net EV by 0.8/1.0/1.5 bps cells, trades by cost cell, session stability, contiguous-block bootstrap CI.
- Intraday reversal Stage B readiness: session count, half-hour interval completeness, malformed/non-monotone timestamp rate, corporate-action/session policy, bid/ask/spread coverage, cost-model status. Stage C, if separately approved: reversal coefficient, bootstrap CI, bid-ask-bounce adjustment, open/close exclusion result, effective-spread ratio.

### 7. Improvement attempts

Required if verdict is PARTIAL or any rerun is proposed:

- `max_improvement_attempts`: registry/prereg limit, currently 5 for both seed experiments.
- `attempt_number`: 1 through 5.
- `frozen_before_rerun`: yes/no, with prereg/update ref.
- `allowed_improvement_type`: copied from prereg.
- `exact_change`: bounded and auditable.
- `why_allowed`: why it is not post-hoc outcome mining.
- `result_ref` and updated verdict.
- `stop_condition`: after five non-GO improvements, kill or mark inconclusive per prereg.

### 8. Risk notes

Required fields:

- `execution_realism`: what the evidence tier proves and does not prove.
- `cost_model_risk`: verified vs placeholder, sensitivity cells, and whether the result depends on optimistic costs.
- `capacity_risk`: size/turnover constraints or unknowns.
- `toxicity_risk`: adverse selection, queue/fill risk, bid-ask bounce, stale quotes, or venue-specific artifacts.
- `data_snooping_risk`: post-hoc selections avoided or remaining concerns.
- `operational_risk`: broker/data/feed/credential dependencies, explicitly without checking secrets.
- `promotion_blockers`: missing gates before any paper/live step.

### 9. Safety attestation

Every final evidence pack must include a filled attestation:

> Safety attestation: For `<experiment_identifier>`, I ran only the commands and data access modes authorized by `<approval_ref>`. I did not run CPS, Vast, GPU/cloud paid compute, paid data APIs, broker routes, paper/demo orders unless explicitly approved for the paper tier, live orders, strategy/model promotion, credential checks, or external claims. Artifacts created: `<artifact list>`. Any GO remains blocked pending fusion(opus4.8-gpt5.5) adversarial review, CRO risk review, and operator approval.

## Required artifacts by evidence tier

### A. Source/readiness package

Use when the work is preregistration, source triage, or data readiness only.

Required artifacts:

- Frozen preregistration markdown.
- Source citation/extract or operator thesis.
- Registry overview snapshot with experiment/pod/evidence-pack IDs.
- Data inventory/readiness artifact.
- Cost-model readiness note.
- Kill-list triage note.
- Dependency gate status snapshot.
- Safety attestation stating no execution/backtest/paper action occurred.

Allowed verdicts: `GO_TO_MEASUREMENT_PROPOSAL`, `KILL_AS_UNAVAILABLE`, `PARTIAL_MONITORING_ONLY`, `INCONCLUSIVE`.

### B. Backtest package

Use only if an approved historical backtest exists. For the current two seed experiments, this is not yet approved by MIC-59.

Required artifacts:

- Operator approval ref for the backtest.
- Frozen preregistration and decision rule.
- Data manifest and immutable input refs.
- Exact harness commands and config.
- Cost model and slippage assumptions.
- Train/validation/test split or walk-forward definition with embargo/look-ahead controls.
- Baseline vs candidate metrics.
- Net-of-cost metrics and sample counts.
- Stability by session/day/symbol.
- Sensitivity grid predeclared in prereg.
- Failure/drop logs.
- Safety attestation that no broker/order/paper/live action occurred.

Backtest cannot support promotion by itself. It can only support `kill`, `revise`, or `go_to_shadow_proposal`.

### C. Shadow package

Use when the system evaluates predictions or quote-only decisions without placing orders.

Required artifacts:

- All backtest package artifacts that still apply.
- Shadow decision log or aggregate equivalent.
- Confirmation that decisions were not routed to broker/paper/live systems.
- Timestamp alignment and quote freshness proof.
- Spread/cost diagnostics at decision time.
- Baseline vs full/candidate comparison.
- Net EV by predeclared cost cells where economics are authorized.
- Capacity/toxicity proxy diagnostics.
- Session stability and CI.
- Final prereg decision-rule mapping.

Shadow can support `kill`, `revise`, `partial`, or `go_to_adversarial_review`. It cannot approve paper/live trading.

### D. Paper package

Use only after a separate operator-approved paper-trading plan exists. Neither current seed has this approval.

Required artifacts:

- Paper-trading approval issue and scope.
- Broker/sandbox identifier without credentials or secrets.
- Order/decision logs with timestamps.
- Fill logs: submitted, accepted/rejected, partial/full fills, cancellations.
- Realized spread, slippage, commission/fee, borrow/financing if relevant.
- Fill rate, adverse selection, queue/cancel metrics.
- Position and risk-limit logs showing no limit breaches.
- Reconciliation against shadow expectations.
- Incident log and operational anomalies.
- Capacity estimate updated from observed fills.
- Safety attestation that scope remained paper/sandbox only.

Paper evidence can support `kill`, `revise`, `continue_paper`, or `go_to_promotion_review`. It still cannot approve live trading without board/operator promotion approval.

## Verdict package checklist

A verdict package is the review wrapper around an evidence pack. It must name exactly one verdict and attach/point to all required artifacts.

### Common checklist for every verdict

- Experiment identifier and registry UUID.
- Evidence pack UUID and durable artifact URI.
- Preregistration URI and hash/ref.
- Decision-rule excerpt copied verbatim.
- Evidence tier: source/readiness, backtest, shadow, or paper.
- Commands/artifacts actually produced.
- Required metrics table or explicit `not_applicable` reason.
- Risk gate table: cost, capacity, toxicity, data lineage, execution realism.
- Safety attestation.
- Reviewer/action requested.
- Explicit next state in registry: `killed`, `revision_requested`, `evidence_review`, `ready_for_board_review`, or `promotion_request_draft`.

### KILL verdict

Required:

- Which preregistered KILL condition fired.
- Numeric evidence supporting the condition.
- Whether the kill is experiment-local or reusable enough to update the research ledger/kill-list.
- Confirmation that no further tuning/rerun is allowed except via a new preregistered experiment.
- Registry update target: experiment verdict `kill`, lifecycle `killed` or `archived`.

### REVISE / PARTIAL verdict

Required:

- Which PARTIAL condition fired.
- The bounded improvement attempt number and remaining attempt budget.
- Exact proposed revision frozen before rerun.
- Why the revision is not post-hoc data mining.
- Dependencies needed before rerun.
- Registry update target: lifecycle `revision_requested`, increment `improvement_attempt_count` only when the revised attempt is actually registered.

### PROMOTE / GO verdict

Required:

- Which GO condition fired, with all numeric gates shown.
- Evidence that the result survives baseline, cost, stability, and capacity/toxicity gates.
- Fusion(opus4.8-gpt5.5) adversarial review ref. If missing, status is `needs_adversarial_review`, not promoted.
- CRO risk gate ref.
- Operator approval request ref.
- Promotion request draft with target limited to the next safe tier, e.g. `go_to_shadow_proposal`, `paper_trade_review`, or `archive_as_signal`.
- Explicit statement: GO is not permission for live or paper trading unless the promotion target is separately approved.

### INCONCLUSIVE / HOLD verdict

Required:

- Which INCONCLUSIVE condition fired.
- Missing artifact/metric/data/gate.
- Whether the blocker is resolvable and by whom.
- Whether existing results must be ignored for tuning.
- Registry update target: lifecycle `evidence_review` or `waiting_on_dependencies`, verdict `hold`/null depending on registry constraints.

## Seed-specific verdict mapping

### `MEXP-FX-6E-EURUSD-LEADLAG-001`

Current approved state: preregistration/source package only. No run is approved by MIC-59.

Backtest/shadow requirements after approval:

- Health gate JSON from `pipeline/fx_data_health.py`.
- 30s and 60s JSON outputs from `pipeline/fx_leadlag_eval.py`.
- 1.0 bps primary decision cell and 0.8/1.5 bps sensitivity cells.
- >=3 ready London/NY overlap sessions.
- >=800 OOS label events/cell for KILL/PARTIAL/INCONCLUSIVE; >=1,000 fired shadow decisions for GO.
- Full model OOS net EV > +0.5 bps/trade at 1.0 bps and lower 95% contiguous-session/block bootstrap CI > 0 for GO.
- Full model improvement over EURUSD quote-only baseline >= +0.3 bps/trade and positive in at least 2 of 3+ ready sessions for GO.
- Fusion adversarial review is mandatory before acting on GO.

### `MEXP-PAPER-INTRADAY-REVERSAL-001`

Current approved state: source/readiness package only. No measurement run is approved by MIC-59.

Readiness package requirements:

- Source paper citation and immutable arXiv refs.
- Universe/data availability table: paper-faithful vs current repo vs approved adaptation needed.
- Session/half-hour completeness plan.
- Corporate-action/session policy requirement.
- Bid/ask or spread proxy coverage requirement.
- Placeholder-vs-verified cost-model note.

Measurement requirements after separate approval:

- Next-interval reversal coefficient and bootstrap CI.
- Bid-ask-bounce/spread-adjusted reversal result.
- Open/close interval exclusion result.
- Effective half-spread comparison.
- Classification as monitoring/execution-timing evidence only unless a separate post-cost trading conversion is preregistered.
- Fusion adversarial review is mandatory before acting on GO.

## Registry and Paperclip attachment expectations

For each completed evidence pack:

1. Upload the durable markdown/JSON artifact to the issue as an attachment.
2. Create a Paperclip work product of type `artifact` with `reviewState: needs_board_review` unless it is purely informational.
3. Ensure the `micro_evidence_packs.artifactUri` points to the canonical artifact location or Paperclip attachment URI.
4. If a verdict exists, update the experiment verdict/lifecycle and attach `verdict_ref` in metadata when the registry supports it.
5. If a GO exists, create a promotion request in draft/needs-adversarial-review state only; do not approve it.

## Acceptance criteria satisfied for MIC-59

- Canonical evidence pack fields are defined for source, hypothesis, data lineage, config, metrics, improvement attempts, risk notes, verdict, and artifact links.
- Required artifacts are separated by source/readiness, backtest, shadow, and paper tiers.
- Kill/revise/promote/inconclusive verdict package checklists are defined.
- Both current seed experiments are mapped to their registry IDs, preregistration refs, existing evidence pack records, and seed-specific gates.
- MIC-7 is referenced as the broader implementation task; this document supplies the first concrete format for that issue.
