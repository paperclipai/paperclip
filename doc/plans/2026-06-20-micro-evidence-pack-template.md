# Micro evidence pack template

Status: first reusable evidence pack format for MIC-7
Date: 2026-06-20
Companion schema: `doc/plans/2026-06-20-micro-evidence-pack-schema-and-verdict-package.md`
Safety mode: template only. Filling this template does not authorize CPS, Vast, paid data, broker calls, order simulation, paper/live trading, credential checks, promotion approval, or external claims.

Use this template for every micro experiment evidence package. Delete no required section; write `not_applicable` with a reason when a field is not valid for the evidence tier.

## 0. Evidence pack header

- Evidence pack title:
- Evidence pack id / registry id:
- Company id:
- Experiment identifier:
- Experiment registry id:
- Pod identifier:
- Pod registry id:
- Paperclip issue ids:
- Owner role / agent:
- Evidence tier: `source_readiness | backtest | shadow | paper`
- Status: `draft | ready_for_review | needs_revision | accepted | superseded | invalid`
- Created at UTC:
- Updated at UTC:
- Safety mode:
- Primary artifact URI:
- Supporting artifact URIs:

## 1. Source and hypothesis

- Source kind:
- Source refs:
- Source claim:
- Frozen hypothesis:
- Open-lever mapping:
- Kill-list triage:
- Binding constraint being tested:
- What this evidence cannot prove:

## 2. Pre-registration and decision rule

- Preregistration URI:
- Preregistration hash / git ref:
- Freeze time UTC:
- Operator approval ref for this evidence tier:
- Allowed harnesses / commands:
- Forbidden actions:

Copy the frozen decision rule exactly:

| Verdict | Frozen condition | Result evidence | Fired? |
|---|---|---|---|
| GO | | | no |
| KILL | | | no |
| PARTIAL / REVISE | | | no |
| INCONCLUSIVE / HOLD | | | no |

## 3. Data lineage

| Source | Path / URI | Symbol / universe | Role | Access mode | Date range | First timestamp | Last timestamp | Raw rows | Usable rows | Freshness / completeness | Hash / manifest |
|---|---|---|---|---|---|---|---|---:|---:|---|---|
| | | | feature / label / health / reference | local / public / approved vendor / paper broker | | | | | | | |

Policies:

- Timezone policy:
- Session / holiday / early close / rollover policy:
- Corporate-action or symbol-map policy:
- Missing data policy:
- Stale/crossed/invalid quote policy:
- Fail-closed exclusions:
- Data limitations:

## 4. Code, config, and environment

- Repo path:
- Git commit:
- Git status summary:
- Relevant diff summary:
- Harness refs:
- Config artifact URI:
- Runtime environment summary:
- Random seeds, if any:
- Walk-forward / split / embargo settings:

Command log:

| UTC start | UTC end | Working directory | Command | Exit code | stdout ref | stderr ref | Notes |
|---|---|---|---|---:|---|---|---|
| | | | | | | | |

## 5. Backtest metrics

Required when evidence tier is `backtest`, otherwise write `not_applicable` and reason.

| Metric | Unit | Baseline | Candidate | Incremental | Sample count | Artifact ref | Notes |
|---|---|---:|---:|---:|---:|---|---|
| gross_ev | bps | | | | | | |
| fees_or_costs | bps | | | | | | |
| net_ev_after_fees | bps | | | | | | |
| prediction_score / IC / R2 | mixed | | | | | | |
| min_cell_n | count | | | | | | |
| capacity_estimate | USD / units | | | | | | |

Backtest controls:

- Look-ahead control:
- Embargo / leakage control:
- Cost/slippage model:
- Sensitivity grid:
- Stability by day/session/symbol:
- Confidence interval method:
- Failure/drop logs:

## 6. Shadow metrics

Required when evidence tier is `shadow`, otherwise write `not_applicable` and reason.

| Metric | Unit | Value | Artifact ref | Notes |
|---|---|---:|---|---|
| shadow decisions | count | | | |
| fired decisions by cost cell | count | | | |
| net EV by cost cell | bps/trade | | | |
| spread median / p90 / p99 / max | bps | | | |
| quote freshness / alignment pass rate | % | | | |
| baseline vs candidate lift | bps / IC / R2 | | | |
| session stability | mixed | | | |
| bootstrap CI | bps | | | |
| capacity proxy | USD / units | | | |
| toxicity proxy | mixed | | | |

Shadow controls:

- Proof decisions were not routed to broker/paper/live:
- Timestamp alignment method:
- Forward-label construction:
- Quote/fill realism limitation:

## 7. Paper metrics

Required only after a separate operator-approved paper-trading plan. Otherwise write `not_applicable` and reason.

| Metric | Unit | Value | Artifact ref | Notes |
|---|---|---:|---|---|
| submitted orders | count | | | |
| accepted / rejected orders | count | | | |
| full / partial fills | count | | | |
| fill rate | % | | | |
| realized spread | bps | | | |
| slippage | bps | | | |
| commission / fees | bps / currency | | | |
| adverse selection | bps | | | |
| cancel rate | % | | | |
| position/risk-limit breaches | count | | | |
| reconciliation vs shadow | mixed | | | |
| capacity estimate from observed fills | USD / units | | | |

Paper controls:

- Paper approval issue:
- Broker/sandbox identifier, with no secrets:
- Scope boundaries:
- Incident log:
- Safety confirmation: paper/sandbox only, no live trading.

## 8. Improvement attempts

Required for PARTIAL / REVISE or rerun proposals.

- Max improvement attempts:
- Current attempt number:
- Remaining attempts:

| Attempt | Frozen before rerun? | Allowed improvement type | Exact change | Why not post-hoc mining | Result ref | Stop condition |
|---:|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |

## 9. Risk notes

| Gate | Status | Evidence | Residual risk | Blocker? |
|---|---|---|---|---|
| Cost model realism | pass / fail / unknown | | | yes/no |
| Capacity | pass / fail / unknown | | | yes/no |
| Toxicity / adverse selection | pass / fail / unknown | | | yes/no |
| Data lineage | pass / fail / unknown | | | yes/no |
| Execution realism | pass / fail / unknown | | | yes/no |
| Operational dependencies | pass / fail / unknown | | | yes/no |
| Data-snooping / overfit risk | pass / fail / unknown | | | yes/no |
| Promotion blockers | pass / fail / unknown | | | yes/no |

## 10. Verdict package

Exactly one verdict must be selected.

### KILL

- Selected? yes/no
- KILL condition fired:
- Numeric evidence:
- Experiment-local or reusable kill-list/ledger update needed?
- Further tuning/rerun allowed? normally no; explain if a new prereg is required.
- Registry update target:

### PARTIAL / REVISE

- Selected? yes/no
- PARTIAL condition fired:
- Proposed bounded improvement:
- Attempt budget remaining:
- Dependencies before rerun:
- Registry update target:

### GO / PROMOTE REVIEW

- Selected? yes/no
- GO condition fired:
- Numeric evidence for all gates:
- Baseline/cost/stability/capacity/toxicity evidence:
- Fusion(opus4.8-gpt5.5) adversarial review ref:
- CRO risk gate ref:
- Operator approval request ref:
- Promotion request draft target:
- Statement: GO is not permission for paper/live trading unless separately approved.
- Registry update target:

### INCONCLUSIVE / HOLD

- Selected? yes/no
- INCONCLUSIVE condition fired:
- Missing artifact/metric/data/gate:
- Is blocker resolvable?
- Existing results usable for tuning? normally no; explain.
- Registry update target:

## 11. Artifact index

| Artifact | Type | URI / attachment path | SHA-256 or git ref | Required for tier? | Notes |
|---|---|---|---|---|---|
| Preregistration | markdown | | | yes | |
| Data manifest | JSON/markdown | | | yes | |
| Config | JSON/YAML/markdown | | | yes | |
| Command log | text/markdown | | | yes | |
| Metrics table | JSON/CSV/markdown | | | yes for result tiers | |
| Verdict doc | markdown | | | yes | |
| Adversarial review | markdown | | | yes before acting on GO | |
| Paper fills | JSON/CSV | | | paper only | |

## 12. Safety attestation

Safety attestation: For `<experiment_identifier>`, I ran only the commands and data access modes authorized by `<approval_ref>`. I did not run CPS, Vast, GPU/cloud paid compute, paid data APIs, broker routes, paper/demo orders unless explicitly approved for the paper tier, live orders, strategy/model promotion, credential checks, or external claims. Artifacts created: `<artifact list>`. Any GO remains blocked pending fusion(opus4.8-gpt5.5) adversarial review, CRO risk review, and operator approval.

## 13. Reviewer notes

- Reviewer requested:
- Open questions:
- Dependencies to file as Paperclip issues:
- Registry updates performed or requested:
