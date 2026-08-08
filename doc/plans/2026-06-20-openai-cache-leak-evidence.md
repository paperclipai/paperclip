# OpenAI Cache Leak Evidence Review

Issue: [LIB-631](/LIB/issues/LIB-631)
Date: 2026-06-20
Owner: CTO

## Summary

The corrected FinOps escalation is still directionally valid. A fresh live read on
2026-06-20 shows OpenAI/ChatGPT subscription runs with roughly 48% cache-hit
efficiency, while Anthropic subscription runs are roughly 98% cached over the
same windows. Marginal spend is still $0.00 because the relevant rows are
`subscription_included`, but the cold-token volume is a subscription-capacity and
latency risk.

This is not enough evidence to change routing, disable routines, or alter model
configuration directly. The next safe step is a targeted engineering audit of
Codex/OpenAI session reuse, fresh-session fallback, and cost-event telemetry.

## Fresh Live Snapshot

Source commands:

```bash
curl --noproxy '*' -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/costs/window-spend"

curl --noproxy '*' -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/costs/by-agent-model"
```

Window read:

| Window | Provider | Cold input | Cached input | Output | Cache hit | Cold/hour | Marginal $ |
|---|---:|---:|---:|---:|---:|---:|---:|
| 5h | OpenAI / ChatGPT | 82,947,738 | 76,919,936 | 545,793 | 48.11% | 16,589,548 | $0.00 |
| 5h | Anthropic | 465,250 | 30,124,746 | 221,791 | 98.48% | 93,050 | $0.00 |
| 24h | OpenAI / ChatGPT | 145,102,825 | 135,213,312 | 902,696 | 48.23% | 6,045,951 | $0.00 |
| 24h | Anthropic | 9,911,711 | 621,062,248 | 3,920,415 | 98.43% | 412,988 | $0.00 |
| 7d | OpenAI / ChatGPT | 459,295,375 | 417,327,360 | 3,279,078 | 47.61% | 2,734,496 | $0.00 |
| 7d | Anthropic | 20,752,252 | 1,468,949,571 | 10,427,686 | 98.61% | 123,525 | $0.00 |

Finance endpoints confirmed:

- `costs/summary`: `spendCents=0`
- `costs/finance-summary`: `netCents=0`, `eventCount=0`
- OpenAI/ChatGPT rows in `by-agent-model`: `billingType=subscription_included`

Top cumulative OpenAI rows in the current read:

| Agent | Model | Cold input | Cached input | Output | Cache hit |
|---|---:|---:|---:|---:|---:|
| Software Engineer | gpt-5.5 | 83,572,576 | 75,313,408 | 598,892 | 47.40% |
| CTO | gpt-5.5 | 60,963,237 | 57,909,888 | 280,437 | 48.71% |
| Site Reliability Engineer | gpt-5.5 | 52,563,758 | 47,588,224 | 433,411 | 47.52% |
| Code Reviewer | gpt-5.5 | 48,251,662 | 44,450,304 | 301,420 | 47.95% |
| Security Engineer | gpt-5.5 | 42,375,367 | 38,648,576 | 373,599 | 47.70% |
| Memory & Context Engineer | gpt-5.5 | 36,636,527 | 33,130,240 | 277,310 | 47.48% |
| FinOps Analyst | gpt-5.5 | 32,582,643 | 30,539,264 | 188,137 | 48.38% |

## Code Review Notes

Relevant implementation points:

- `packages/adapters/codex-local/src/server/execute.ts` resumes Codex sessions
  when saved session identity and cwd match.
- On resumed Codex sessions with a Paperclip wake payload, the adapter sends a
  compact resume delta and skips reinjecting the full instructions and default
  heartbeat prompt.
- `server/src/__tests__/codex-local-execute.test.ts` covers the compact wake
  delta behavior.
- `packages/adapters/codex-local/src/server/parse.ts` records
  `cached_input_tokens` from `turn.completed` into `cachedInputTokens`; no
  obvious unit mismatch was found in the parser path.

This lowers the likelihood that the observed 48% OpenAI hit rate is caused only
by naive prompt reinjection on every resumed heartbeat. The remaining likely
causes are:

- frequent fresh-session fallback or session identity mismatch;
- provider-side cache mechanics for Codex/OpenAI subscriptions;
- telemetry aggregation mixing cumulative `by-agent-model` evidence with live
  window evidence;
- routine churn creating many first-turn or low-reuse sessions.

## Proposed Engineering Follow-Up

Create a bounded audit task before any production behavior change:

1. Add a diagnostic report for Codex/OpenAI runs that groups recent
   `costEvents` by session id, issue id, run id, adapter type, model, and
   `cachedInputTokens / (inputTokens + cachedInputTokens)`.
2. Correlate cold-token spikes with session starts, unknown-session fallbacks,
   `codexTransientFallbackMode`, remote execution identity changes, and routine
   coalescing.
3. Add regression coverage only if the audit finds a local bug, such as dropped
   session params or avoidable prompt reinjection.
4. Leave routing/model/routine changes behind an explicit review gate because
   marginal dollars are currently $0.00 and the main risk is capacity/latency.

Projected impact if the 5h OpenAI window reached 98.4% cache efficiency:

- Current 5h OpenAI total input basis: 159,867,674 tokens.
- Cold input at 98.4% cache hit: about 2,557,883 tokens.
- Avoided cold input: about 80,389,855 tokens per 5h.
- Marginal dollar savings at current billing: $0.00.

## Recommendation

Do not disable critical routines or change model routing from this issue alone.
Open a follow-up engineering audit and use the audit output to decide whether to
patch telemetry, session-resume behavior, or operational routine settings.
