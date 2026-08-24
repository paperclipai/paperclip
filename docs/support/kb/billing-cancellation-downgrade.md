---
title: Support KB — Billing Downgrade-to-Free on Cancellation
summary: Subscription cancellation now reliably downgrades to Free tier on next login (VOY-944)
version: v0.2.13+
commit: 83a1cee
---

# Support KB: Billing Downgrade-to-Free on Cancellation

> ⚠️ **Feature-flagged:** Billing is gated behind `PAPERCLIP_BILLING_ENABLED=true`. Without this flag, billing routes are not registered.
>
> The billing system has been restored with upstream-compatible code (VOY-1611, commit `1fb17b8f18`). API contracts are unchanged from the previous fork-specific implementation.

**Applies to:** Voyonder v0.2.13+
**Tag:** `83a1cee`
**Related:** VOY-944, VOY-1218, VOY-1227
**Date:** 2026-08-15

---

## Summary

When a user cancels their Stripe subscription, their Voyonder tier is now automatically downgraded to **Free** on their next login — even if the Stripe cancellation webhook was lost or delayed. This prevents the "stuck paid tier" problem where a user appears to have a paid subscription after cancellation.

## Old Behavior

When a user cancelled their Stripe subscription:

1. Stripe fires a `customer.subscription.deleted` webhook event
2. Voyonder processes the webhook and downgrades the user's tier
3. If the webhook was **lost** (network failure, Stripe outage, delayed delivery), the downgrade never happened
4. The user's tier remained stuck at whatever paid level they had — appearing as a paying customer with no active subscription

This required manual support intervention to fix: a support agent would need to verify cancellation and manually downgrade the user's tier in the database.

## New Behavior

When a user cancels their Stripe subscription:

1. Stripe fires the webhook (same as before)
2. If the webhook succeeds, the tier is downgraded immediately
3. **If the webhook was lost**, the downgrade still happens on the user's **next login** — the `syncTierFromStripe()` function detects there is no active subscription and downgrades to Free
4. The user never sees a stuck paid tier, even with webhook delivery failures

## What This Means for Support

- **No more stuck paid tiers.** Every cancellation event is eventually consistent, even without webhook delivery.
- **Existing stuck users are auto-healed.** Any user who cancelled in the past but remained on a paid tier will be downgraded on their next login.
- **No manual DB fixes needed** for cancellation-related tier issues.
- **If a user contacts support** saying "I cancelled but I'm still on a paid plan" — the answer is: log out and log back in. The downgrade will apply on your next login.

## Troubleshooting

### User says "I cancelled but still have access to paid features"

1. Verify the user actually cancelled their Stripe subscription (check Stripe dashboard)
2. If they cancelled, tell them to **log out and log back in**
3. On next login, `syncTierFromStripe()` runs and detects the cancelled subscription
4. The user's tier is downgraded to Free
5. Confirm by checking their account tier in the admin panel

### User says "I was downgraded but I didn't cancel"

1. Check Stripe dashboard — their subscription may have expired or been cancelled on Stripe's side
2. If the subscription is genuinely active, check the Stripe subscription status (must be `active` or `trialing`)
3. If the subscription is expired/incomplete/past_due, the downgrade is correct behavior — the user needs to resubscribe
4. If the subscription is active and the user was wrongly downgraded, escalate to CTO

### User says "I'm on a trial but got downgraded"

1. Check Stripe subscription status — trials show as `trialing`
2. `syncTierFromStripe()` now correctly filters to `active || trialing` subscriptions only (VOY-905 fix)
3. If they were wrongly downgraded despite an active trial, check that the v0.2.13 deployment completed successfully
4. If the fix is deployed, ask them to log out and log back in

### User was on a paid plan, cancelled, and was never downgraded (legacy case)

1. This is the scenario the fix addresses — the webhook was lost
2. Ask the user to log out and log back in
3. The fix is deployed server-side; no action needed beyond the logout/login cycle
4. If the user is still stuck after logging back in, escalate to CTO

## How It Works (for Support)

The fix lives in two places:

1. **Login flow** — Every login calls `syncTierFromStripe()` which checks the user's Stripe subscription status. If no active subscription exists, the tier is downgraded to Free.

2. **syncTierFromStripe()** — Previously, this function could miss some stale cases. Now it:
   - Lists all non-canceled subscriptions from Stripe
   - Filters to only `active || trialing` status subscriptions
   - If no qualifying subscription is found, assigns Free tier
   - Also detects deleted Stripe customers (`{deleted: true}` flag) — not just 404s

## Related Documentation

- `/documentation/releases` — v0.2.13 release notes
- `/documentation` — Main help center
- `/settings/billing` — Billing page (on voyonder.com)
- Support case assessment: [Stripe Billing Fixes Support Case](../assessments/support-case-stripe-billing-fixes.md)