# DIYBrand Launch Operations Guide

**Owner:** Atlas (DevOps & Infrastructure Engineer)
**Date:** 2026-03-20
**Purpose:** Step-by-step operational guidance for launch day and launch week

---

## Quick Navigation

- **Pre-Launch (48 hours before):** [Checklist 1](#pre-launch-48-hours-before)
- **Launch Day (Morning):** [Checklist 2](#launch-day-morning-preparation)
- **First Deployment:** [Checklist 3](#first-production-deployment)
- **Post-Launch (First 24 hours):** [Checklist 4](#post-launch-first-24-hours)
- **Launch Week:** [Checklist 5](#launch-week-ongoing-monitoring)

---

## Pre-Launch (48 hours before)

### Infrastructure Final Verification

**Objective:** Ensure all infrastructure is functioning correctly before launch

**Timeline:** 2 hours

#### Step 1: Verify GitHub Secrets are Correct
```bash
# In GitHub repo Settings → Secrets and variables → Actions
# Verify these 8 secrets exist and are masked:
- VERCEL_TOKEN              ✓ Marked as masked
- VERCEL_PROJECT_ID         ✓ Marked as masked
- VERCEL_ORG_ID             ✓ Marked as masked
- SENTRY_DSN                ✓ Marked as masked
- NEXT_PUBLIC_SENTRY_DSN    ✓ Marked as masked
- STRIPE_SECRET_KEY         ✓ Marked as masked
- DATABASE_URL              ✓ Marked as masked
- SLACK_WEBHOOK             ✓ Marked as masked (optional)
```

**Action:** Have team lead verify each secret exists

#### Step 2: Test Sentry DSN Endpoint
```bash
# Verify Sentry project is accessible
curl -X POST https://YOUR-SENTRY-DSN@sentry.io/events/ \
  -H "Content-Type: application/json" \
  -d '{"message":"Launch test from DIYBrand"}'

# Check Sentry dashboard for test event
# https://sentry.io/organizations/diybrand/issues/
```

**Action:** Confirm test event appears in Sentry within 30 seconds

#### Step 3: Verify Vercel Project Settings
```bash
# In Vercel Dashboard:
1. [ ] Project environment variables set (staging/production)
2. [ ] Custom domain points to Vercel nameservers
3. [ ] SSL/TLS certificate is valid (green checkmark)
4. [ ] Deployments settings: auto-deploy on push enabled
5. [ ] Production environment: manual approval gate enabled
```

**Action:** Team lead confirms each item in Vercel dashboard

#### Step 4: Database Connection Test
```bash
# Test DATABASE_URL from GitHub secret
psql $DATABASE_URL -c "SELECT version();"

# Should return PostgreSQL version info
# If fails: verify Vercel Postgres IP whitelist includes Vercel deployment IPs
```

**Action:** Confirm database connection succeeds

#### Step 5: Slack Webhook Test (Optional)
```bash
# Test deployment notification webhook
curl -X POST $SLACK_WEBHOOK \
  -H 'Content-type: application/json' \
  -d '{"text":"🚀 DIYBrand launch infrastructure test - this is a test message"}'
```

**Action:** Confirm Slack message appears in configured channel

---

## Launch Day (Morning Preparation)

### 2 Hours Before First Deployment

**Objective:** Prepare team and systems for first production deployment

**Timeline:** 2 hours before first push to main

#### 1. Team Synchronization Meeting (30 minutes)
- [ ] Launch team gathered (CEO, Lead Engineer, Atlas)
- [ ] Roles clarified:
  - **Atlas** (DevOps): Monitoring infrastructure, responding to alerts
  - **Lead Engineer** (Viktor): Code quality, incident response
  - **CEO**: Business decisions, customer communication if needed
- [ ] Communication plan agreed:
  - Slack channel: #launch (real-time updates)
  - Alert escalation: Atlas → Viktor → CEO
  - Decision-making timeline: < 5 minutes for critical issues
- [ ] Rollback decision criteria defined:
  - Error rate > 5%: automatic rollback
  - Uptime check failures: immediate investigation
  - Payment failures > 10%: investigate and report

#### 2. Monitor Dashboards Setup (30 minutes)
- [ ] **Sentry Dashboard** open: https://sentry.io/organizations/diybrand/issues/
  - Set to real-time updates
  - Create filter for "level:error" to catch all errors
  - Note: takes ~30 seconds for errors to appear
- [ ] **Vercel Dashboard** open: https://vercel.com/dashboard
  - Watch Deployments section
  - Verify staging and production both show in environments
- [ ] **Uptime Monitoring** open: Your uptime monitoring tool
  - Ensure checks are running
  - Verify alert contacts are correct
- [ ] **GitHub Actions** open: https://github.com/diybrand/app/actions
  - Ready to monitor workflow runs
  - Scroll down to see real-time logs if needed

#### 3. Communication Channels Ready (15 minutes)
- [ ] Slack #launch channel created (or verified)
  - @-mention critical people to verify they see messages
  - Pin this guide to channel for easy reference
  - Post: "🚀 Launch operations underway. First deployment will begin in ~1.5 hours."
- [ ] On-call rotation confirmed
  - Atlas primary (0-24 hours)
  - Viktor secondary (escalation)
  - CEO tertiary (critical decisions)
- [ ] Customer communication plan ready (if applicable)
  - Support email monitored
  - Planned status page updates
  - Known downtime windows communicated

#### 4. Database Backup Before First Deployment (15 minutes)
```bash
# Vercel Postgres automatically backs up, but manual backup is good practice
# In Vercel Dashboard → Storage → Postgres:
# Click "Backup" button to create pre-launch snapshot

# Record backup ID and timestamp:
# Backup ID: ___________
# Time: ___________
# Note: This becomes restore point if needed
```

**Action:** Confirm backup created successfully

---

## First Production Deployment

### Execution Timeline: ~45 minutes total

#### T-0:00 — Team Ready
- [ ] All dashboards open and visible to team
- [ ] Slack channel (#launch) active
- [ ] On-call escalation chain confirmed
- [ ] Post "Starting first production deployment" in #launch

#### T+0:00 — First Commit to main Branch
```bash
# Lead Engineer: Push first commit to main
git commit -m "chore: launch diybrand to production"
git push origin main

# OR merge a PR to main
```

**Atlas watches:** GitHub Actions starts running

#### T+2:00 — Lint Stage Completes
- [ ] GitHub Actions CI/CD workflow shows "Lint" job running
- [ ] Wait for ESLint validation to complete
- [ ] Status: Should be 🟢 GREEN
- **If fails:** Stop immediately, report in #launch, investigate lint errors

#### T+4:00 — Test Stage Completes
- [ ] Test suite runs (non-blocking, may have warnings)
- [ ] Status: Can be 🟢 GREEN or 🟡 YELLOW
- **If critical failure:** Review error, may need rollback

#### T+6:00 — Build Stage Completes
- [ ] Next.js build compiles all code
- [ ] Create `.next` folder for deployment
- [ ] Status: Should be 🟢 GREEN
- **If fails:** STOP — critical error. Check logs, rollback if needed

#### T+8:00 — Deploy to Staging
- [ ] Vercel auto-deploys to staging environment
- [ ] Staging URL: https://staging.diybrand.app
- [ ] **Atlas tests:** `curl -I https://staging.diybrand.app`
- [ ] **Test endpoint:** `curl https://staging.diybrand.app/api/test-error`
- [ ] Wait for uptime check to confirm staging is responding
- Post in #launch: "✅ Staging deployment successful"

#### T+10:00 — Manual Approval for Production
- [ ] GitHub shows "Waiting for review" on production environment
- [ ] Lead Engineer clicks "Approve and Deploy" button
- [ ] Post in #launch: "🚀 Approving production deployment"

#### T+12:00 — Deploy to Production
- [ ] Vercel deploys to diybrand.app
- [ ] Watch deployment progress in Vercel dashboard
- [ ] Deployment typically takes 1-2 minutes

#### T+13:00 — Uptime Verification
- [ ] Uptime check runs against production
- [ ] **Atlas tests:** `curl -I https://diybrand.app`
- [ ] Sentry URL reachable: `curl https://diybrand.app/api/test-error`
- **If successful:** Continue to monitoring phase
- **If fails:** Immediate rollback (see [Rollback Procedures](#rollback-procedures))

#### T+15:00 — First 5 Minutes of Monitoring
- [ ] **Sentry:** Check error count (target: 0 errors initially)
- [ ] **Uptime:** Check all green (no timeouts)
- [ ] **Slack alerts:** None (if no alerts, infrastructure is good)
- Post in #launch: "✅ Production deployment successful. Monitoring first 5 minutes..."

#### T+20:00 — Extended Monitoring (Next 5 minutes)
- [ ] Error rate still low (< 0.1%)
- [ ] Uptime check consistent
- [ ] Stripe payments processing (if testable)
- [ ] No alerts from monitoring systems

#### T+30:00 — First Issue Report
- [ ] Any immediate issues reported in #launch?
- [ ] Support email received any complaints?
- [ ] Atlas monitors for spikes

#### T+45:00 — First Production Deployment Complete ✅
- [ ] No critical errors detected
- [ ] Uptime checks passing
- [ ] Database queries responding normally
- [ ] Post in #launch: "🎉 First production deployment complete and verified!"

---

## Post-Launch: First 24 Hours

### Hourly Monitoring Schedule

**Hour 0-1 (Immediate):** Every 5 minutes
- [ ] Check Sentry error rate (target: < 0.5%)
- [ ] Verify uptime checks are green
- [ ] Monitor Slack for alerts
- Atlas stays actively monitoring

**Hour 1-4:** Every 15 minutes
- [ ] Sample check of Sentry dashboard
- [ ] Verify no new error patterns emerging
- [ ] Team available for quick response

**Hour 4-24:** Every hour
- [ ] Morning: Check overnight error rate (target: < 1%)
- [ ] Review Sentry errors accumulated overnight
- [ ] Check database connection pool usage
- [ ] Atlas remains on-call for critical issues

### Critical Thresholds for Day 1

| Metric | Threshold | Action |
|--------|-----------|--------|
| Error Rate | > 5% | Investigate immediately, consider rollback |
| Uptime | < 95% | Critical incident, page Atlas + Viktor |
| Payment Failures | > 10% | Investigate Stripe config, may need customer communication |
| LCP (Page Load) | > 5s | Document, likely not critical day 1, monitor trend |

### Day 1 Incident Response

**If critical error occurs:**

1. **Immediate (< 5 min):**
   - Post in #launch: "🚨 CRITICAL INCIDENT DETECTED"
   - Check Sentry for error pattern
   - Verify it's not a false alarm (check uptime separately)

2. **Triage (5-10 min):**
   - Is this a recent code issue? Check git log
   - Is this an infrastructure issue? Check Vercel status
   - Is this a database issue? Check connection pool
   - Is this third-party (Stripe, Sentry)? Check those dashboards

3. **Decision (10-15 min):**
   - Can we fix quickly? (< 15 min)
   - Should we rollback? (if unfixable quickly)
   - Should we report to customers? (only if > 15 min downtime)

4. **Execute (15+ min):**
   - Atlas executes rollback OR Lead Engineer fixes code
   - Post status update every 5 minutes
   - Escalate to CEO if > 30 min downtime

---

## Launch Week: Ongoing Monitoring

### Daily (First 7 Days)

**Every morning (9 AM):**
```
1. Check overnight error rate (Sentry)
2. Review error patterns (any new issues?)
3. Check database size growth (normal?)
4. Review customer feedback (support email)
5. Check Vercel costs (any unusual spikes?)
6. Post "Daily Status" in #infrastructure
```

**Example daily status:**
```
📊 DIYBrand Daily Status (2026-03-21)
- Error rate: 0.2% (target: < 1%) ✅
- Uptime: 100% (target: 99.9%) ✅
- Avg response time: 0.8s (target: < 2.5s) ✅
- Sentry events: 47 (mostly expected errors)
- Customers: 12 new signups, 0 support tickets
- Database: 250MB used (normal for day 1)
```

### Weekly (First Month)

**Every Monday:**
- Full infrastructure review
- Cost analysis (Vercel, Postgres, Stripe)
- Performance trends
- Security check (no unexpected access patterns)
- Team retrospective (what went well, what to improve)

---

## Rollback Procedures

### Quick Rollback (Most Recent Commit)

**Use if:** Critical issue from last deployment, need fast revert

```bash
# 1. Create rollback commit
git revert HEAD --no-edit

# 2. Push to main (triggers CI/CD)
git push origin main

# 3. Monitor deployment (2-3 minutes)
# Watch GitHub Actions and Vercel

# 4. Verify rollback
curl -I https://diybrand.app  # Should be back
Check Sentry for error spike decline
Check uptime monitor for recovery
```

**Expected time:** 3-5 minutes total

### Emergency Rollback (Immediate)

**Use if:** Production is completely down, no time for normal rollback

```bash
# 1. Identify last known good commit (git log --oneline)
GOOD_COMMIT="abc123"

# 2. Create emergency rollback
git revert HEAD --no-edit
# OR for faster: git checkout $GOOD_COMMIT -- src/ package.json

# 3. Force push (only with explicit approval)
git push origin main --force

# 4. Monitor uptime for recovery
```

**Warning:** Force push should only be used in true emergency with explicit approval

---

## Communication Templates

### Launch Notification (To Slack)
```
🚀 DIYBrand Production Launch
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status: ✅ LIVE
Site: https://diybrand.app
Deployment: Complete and verified
Next check: Every 5 minutes (first hour)

Infrastructure status: ✅ All systems operational
- Vercel: Deployed
- Sentry: Monitoring
- Uptime: Verified
- Database: Responsive

Questions? Ping @Atlas in #launch
```

### Hourly Status (Day 1)
```
📊 Status Update (T+2 hours)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Uptime: 100% ✅
Error rate: 0.1% ✅
Response time: 850ms ✅
Last check: Just now
Next check: In 15 minutes

All systems nominal.
```

### Critical Issue Notification
```
🚨 CRITICAL INCIDENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Issue: [Description]
Severity: CRITICAL
Detected: [Time]
Status: [Investigating/Resolving/Resolved]

Actions taken:
- [Action 1]
- [Action 2]

ETA for resolution: [Time]

Updates every 5 minutes.
```

---

## Post-Launch Review Template

**After 24 hours, complete:**

### Metrics Review
- [ ] Error rate throughout day 1: ______%
- [ ] Max error rate spike: ______%
- [ ] Uptime: ______%
- [ ] Page load time (LCP): ______ms
- [ ] Database connection pool peak: ______
- [ ] Total customers: ______
- [ ] Support tickets: ______

### Incidents During Day 1
- [ ] Count: ______
- [ ] Severity: [CRITICAL/HIGH/MEDIUM/LOW]
- [ ] Duration: ______minutes
- [ ] Cause: ______
- [ ] Resolution: ______

### What Went Well
- ___________
- ___________
- ___________

### What Could Be Improved
- ___________
- ___________
- ___________

### Action Items for Week 2
1. ___________
2. ___________
3. ___________

---

## Key Contacts

| Role | Name | Slack | On-Call |
|------|------|-------|---------|
| DevOps | Atlas | @Atlas | Primary (24h) |
| Lead Engineer | Viktor | @Viktor | Secondary |
| CEO | [Name] | @CEO | Tertiary |
| Support | [Name] | @support | Available |

---

## Reference Dashboards (Bookmark These)

1. **Sentry Issues:** https://sentry.io/organizations/diybrand/issues/
2. **Vercel Deployments:** https://vercel.com/diybrand-team/diybrand/deployments
3. **Vercel Analytics:** https://vercel.com/diybrand-team/diybrand/analytics
4. **Uptime Monitor:** [Your uptime monitor URL]
5. **GitHub Actions:** https://github.com/diybrand/app/actions

---

## Success Criteria for Launch Day

✅ **Must Achieve:**
1. Production deployment succeeds
2. Uptime check passes
3. Error rate < 1%
4. No critical incidents requiring rollback
5. First customer can purchase and download product

✅ **Should Achieve:**
1. Error rate < 0.5%
2. Page load time < 2.5 seconds
3. All documentation pages accessible
4. Support email monitored

✅ **Nice to Have:**
1. Analytics tracking working
2. Feedback widget collecting responses
3. Database queries under 100ms average

---

## Document Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-20 | Atlas | Initial launch operations guide |

---

**Last Updated:** 2026-03-20
**Next Update:** After launch review (2026-03-21)
**Questions?** Contact Atlas (@Atlas on Slack)
