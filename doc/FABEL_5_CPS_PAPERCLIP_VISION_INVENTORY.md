# Fabel 5 handoff: Paperclip × CPS expert-judgment control room

Generated: 2026-07-02T06:47:32Z  
Audience: Fabel 5 / Claude-family strategic implementation agent  
Primary repos/artifact roots:

- Paperclip repo: `/root/paperclip`
- CPS repo/root: `/root/cps`
- CPS self-practice artifacts: `/root/cps/var/self_practice`
- CPS eval artifacts: `/root/cps/var/evals`

## 1. One-sentence mission

Build **fincli.ai / CPS** into a safely governed autonomous research company where Paperclip is the board/control room, CPS pods execute bounded research and data work, and the durable proprietary asset is an accumulating dataset of **expert financial judgment labels**: what deserves testing, what is noise, what is blocked, what can be delegated, and what can be promoted only after evidence-backed review.

## 2. Core vision

The project is shifting from “run many backtests” to “learn expert taste.” The Thinking Machines / Bridgewater-style lesson is that the hard problem in finance is not generating another strategy script; it is reliably replicating the decision process of an expert operator who can:

1. extract or reject rules from noisy public sources,
2. select the cheapest valid validation path,
3. distinguish proxy support from faithful reproduction,
4. detect data, execution, fees, survivor-bias, sequencing, and promotion blockers,
5. route bounded follow-up work to the right specialist,
6. archive failures as reusable learning rather than hiding them,
7. promote only positive, evidence-backed operator dossiers.

Paperclip should therefore become the **judgment capture and governance layer**. CPS remains the execution/research layer.

## 3. Current architecture in plain English

```text
Human operator / board
  -> Paperclip board UI + company/org/issue control plane
  -> CPS experiment overview + judgment panel
  -> append-only operator feedback labels
  -> bounded run requests
  -> CPS executor/pods consume requests from disk queues
  -> local experiments/data probes/backtests run under CPS safety policy
  -> artifacts + JUDGMENT.json are written under self_practice
  -> experiment tracker indexes artifacts
  -> Paperclip reads the index and displays verdicts/blockers/next actions
  -> dataset exporter turns judgments + labels into training/eval JSONL
  -> later: Tinker/fine-tuning only after enough clean accepted labels exist
```

Paperclip is the control plane. It should not place trades, publish signals, spend money, or shell out inline for research. It records intent, approvals, labels, run requests, activity, and visibility. CPS workers do the bounded execution.

## 4. Product doctrine: Paperclip

Authoritative product docs:

- `/root/paperclip/doc/GOAL.md`
- `/root/paperclip/doc/PRODUCT.md`
- `/root/paperclip/doc/SPEC-implementation.md`
- `/root/paperclip/doc/DEVELOPING.md`
- `/root/paperclip/doc/DATABASE.md`

Relevant product principles:

- Paperclip is the **control plane for autonomous AI companies**.
- One Paperclip instance can manage multiple companies.
- Companies have goals, agents/employees, org structure, issues, comments, artifacts, approvals, costs, and heartbeat runs.
- Work must stay attached to goals/issues/comments/artifacts, not disappear into chat.
- Default UI should be board-level: what is happening, who owns it, why it matters, what it cost, and what needs approval.
- Paperclip orchestrates agents; execution services/adapters do the work.
- Safe autonomy is allowed; hidden token burn, broker actions, public claims, and unmanaged paid spend are not.

## 5. CPS / fincli doctrine

Persistent user/project direction:

- User is building **fincli.ai**, CPS strategy research, Paperclip/board as CEO control room, and micro.fincli.ai as intraday/research podshops.
- User wants broad installed tools used proactively to test public papers and mechanisms against available historical data.
- User wants evidence artifacts and honest verdicts, not optimistic strategy marketing.
- Positive operator dossiers only; failures should become evidence dossiers and future judgment training examples.
- Databento use is bounded: verify local inventory first, use existing data if available, otherwise only concrete missing validation datasets within the daily cap and with spend logging.
- Broker/paper/live actions remain explicit approval gates.

## 6. Thinking Machines-inspired improvement being implemented

The key change is to transform every research artifact into a supervised judgment example.

Each experiment should produce:

1. **Evidence artifacts** — scripts, data manifests, metrics, logs, trades CSVs, charts, summaries.
2. **Judgment artifact** — `JUDGMENT.json`, a typed statement of what the evidence means and what should happen next.
3. **Operator feedback label** — append-only board correction, agreement, disagreement, or routing label.
4. **Dataset row** — prompt/context + model/agent judgment + operator correction + final accepted label + evidence refs.

The goal is not to fine-tune immediately. The goal is to collect clean labels from real CPS/Paperclip work, establish evals, then compare prompted frontier models, cheap open models, and eventually fine-tuned models.

## 7. Judgment schema inventory

Planning/contract doc:

- `/root/paperclip/doc/plans/2026-07-01-paperclip-cps-judgment-loop.md`

Core sidecar path:

```text
/root/cps/var/self_practice/<experiment_id>/JUDGMENT.json
```

Current TypeScript shared type:

- `/root/paperclip/packages/shared/src/types/cps-experiments.ts`

Important fields:

```json
{
  "schema": "cps.experiment_judgment.v1",
  "experiment_id": "...",
  "source": { "type": "article|paper|repo|operator|monitoring_signal|postmortem", "url": "...", "title": "..." },
  "task_family": "strategy_article_triage|paper_reproduction|local_proxy_validation|shadow_ledger|data_feasibility|execution_realism",
  "claim_type": "mean_reversion|breakout|event_study|volatility|microstructure|portfolio_allocation|other",
  "rules_disclosure": { "status": "complete|partial|gated|missing|ambiguous" },
  "data_fit": { "status": "exact|proxy|missing|paid_required|wrong_granularity|blocked_external", "available_dataset": true },
  "execution_fit": { "status": "safe_daily|needs_intraday|path_dependent|requires_order_book|not_executable" },
  "result_verdict": "PROMOTE_TO_OPERATOR_DOSSIER|SHADOW_ONLY|LOCAL_PROXY_SUPPORTS_MECHANISM|LOCAL_VALIDATION_KILL|DATA_BLOCKED|RULES_BLOCKED|INCONCLUSIVE",
  "promotion_verdict": "promote|do_not_promote|needs_review|blocked",
  "confidence": 0.0,
  "blockers": [{ "kind": "data|rules|execution|cost|broker|review", "route_to_role": "data_engineering|quant_review|platform_engineering|board|external_vendor" }],
  "next_action": { "type": "archive|rerun_with_variant|fetch_data|ask_operator|delegate_review|build_shadow|promote_dossier", "safe_to_delegate": true, "requires_approval": false, "max_runtime_minutes": 60, "prompt": "..." },
  "evidence_refs": { "summary_md": "...", "primary_json": "...", "trades_csv": "..." }
}
```

## 8. Paperclip implementation inventory

Recent commits:

- `64ffdd16 Add CPS experiment judgment loop`
- `b81f1536 Export CPS judgment training datasets`

Shared contracts:

- `/root/paperclip/packages/shared/src/types/cps-experiments.ts`
- `/root/paperclip/packages/shared/src/types/index.ts`
- `/root/paperclip/packages/shared/src/index.ts`

Server:

- `/root/paperclip/server/src/services/cps-experiments.ts`
- `/root/paperclip/server/src/routes/cps-experiments.ts`
- Tests:
  - `/root/paperclip/server/src/__tests__/cps-experiments-service.test.ts`
  - `/root/paperclip/server/src/__tests__/cps-experiments-routes.test.ts`

UI:

- `/root/paperclip/ui/src/api/cps-experiments.ts`
- `/root/paperclip/ui/src/pages/CpsExperiments.tsx`

Dataset exporter:

- `/root/paperclip/scripts/export-cps-judgment-dataset.py`
- root script: `pnpm cps:export-judgments`

Paperclip now supports:

- `GET /api/companies/:companyId/cps-experiments`
  - reads CPS experiment index and sidecar `JUDGMENT.json` files
  - returns counts by judgment result verdict, promotion verdict, data-fit status, rules-disclosure status
- `POST /api/companies/:companyId/cps-experiments/run-requests`
  - queues bounded CPS run requests under `/root/cps/var/self_practice/paperclip-run-requests`
- `POST /api/companies/:companyId/cps-experiments/judgment-feedback`
  - writes append-only labels under `/root/cps/var/self_practice/paperclip-judgment-labels`
  - logs `cps.judgment_label.created`

Run-request actions now include:

- `generate_judgment`
- `revise_judgment_from_operator_label`
- `delegate_quant_review`
- `delegate_data_feasibility`
- `run_next_safe_action`
- `build_operator_dossier`
- `archive_failure_with_learning`

Safety defaults for run requests:

```json
{
  "brokerActions": false,
  "signalPublishing": false,
  "allowPaidData": false,
  "allowPaidCompute": false
}
```

## 9. Current data inventory

Current judgment sidecars found:

- `/root/cps/var/self_practice/iv-mean-reversion-20260630/JUDGMENT.json`
- `/root/cps/var/self_practice/crackingmarkets-volatility-breakout-20260630/JUDGMENT.json`
- `/root/cps/var/self_practice/crackingmarkets-buy-the-dip-20260630/JUDGMENT.json`

Current exported datasets:

- `/root/cps/var/self_practice/EXPERIMENT_JUDGMENTS.jsonl`
- `/root/cps/var/evals/judgment_tinker_prompt_response.jsonl`

Current exporter output from `pnpm cps:export-judgments`:

```json
{
  "status": "ok",
  "training_rows": 3,
  "tinker_rows": 3,
  "accepted_label_rows": 0,
  "eval_rows_written": 0,
  "eval_min_labels": 100,
  "network": false,
  "paid_actions": false
}
```

Current seed verdicts:

| Experiment | Result verdict | Promotion verdict | Why it matters |
|---|---|---|---|
| `iv-mean-reversion-20260630` | `DATA_BLOCKED` | `blocked` | Daily-bar adaptation failed under conservative sequencing; partial intraday probe was interesting, but full OOS intraday replay is blocked by IBKR session conflict / incomplete intraday data. |
| `crackingmarkets-volatility-breakout-20260630` | `RULES_BLOCKED` | `do_not_promote` | Article logic is member-gated. System correctly refuses to invent missing rules. |
| `crackingmarkets-buy-the-dip-20260630` | `LOCAL_PROXY_SUPPORTS_MECHANISM` | `do_not_promote` | Proxy reproduced core stats, but survivor bias, historical constituents, delisted names, and fee realism block promotion. |

## 10. Tinker / Thinking Machines API inventory

Installed package:

```text
tinker==0.22.7
pyqwest==0.6.2
```

Import verified:

```text
tinker.__version__ == 0.22.7
```

SDK env vars discovered from package introspection:

- `TINKER_API_KEY`
- `TINKER_BASE_URL`
- `TINKER_CREDENTIAL_CMD`
- `TINKER_FEATURE_GATES`
- `TINKER_LOG`
- `TINKER_PROJECT_ID`
- `TINKER_SUBPROCESS_SAMPLING`
- `TINKER_TAGS`
- `TINKER_TELEMETRY`

Primary SDK entry point:

```python
from tinker import ServiceClient
client = ServiceClient(user_metadata={"purpose": "..."})
```

Important methods discovered:

- `get_server_capabilities()`
- `create_sampling_client(base_model=...)`
- `create_lora_training_client(base_model=...)`
- `create_training_client_from_state(...)`
- `create_rest_client()`
- `get_telemetry()`

API smoke result:

- `ServiceClient` construction succeeds when `TINKER_API_KEY` is supplied transiently.
- `get_server_capabilities()` reached the service but returned HTTP `402` billing status and retried until timeout.
- No Tinker training/sampling job was launched.
- No API key was committed to repo files. Future agents must supply `TINKER_API_KEY` via secure environment or secret manager only.

Billing blocker text observed, with account details redacted:

```text
Access is blocked due to billing status. Please add payment at https://tinker-console.thinkingmachines.ai/billing/balance
```

## 11. Guardrails for Fabel 5

Do not do these without explicit approval:

- store API keys in repo files, markdown, shell history, committed configs, or artifacts,
- place trades,
- publish buy/sell signals,
- enable broker-paper/live trading,
- spend paid data or compute outside bounded written policy,
- promote proxy results as real alpha,
- invent hidden member-only strategy rules,
- claim a strategy works without artifact-backed local evidence,
- treat daily OHLCV fill assumptions as valid when intraday path ordering matters,
- use Tinker fine-tuning before enough accepted labels and a frozen eval set exist.

## 12. Desired next implementation slices

### Slice A — safer Tinker integration

Build a small local Tinker diagnostics command that:

- reads `TINKER_API_KEY` only from env or credential command,
- prints SDK version, methods, and billing/capability status,
- redacts any secret material,
- exits quickly on 402/401 without retry storms,
- writes a safe JSON readiness artifact under `/root/cps/var/toolbelt/tinker/READINESS.json`.

### Slice B — judgment writer/scanner scale-up

Extend the local/offline dataset exporter into a judgment maintenance tool:

- scan all recent CPS experiment directories,
- identify missing `JUDGMENT.json`,
- generate `MISSING_JUDGMENTS.md` with required evidence refs,
- prioritize experiments with primary metrics and enough artifacts,
- never invent missing rules or results.

### Slice C — Paperclip labeling UX polish

Current UI has feedback buttons but not full correction forms. Add:

- free-text correction,
- corrected verdict dropdown,
- blocker re-route selector,
- “needs data engineering” / “needs execution realism” quick route,
- accepted-label status in the experiment list,
- dataset-export status card.

### Slice D — CPS executor consumption for all new actions

`/root/cps/var/self_practice/paperclip-run-requests/consume_paperclip_queue.py` currently has a typed CL EIA near-miss handler. Extend it to typed handlers for:

- `generate_judgment`,
- `run_next_safe_action`,
- `archive_failure_with_learning`,
- `delegate_data_feasibility`,
- `delegate_quant_review`.

Each handler should write artifacts plus updated `JUDGMENT.json` and preserve safety defaults.

### Slice E — eval set and model comparison

After enough operator labels exist:

1. Freeze `/root/cps/var/evals/judgment_triage_eval.jsonl`.
2. Evaluate prompted Fabel 5 / Claude-family, GPT-family, and cheap open-weight models.
3. Measure exact verdict accuracy, blocker routing accuracy, and unsafe-promotion false-positive rate.
4. Only then consider Tinker LoRA or other fine-tuning.

Primary metric should not be generic accuracy; it should heavily penalize **unsafe promotion false positives**.

## 13. How Fabel 5 should work on this project

Fabel 5 should act as a senior operating partner, not a generic coding bot.

Default posture:

1. Observe the artifacts and contracts before editing.
2. Keep Paperclip as control plane and CPS as execution plane.
3. Preserve safety gates and company-scoped access.
4. Produce evidence-backed diffs and docs, not only prose.
5. When evaluating strategies, distinguish:
   - article/paper claim,
   - faithful reproduction,
   - local proxy,
   - execution realism,
   - data blocker,
   - promotion eligibility.
6. Treat failures as training labels.
7. Route work to the right role rather than making the CEO/operator do implementation.

## 14. Fast orientation commands

From `/root/paperclip`:

```sh
pnpm --filter @paperclipai/shared typecheck
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/ui typecheck
pnpm cps:export-judgments
```

Inspect current judgments:

```sh
python - <<'PY'
import json, pathlib
p=pathlib.Path('/root/cps/var/self_practice/EXPERIMENT_JUDGMENTS.jsonl')
for line in p.read_text().splitlines():
    row=json.loads(line)
    print(row['experiment_id'], row['features']['result_verdict'], row['features']['promotion_verdict'])
PY
```

Do not put `TINKER_API_KEY` in commands that will be committed or logged. Use a secure environment injection path.

## 15. Current clean-room summary for another model

We are building a governed financial research company. Paperclip is the board/control plane for autonomous agents. CPS is the research/execution layer. The current strategic improvement is inspired by Thinking Machines / Bridgewater: capture expert judgment as data. Every experiment should generate a `JUDGMENT.json`; Paperclip displays it, lets the operator label/correct it, queues safe follow-up actions, and exports a growing JSONL dataset. The first seed labels cover IV mean reversion, volatility breakout, and buy-the-dip. Tinker is installed and import-tested but currently blocked by billing for live capability calls. The next valuable work is to scale judgment coverage, improve Paperclip labeling UX, implement CPS queue handlers for the new action types, and build evals before any fine-tuning.
