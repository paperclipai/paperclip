# 012 — Quota-Aware Provider Fallback Chains

## Suggestion

Paperclip already *observes* provider quota — `quota-windows.ts` asks each adapter for its
provider quota windows (`getQuotaWindows()`) and aggregates them. But nothing **acts** on
exhaustion: when an agent's provider is rate-limited or out of quota, its runs just fail or
stall until the window resets. For an "always-on 24/7" company, hitting Anthropic's or
OpenAI's rate limit at 2am can freeze a whole team for hours with no human awake to switch
models.

Add **provider fallback chains**: per agent (or per role), define an ordered list of
adapter/model options. When the primary is rate-limited, over-quota, or erroring, Paperclip
automatically retries the run on the next option in the chain — e.g. premium API model →
cheaper API model → local model (idea 008).

## How it could be achieved

1. **Chain config.** Add an optional `fallbackChain` to an agent's adapter config: an ordered
   list of `{ adapterType, model }`. Default empty (current behavior).
2. **Trigger conditions.** Reuse the existing quota signal (`quota-windows.ts`) plus the
   recovery classifiers (`server/src/services/recovery/`, `recovery-classifiers.test.ts`) to
   distinguish *fall-back-worthy* failures (429/quota/provider outage) from *don't-retry*
   failures (auth, bad config, agent logic errors).
3. **Failover in the run path.** On a qualifying failure, `heartbeat.ts` re-dispatches the same
   run with the next chain entry instead of marking it failed, preserving session/context where
   the target adapter supports it. Cap the number of hops to avoid thrash.
4. **Cost & honesty.** Record which provider actually served each run (costs already track this)
   so spend and the unit-economics view stay accurate when a fallback is cheaper or free.
5. **Surface it.** A small "served by fallback: local-llm (primary rate-limited)" note on the
   run, and an inbox nudge if an agent is *chronically* falling back — that's a signal to raise
   the primary's quota or rebalance.

## Perceived complexity

**Medium.** The two hard pieces — quota observation and failure classification — already exist
in the repo; this idea connects them to an action. The real work is the failover logic in the
run dispatch path (idempotency, hop limits, context preservation across a provider switch) and
getting the retry-vs-fail classification right so it doesn't burn money retrying a request that
will always fail. Strong synergy with the local-LLM adapter (008) as a free last resort and with
the predictive breaker (002), which might *prefer* the cheap fallback under budget pressure.
