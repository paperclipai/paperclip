# 032 — A/B Model Bake-Off Harness

## Suggestion

Paperclip is proudly multi-adapter and multi-model (Claude, Codex, Cursor, Gemini, Grok, local
LLMs, …), and an operator picks an adapter/model per agent. But there's **no way to actually
compare them on real work**. Is the cheaper model good enough for triage? Does the premium model
earn its 10× cost on this company's tasks? Would a local model (idea 008) handle reviews
acceptably for free? Today that's a guess, re-made per agent, with no evidence — which means
operators systematically over-pay (defaulting to the expensive model everywhere) or under-deliver
(cheaping out where quality matters).

Add an **A/B bake-off harness**: run the same task(s) through two or more adapter/model
configurations and compare cost, speed, and quality side by side, so model selection is
evidence-based.

## How it could be achieved

1. **Define a bake-off.** Pick a set of representative tasks (real past issues, or eval cases
   from `evals/promptfoo/`) and two-plus candidate configs (e.g. `claude` vs `local-llm` vs a
   cheaper API model).
2. **Run in shadow.** Execute each candidate against each task in an isolated, side-effect-free
   mode (reuse the `planOnly`/dry-run capability proposed for idea 004 so a bake-off doesn't
   touch production workspaces or send anything).
3. **Measure automatically.** Cost and tokens come from `cost_events`; latency from run timing.
   Quality is scored by the eval assertions (idea 011) plus an optional LLM-judge for open-ended
   tasks — judged by a *neutral* model to avoid self-preference bias.
4. **Report a recommendation.** "For `code-review` tasks: local-llm scores 0.92 of premium at
   $0.00 vs $0.41/run — recommend local-llm." Surface a cost/quality frontier, not just a winner.
5. **One-click apply.** Let the operator adopt the winning config for an agent/role directly, and
   re-run bake-offs periodically as models change — model quality/price move fast.

## Perceived complexity

**Medium.** The pieces exist — multiple adapters, per-run cost data, and an eval harness — so the
harness is orchestration plus comparison reporting rather than new runtime. The two genuinely
hard parts are (a) a fair, low-bias quality score for open-ended agent work (eval assertions are
easy; subjective quality needs a careful neutral-judge setup) and (b) guaranteeing the shadow
runs are truly side-effect-free, which it shares with idea 004's `planOnly` contract. Start with
eval-scored, deterministic tasks where quality is objective, then extend to judged open-ended
work.
