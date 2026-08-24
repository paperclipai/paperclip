# Support Case Assessment: Stripe Tier Sync Hardening (v0.2.13)

> ⚠️ **Fork-only implementation removed; upstream-compatible restoration in progress.** The fork-specific Stripe billing code (including tier sync) was removed during upstream merge cleanup (commit `de8529fc03`). The Staff Engineer is restoring billing with upstream-compatible code (VOY-1590 in_progress). This assessment describes the **old fork-specific implementation** and may be stale. Pending: VOY-1590 completion.

**Feature**: Stripe subscription tier synchronization fixes
**Assessed by**: Support Engineer
**Date**: 2026-08-16
**Related**: VOY-944, VOY-905, VOY-896
**Release**: v0.2.13

## Feature Overview (User Perspective)

For users, nothing visible changed in the UI. However, billing tier behavior is now more accurate:

- **Your tier reflects your actual Stripe subscription.** If your subscription is active or in a trial period, you stay on your paid tier (Elite, Pro, etc.). If your subscription expires, is cancelled, or enters a non-active state, you are downgraded to the free tier.
- **Billing operations should no longer fail with "No such customer" errors.** If your Stripe customer was deleted on the Stripe side (e.g., during account cleanup), Voyonder now automatically creates a fresh Stripe customer record.
- **Google login should always redirect back to voyonder.com**, even when the service is behind a proxy.

## What Changed

### `syncTierFromStripe()` — Tier synchronization hardening

The function that syncs a user's tier from their Stripe subscription was hardened in three ways:

1. **Only active/trialing subscriptions count.** Previously, any subscription status (including `past_due`, `unpaid`, `expired`, `canceled`, `incomplete`, `incomplete_expired`) could match and keep a user on a paid tier. Now only `active` and `trialing` subscriptions count as active. All other statuses trigger a downgrade to free.

2. **Deleted Stripe customers are handled gracefully.** If your Stripe customer record was deleted (returns `{deleted: true}`), the sync function detects this and downgrades the user to free instead of crashing.

3. **Safe status mapping.** `mapStripeStatus()` function provides typed, safe status mapping instead of unsafe type casts, preventing runtime errors from unexpected Stripe status values.

### `findOrCreateStripeCustomer()` — Stale reference auto-repair

When Voyonder's database has a Stripe customer ID that no longer exists in Stripe (because it was deleted), this function now removes the stale database record and creates a fresh Stripe customer automatically. This prevents "No such customer" errors during checkout and subscription changes.

### Google OAuth redirect fix

The Google OAuth callback now uses `NEXTAUTH_URL` for all redirects, ensuring users are always redirected to the correct canonical domain even when Voyonder is behind a proxy or load balancer.

## Potential User Confusion Points

1. **"I cancelled my subscription but I was still on the Elite tier — now I'm on free"** — This was a bug. Previously, cancelled subscriptions could leave the user on a paid tier indefinitely if the sync didn't detect the cancellation. Now the next sync correctly downgrades to free. This is the intended behavior.

2. **"I was downgraded to free but my subscription is still active"** — Check Stripe dashboard for actual subscription status. If Stripe shows active/trialing and Voyonder shows free, there may be a sync issue — escalate to engineering.

3. **"Google login sends me to some other URL"** — If this happens after v0.2.13, the NEXTAUTH_URL environment variable may not be set correctly on the server.

4. **"I got 'No such customer' when trying to upgrade"** — This error should now be resolved by the auto-repair. If it persists, the issue may be a different root cause.

## FAQ

**Q: Why was I downgraded to free?**
A: Voyonder checks your Stripe subscription status each time it syncs. If your subscription shows as expired, cancelled, or any status other than active or trialing, you're moved to the free tier. Check your billing page to see your current plan.

**Q: I have an active subscription but Voyonder shows me as free. What do I do?**
A: First, check the Stripe dashboard to confirm your subscription is active. If it is, try logging out and back in, or visit the billing page to trigger a resync. If it still shows free after 24 hours, contact support — we may need to run a manual sync.

**Q: I cancelled my subscription — why am I still on the paid tier?**
A: You may have been caught by the previous bug where cancelled subscriptions weren't detected. The fix in v0.2.13 ensures cancelled users are moved to free on the next sync. If you still see a paid tier after a day, let us know.

**Q: Google login doesn't work / redirects to a strange URL.**
A: This is likely a server configuration issue. The v0.2.13 fix corrects the redirect behavior, but `NEXTAUTH_URL` must be set to `https://voyonder.com` on the server. Contact support for verification.

**Q: I see a 'No such customer' error on the billing page.**
A: This should be automatically resolved by the stale reference auto-repair. Try again in a few minutes. If it persists, contact support.

## Troubleshooting

### User reports wrong tier

1. Verify user's Stripe subscription status in Stripe dashboard
2. If Stripe shows active/trialing → check Voyonder's tier for that user in the database
3. If mismatch: ask user to visit billing page (triggers sync) or escalate for manual sync
4. If Stripe shows cancelled/expired/past_due → the free tier is correct behavior

### User reports "No such customer" error

1. Check Stripe dashboard for the customer ID
2. If customer doesn't exist in Stripe → auto-repair should create one on next operation
3. If auto-repair doesn't resolve → check if the DB record has a valid Stripe customer ID
4. Escalate if unresolved after 24 hours

### User reports Google OAuth redirect issues

1. Verify `NEXTAUTH_URL` env var on the server
2. Check if server is behind a proxy; if so, verify proxy headers (X-Forwarded-Proto, X-Forwarded-Host)
3. Check NextAuth configuration for callback URL settings
4. Escalate to CTO for server-level configuration issues

### User reports billing page crash

1. Confirm by trying to access `/settings/billing` 
2. If blank page or 500 error: the v0.2.10 force-dynamic fix should handle this
3. If crash is new to v0.2.13: may be related to Stripe tier sync code
4. Escalate to CTO with any error logs or screenshots

## Error States

| Error | User sees | Root cause | Recovery |
|---|---|---|---|
| Wrong tier (free instead of paid) | "Free" on billing page despite active sub | Sync not triggered or NEXTAUTH_URL mismatch | Visit billing page to trigger sync; escalate if persists |
| Wrong tier (paid instead of free) | Paid tier shown after cancellation | Pre-v0.2.13 bug; cancelled sub not detected | Self-corrects on next sync; confirm after 24h |
| "No such customer" error | Error on billing or checkout | Stale Stripe customer ref in DB | Auto-repaired by findOrCreateStripeCustomer on next operation |
| Google OAuth redirect fails | "This site can't be reached" or wrong domain | NEXTAUTH_URL misconfiguration | Check server env vars and proxy headers |
| Billing page blank/500 | Blank page or server error | Various (prerender, Stripe API failure) | Check logs; v0.2.10 force-dynamic fix should handle most cases |
| Stripe API returns unexpected status | Internal error, no tier change | Unknown Stripe status value | `mapStripeStatus()` handles known values; unknown values escalate to engineering |

## Related Documentation

- `/documentation` — Main help center
- `/documentation/releases` — v0.2.13 release notes
- `/settings/billing` — Billing page in app
- Stripe Dashboard — Actual subscription state

## Escalation Path

| Issue | Severity | Escalate to | Notes |
|---|---|---|---|
| Wrong tier persists >24h | Medium | CTO | Manual syncStripeTier may be needed |
| "No such customer" persists | High | CTO | May need manual Stripe customer re-link |
| Google OAuth broken | High | CTO | NEXTAUTH_URL / server config issue |
| Billing page crashes | High | CTO | Check server logs for Stripe API errors |
| Unknown Stripe status values | Low | Staff Engineer | Add mapping for new Stripe status |
| Tier mismatch in bulk (many users) | Critical | CTO / CEO | Possible regression from the hardening changes |