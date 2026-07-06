# 037 — Prompt-Cache-Aware Context Optimization

## Suggestion

Paperclip already *measures* cached input tokens — `cost_events.cachedInputTokens` and
`agent_runtime_state.totalCachedInputTokens` are tracked distinctly from fresh input. That's a
signal it knows prompt caching exists, but nothing in the product actively **optimizes for it**.
Modern LLM providers charge a fraction (often ~10%) for cached prompt prefixes, so the single
biggest lever on token cost for repetitive agent loops is **maximizing cache hits** by keeping
the stable part of each prompt (system instructions, role/SOUL config, company context,
long-lived issue context) byte-stable and front-loaded, with only the volatile part at the end.
Agents that rebuild their context fresh each heartbeat — reordering or regenerating the
preamble — silently pay full price every run.

Add **cache-aware context assembly**: structure the context Paperclip provides to agents so the
invariant prefix is stable and cacheable, and surface cache efficiency so operators can see (and
improve) it.

## How it could be achieved

1. **Stable-prefix discipline.** Where Paperclip assembles run context (instructions, role
   config, company/goal context, continuation summaries — `agent-instructions.ts`,
   `issue-continuation-summary.ts`), order it invariant-first / volatile-last and avoid
   regenerating the stable portion run-to-run. For Anthropic adapters, set explicit cache
   breakpoints at the prefix boundary.
2. **Cache-hit metric.** Compute `cachedInputTokens / totalInputTokens` per agent/company from
   data already collected and surface it: "Marketing-bot cache hit rate: 31% — low." A low rate
   on a repetitive agent is found money.
3. **Diagnose cache-busters.** Flag patterns that defeat caching — timestamps or volatile IDs
   injected near the top of the prompt, instruction churn, per-run reordering — and recommend
   fixes. The A/B harness (idea 032) and tracing (idea 031) give the data to spot them.
4. **Adapter-aware.** Caching mechics differ per provider; apply it where the adapter supports
   explicit cache control and treat it as best-effort elsewhere. Local models (idea 008) have
   their own prefix-caching behavior worth aligning to.
5. **Tie to economics.** Show estimated savings from improved cache hits in the Unit-Economics
   Dashboard (idea 013) — this is one of the clearest cost wins available and is invisible today.

## Perceived complexity

**Medium.** The token data and the context-assembly code already exist, and the cache-hit metric
is a pure read-model addition (quick, high-insight). The deeper work is auditing every place run
context is built to enforce stable-prefix ordering and wiring explicit cache breakpoints per
adapter without breaking adapters that don't support them — careful, incremental plumbing rather
than algorithmic difficulty. Ship the cache-hit *metric* first to quantify the opportunity, then
optimize the assembly where the numbers say it pays.
