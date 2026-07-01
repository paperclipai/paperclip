# Monthly Token-Telemetry ↔ Provider-Billing Reconciliation

**Owner:** Cortex (agent, NEO-299 recurring routine)
**Cadence:** Monthly, on the 1st (UTC), reconciling the **just-closed** UTC calendar month.
**Tracking issue:** [NEO-299](/NEO/issues/NEO-299) · **Parent:** [NEO-166](/NEO/issues/NEO-166) · **Feeds:** [NEO-163](/NEO/issues/NEO-163) telemetry doc, [NEO-164](/NEO/issues/NEO-164) PPA cost model.

## 1. Purpose

Each month, prove that our internal per-org / per-model+route / per-workload token telemetry
(the `cost_events` ledger) reconciles, within an agreed tolerance, against what the providers
actually bill us. The reconciled numbers are the measured baselines that replace the estimate-only
figures in the NEO-163 telemetry doc and NEO-164 PPA cost model, and they are the evidence base for
the Anthropic-through-Bedrock PPA qualification narrative.

Reconciliation is **not** a human dashboard-pulling chore. The agent pulls the internal rollup,
pulls the provider surfaces itself (using available provider credentials/secrets), computes the
variance, and appends a dated Results entry to this doc. A human is escalated to **only** when a
provider billing surface is genuinely inaccessible with the credentials on hand.

## 2. Data source — internal rollup (plumbing)

The canonical internal source is the monthly rollup endpoint:

```
GET /companies/:companyId/costs/monthly-rollup?from=<UTC-month-start>&to=<next-UTC-month-start>
```

- **Bounds are half-open UTC month boundaries**: `from = YYYY-MM-01T00:00:00Z`,
  `to = <first day of next month>T00:00:00Z`. The service buckets by
  `date_trunc('month', occurred_at AT TIME ZONE 'UTC')`, so passing exact UTC month bounds
  yields exactly one `month` bucket.
- This is the same data Ruth pulls from **Costs → Monthly rollup → Download CSV**.

**Response dimensions** (one row per group):

| field | meaning |
|---|---|
| `month` | `YYYY-MM` (UTC) |
| `provider` | anthropic / openai / … (the model vendor) |
| `biller` | who invoices us: `anthropic`, `aws_bedrock`, `openrouter`, `unknown` |
| `billingType` | `metered` / `subscription_included` / `unknown` |
| `model` | e.g. `claude-opus-4-8`, `claude-opus-4-8[1m]` |
| `workload` | `autonomous` / `interactive` / `distillation` |
| `bedrock` | boolean, `biller = 'aws_bedrock'` (the PPA-qualifying slice) |
| `costCents`, `inputTokens`, `cachedInputTokens`, `outputTokens` | summed |
| `eventCount`, `runCount` | rows, and distinct `heartbeat_run_id` |

> **Plumbing status (as of 2026-07-01): NOT YET DEPLOYED.** The `monthly-rollup` endpoint and the
> `workload` dimension were built under [NEO-165](/NEO/issues/NEO-165) (branch
> `feat/neo-165-token-telemetry-workload`, commit `09b3b583f`, migration `0099_cost_event_workload`)
> but that issue was **cancelled** and the change was never merged to `master` / deployed to
> `cortex.neoreef.com`. The endpoint returns HTTP 404 in production and `cost_events` has no
> `workload` column. Re-landing this plumbing is a **hard prerequisite** for the first meaningful run
> (2026-08-01). See §7 Results / 2026-07-01 and the NEO-299 blocker. Until it lands, runs fall back
> to the already-deployed slice endpoints (`/costs/by-provider`, `/costs/by-biller`,
> `/costs/by-agent-model`) which carry provider/biller/billingType/model but **not** workload.

## 3. Per-run procedure

1. **Compute UTC month bounds** for the just-closed month (`from`, `to` as in §2).
2. **Pull the internal rollup CSV** for those bounds (the Ruth surface / the `monthly-rollup`
   endpoint). Persist it as the run's raw internal artifact.
3. **Pivot per the §4 dimension → dashboard mapping** and pull each provider's billing surface for
   the same UTC month. Use provider credentials/secrets directly; do not hand this to a human
   (rule #1). Apply the §5 systematic adjustments before comparing.
4. **Compute per-slice variance** (internal vs provider) for both tokens and cost, against the §6
   tolerance.
5. **Append a dated Results section** (§7) with: the slices, internal totals, provider totals,
   variance %, pass/fail vs tolerance, and any new systematic gaps discovered.
6. **First meaningful run only (2026-08-01, covering July 2026):** replace the estimate numbers in
   the [NEO-163](/NEO/issues/NEO-163) telemetry doc and [NEO-164](/NEO/issues/NEO-164) PPA cost
   model with the measured baselines, and close [NEO-166](/NEO/issues/NEO-166) (which unblocks the
   remainder of [NEO-165](/NEO/issues/NEO-165)'s "Done when").
7. A run **before a full closed tagged month exists** validates the rollup → CSV → pivot plumbing
   only and does **not** post baselines.

## 4. Dimension → dashboard mapping

| internal slice (rollup) | provider billing surface |
|---|---|
| `provider=anthropic`, `biller=anthropic` | **Anthropic Console** → Usage / Cost (per-model, per-day; sum to UTC month) |
| `biller=aws_bedrock` (the `bedrock=true` slice) | **Bedrock CloudWatch** model-invocation metrics (tokens) **+ AWS Cost Explorer** filtered to Bedrock (cost) |
| `provider=*, biller=openrouter` | **OpenRouter** activity/usage export |

## 5. Known systematic gaps (apply before comparing)

- **Cache-token accounting.** Anthropic bills cache-write and cache-read at different multiples of
  the base input rate; the ledger stores `cachedInputTokens` as a raw count. When reconciling
  **cost**, cache reads/writes must be priced separately, not folded into `inputTokens`. This is the
  single largest source of token-vs-cost skew given our cache-heavy workload (June 2026: cached
  input ≈ **94×** raw input — see §7).
- **Bedrock has no cache dimension.** Bedrock invocations don't expose a cache-token breakout the
  way the Anthropic API does; the `bedrock=true` slice reconciles on input/output only.
- **OpenRouter margin.** OpenRouter's invoiced amount includes its markup over the underlying model
  price; expect internal (model-priced) cost to run *under* the OpenRouter invoice by the margin.
- **UTC month boundary.** Provider dashboards may default to a local/billing-cycle timezone. Always
  force the provider surface to UTC and to calendar-month (not billing-cycle) bounds to match the
  `date_trunc('month', … AT TIME ZONE 'UTC')` bucketing.
- **Subscription vs metered.** `billingType=subscription_included` rows (e.g. Claude Max seats) have
  `costCents=0` in the ledger and no per-token line on the provider invoice — reconcile these on
  **tokens only**; they do not appear in provider *cost*. Only `billingType=metered` rows carry a
  cost line to reconcile.

## 6. Tolerance

Proposed (pending Ruth/CFO sign-off): **±2% tokens**, **±5% cost** per reconciled slice. A slice
outside tolerance is flagged in its Results entry with a root-cause note and, if it recurs, a
follow-up issue.

## 7. Results log (append-only)

### 2026-07-01 — plumbing-validation run (pre-full-month; no baselines posted)

**Scope:** validate the rollup → CSV → pivot plumbing only. July 2026 is not closed; the first
meaningful run is 2026-08-01. No baselines posted (per §3.7).

**Plumbing verdict: NOT READY.**

- `GET /companies/:companyId/costs/monthly-rollup` → **HTTP 404** on `cortex.neoreef.com`. The
  endpoint is unmerged/undeployed (NEO-165 / commit `09b3b583f` cancelled).
- `cost_events` has **no `workload` column** on `master`/deployed → the workload dimension is **not
  being captured**. The NEO-299 premise that "tagging began at the NEO-165 merge on 2026-06-17" does
  **not** hold: PR for NEO-165 (`feat/neo-165-token-telemetry-workload`) was never merged.
- **Blocker raised** on NEO-299: re-land the monthly-rollup endpoint + `workload` column + workload
  tagging (and deploy) before 2026-08-01, or the first meaningful run cannot execute.

**What *is* deployed and working** — the base `cost_events` ledger and the slice endpoints
(`by-provider`, `by-biller`, `by-agent-model`) return real June 2026 data, proving the underlying
pivot works end-to-end minus the workload dim and the single-endpoint rollup:

| June 2026 (UTC), biller=anthropic, all subscription_included | value |
|---|---|
| distinct runs | 521 |
| input tokens | 9,335,978 |
| cached input tokens | 873,680,106 |
| output tokens | 9,022,606 |
| metered cost | $0.00 (subscription-included) |
| billers present | `anthropic` only — **no `aws_bedrock`, no `openrouter`** |
| models | 3 (`claude-opus-4-8`, `claude-opus-4-8[1m]`, + haiku) |

**Observations that will matter for the 2026-08-01 baseline run:**

- **Cache dominance:** cached input ≈ 94× raw input. Cost reconciliation must price cache
  reads/writes explicitly (§5) or it will be meaningless.
- **No Bedrock volume yet:** the `bedrock=true` / PPA-qualifying slice is currently **empty** — all
  traffic is Anthropic first-party subscription. The PPA-volume narrative (NEO-164) has no measured
  Bedrock tokens to stand on until Bedrock routing carries real load.
- **All subscription, $0 metered:** with everything `subscription_included`, there is no provider
  *cost* line to reconcile yet — only token reconciliation against Anthropic Console usage applies.

**Next run:** 2026-08-01, covering July 2026 — **conditional on the plumbing blocker clearing.**
