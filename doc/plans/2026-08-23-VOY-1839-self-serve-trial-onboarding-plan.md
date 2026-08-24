# VOY-1839: M6 Self-Serve Trial and Onboarding Flow

## Architecture

### Current State
- Sign-up via better-auth (`POST /api/auth/sign-up/email`) creates user + session but **no company**
- User lands on empty dashboard with no company → "no companies" redirect loop
- Onboarding wizard exists but only works inside an existing company
- Billing system supports `trialing` status and `trialEnd` on subscriptions
- Subscription tiers (Adventurer/Explorer/Elite) are seeded via SQL
- Pricing page exists with Stripe checkout

### Target State
```
Sign-up → Company created → Trial subscription → Onboarding wizard → Dashboard
                ↓
        (optional: Stripe trial via checkout)
```

### New Server Routes
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/complete-registration` | Post-sign-up company+trial creation |
| GET | `/api/companies/:companyId/billing/trial-info` | Trial status for UI |
| POST | `/api/companies/:companyId/billing/start-trial` | Start trial for existing company |

### New Service Methods (in billing.ts)
- `startTrial(companyId, tierId, userId)` — Creates Stripe customer + trialing subscription
- `getTrialInfo(companyId)` — Returns trial status, days remaining
- `expireTrials()` — Reaper: marks expired trials as inactive

### Database
- No schema changes needed. `company_subscriptions` has `trialEnd` and supports `trialing` status.
- Add a "Trial" tier to the seed data (free tier with limited features).

### Flow Details

**Sign-up → Registration:**
1. User submits sign-up form → better-auth creates user + session
2. UI detects session.exists && companies.length === 0
3. UI calls `POST /api/auth/complete-registration`
4. Server:
   a. Creates company (name from user profile or "My Company")
   b. Creates Stripe customer (if STRIPE_SECRET_KEY set)
   c. Creates subscription with `status: "trialing"`, `trialEnd: now + 14 days`
   d. Returns company ID
5. UI navigates to `/{companyPrefix}/onboarding`
6. Onboarding wizard runs (existing UX: mission → agent → first task)

**Trial Conversion:**
1. User clicks "Upgrade" on pricing page
2. Existing `POST /companies/:companyId/billing/create-checkout-session` creates Stripe Checkout
3. On successful payment, Stripe webhook updates subscription to `active`
4. Existing `Pricing.tsx` handles this flow

**Trial Expiration:**
1. Reaper runs daily (in `billing.startTrialReaper`)
2. Finds subscriptions where `status = "trialing"` AND `trialEnd < now()`
3. Sets status to `inactive` (or `paused`)
4. Feature gating (`checkFeatureAccess`) denies paid features

### UI Changes (Minimal)
- `Auth.tsx`: After sign-up success, call `completeRegistration` then navigate to onboarding
- `api/auth.ts`: Add `completeRegistration()` method
- `api/billing.ts`: Add `trialInfo()` method
- New `TrialBanner` component (optional)

### Funnel Instrumentation
- PostHog events (placeholder) on: sign_up, trial_started, onboarding_step, trial_converted

## Implementation Order

1. Add "Trial" tier to seed SQL (+ Stripe product/price)
2. Add `startTrial` method to billing service
3. Add `POST /api/auth/complete-registration` route
4. Add `GET /api/companies/:companyId/billing/trial-info` route
5. Add trial reaper
6. UI: post-sign-up registration + redirect to onboarding
7. UI: trial status banner

## Child Issues
- **VOY-1840**: Server — Complete registration endpoint + trial service methods
- **VOY-1841**: Server — Trial reaper + trial info endpoint
- **VOY-1842**: UI — Post-sign-up flow + redirect to onboarding
- **VOY-1843**: UI — Trial status banner + conversion prompt
- **VOY-1844**: QA — End-to-end trial onboarding verification
