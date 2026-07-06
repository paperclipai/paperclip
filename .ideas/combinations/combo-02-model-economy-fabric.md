# Combo 02 — Mixed-Economy Model & Provider Fabric

**Combines:** 008 First-Class Local LLM Adapter · 012 Quota-Aware Provider Fallback Chains ·
049 Shared Credential Pooling & Fair-Share Rate Limiting · 041 Host Resource-Aware Local Scheduling
· (builds on 037 Prompt-Cache-Aware Context)

## The unified idea

An always-on company's defining constraint is *the economics of inference*. Four ideas each address
one face of it; together they form a single **model-execution fabric** that decides, for every run,
*where to run it, on whose credential, and whether the hardware/quota can take it* — optimizing for
cost and privacy without thrashing.

- **A free/private tier (008).** A first-class `local_llm` adapter (Ollama / LM Studio / llama.cpp,
  all OpenAI-`/v1`-compatible) with $0-cost billing for loopback/LAN endpoints while still recording
  token counts so productivity metrics stay honest. This is the *floor* of the economy.
- **Graceful degradation (012).** Per-agent ordered fallback chains: premium API → cheap API → local.
  On a quota/429/outage failure (distinguished from don't-retry failures by the existing recovery
  classifiers), re-dispatch down the chain instead of stalling at 2am.
- **Fair sharing of scarce keys (049).** Model a shared credential as a pool with known RPM/TPM
  capacity and put a weighted-fair-queue in front so the noisy marketing batch can't starve the CEO
  agent; reserve a capacity slice for critical roles; backpressure (and prefer the local fallback)
  instead of letting everyone 429 at once.
- **Don't melt the operator's machine (041).** Host CPU/RAM/GPU/VRAM probe + capacity-based admission
  for *local* runs only, with per-model footprint hints (avoid OOM) and a "yield to the human during
  work hours" profile that ramps local work off-hours.

The connective tissue: under budget pressure the predictive breaker (combo 01 / idea 002) *prefers*
the cheap fallback; the local tier makes evals, embeddings, summaries, and handoff briefings free
across the rest of the roadmap (ideas 011, 028, 029, 060).

## Why combining wins

These four share the same decision point — the run-dispatch path — and the same goal: serve each run
on the cheapest viable target without breaking. Fallback chains are nearly useless without a free
last resort (008); a shared-key fair-share scheduler must know about fallback to shed load; local
execution must be capacity-gated by the host probe or it OOMs. Build them as one fabric with one
"select execution target" function rather than four bolt-ons. `inferOpenAiCompatibleBiller` and the
local-vs-remote `environment-execution-target.ts` distinction are the existing seams.

## Phasing

1. `local_llm` adapter + loopback→$0 billing rule with strong `billing.test.ts` coverage (008).
2. Provider fallback chains using quota signal + recovery classifiers (012).
3. Shared-credential pool + weighted fair-share + critical-role reservation (049).
4. Host resource probe (the one piece the repo entirely lacks) + capacity admission + work-hours yield (041).

## Ratings

- **Difficulty:** Medium–High — 008 has a direct in-repo template; the hard parts are correct billing
  classification, idempotent failover with hop limits, concurrency-safe capacity accounting, and
  cross-platform GPU/VRAM sampling (best-effort, graceful degradation).
- **Estimated time to complete:** ~4–6 engineer-weeks (008 alone ~1 week, high standalone value).
- **Importance:** 8/10 — makes the "24/7" pitch economically real, is a genuine differentiator
  (mixed cheap-local / premium-API fleets), and removes the 2am-rate-limit-freeze failure mode.
