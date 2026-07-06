# Combo 06 — Agent CI/CD & Evidence-Based Quality

**Combines:** 011 Eval-Gated Agent Config Deploys · 032 A/B Model Bake-Off Harness ·
040 Operator-Owned Training Dataset · 046 Skill Effectiveness Analytics
· (runs on 008 local model + the shared `planOnly`/shadow execution contract)

## The unified idea

Editing an agent's config/prompt is the highest-leverage, highest-risk action an operator takes, and
today it's done blind: no pre-deploy check, no way to compare models on real work, no structured
record of what worked, no evidence that a skill helps. Four ideas turn agent improvement from
guesswork into **CI/CD for agents** — and they all stand on the same three foundations: a
**side-effect-free `planOnly`/shadow execution mode**, the existing **eval harness** (`evals/
promptfoo/`), and **outcome-labeled run history**.

- **Gate config changes (011).** On a config edit, run a saved per-agent eval suite (golden scenarios
  + governance assertions mirroring `governance.yaml`) against the new config *before* it goes live —
  on a free local model (008) so gating is cheap. Regressions block (governance) or warn (quality);
  every result is logged for an agent quality history.
- **Choose models on evidence (032).** Run the same representative tasks through 2+ adapter/model
  configs in shadow, measure cost/latency from run data and quality from eval assertions + a *neutral*
  LLM judge, and report a cost/quality frontier ("local-llm scores 0.92 of premium at $0 vs $0.41/
  run") with one-click apply.
- **Own the data that powers both (040).** Promote opaque run-log blobs into normalized, **outcome-
  labeled** records (approved/rejected/reworked/shipped/abandoned, plus 👍/👎), redacted and consented
  and *local by default*. Export to eval cases (feeding 011/032), JSONL preference pairs (for
  distilling a cheaper/local model), or plain analysis.
- **Prove skills earn their keep (046).** Join skill usage to those same outcome labels: approval-rate
  delta, rework delta, cost delta per skill — replacing "popular by install count" with "demonstrably
  helps on `code-review` tasks," and validating high-stakes claims via the bake-off (032).

## Why combining wins

The dependency graph is tight: the training dataset (040) *is* the source of eval cases and the
outcome truth that 011, 032, and 046 all consume; the bake-off (032) and the eval gate (011) share
the exact same `planOnly`/shadow guarantee (also needed by combos 07/10) and the same harness; skill
analytics (046) is the bake-off applied to skills. Build the shadow contract + labeled-data pipeline
*once* and the four features fall out as views on it. Building separately means three teams each
re-solving "run an agent safely with no side effects and score it."

## Phasing

1. The `planOnly`/shadow execution contract across adapters (shared dependency) + structured,
   outcome-labeled capture (040).
2. Eval-gated deploys, advisory-then-blocking (011); descriptive skill analytics (046).
3. A/B bake-off harness with neutral judge (032); preference-pair/fine-tune export + causal skill
   validation.

## Ratings

- **Difficulty:** Medium–High — the eval runner, adapters, and cost data exist; the hard parts are a
  *trustworthy side-effect-free* shadow mode, low-bias quality scoring for open-ended work, faithful
  capture across heterogeneous adapters, and the statistical honesty (sample size/confounds) of the
  analytics.
- **Estimated time to complete:** ~5–7 engineer-weeks.
- **Importance:** 7/10 — high leverage for quality and cost discipline as fleets grow, but it sits a
  layer above the core safety/economics work and pays off most once a company has run volume.
