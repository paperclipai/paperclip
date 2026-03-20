# DIYBrand Infrastructure Quick Reference

**Keep this open during launch and refer to it during incidents**

---

## Critical URLs (Bookmark All)

| System | URL | Purpose |
|--------|-----|---------|
| **Production** | https://diybrand.app | Live site |
| **Staging** | https://staging.diybrand.app | Testing environment |
| **Sentry** | https://sentry.io/organizations/diybrand/issues/ | Error tracking |
| **Vercel** | https://vercel.com/dashboard | Deployment status |
| **GitHub** | https://github.com/diybrand/app/actions | CI/CD pipeline |
| **Status** | https://status.diybrand.app | Uptime monitor |

---

## Quick Health Checks

### 30-Second Production Check
```bash
# Is site responding?
curl -I https://diybrand.app

# Can we track errors?
curl https://diybrand.app/api/test-error

# Database working?
# (Check Sentry for database errors)
```

**Expected:**
- HTTP 200 OK on main site
- Sentry receives error within 30 seconds
- No database connection errors in last 5 minutes

### Command Quick Reference
```bash
# View recent commits
git log --oneline -5

# Check deployment status
vercel --version  # confirm tool installed

# View error logs (if SSH access available)
vercel logs production

# Test Sentry
curl -X POST $SENTRY_DSN/events/ -H "Content-Type: application/json" \
  -d '{"message":"Test event"}'
```

---

## 🚨 Critical Thresholds

**ALERT if any of these occur:**

| Metric | Threshold | Action |
|--------|-----------|--------|
| **Error Rate** | > 5% | Investigate immediately |
| **Error Rate** | > 10% | ROLLBACK |
| **Uptime Check** | 2+ failures | Check site manually |
| **Uptime Down** | > 5 minutes | CRITICAL - escalate to Viktor |
| **Response Time** | > 5 seconds (p95) | Check database, identify slow query |
| **Payment Failures** | > 10% in 5 min | Check Stripe status, check logs |

---

## 🔴 If Production is Down

**Do this immediately (in order):**

1. **Verify it's actually down:**
   ```bash
   curl -I https://diybrand.app
   # Try from different network if possible
   ```

2. **Check Vercel status:**
   - https://vercel.com/dashboard → DIYBrand → Deployments
   - Look for red X or yellow warning

3. **Check GitHub Actions:**
   - https://github.com/diybrand/app/actions
   - Is a deployment in progress?

4. **If recent commit is the problem:**
   ```bash
   # Rollback (quick revert)
   git revert HEAD --no-edit
   git push origin main
   # Wait 3-5 minutes for Vercel to redeploy
   ```

5. **If still down after 5 minutes:**
   - Post in #launch: "🚨 PRODUCTION DOWN - investigating"
   - Check Sentry for error patterns
   - Call Viktor (Lead Engineer)

6. **Escalation (if unresolved after 15 min):**
   - Call CEO
   - Consider manual intervention on Vercel

---

## 🔴 If Error Rate Spikes

**Error rate > 5% within 5 minutes:**

1. **Check Sentry immediately:**
   - https://sentry.io/organizations/diybrand/issues/
   - What's the most common error?
   - Did it start recently? (check timestamp)

2. **Is it a code issue?**
   - Check recent commits: `git log --oneline -5`
   - Look at Sentry stack trace - which file?
   - If yes: ROLLBACK

3. **Is it infrastructure?**
   - Check database connection errors (Sentry)
   - Check Stripe API errors
   - Check Vercel logs
   - If yes: Check config, escalate to Viktor

4. **Decision Tree:**
   ```
   Error rate > 5%?
   ├─ Can we identify fix in < 5 min?
   │  ├─ YES → Push fix
   │  └─ NO → ROLLBACK
   └─ Unknown cause?
      └─ ROLLBACK (investigate after)
   ```

---

## 🟡 If Page Loads Slowly (LCP > 3s)

**This is usually not critical day 1, but monitor:**

1. Check Core Web Vitals:
   - Vercel Dashboard → Analytics
   - Look at LCP (Largest Contentful Paint)

2. Common causes:
   - Large images not optimized → Add Next.js `<Image>`
   - Slow API endpoint → Check Server-Timing header
   - Third-party script → Load async or defer

3. Action:
   - Document the issue
   - Monitor if it gets worse
   - Not critical unless > 5 seconds

---

## 💳 If Stripe Payments Fail

**Multiple payment failures detected:**

1. Check Stripe dashboard:
   - https://dashboard.stripe.com
   - Look for recent declined charges
   - Any API errors?

2. Common causes:
   - API key wrong/expired → Check GitHub secrets
   - Customer card declined → Notify customer
   - Webhook not received → Check Stripe settings

3. Actions:
   - Verify STRIPE_SECRET_KEY in GitHub secrets
   - Test webhook endpoint: `POST /api/webhooks/stripe`
   - If webhook broken: This needs code fix

4. Escalate if:
   - Multiple customer complaints
   - > 10% failure rate
   - Cannot identify cause

---

## 🔑 Critical Environment Variables (Do NOT Commit These)

**These must be in GitHub secrets, NEVER in code:**

```
VERCEL_TOKEN           (from Vercel account settings)
VERCEL_PROJECT_ID      (from Vercel project settings)
VERCEL_ORG_ID          (from Vercel team settings)
SENTRY_DSN             (from Sentry project)
NEXT_PUBLIC_SENTRY_DSN (from Sentry project)
STRIPE_SECRET_KEY      (from Stripe dashboard)
DATABASE_URL           (from Vercel Postgres)
SLACK_WEBHOOK          (from Slack workspace)
```

**To check they're configured:**
1. GitHub repo → Settings → Secrets and variables → Actions
2. All 8 should be listed
3. All should be marked as "masked"

---

## 📊 Monitoring Dashboards (Refresh Every 5 Minutes During Day 1)

**Open tabs and keep refreshing:**

### Sentry Error Dashboard
- What's the error rate right now?
- Are new errors appearing?
- Any error spike in last 5 minutes?

### Vercel Deployments
- Is deployment still running?
- Any failed steps?
- How long until complete?

### GitHub Actions
- Is workflow still running?
- Any red X on lint/build/deploy?
- Check logs if something fails

### Uptime Monitor
- Are all checks green?
- Any recent failures (even if resolved)?
- Response times normal?

---

## 📞 Escalation Chain

**When to escalate:**

### Level 1 (Atlas Handles)
- [ ] Slow page loads (LCP 2.5-5s)
- [ ] Minor errors (< 0.5%)
- [ ] Single customer report
- **Action:** Investigate, monitor, document

### Level 2 (Escalate to Viktor)
- [ ] Error rate 1-5%
- [ ] Deploy fails
- [ ] Database connection issues
- [ ] Unidentified critical issue
- **Action:** Message @Viktor in #launch

### Level 3 (Escalate to CEO)
- [ ] Production down > 5 minutes
- [ ] Error rate > 10%
- [ ] Unresolved > 15 minutes
- [ ] Need business decisions (refunds, etc.)
- **Action:** Call or message @CEO immediately

---

## 🔄 Quick Rollback (Copy-Paste)

**If you need to rollback fast:**

```bash
# Step 1: Create rollback commit
git revert HEAD --no-edit

# Step 2: Push to main
git push origin main

# Step 3: Watch Vercel dashboard for deployment
# Should complete in 2-3 minutes

# Step 4: Verify
curl -I https://diybrand.app
# Should get HTTP 200

# Step 5: Check Sentry
# Error rate should decrease within 2 minutes
```

**Expected time:** 3-5 minutes total

---

## 📝 Key Files by Purpose

**Setup & Configuration:**
- `DEPLOYMENT-CHECKLIST.md` — Pre-launch verification
- `.env.production` — Production environment variables
- `.github/workflows/ci-cd.yml` — CI/CD pipeline definition

**Operations & Incident Response:**
- `INFRASTRUCTURE-RUNBOOK.md` — Detailed troubleshooting guide
- `LAUNCH-OPERATIONS-GUIDE.md` — Day-by-day operational plan
- `QUICK-REFERENCE.md` — This file (quick answers)

**Architecture & Reference:**
- `INFRASTRUCTURE.md` — Full infrastructure documentation
- `VERCEL-SETUP.md` — Domain and Vercel configuration
- `ATLAS-INFRASTRUCTURE-SUMMARY.md` — Executive summary

---

## ✅ Daily Checklist (Copy to Slack Daily)

**Every morning during launch week:**

```
📊 Daily Infrastructure Check
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Date: [DATE]
Time: [TIME]

[ ] Overnight error rate checked (target: < 1%)
[ ] Uptime check confirmed (target: 100%)
[ ] Database connection pool normal
[ ] No unusual Slack alerts
[ ] Support email reviewed (any issues?)
[ ] Cost trends normal (Vercel, Postgres)

Status: [GREEN/YELLOW/RED]
Notes: [Any observations]

Next check: [TIME]
```

---

## 💡 Pro Tips

1. **Tabs open at all times during day 1:**
   - Sentry Issues
   - Vercel Deployments
   - GitHub Actions
   - Uptime Monitor

2. **Fastest way to check health:**
   ```bash
   # One-liner to verify site is up
   curl -s -o /dev/null -w "%{http_code}" https://diybrand.app && echo "✅"
   ```

3. **If unsure, ask yourself:**
   - Is the site actually down or just slow?
   - Is this a code issue or infrastructure issue?
   - Have we seen this error before?
   - Can we fix in < 5 minutes?

4. **Communication is critical:**
   - Post updates every 5 minutes during incident
   - Keep team informed, don't go silent
   - Escalate early rather than late

5. **Keep calm:**
   - Most issues are fixable
   - Rollback is always an option
   - Day 1 issues are normal
   - You've got a team to help

---

## Document History

| Version | Date | Author |
|---------|------|--------|
| 1.0 | 2026-03-20 | Atlas |

---

**Last Updated:** 2026-03-20
**Print this page and keep it nearby during launch**
**Questions? Slack @Atlas anytime**
