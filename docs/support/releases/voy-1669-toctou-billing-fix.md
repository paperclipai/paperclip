|---
title: P1-2 TOCTOU Billing Fix — Concurrent Subscription & Usage Race Elimination
version: voy-1669
date: 2026-08-22
commit: b840497fab + 151f0a2066
status: PENDING — merged to custom branch, awaiting PR merge via VOY-1673
---

# P1-2 TOCTOU Billing Fix — Concurrent Subscription & Usage Race Elimination

**Release:** VOY-1669 / VOY-1673
**Commits:** `b840497fab`, `cd74f15ca8`, `151f0a2066`
**Date:** 2026-08-22
**Status:** PENDING — merged to custom branch, awaiting PR merge via VOY-1673
**Related issues:** VOY-1669, VOY-1671, VOY-1687, VOY-1673, VOY-1682

## Summary

This release fixes two race conditions in Voyonder's billing system that could cause duplicate records under concurrent requests. Both fixes use PostgreSQL `ON CONFLICT` (upsert) patterns to ensure safety without sacrificing performance. Seven additional Stripe API calls are now wrapped in automatic retry for resilience against transient network and rate-limit errors.

No API endpoints changed. No request or response formats changed. No environment variables changed. All fixes are server-side and invisible to end users — the visible effect is improved billing reliability under load.

## Changes

### 1. TOCTOU in `createOrUpdateSubscription` (P1-2)

The `POST /api/companies/:companyId/billing/subscription` endpoint had a classic time-of-check-to-time-of-use (TOCTOU) vulnerability: the SELECT that checked for an existing subscription was outside the transaction, so two concurrent requests could both see "no subscription exists" and both attempt to INSERT, potentially creating duplicate subscription records.

**The fix:**
- The INSERT now uses `ON CONFLICT (company_id) DO NOTHING` — if a concurrent request already created the subscription, the INSERT is a no-op
- When the race is lost, the system fetches the winner's record, cancels the orphan Stripe subscription to avoid double-billing, and returns the winner's subscription
- The UPDATE path now identifies the record by `companyId` instead of a potentially stale record ID
- Both the Stripe create and update calls are wrapped in `withStripeRetry` for transient-failure resilience

**What this means for support:**
- Completely invisible to customers — no API change, no UI change, no configuration change
- Eliminates the risk of duplicate subscription creation under rapid concurrent requests (e.g., double-click on the subscribe button, rapid page reloads)
- If a customer reports they were charged twice, this fix prevents it going forward. Historical duplicates would be visible on the Stripe dashboard — contact Stripe support for refunds on any orphan subscriptions
- No customer action needed. No manual intervention needed from support.

### 2. `reportUsage` read-then-write race (P2)

The `POST /api/companies/:companyId/billing/usage` endpoint had a similar race: it SELECTed for an existing usage record and then either UPDATE or INSERT based on the result. Two concurrent requests for the same metric and billing period could both see "no record exists" and both INSERT.

**The fix:**
- The entire SELECT-then-INSERT/UPDATE pattern is replaced with a single `INSERT ... ON CONFLICT DO UPDATE` (upsert) on the unique constraint `(subscription_id, metric, period_start, period_end)`
- The `stripe.subscriptionItems.createUsageRecord()` call is now wrapped in `withStripeRetry`

**What this means for support:**
- Completely invisible to customers — no API change, no UI change, no configuration change
- Concurrent usage reports for the same metric and period are now handled safely — the last write wins, which is the correct semantics for usage reporting
- If a customer previously saw duplicate usage records (doubled seat counts, doubled agent run counts) after rapid usage reporting calls, this fix prevents it

### 3. Additional `withStripeRetry` wrapping

Seven Stripe API calls that were previously unwrapped now benefit from exponential-backoff retry on transient failures:

| Call site | Operation |
|---|---|
| `createOrUpdateSubscription` (update path) | `stripe.subscriptions.retrieve()` |
| `createOrUpdateSubscription` (update path) | `stripe.subscriptions.update()` |
| `createOrUpdateSubscription` (create path) | `stripe.subscriptions.create()` |
| `cancelSubscription` | `stripe.subscriptions.update()` |
| `reactivateSubscription` | `stripe.subscriptions.update()` |
| `reportUsage` | `stripe.subscriptionItems.createUsageRecord()` |
| `syncInvoicesFromStripe` | `stripe.invoices.list()` |

**What this means for support:**
- Reduces transient failures from Stripe API rate limits or network blips
- Customers will see fewer "Stripe API error" messages during normal operation
- No configuration or customer action needed

### 4. Webhook transaction wrapping — `handleInvoicePaymentFailed` and `handleSubscriptionDeleted` (P2-1)

The two remaining Stripe webhook handlers — `handleInvoicePaymentFailed` (marks subscription as `past_due`) and `handleSubscriptionDeleted` (marks subscription as `canceled`) — are now wrapped in `db.transaction()` to match the pattern already used by `handleInvoicePaid` and `handleSubscriptionUpdated`.

**Why this matters:** These handlers perform single UPDATE operations with no read-then-write race, so the TOCTOU risk was minimal. The wrapping ensures consistent error-recovery semantics across all webhook handlers: if a handler fails partway through, the entire UPDATE + live-event publish is rolled back atomically. This prevents a state where the database is updated but the live event is not published (or vice versa).

**What this means for support:**
- Completely invisible to customers — no API change, no UI change, no configuration change
- Eliminates inconsistent state where a subscription status updates in the database but the live event is not emitted to the UI
- If a customer previously reported that their subscription status appeared to "stick" (e.g., a canceled subscription still showing as active in the UI briefly before catching up), this fix ensures the database update and live event are always atomic
- No customer action needed. No manual intervention needed from support.

## Configuration

No new configuration options. Existing `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` remain the only required Stripe environment variables.

## Verification

- [x] `withStripeRetry` wrapping verified on all 10 Stripe API call sites (11 including local-only `stripe.webhooks.constructEvent()`)
- [x] `createOrUpdateSubscription` uses `ON CONFLICT DO NOTHING` on `(company_id)`
- [x] `reportUsage` uses `INSERT ... ON CONFLICT DO UPDATE` on `(subscription_id, metric, period_start, period_end)`
- [x] Orphan Stripe subscription cancellation on race loss
- [x] `handleInvoicePaymentFailed` and `handleSubscriptionDeleted` wrapped in `db.transaction()`
- [x] VOY-1687: Idempotency key on `stripe.subscriptions.create()`
- [x] Code reviewed by Staff Engineer, CTO approval gate
- [ ] Merged to main via PR #63 (VOY-1673) — **BLOCKED** (CI infrastructure failures + missing formal GitHub reviews)

## Support Escalation Path

| Issue | Severity | Action |
|---|---|---|
| Customer reports double charge for subscription | Low (prevented going forward) | If it occurred before this release, check Stripe dashboard for duplicate subscriptions; contact Stripe support for refund. Going forward this fix prevents it. |
| Customer reports doubled usage metrics | Low (prevented going forward) | If it occurred before this release, verify usage records via Stripe dashboard. Going forward the upsert pattern prevents duplicates. |
| Transient Stripe API failure still occurs | Low | All 10 Stripe API call sites now have retry. If a failure still propagates to the user, check Stripe dashboard for account health and escalate to CTO. |