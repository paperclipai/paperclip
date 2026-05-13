# RFC: Stripe Usage-Billing Primitives for Paperclip

- **Status:** Draft v0.1 — open for review
- **Author:** Joe Lee, CTO @ Company OS (downstream Paperclip consumer)
- **Date:** 2026-05-13
- **Implements:** Company OS [JOE-3 MVP §1 capability 8 + §4 Risk 1](/JOE/issues/JOE-3#document-mvp)
- **Tracks:** Company OS [JOE-11](/JOE/issues/JOE-11)
- **Downstream blocker for:** Company OS [JOE-13](/JOE/issues/JOE-13) (Week 2 PR-1 metering pipeline)

## 0. Summary

Paperclip lacks usage-metering primitives. Company OS (and every other downstream Paperclip consumer that wants metered billing) cannot wire Stripe usage records without re-implementing the capture, idempotency, and rollup layers per-product. This RFC proposes a small, opinionated set of upstream primitives:

1. An **append-only meter-event log** writable by anything inside Paperclip with a `(meter_key, source_event_type, source_event_id)` idempotency contract.
2. A **per-company per-day rollup** populated by a built-in hourly routine, with a 7-year retention floor for financial records.
3. A **pluggable usage-reporter** that maps `(company, meter_key)` → Stripe `subscription_item`, batched hourly, idempotent on a deterministic key.
4. A **subscription-state machine** (`current → grace → suspended → cancelled`) driven by Stripe webhooks, with a hook for downstream products to enforce suspension semantics.
5. A **first-party test harness** (Stripe sandbox + `stripe listen` + local stub) so consumers can verify the contract without standing up infra.

Out of scope for this RFC: any product-layer UI, plan-pricing definitions, or per-tenant quotas. Those belong downstream.

## 1. Metering primitive

### 1.1 What counts

Three meters are first-class at v1. They are deliberately few — adding meters later is cheap; removing is expensive once consumers depend on them.

| `meter_key` | Unit | Semantics |
|---|---|---|
| `agent_minute` | seconds (stored), minutes (reported to Stripe via rounding) | Wall-clock duration of a heartbeat run, attributed to the run's agent + company. |
| `action_completed` | count | A discrete agent action with business meaning: issue created, comment posted, document put (new revision), approval created, attachment uploaded, routine fired. Excludes pure reads. |
| `doc_published` | count | A specialization: an issue document revision that crosses a `published=true` flag set by the consumer. Optional — only consumers that opt-in to publication flags emit it. |

A `meter_key` is a string, not an enum, so consumers can register additional product-specific meters via `meter_registry.register(meter_key, unit_label, stripe_quantity_fn)`. v1 ships the three above and the registry hook; consumers register their own at boot.

### 1.2 How captured: observer, not synchronous

Synchronous billing in the hot path is rejected. Reasons:

- **Latency cost.** Adding a DB write to every action multiplies write traffic by ~2x for an effect (billing) that doesn't need to be in-band.
- **Retry coupling.** A failed meter write should never fail the underlying action. If agent comment creation fails because the meter table is hot, the product is broken.
- **Idempotency surface.** Doing it in-band means every retry path in every action handler needs idempotency awareness for meters. Observer pattern centralizes that.

The pattern:

1. Existing Paperclip domain events (`run.completed`, `issue.created`, `comment.created`, `document.put`, `approval.created`, `attachment.uploaded`, `routine.fired`) are emitted on the existing event bus. (v0.1 of the bus already exists for wake/heartbeat plumbing; we extend it.)
2. A new **meter subscriber** consumes those events and writes to `meter_events`. The subscriber lives in-process for v1 (single Paperclip control-plane node); the schema is forward-compatible with moving it to a separate worker queue (Vercel Queues / SQS) when we shard.
3. The subscriber is **at-least-once**. The idempotency key on `meter_events` (see §1.3) absorbs duplicates.
4. Failure to write a meter row triggers a **structured-log line at ERROR** (`paperclip.metering.write_failed`) plus a counter increment. It does not raise. A scheduled reconciliation job replays missed events from the event log nightly (see §6).

### 1.3 Schema

PostgreSQL, in Paperclip's existing control-plane DB. Append-only.

```sql
CREATE TABLE meter_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at         TIMESTAMPTZ NOT NULL,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  agent_id            UUID REFERENCES agents(id) ON DELETE SET NULL,
  meter_key           TEXT NOT NULL,
  quantity            BIGINT NOT NULL,           -- in the meter's native unit (seconds for agent_minute, count for the rest)
  source_event_type   TEXT NOT NULL,             -- e.g. 'run.completed'
  source_event_id     TEXT NOT NULL,             -- the domain event's id
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meter_events_idempotency
    UNIQUE (meter_key, source_event_type, source_event_id)
);

CREATE INDEX meter_events_company_occurred_idx
  ON meter_events (company_id, occurred_at DESC);

CREATE INDEX meter_events_unrolled_idx
  ON meter_events (meter_key, company_id, occurred_at)
  WHERE occurred_at >= now() - INTERVAL '7 days';   -- hot window for rollup
```

Notes:

- `company_id` is `ON DELETE RESTRICT`: meter rows outlive the parent company until the financial-records retention has elapsed, otherwise audits become impossible.
- `quantity` is `BIGINT` to keep the option open for sub-unit reporting later (e.g. fractional minutes if we move to seconds-billing); v1 stores integer units and converts at Stripe-report time.
- The partial index on the 7-day hot window keeps rollup queries cheap as the table grows.
- The UNIQUE constraint is the idempotency lever. Every meter write goes through `INSERT … ON CONFLICT DO NOTHING`. Replays are no-ops.

### 1.4 API

Library surface, not REST. The meter subscriber is internal; consumers don't write meter rows directly. If a consumer ever needs to (e.g. a product-layer event Paperclip can't see), it goes through:

```ts
paperclip.metering.record({
  companyId: string,
  agentId?: string,
  meterKey: string,
  quantity: number,
  occurredAt: Date,
  sourceEventType: string,
  sourceEventId: string,        // caller-controlled idempotency
  metadata?: Record<string, unknown>,
}): Promise<{ recorded: boolean }>;
```

`recorded: false` means the row was a duplicate. Callers should treat that as success.

## 2. Rollup

### 2.1 Aggregate table

```sql
CREATE TABLE meter_rollups_daily (
  company_id     UUID NOT NULL,
  meter_key      TEXT NOT NULL,
  bucket_date    DATE NOT NULL,                  -- UTC day
  quantity       BIGINT NOT NULL,                -- in native meter unit
  event_count    BIGINT NOT NULL,                -- number of underlying meter_events rows
  rolled_up_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (company_id, meter_key, bucket_date)
);

CREATE INDEX meter_rollups_daily_company_idx
  ON meter_rollups_daily (company_id, bucket_date DESC);
```

### 2.2 Routine

A built-in Paperclip routine, owned by a synthetic system agent (`paperclip-metering-rollup`), schedule `0 * * * *` (hourly), `concurrencyPolicy: skip_if_running`, `catchUpPolicy: window_24h`:

```sql
INSERT INTO meter_rollups_daily (company_id, meter_key, bucket_date, quantity, event_count, rolled_up_at)
SELECT
  company_id,
  meter_key,
  date_trunc('day', occurred_at AT TIME ZONE 'UTC')::date AS bucket_date,
  SUM(quantity)::bigint,
  COUNT(*)::bigint,
  now()
FROM meter_events
WHERE occurred_at >= (now() - INTERVAL '49 hours')          -- always re-roll yesterday + today to absorb late events
  AND occurred_at <  date_trunc('hour', now())              -- never roll the in-flight hour
GROUP BY company_id, meter_key, bucket_date
ON CONFLICT (company_id, meter_key, bucket_date) DO UPDATE
  SET quantity     = EXCLUDED.quantity,
      event_count  = EXCLUDED.event_count,
      rolled_up_at = EXCLUDED.rolled_up_at;
```

Properties:

- **Idempotent.** Re-running the rollup is safe; it recomputes from source events.
- **Late events tolerated.** The 49-hour lookback re-rolls yesterday, so an event that arrives 36 hours late gets counted.
- **In-flight hour excluded.** We don't roll up the current hour to avoid partial sums.

### 2.3 Retention

| Table | Hot (Postgres) | Cold (object storage) | Justification |
|---|---|---|---|
| `meter_events` | 90 days | 7 years, archived nightly to S3-compatible bucket as Parquet | Stripe disputes need raw event provenance up to chargeback window (~120 days); 7 years matches typical financial-records floor. |
| `meter_rollups_daily` | 7 years | — | Source of truth for billing; small enough to keep in Postgres indefinitely. |

A separate `paperclip-metering-archive` routine runs daily and copies `meter_events` older than 90 days to cold storage, then deletes them from Postgres. Cold storage retains forever (Stripe-dispute and SOC-2-audit considerations).

## 3. Stripe contract

### 3.1 Mapping

A new table:

```sql
CREATE TABLE billing_stripe_subscriptions (
  company_id              UUID PRIMARY KEY REFERENCES companies(id),
  stripe_customer_id      TEXT NOT NULL,
  stripe_subscription_id  TEXT NOT NULL,
  status                  TEXT NOT NULL,             -- mirror of subscription-state machine (§5)
  current_period_start    TIMESTAMPTZ NOT NULL,
  current_period_end      TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE billing_meter_mappings (
  company_id                  UUID NOT NULL REFERENCES billing_stripe_subscriptions(company_id),
  meter_key                   TEXT NOT NULL,
  stripe_subscription_item_id TEXT NOT NULL,
  quantity_unit               TEXT NOT NULL,         -- 'minute', 'count', etc.
  reporting_enabled           BOOLEAN NOT NULL DEFAULT false,   -- dark-launch flag
  PRIMARY KEY (company_id, meter_key)
);
```

`reporting_enabled = false` means "capture meters, do not send to Stripe." This is the MVP beta posture for Company OS (§MVP §1 capability 8: "usage meter visible but not charged"). Flipping to `true` per-company per-meter is the production rollout switch.

### 3.2 Reporting cadence

**Batched hourly**, not realtime. Reasons:

- Stripe's `usage_records` endpoint accepts `action=increment`, which composes cleanly with hourly batches. No correctness benefit to realtime.
- Hourly reduces Stripe API surface by ~3600x vs. per-event reporting → fewer retry edges, fewer rate-limit risks, simpler error budgets.
- Hourly is well within the granularity Stripe's invoice generator needs (monthly).

The reporter is another built-in routine, `paperclip-stripe-usage-reporter`, schedule `15 * * * *` (offset 15 min from rollup), runs only when `reporting_enabled=true` for at least one mapping:

```text
For each company with reporting_enabled mappings:
  For each enabled mapping (company_id, meter_key, sub_item_id):
    Compute delta_since_last_report = SUM(meter_rollups_daily.quantity)
      WHERE company_id = ? AND meter_key = ?
        AND bucket_date >= last_reported_bucket_date(company_id, meter_key)
        AND bucket_date <  current_hour_bucket_date
      MINUS previously_reported_quantity(company_id, meter_key)
    If delta > 0:
      POST /v1/subscription_items/{sub_item_id}/usage_records
        body: { quantity: convert_to_stripe_unit(delta, quantity_unit),
                timestamp: end_of_last_completed_hour,
                action: 'increment' }
        headers: { Idempotency-Key: 'meter:{company_id}:{meter_key}:{ISO_HOUR}' }
      Record (company_id, meter_key, ISO_HOUR, quantity, stripe_usage_record_id) in billing_stripe_usage_records
```

### 3.3 Idempotency

Two layers:

1. **Stripe-level idempotency key.** Deterministic: `meter:{company_id}:{meter_key}:{ISO_HOUR_BUCKET}`. Stripe deduplicates server-side for 24 hours, so a retry within that window is a no-op.
2. **Local replay ledger.**

```sql
CREATE TABLE billing_stripe_usage_records (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               UUID NOT NULL,
  meter_key                TEXT NOT NULL,
  hour_bucket              TIMESTAMPTZ NOT NULL,    -- truncated to hour
  quantity_reported        BIGINT NOT NULL,
  stripe_usage_record_id   TEXT,
  stripe_idempotency_key   TEXT NOT NULL,
  reported_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                   TEXT NOT NULL,            -- 'sent', 'failed', 'replayed'
  error_message            TEXT,

  UNIQUE (company_id, meter_key, hour_bucket)
);
```

If a row already exists for `(company_id, meter_key, hour_bucket)` with `status=sent`, the reporter skips. If `status=failed`, the reporter retries on the next pass with backoff. After 6 failed retries, the row is marked `dead` and an approval is auto-opened to the company's owning agent (per chain-of-command) so a human can intervene.

### 3.4 Quantity conversion

Per-meter `stripe_quantity_fn` (registered in §1.1) converts the native unit to the integer Stripe expects:

- `agent_minute`: `Math.ceil(seconds / 60)` — round up to whole minutes (consumer-favorable for us, plays nice with Stripe's integer quantity).
- `action_completed` / `doc_published`: identity (`count`).

The rounding rule is fixed at the registry level; consumers can't override it ad-hoc, since that would break audit reconciliation.

## 4. Invoice & proration

### 4.1 Monthly invoice

Stripe generates the invoice automatically at the end of each billing cycle, summing all usage records posted within the period plus the recurring flat fee. Paperclip does not generate invoices; it only feeds usage records and listens for invoice events.

Webhook handler `invoice.finalized`:

- Persists the invoice id + amount + period to `billing_invoices`.
- Posts a comment to the company's owning issue thread (consumer-defined) so the founder can see "Invoice posted: $X for period Y."
- Does not advance the subscription-state machine. State changes only happen on `payment_*` webhooks (§5).

### 4.2 Proration

Stripe handles default proration on plan changes. For mid-cycle plan switches initiated by the consumer:

```ts
paperclip.billing.previewProration({
  companyId,
  newPriceIds: [...],
}): Promise<{ amountDue: number, lineItems: [...] }>;
```

This wraps `GET /v1/invoices/upcoming?customer=...&subscription_items=...` and returns the preview without committing. The consumer's product-layer UI shows the preview to the founder; on confirmation:

```ts
paperclip.billing.applyPlanChange({
  companyId,
  newPriceIds: [...],
  prorationBehavior: 'create_prorations',  // Stripe default
}): Promise<{ subscriptionId: string }>;
```

### 4.3 Refunds

Refunds are out-of-band from the meter pipeline. The principle: **meters are factual; refunds are financial adjustments**. Zeroing a meter row to "refund a usage charge" destroys audit history.

Refund flow:

- Consumer calls `paperclip.billing.refund({ companyId, invoiceId, amount, reason })`.
- Wraps `POST /v1/refunds` against Stripe.
- Records in `billing_refunds (id, company_id, invoice_id, stripe_refund_id, amount, reason, refunded_at)`.
- Posts a comment to the same issue thread as the invoice.
- Meter rows are untouched.

If a consumer ever needs to *credit* a future invoice (e.g. SLA credit), use Stripe `customer.invoice_settings.custom_fields` or `customer.invoice_credit_balance` — not meter manipulation.

## 5. Failed-payment dunning state machine

### 5.1 States

```
current  ──(invoice.payment_failed)──▶  grace
grace    ──(invoice.paid)──────────▶  current
grace    ──(T+7 days)──────────────▶  suspended
suspended──(invoice.paid)──────────▶  current
suspended──(T+30 days from grace)──▶  cancelled
*        ──(consumer.cancel)───────▶  cancelled
```

Persisted in `billing_stripe_subscriptions.status`.

### 5.2 Triggers and side effects

| Transition | Trigger | Side effects |
|---|---|---|
| `current → grace` | Webhook `invoice.payment_failed` | Set `grace_started_at`. Schedule emails at T+0, T+3, T+6. Emit `paperclip.billing.subscription.grace_entered` event for consumers. |
| `grace → current` | Webhook `invoice.paid` | Clear `grace_started_at`. Cancel scheduled emails. Emit `subscription.recovered`. |
| `grace → suspended` | Cron at T+7 from `grace_started_at` with no `invoice.paid` | Emit `subscription.suspended` event. **Consumers are expected to honor suspension** by enforcing a 402 on agent heartbeats for that company. Paperclip ships a default middleware that does this; consumers can override but must opt-in to do so. |
| `suspended → current` | Webhook `invoice.paid` | Emit `subscription.recovered`. Paperclip middleware re-enables heartbeats. |
| `suspended → cancelled` | Cron at T+30 from `grace_started_at` | Emit `subscription.cancelled`. Lock the company (read-only). Founder retains read access for 90 days; then data is archived per Paperclip's existing deletion policy. |
| `* → cancelled` | `paperclip.billing.cancelSubscription({ companyId })` | Same as above plus optional immediate vs end-of-period; defaults to end-of-period. |

### 5.3 Email contract

Dunning emails are sent via the consumer's configured email provider. Paperclip ships templates (subject + body, Markdown) and exposes a `paperclip.billing.email.send` hook the consumer wires to their email vendor (Resend, SES, etc.). The default Paperclip-hosted deployment ships a Resend-backed implementation; self-hosters provide their own.

Templates: `dunning.t0`, `dunning.t3`, `dunning.t6`, `dunning.suspended`, `dunning.cancelled`. All include:

- Outstanding amount + invoice link
- "Update payment method" link → Stripe Customer Portal session
- Grace period clock ("Your account will be suspended on YYYY-MM-DD UTC")
- Company name + founder name (resolved via the company's owning user)

### 5.4 Heartbeat enforcement

A default `paperclip.middleware.billing.enforceSubscription` middleware checks the company's `billing_stripe_subscriptions.status` before allowing a heartbeat run to start. If `suspended` or `cancelled`, the run is short-circuited and the agent receives a 402-equivalent response that's surfaced in the run log. Consumers can disable this per-company (e.g. internal Paperclip-team companies) by setting `billing_stripe_subscriptions.enforcement_mode = 'observe'`.

## 6. Test harness

### 6.1 Sandbox flow

Paperclip ships `paperclip test billing` (CLI subcommand) that, given Stripe test keys in env, runs a deterministic end-to-end scenario:

1. Boots Paperclip with a test config that points to Stripe sandbox.
2. Creates a synthetic test company + customer + subscription with two metered items (`agent_minute`, `action_completed`).
3. Fires N synthetic events through the existing event bus (`run.completed × 10`, `comment.created × 50`).
4. Forces rollup and reporter to run inline (skip the cron wait).
5. Asserts:
   - `meter_events` has exactly N rows (idempotency on retry of the same events).
   - `meter_rollups_daily` reflects the sum.
   - `billing_stripe_usage_records` has rows for each `(meter_key, hour_bucket)` with `status=sent`.
   - Stripe sandbox returns matching usage records via `GET /v1/subscription_items/{id}/usage_record_summaries`.
6. Cleans up the test customer.

### 6.2 Local-only mode (no Stripe round-trip)

`paperclip test billing --local-stub` substitutes an in-memory Stripe stub that records calls but doesn't hit the network. Used in CI for fast unit tests; the sandbox path runs nightly + on release tags.

### 6.3 Webhook simulator

`stripe listen --forward-to localhost:3100/webhooks/stripe` for local dev. Paperclip ships a `stripe trigger` recipe file (`docs/billing/stripe-fixtures.yaml`) that maps named scenarios to `stripe trigger` invocations:

- `happy_path` — subscribe → use → invoice → pay.
- `payment_failed_recovery` — subscribe → use → `invoice.payment_failed` → wait → `invoice.paid` → assert `current`.
- `payment_failed_suspend` — subscribe → use → `invoice.payment_failed` → fast-forward 7 days → assert `suspended`.
- `payment_failed_cancel` — subscribe → use → `invoice.payment_failed` → fast-forward 30 days → assert `cancelled`.
- `proration_mid_cycle` — subscribe → use → plan-change → assert preview matches actual.
- `refund` — subscribe → use → pay → refund → assert meters intact.
- `idempotency_replay` — fire same event 10x → assert exactly one meter row, exactly one Stripe usage record.

### 6.4 Reconciliation

A nightly routine, `paperclip-metering-reconcile`, compares `SUM(meter_rollups_daily.quantity)` for each `(company_id, meter_key)` in the prior 7 days against the corresponding Stripe usage-record sum. Discrepancies generate an approval to the platform on-call.

## 7. Migration & rollout

### 7.1 PR sequence

This RFC is the design doc. Implementation lands as three PRs against the Paperclip repo:

| PR | Scope | Tracks |
|---|---|---|
| PR-1 | Metering pipeline: schema, event subscriber, rollup routine, `paperclip.metering.record` API, local tests. No Stripe round-trip. | [JOE-13](/JOE/issues/JOE-13) |
| PR-2 | Stripe contract: mappings, usage reporter, idempotency ledger, webhook handlers for `invoice.*`, sandbox harness. | (to be created — Week 3 milestone in [JOE-3](/JOE/issues/JOE-3#document-mvp)) |
| PR-3 | Dunning state machine, default enforcement middleware, email templates, full `paperclip test billing` harness, reconciliation. | (to be created — Week 3–4) |

### 7.2 Feature flags

- Per-company `billing_stripe_subscriptions.enforcement_mode` (`enforce` / `observe`) for the heartbeat middleware. Default: `enforce` for paying companies, `observe` for internal/test.
- Per-mapping `billing_meter_mappings.reporting_enabled` for Stripe round-trip. Default: `false`. Flipping to `true` is the production rollout switch per-meter, per-company.

### 7.3 Backwards compatibility

This is net-new schema and net-new code paths. No existing Paperclip surface is modified except:

- The event bus gains additional subscribers — additive, no breaking change.
- A new system agent (`paperclip-metering-rollup`) is auto-created on migration. It cannot be deleted by company admins.

No data migrations required; new tables start empty.

## 8. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Synchronous in-band metering** | Hot-path latency + retry coupling. Rejected in §1.2. |
| **Realtime per-event usage reporting to Stripe** | 3600x API surface increase for no correctness benefit. Rejected in §3.2. |
| **Store quantities as `NUMERIC` for fractional precision** | Premature. Integer units are sufficient for v1 meters. `BIGINT` reserves the option to redefine units finer later. |
| **One Stripe subscription per meter** | Stripe charges per subscription. Combining meters under one subscription with multiple `subscription_items` keeps it to one. |
| **Zero meter rows on refund** | Destroys audit history. Refunds are tracked separately (§4.3). |
| **No idempotency ledger; rely solely on Stripe idempotency key** | Stripe's 24-hour idempotency window is shorter than our retry-with-backoff worst case (6 retries over 7 days for `failed`). Local ledger needed. |
| **External Postgres for billing** | Adds vendor + data-locality coordination. Billing data is small enough; co-locate. |

## 9. Open questions

1. **Multi-region.** When Paperclip shards across regions, where does the meter subscriber live? v1 assumes single control-plane region; v2 must address per-region capture + central rollup. Not blocking for MVP.
2. **Tax handling.** Stripe Tax integration is out of scope; we'll layer it on once we have a non-US partner. Tracked separately.
3. **Tiered pricing.** v1 supports `usage_type=metered` with linear per-unit pricing. Tiered pricing works on the Stripe side natively; no Paperclip change needed beyond what's specified.
4. **GDPR deletion vs. financial-records retention.** If a company invokes deletion, meter rows must be anonymized (drop `agent_id`, keep `company_id` hash) rather than deleted, to preserve the 7-year financial record. Needs legal sign-off before PR-3 lands.

## 10. Done-when

This RFC is **merged** when:

- This document is committed to the Paperclip repo at `docs/rfcs/stripe-usage-billing.md`.
- Reviewers sign off: at least one Paperclip platform maintainer + one downstream-consumer representative (initially Company OS / Joe).
- The three implementation PRs (§7.1) have child tickets opened in the Paperclip tracker, blocked on this merge.

## 11. References

- Company OS MVP doc: [JOE-3 §1, §3, §4, §5](/JOE/issues/JOE-3#document-mvp)
- Source issue: [JOE-11](/JOE/issues/JOE-11)
- Downstream blocker: [JOE-13](/JOE/issues/JOE-13)
- Stripe Usage Records API: https://stripe.com/docs/api/usage_records
- Stripe Customer Portal: https://stripe.com/docs/customer-management
- Stripe Test Mode + CLI: https://stripe.com/docs/stripe-cli
