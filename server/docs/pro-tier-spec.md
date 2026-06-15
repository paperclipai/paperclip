# Gradata Pro Tier — Packaging, Pricing & Feature-Gate Spec

**Status:** Design spec (zero-deploy). Unblocks GRA-3230 (Stripe integration).
**Author:** boss (GRA-3263)
**Date:** 2026-06-14

---

## 1. Tier Structure

### Free Tier (never paywalled — OSS core)

Everything in the OSS CLI/SDK stays free forever. This is the distribution wedge.

| Feature | Description |
|---------|-------------|
| `gradata` CLI | install, status, review, forget, doctor |
| Local rule store | `lessons.md` in project root |
| Single brain | one brain per API key |
| Basic correction capture | hook-based capture, local processing |
| 100 corrections/month | soft cap — shows upgrade nudge, doesn't block |
| Community support | GitHub issues, docs |

**Hard rule:** Nothing in the `gradata` pip package or the open-source plugin repos ever requires a paid tier. The CLI is the acquisition channel.

### Pro Tier — $49/mo (individual developer)

| Feature | Description |
|---------|-------------|
| Unlimited corrections | no monthly cap |
| Cloud sync | rules sync across devices/CLIs via api.gradata.ai |
| Dashboard access | convergence charts, lift reports, rule lifecycle |
| Up to 3 brains | separate brains per project/team |
| API access | REST API for custom integrations |
| Semantic dedup | cross-session rule deduplication |
| Email support | 24h response SLA |

### Team Tier — $149/mo (up to 10 seats)

Everything in Pro, plus:

| Feature | Description |
|---------|-------------|
| Shared brains | team-wide rule store with role-based access |
| Admin dashboard | team usage, rule health, member management |
| Private rule namespaces | per-team rule isolation |
| Priority support | 4h response SLA |
| Audit logs | who changed what rule, when |
| SSO (future) | Google/GitHub OAuth (post-MVP) |

### Enterprise — custom pricing

| Feature | Description |
|---------|-------------|
| Everything in Team | |
| Unlimited seats | |
| Private deployment | on-prem or dedicated cloud instance |
| SLA | 99.9% uptime, 1h response |
| Custom integrations | webhooks, CRM sync, compliance exports |

---

## 2. Feature-Gate Matrix

Where each gate lives in the stack:

| Pro Feature | Gate Location | Mechanism |
|-------------|---------------|-----------|
| Unlimited corrections | Cloud API middleware | `X-Tier: pro\|team\|enterprise` header from API key lookup |
| Cloud sync | `POST /api/v1/brains/:id/sync` | Entitlement check before sync write |
| Dashboard access | dashboard.gradata.ai (Next.js) | JWT claim `tier` — redirect to `/pricing` if `free` |
| Multiple brains (2+) | `POST /api/v1/brains` | Count user's brains; reject if ≥1 and tier=free |
| API access | `Authorization: Bearer gd_live_*` | Key validation returns tier; free keys get 403 on `/api/v1/*` |
| Semantic dedup | Graduation pipeline | Feature flag in brain config; free brains skip dedup pass |
| Shared brains (Team) | Brain model | `visibility: team` field; free/pro brains are `visibility: private` |
| Admin dashboard | dashboard.gradata.ai | `/admin/*` routes gated on `tier=team\|enterprise` |
| Audit logs | Cloud DB writes | Team+ brains write to `audit_log` table; free/pro skip |
| Rate limits | API gateway | Free: 100 req/h, Pro: 1000 req/h, Team: 5000 req/h |

### Gate implementation pattern (pseudocode)

```python
# middleware/entitlement.py
def check_entitlement(request, feature: str) -> bool:
    tier = get_tier_from_api_key(request.headers["Authorization"])
    required = FEATURE_TIER_MAP[feature]  # e.g. "pro"
    return TIER_HIERARCHY[tier] >= TIER_HIERARCHY[required]

# Usage in sync endpoint
@router.post("/brains/{brain_id}/sync")
def sync_brain(brain_id: str, request: Request):
    if not check_entitlement(request, "cloud_sync"):
        raise HTTPException(402, detail="Cloud sync requires Pro tier. Upgrade at dashboard.gradata.ai/pricing")
    # ... proceed with sync
```

---

## 3. Pricing Validation

### Current reference: $99/mo (from old goals/docs)

**Recommendation: $49/mo Pro, $149/mo Team.**

Rationale:
- $99/mo is above the impulse-buy threshold for individual devs. GitHub Copilot is $10/mo; Cursor is $20/mo. $49 lands in "serious tool" territory without sticker shock.
- $149/mo for teams is standard SaaS per-seat math (~$15/seat at 10 seats) and leaves room for enterprise upsell.
- Free tier with 100 corrections/mo cap gives a real试用 (try-before-buy) without cannibalizing Pro — serious users hit the cap in days.
- YC companies typically start lower and raise after PMF. $49→$99 is an easy price increase once value is proven.

### Competitor anchors

| Product | Individual | Team |
|---------|-----------|------|
| GitHub Copilot | $10/mo | $19/user/mo |
| Cursor | $20/mo | $40/user/mo |
| Sentry | $26/mo | $80/mo (5 seats) |
| Linear | $0 (basic) | $8/user/mo |
| **Gradata (proposed)** | **$49/mo** | **$149/mo (≤10 seats)** |

Gradata's value prop is different: it's infrastructure that compounds. The $49 price signals "this saves you more than it costs" — one prevented production bug covers a year of Pro.

---

## 4. Paywall UX — Copy & States

### 4a. Correction cap nudge (free tier, 100/mo)

**State: approaching cap (80+ corrections)**

> You've used 87 of 100 free corrections this month. Pro users get unlimited corrections, cloud sync, and dashboard analytics. [Upgrade to Pro →]

**State: cap hit (100/100)**

> You've reached the free correction limit. Your rules still work — new corrections will be queued and processed when you upgrade. [Upgrade to Pro — $49/mo →]

### 4b. Dashboard paywall (free tier visiting dashboard)

**State: locked dashboard**

> ## Unlock Your Dashboard
> See how your rules improve over time. Pro includes:
> - Convergence charts (are your agents getting better?)
> - Lift reports (how many corrections did Gradata prevent?)
> - Rule lifecycle tracking (which rules are graduating, which are quarantined?)
>
> [Upgrade to Pro — $49/mo] [Learn more →]

### 4c. Feature-gate inline (CLI or API)

**State: hitting a Pro feature on free tier**

```
$ gradata sync
Error: Cloud sync requires Gradata Pro.
Your rules are safe locally. Upgrade to sync across devices and agents.
→ dashboard.gradata.ai/pricing
```

### 4d. Stripe Checkout flow

**Checkout page copy:**

> ## Gradata Pro
> $49/month — cancel anytime
>
> - Unlimited corrections
> - Cloud sync across all your agents
> - Dashboard with convergence + lift reports
> - Up to 3 brains
> - REST API access
>
> [Subscribe with Stripe →]

**Post-checkout success state:**

> ## You're on Pro! 🎉
> Your rules are syncing now. Next steps:
> - [Open your dashboard →]
> - [Run `gradata sync` to push local rules →]
> - [Add a second brain for another project →]

### 4e. Cancellation flow

**Cancel confirmation:**

> Your Pro access continues until June 14, 2026. After that:
> - Cloud sync stops (rules stay local)
> - Dashboard becomes read-only
> - Extra brains are frozen (your primary brain stays active)
> - API access is revoked
>
> Your rules are never deleted. [Cancel my subscription] [Keep Pro]

---

## 5. Stripe Test-Mode Integration Checklist

For GRA-3230 to implement against:

### Phase 1: Stripe Setup (Oliver or delegated)

- [ ] Create Stripe account (or use existing)
- [ ] Get test-mode secret key (`sk_test_*`)
- [ ] Create products in Stripe dashboard:
  - Product: "Gradata Pro" — $49/mo, recurring
  - Product: "Gradata Team" — $149/mo, recurring (up to 10 seats)
- [ ] Store price IDs in environment config:
  - `STRIPE_PRO_PRICE_ID=price_xxx`
  - `STRIPE_TEAM_PRICE_ID=price_yyy`
- [ ] Set `STRIPE_WEBHOOK_SECRET=whsec_*` for signature verification

### Phase 2: Backend (gradata-cloud)

- [ ] Add `stripe` to Python dependencies (`stripe` pypi package)
- [ ] Create `/api/v1/billing/create-checkout-session` endpoint:
  - Accepts `price_id`, `brain_id`, `success_url`, `cancel_url`
  - Creates Stripe Checkout Session
  - Returns session URL for redirect
- [ ] Create `/api/v1/billing/webhook` endpoint:
  - Verifies `stripe-signature` header
  - Handles events:
    - `checkout.session.completed` → grant entitlement, set `tier=pro|team` on brain
    - `invoice.payment_failed` → notify user, grace period (7 days), then downgrade
    - `customer.subscription.deleted` → downgrade to free, freeze extra brains
- [ ] Add `tier` field to brain model (enum: `free`, `pro`, `team`, `enterprise`)
- [ ] Add `stripe_customer_id` and `stripe_subscription_id` to brain model
- [ ] Add entitlement middleware (see §2 pattern above)

### Phase 3: Frontend (gradata-website / dashboard)

- [ ] Create `/pricing` page with tier comparison table
- [ ] Add "Upgrade" button → POST to create-checkout-session → redirect to Stripe
- [ ] Create `/pricing/success` page (post-checkout confirmation)
- [ ] Add tier badge to dashboard header ("Pro" / "Team" / "Free")
- [ ] Add paywall components for each gated feature (see §4)
- [ ] Add "Manage Subscription" link → Stripe Customer Portal

### Phase 4: Testing

- [ ] Stripe test-mode card: `4242 4242 4242 4242`
- [ ] Test checkout flow end-to-end (free → checkout → success → entitlement)
- [ ] Test webhook delivery (`stripe trigger checkout.session.completed`)
- [ ] Test payment failure → downgrade path
- [ ] Test cancellation → freeze path
- [ ] Test rate-limit enforcement on free tier
- [ ] Test feature gates return 402 with correct messaging

### Phase 5: Go-Live

- [ ] Swap test keys for live keys
- [ ] Create live Stripe products/prices
- [ ] Add billing compliance (GDPR tax collection if needed)
- [ ] Monitor first 10 real transactions before announcing

---

## Appendix: Revenue Model Summary (for investor conversations)

- **Acquisition:** Free OSS CLI → developers install, capture corrections, hit the 100/mo cap
- **Conversion:** Cap nudge + dashboard preview → $49/mo Pro (individual) or $149/mo Team
- **Retention:** Compounding memory effect — churning means losing accumulated rules. Structural lock-in without vendor lock-in.
- **Expansion:** Team → Enterprise (private deployment, SSO, SLA)
- **Unit economics at scale:** 1,000 Pro users = $49K MRR = $588K ARR. 100 Team accounts = $14.9K MRR = $179K ARR. Combined: ~$767K ARR at modest scale.
