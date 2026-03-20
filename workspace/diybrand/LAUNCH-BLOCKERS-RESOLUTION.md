# Launch Blockers & Resolution Path

**Date:** 2026-03-20
**Status:** 3 Critical Path Items Remaining Before Launch
**Owner:** Echo (Customer Success Lead)

---

## What's Complete ✅

1. **Privacy Policy Page** — `/src/app/privacy/page.tsx` (deployed)
2. **Terms of Service Page** — `/src/app/terms/page.tsx` (deployed)
3. **Feedback API Storage** — PostgreSQL database + migration 0006 (ready for deployment)
4. **FAQ, Guides, Refund Policy** — All live and searchable
5. **Feedback Widget** — Integrated on success page
6. **Support Templates** — 8 templates ready for use
7. **Onboarding Email Sequence** — 10-email sequence documented

---

## Remaining Blockers (Priority Order)

### 1. Email System Configuration & Testing
**Status:** ❌ Blocking Launch
**Effort:** ~2 hours
**Owner:** [Engineering Lead / DevOps]

**What's needed:**
1. Choose email service: Brevo, Mailchimp, Klaviyo, or Resend
   - See `ONBOARDING-EMAILS.md` for service-specific setup instructions
   - Recommended: **Resend** (modern, API-first, $0.20/email) or **Brevo** (free for 300/day)

2. Add email credentials to environment:
   ```bash
   # In .env.production
   RESEND_API_KEY=re_xxxxx  # or equivalent for your service
   SUPPORT_EMAIL=support@diybrand.app
   NOREPLY_EMAIL=noreply@diybrand.app
   ```

3. Implement email sending in Stripe webhook:
   ```typescript
   // After order is created in /src/app/api/webhooks/stripe/route.ts
   // Send welcome email with download link and FAQ/guides
   ```

4. Create email templates (use template service's dashboard or code)
   - Welcome email (day 0)
   - Help email (day 1)
   - Check-in email (day 2-3)
   - See `ONBOARDING-EMAILS.md` for full sequence

5. Test email delivery:
   ```bash
   # Send test email to support@diybrand.app
   # Verify: subject line, sender, links work, HTML renders
   ```

6. Document process for team:
   - How to resend transactional emails
   - How to update email templates
   - Bounce/complaint handling

**Success Criteria:**
- [ ] Email service configured with valid API key
- [ ] Welcome email sends within 5 seconds of checkout completion
- [ ] Test email to support@ arrives within 2 minutes
- [ ] All links in email work (FAQ, guides, support)
- [ ] Email renders correctly in Gmail, Outlook, Apple Mail

---

### 2. Support Email Inbox Monitoring Setup
**Status:** ❌ Blocking Launch
**Effort:** ~30 minutes
**Owner:** [Customer Success Team]

**What's needed:**
1. Create or activate `support@diybrand.app` email account
   - Email provider (likely same as main company domain)
   - Forward rules if using Gmail/Inbox

2. Set up inbox monitoring checklist:
   - [ ] Email forwarding enabled (if needed)
   - [ ] Out-of-office auto-responder disabled
   - [ ] Signature configured with support hours
   - [ ] Templates accessible (see `SUPPORT-TEMPLATES.md`)

3. Create monitoring schedule:
   - [ ] Check inbox daily for first week post-launch
   - [ ] Response time target: < 24 hours
   - [ ] Escalation path defined (who handles refunds, bugs, etc.)

4. Set up analytics:
   - [ ] Incoming email volume tracked
   - [ ] Response time logged
   - [ ] Resolution rate tracked (issue resolved vs. forwarded)

**Success Criteria:**
- [ ] Support email receives test message within 5 minutes
- [ ] Team member confirms ability to send responses using templates
- [ ] Response times SLA documented and agreed upon

---

### 3. Mobile & Cross-Browser Testing
**Status:** ⚠️ Mostly Done (Tailwind responsive), Needs Verification
**Effort:** ~1 hour
**Owner:** [QA / Testing]

**What's needed:**
1. Test on actual mobile devices (not just browser dev tools):
   - [ ] iPhone 14/15 Pro (Safari)
   - [ ] iPhone 12 (older Safari version)
   - [ ] Samsung Galaxy S23 (Chrome)
   - [ ] Android 11+ device (Firefox)

2. Test key pages on mobile:
   - [ ] `/faq` — Search works, Q&A expands, footer visible
   - [ ] `/guides` — Readable text, images scale, step numbers visible
   - [ ] `/refund-policy` — Timeline readable, links work
   - [ ] `/privacy` and `/terms` — Text readable, scrolling smooth
   - [ ] `/success` — Download button hits, feedback widget renders

3. Check for common issues:
   - [ ] No horizontal scroll needed
   - [ ] Touch targets minimum 44x44px
   - [ ] Forms accessible (keyboard works)
   - [ ] Images load and scale correctly
   - [ ] Dark mode supported (if applicable)

4. Test on slow connections:
   - [ ] Pages load in < 3 seconds (3G connection)
   - [ ] Images display (avoid 404s)
   - [ ] No JavaScript errors in console

5. Desktop browsers (quick check):
   - [ ] Chrome 120+
   - [ ] Firefox 121+
   - [ ] Safari 17+
   - [ ] Edge 120+

**Success Criteria:**
- [ ] All pages load on mobile without errors
- [ ] FAQ search works on mobile
- [ ] Feedback widget is visible and functional
- [ ] No layout broken on any tested device
- [ ] All links navigate correctly

---

## Implementation Roadmap

### Phase 1: Email System (Day 1)
- [ ] Choose email service
- [ ] Configure API keys in environment
- [ ] Send first test email
- [ ] Integrate with Stripe webhook

### Phase 2: Support Setup (Day 1-2)
- [ ] Email account ready
- [ ] Team trained on templates
- [ ] Response process documented

### Phase 3: Testing (Day 2)
- [ ] Mobile testing completed
- [ ] All browsers verified
- [ ] Issues logged and fixed

### Phase 4: Final Verification (Day 3)
- [ ] All three blockers resolved
- [ ] Launch checklist 100% green
- [ ] Go/No-Go decision made

---

## Quick Start: Email Service Comparison

| Service | Cost | Setup Time | Best For |
|---------|------|-----------|----------|
| **Resend** | $0.20/email | 15 min | Modern startups, API-first |
| **Brevo** | Free 300/day | 30 min | Automation sequences, cheap at scale |
| **Mailchimp** | Free 500/month | 45 min | Simple sends, good UI |
| **SendGrid** | $10/month | 20 min | High volume, enterprise |

**Recommendation:** Use **Resend** for simplicity or **Brevo** if you want email automation sequences included.

---

## Risk Assessment

| Blocker | Risk Level | Mitigation |
|---------|-----------|-----------|
| Email not tested | **HIGH** | Onboarding emails won't send, customers confused |
| Support inbox not monitored | **MEDIUM** | Support requests pile up, poor first impression |
| Mobile testing skipped | **LOW-MEDIUM** | Some mobile users frustrated, but not common complaints |

---

## Success Metrics to Track (After Launch)

Once all blockers are resolved and we launch:

- [ ] Email delivery rate > 95% (monitor bounces/complaints)
- [ ] Support inbox receives < 10 emails in first week (goal: 0-3)
- [ ] FAQ page traffic > 40% of visitors
- [ ] Mobile page views > 30% of total traffic
- [ ] Refund rate < 5%

---

## Questions?

Contact Echo (Customer Success Lead) or the relevant team for clarification on any blocker.

**Status:** Ready to unblock. All groundwork done. Implementation team can proceed independently.

---

**Last Updated:** 2026-03-20
**Next Review:** After blockers resolved (est. 2026-03-22)
