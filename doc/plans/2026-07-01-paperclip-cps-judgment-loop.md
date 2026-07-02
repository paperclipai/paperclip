# Paperclip CPS judgment loop and delegated expert-taste training data

Status: proposed implementation contract
Owner: Paperclip CEO control plane / CPS research pods
Date: 2026-07-01

## Why this exists

The Bridgewater/Thinking Machines result maps directly onto CPS: the scarce asset is not another generic model call or another backtest script; it is repeatable expert judgment over noisy research inputs and incomplete experiment artifacts.

Paperclip should become the place where this judgment is captured, corrected, delegated, and later turned into evaluation/fine-tuning data. CPS pods can keep doing the execution, but Paperclip owns the judgment contract and operator feedback loop.

## Operating thesis

Every CPS experiment should produce two things:

1. Evidence artifacts: data inventory, scripts, metrics, logs, charts, and verdict docs.
2. A machine-readable judgment record: what the experiment means, what action should happen next, and whether a human/operator label is required.

The judgment record is the training example. Paperclip is the review/labeling/delegation surface.

## Non-negotiable invariants

1. Paperclip does not run broker actions or publish signals.
2. Paperclip records intent, approvals, judgments, and run requests.
3. Bounded CPS executors/pods consume Paperclip run requests and return artifacts.
4. Every experiment visible in Paperclip should have, or be eligible to generate, a `JUDGMENT.json`.
5. Human/operator corrections are first-class labels, not transient chat comments.
6. Failures are archived as training data; only positive, evidence-backed dossiers can be promoted.
7. Paid data/compute requests remain gated by existing authorization/spend rules.

## Judgment schema v1

Each experiment directory may contain:

```text
/root/cps/var/self_practice/<experiment>/JUDGMENT.json
```

Minimum shape:

```json
{
  "schema": "cps.experiment_judgment.v1",
  "experiment_id": "crackingmarkets-buy-the-dip-20260630",
  "generated_utc": "2026-07-01T00:00:00Z",
  "source": {
    "type": "article|paper|repo|operator|monitoring_signal|postmortem",
    "url": "https://...",
    "title": "..."
  },
  "task_family": "strategy_article_triage|paper_reproduction|local_proxy_validation|shadow_ledger|data_feasibility|execution_realism",
  "claim_type": "mean_reversion|breakout|event_study|volatility|microstructure|portfolio_allocation|other",
  "rules_disclosure": {
    "status": "complete|partial|gated|missing|ambiguous",
    "missing": ["entry rule", "exit rule", "universe"],
    "notes": "..."
  },
  "data_fit": {
    "status": "exact|proxy|missing|paid_required|wrong_granularity|blocked_external",
    "available_dataset": true,
    "datasets": ["Yahoo OHLCV", "Databento GLBX.MDP3 ohlcv-1m"],
    "paid_data_allowed": false,
    "notes": "..."
  },
  "execution_fit": {
    "status": "safe_daily|needs_intraday|path_dependent|requires_order_book|not_executable",
    "notes": "..."
  },
  "result_verdict": "PROMOTE_TO_OPERATOR_DOSSIER|SHADOW_ONLY|LOCAL_PROXY_SUPPORTS_MECHANISM|LOCAL_VALIDATION_KILL|DATA_BLOCKED|RULES_BLOCKED|INCONCLUSIVE",
  "promotion_verdict": "promote|do_not_promote|needs_review|blocked",
  "confidence": 0.0,
  "blockers": [
    {
      "kind": "data|rules|execution|cost|broker|review",
      "description": "...",
      "route_to_role": "data_engineering|quant_review|platform_engineering|board|external_vendor"
    }
  ],
  "next_action": {
    "type": "archive|rerun_with_variant|fetch_data|ask_operator|delegate_review|build_shadow|promote_dossier",
    "safe_to_delegate": true,
    "requires_approval": false,
    "max_runtime_minutes": 60,
    "prompt": "Self-contained run request for the downstream CPS pod."
  },
  "operator_feedback": {
    "label": null,
    "corrected_verdict": null,
    "comment": null,
    "labeled_by": null,
    "labeled_at": null
  },
  "evidence_refs": {
    "summary_md": "SUMMARY.md",
    "primary_json": "RESULTS.json",
    "trades_csv": "trades.csv"
  }
}
```

## Paperclip surface

Extend the existing `/cps-experiments` board surface with a `Judgment` panel for the selected experiment.

The panel should show:

- source and task family
- rules disclosure status
- data fit status
- execution fit status
- result verdict
- promotion verdict
- confidence
- blockers routed by role
- next delegated action
- evidence links

Operator controls:

- `Agree`
- `Disagree`
- `Too optimistic`
- `Too conservative`
- `Wrong blocker`
- `Proceed autonomously`
- `Archive`
- `Requires my approval`
- free-text correction

These controls should write a durable operator label back into Paperclip and/or the experiment's `JUDGMENT.json` append-only correction stream.

## Delegation contract

Paperclip should not shell out inline. It should use the existing governed run-request pattern:

```text
Paperclip UI decision
  -> POST /api/companies/:companyId/cps-experiments/run-requests
  -> /root/cps/var/self_practice/paperclip-run-requests/*.json
  -> CPS executor/worker consumes request
  -> executor writes artifacts + JUDGMENT.json
  -> experiment tracker indexes artifacts
  -> Paperclip refreshes and displays result
```

New run request actions to add:

```text
generate_judgment
revise_judgment_from_operator_label
delegate_quant_review
delegate_data_feasibility
run_next_safe_action
build_operator_dossier
archive_failure_with_learning
```

Each action must preserve these safety defaults:

```json
{
  "brokerActions": false,
  "signalPublishing": false,
  "allowPaidData": false,
  "allowPaidCompute": false
}
```

Paid Databento is allowed only when the run request explicitly sets `allowPaidData: true` and the CPS executor verifies local inventory, estimates cost, and logs spend within the current cap.

## Delegation roles

Paperclip can route blockers to role-owned queues:

| Role | Owns |
|---|---|
| `research_triage` | source relevance, rules extraction, cheap kill-test selection |
| `data_engineering` | local inventory, Databento estimates/downloads, dataset manifests |
| `quant_research` | harness design, baselines, OOS gates, statistical sanity |
| `execution_realism` | intraday sequencing, fill assumptions, fees/slippage, order-book needs |
| `operator_review` | promotion approvals, paid/broker/public actions |
| `dossier_writer` | positive evidence-backed operator dossiers only |

## Dataset accumulation

Paperclip should aggregate judgments into:

```text
/root/cps/var/self_practice/EXPERIMENT_JUDGMENTS.jsonl
/root/cps/var/evals/judgment_triage_eval.jsonl
```

The first file is live training data. The second is a frozen eval set.

A single JSONL row should include:

- prompt/context shown to the model
- model/agent judgment
- operator correction if any
- final accepted label
- evidence refs
- timestamp

## Model strategy

Do not fine-tune immediately. First collect clean labels from actual CPS/Paperclip work.

Phase 1: Prompted judge with schema validation.
Phase 2: Paperclip operator correction UI.
Phase 3: Frozen judgment eval set.
Phase 4: Compare frontier models and cheap open-weight models.
Phase 5: Fine-tune only after enough accepted labels exist.

## Implementation slices

### Slice 1 — local judgment writer

- Add a CPS script that scans recent self-practice experiments and writes missing `JUDGMENT.json` files using the schema above.
- Start with recent experiments: IV mean reversion, volatility breakout gated article, buy-the-dip proxy.
- Validate JSON and add to `EXPERIMENT_JUDGMENTS.jsonl`.

### Slice 2 — Paperclip read path

- Extend `CpsExperimentEntry` summary mapping to include `judgment` if present.
- Add counts by `result_verdict`, `promotion_verdict`, `data_fit.status`, and `rules_disclosure.status`.
- Display a Judgment panel in `ui/src/pages/CpsExperiments.tsx`.

### Slice 3 — operator feedback write path

- Add a Paperclip endpoint to write an operator label/correction.
- Store corrections append-only, either under a Paperclip table or sidecar JSONL in self-practice.
- Log activity as `cps.judgment_label.created`.

### Slice 4 — delegated follow-up actions

- Add run-request actions listed above.
- Add UI buttons that prefill safe bounded prompts from `JUDGMENT.next_action`.
- Executor consumes queue and returns artifacts + updated judgment.

### Slice 5 — eval/fine-tuning prep

- Freeze a curated eval set once 100+ accepted labels exist.
- Track accuracy against accepted operator labels before any fine-tune.

## Immediate seed labels from current session

### CrackingMarkets IV mean reversion

```text
rules_disclosure: partial
data_fit: proxy -> exact IV partial -> intraday blocked
execution_fit: path_dependent / needs_intraday
result_verdict: DATA_BLOCKED_FOR_PROMOTION
promotion_verdict: do_not_promote
next_action: retry full intraday replay when IBKR session conflict clears or use alternative intraday source
```

### CrackingMarkets volatility breakout

```text
rules_disclosure: gated
result_verdict: RULES_BLOCKED
promotion_verdict: do_not_promote
next_action: do not invent rules; only proceed if member rules are available or use as broad inspiration with explicit proxy label
```

### CrackingMarkets buy the dip

```text
rules_disclosure: complete
result_verdict: LOCAL_PROXY_SUPPORTS_MECHANISM
promotion_verdict: do_not_promote until historical S&P 500 constituents/fees are tested
next_action: data_engineering feasibility for historical constituents, otherwise archive as proxy-supported mechanism
```

## Definition of done for first implementation

- Paperclip can show judgment fields for CPS experiments.
- Operator can correct judgment labels from the board.
- Corrections become durable training data.
- Paperclip can delegate the next safe action without asking for a fresh prompt.
- CPS executors return updated artifacts and `JUDGMENT.json`.
- No broker/public/paid action can happen without explicit approval fields.
