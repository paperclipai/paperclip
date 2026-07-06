# 056 — Business Experiment Framework

## Suggestion

Paperclip's whole purpose is autonomous companies that *grow a business* — and growing a business
is fundamentally about running experiments: try a price, a landing-page headline, an ad creative,
a feature; measure; keep what works. But Paperclip has no structured way to run one. Agents do
ad-hoc work and (with revenue tracking, idea 030) you might see the aggregate needle move, but
there's no primitive for a **hypothesis → variants → metric → decision** loop. So an autonomous
company can't reason about *why* a number changed, can't run two variants cleanly, and can't
accumulate validated learnings — it just acts and hopes. (Note this is distinct from the A/B
*model* bake-off, idea 032, which compares LLMs; this experiments on the **business itself**.)

Add a **business experiment framework**: a first-class object for running controlled experiments on
the company's real-world work, with hypotheses, variants, success metrics, and recorded outcomes.

## How it could be achieved

1. **Experiment object.** `{ hypothesis, variants[], primaryMetric, guardrailMetrics[],
   duration/sampleTarget, status, result }`. Variants are concrete pieces of work (two ad sets, two
   pricing pages) executed by agents as normal issues, tagged to the experiment.
2. **Tie metrics to real data.** The primary metric draws on revenue/outcome data (idea 030) and
   unit economics (idea 013) — signups, conversion, MRR delta — so an experiment is evaluated
   against actual business results, not vibes. Guardrail metrics (cost, churn) catch variants that
   win locally but harm globally.
3. **Decision + learning ledger.** At the end, record the result and the *decision* (ship variant
   B, kill both, iterate), and append a durable "validated learning" to a company learnings log.
   Over time this becomes the company's accumulated playbook — the thing that makes it smarter run
   over run.
4. **Agent-runnable.** A growth/marketing agent can *propose* experiments (governed by approval,
   idea 016), launch the variant work, monitor metrics, and call the result — closing the loop
   autonomously while the operator keeps oversight.
5. **Goal alignment.** Experiments hang off the goal tree (`goals.ts`) so every experiment traces
   to the company mission, and the experiment ledger feeds the operator digest (idea 029) and
   stakeholder page (idea 033): "ran 3 experiments, 1 winner, +6% conversion."

## Perceived complexity

**Medium.** Mechanically the experiment object, variant tagging, and metric wiring are moderate —
but this idea is **gated on real outcome/revenue data** (idea 030), without which experiments can't
be scored, so it sequences after that. The genuinely hard parts are statistical rigor (attribution,
sample size, avoiding false wins on tiny data) and clean variant isolation in a messy real-world
business where you can't always randomize. Start with simple sequential experiments and explicit
operator-called results; add proper significance testing and concurrent variants as the data
volume justifies it. High strategic value: it turns "agents doing stuff" into "a company that
learns."
