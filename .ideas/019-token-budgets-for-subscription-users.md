# 019 — Token-Denominated Budgets for Subscription / Flat-Rate Users

## Suggestion

Paperclip's budgets and cost controls are **dollar-denominated**: company and agent budgets
are `budgetMonthlyCents` / `spentMonthlyCents`, budget policies enforce on `billed_cents`, and
the spend bar is computed as `spendCents / budgetMonthlyCents`. That works for pay-per-token
(metered) API keys — but it's **blind for subscription / flat-rate users**, who are a large and
growing share of operators (Claude Pro/Max, ChatGPT Plus, Claude Code on a subscription, etc.).

For those users the marginal cost of a run is ≈ $0, so `costCents` ≈ 0. Result: their budget
shows "$0 spent," their hard-stop never trips, and an agent can burn through the subscription's
real constraint — **tokens and rate-limit windows** — completely unguarded. The very users who
most need a guardrail (you can't just "spend less" your way out of a fixed plan's rate limit)
have none. The system already *knows* this is happening — `BILLING_TYPES` distinguishes
`metered_api`, `subscription_included`, and `subscription_overage`, and `cost_events` records
`inputTokens` / `cachedInputTokens` / `outputTokens` per run — but budgets never consume that
data.

Make **token usage a first-class budget metric** alongside dollars, so subscription users can
set and enforce real limits.

## Why this is mostly unfinished plumbing, not a greenfield build

The framework already anticipates non-dollar metrics — it's just not implemented:

- `budget_policies.metric` is a generic column that **defaults to `"billed_cents"`** (the
  schema clearly expected other metrics), with a per-scope-per-metric unique index.
- A `BudgetMetric` type already exists in shared validators/types.
- The warn / hard-stop / incident / override machinery in `budgets.ts` is **metric-agnostic** —
  it threshold-checks `spend vs amount` regardless of unit.
- The one thing blocking it: `budgets.ts` (~line 161) short-circuits —
  `if (policy.metric !== "billed_cents") return 0;` — so any token-metric policy computes a
  spend of 0 and never fires.
- `costs.ts` already aggregates `inputTokens`/`outputTokens` and even breaks out
  `subscriptionInputTokens` / `subscriptionOutputTokens` / `subscriptionRunCount` separately.

## How it could be achieved

1. **Extend the metric enum.** Add `total_tokens` (and optionally `input_tokens`,
   `output_tokens`, `run_count`) to `BudgetMetric` / `BILLING`-adjacent constants.
2. **Implement the missing spend computation.** Replace the `return 0` short-circuit in
   `budgets.ts` with real aggregation per metric — sum `costEvents.inputTokens + outputTokens`
   (or the chosen columns) over the policy window. The summation helper already exists in
   `costs.ts` (`sumAsNumber` over `costEvents.inputTokens` / `outputTokens`).
3. **Window alignment for subscriptions.** Subscription limits reset on provider-specific
   schedules (e.g. rolling 5-hour windows), not calendar months. Let a token policy's
   `windowKind` mirror the provider quota window already surfaced by `quota-windows.ts`, so a
   Paperclip token budget can track "tokens used in the current rate-limit window."
4. **Budget UI for both units.** Let operators set a token budget per company/agent and show
   token spend next to dollar spend on the budget overview. For `subscription_included`
   agents, lead with tokens/run-count (the real constraint) and de-emphasize the $0 cost.
5. **Optional imputed/shadow cost.** For comparison and capital-allocation, compute an
   *imputed* dollar value of subscription token usage from public list prices ("you used
   ~$140 of tokens on a flat plan"). This lets the Unit-Economics Dashboard (idea 013) and
   Holding Company (idea 007) compare metered vs subscription agents on equal footing without
   implying real cash was spent.
6. **Mixed enforcement.** A scope can carry both a `billed_cents` policy and a `total_tokens`
   policy; the hardest-binding one wins. This also makes `subscription_overage` honest — stay
   within the token budget on the included plan, and only metered-cost budgets bite once you
   spill into overage pricing.

## Perceived complexity

**Low–Medium.** The schema (`metric` column), the token data (`cost_events`), the
subscription-aware aggregation (`costs.ts`), and the threshold/incident/override enforcement
(`budgets.ts`) all already exist — the core work is implementing the non-cents spend
computation (removing one short-circuit), extending the metric enum, and the budget-setting UI.
The genuinely subtle parts are (a) aligning token windows to provider rate-limit resets rather
than calendar periods, and (b) deciding how cached-input tokens count toward a budget (they're
cheaper/free and shouldn't be penalized like fresh input). Ship calendar-window token budgets
first (trivial given the above), then add provider-window alignment.
