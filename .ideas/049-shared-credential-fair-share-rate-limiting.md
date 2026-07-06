# 049 — Shared Credential Pooling & Fair-Share Rate Limiting

## Suggestion

In real deployments, many agents share **one** provider credential — a single Anthropic API key,
one OpenAI org, one Claude subscription. That shared key has a finite rate limit (RPM/TPM) and,
for subscriptions, a shared usage window. Paperclip *observes* provider quota
(`quota-windows.ts`) but a code scan finds **no notion of pooling a shared credential or
fair-sharing its capacity across agents**. So when ten agents back the same key, they stampede it:
the noisiest agents starve the rest, everyone hits 429s at once, and a single low-priority agent
can consume the whole window the CEO agent needed. Per-agent run concurrency (idea 001) doesn't
help — four runs each making rapid calls on one shared key still blow its rate limit.

Add **shared-credential pooling with fair-share rate limiting**: model a credential as a pooled
resource with a known capacity, and meter agents' access to it fairly by priority/weight.

## How it could be achieved

1. **Model the pool.** Group agents that resolve the same underlying credential
   (`agent-secret-bindings.ts`, `secrets.ts`) into a pool with a configured capacity (RPM/TPM, or
   the provider window from `quota-windows.ts`).
2. **Fair-share scheduler.** Put a token-bucket / weighted-fair-queue in front of the pool: each
   agent gets a share of the credential's capacity by weight (role/priority/trust), so no single
   agent monopolizes it and critical agents get guaranteed headroom. This is the credential-level
   sibling of the run-level Fleet Governor (idea 001).
3. **Backpressure, not failure.** When the pool is saturated, *queue* an agent's next call (or
   defer its heartbeat — idea 035) instead of letting it 429, and prefer the provider-fallback
   chain (idea 012) — including a local model (idea 008) — for low-priority work when the shared
   key is hot.
4. **Reserve capacity.** Let operators reserve a slice of a shared key for critical roles ("CEO +
   on-call agents always get 20%"), so a marketing batch can't crowd out strategic work.
5. **Visibility.** Show per-credential utilization and which agents are consuming it — the missing
   answer to "why is everything rate-limited right now?"

## Perceived complexity

**Medium.** Credential resolution and quota observation already exist; the new core is the pool
model plus a fair-share/token-bucket gate in the call path, which is well-understood but must be
correct under concurrency (no double-spend of capacity, graceful when the provider's real limit
differs from the configured one). The subtle part is estimating per-call cost *before* the call to
budget the bucket (token counts are only known after) — approximate up front and reconcile after.
Strong synergy with ideas 001 (run concurrency), 012 (fallback), 019 (token budgets), and 035
(heartbeat backoff): together they govern load at the run, credential, and provider layers.
