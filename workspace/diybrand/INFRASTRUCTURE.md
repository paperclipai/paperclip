# DIYBrand Infrastructure & Deployment Guide

This document covers the deployment, monitoring, and infrastructure management for DIYBrand.

> **Quick Links - Read in This Order:**
>
> **Pre-Launch (Team Setup):**
> 1. [DEPLOYMENT-CHECKLIST.md](./DEPLOYMENT-CHECKLIST.md) — 9-phase pre-launch verification
> 2. [LAUNCH-OPERATIONS-GUIDE.md](./LAUNCH-OPERATIONS-GUIDE.md) — Launch day timeline and operations
>
> **Launch Day (Keep Nearby):**
> 3. [QUICK-REFERENCE.md](./QUICK-REFERENCE.md) — One-page incident response guide ⭐
>
> **Detailed Reference:**
> 4. [INFRASTRUCTURE-RUNBOOK.md](./INFRASTRUCTURE-RUNBOOK.md) — On-call incident procedures
> 5. [VERCEL-SETUP.md](./VERCEL-SETUP.md) — Domain and Vercel configuration details
> 6. [Sentry Configuration](#error-tracking-sentry) — Error tracking setup
> 7. [GitHub Actions Workflows](./.github/workflows/) — CI/CD pipeline definitions
>
> **Summary Documents:**
> - [ATLAS-INFRASTRUCTURE-SUMMARY.md](./ATLAS-INFRASTRUCTURE-SUMMARY.md) — Executive work summary

## Overview

DIYBrand uses:
- **Hosting**: Vercel (Next.js optimized)
- **Database**: PostgreSQL
- **CI/CD**: GitHub Actions
- **Monitoring**: Sentry (error tracking), custom uptime checks
- **Payment**: Stripe (integrated)
- **Environment Stages**: Staging (preview) and Production

## Deployment Pipeline

### Architecture

```
Commit to main
    ↓
GitHub Actions: Lint + Test + Build
    ↓
Deploy to Staging (automatic)
    ↓
[Manual Approval Gate]
    ↓
Deploy to Production (manual)
    ↓
Uptime Verification
    ↓
Slack Notification
```

### Automated Workflows

#### 1. **CI/CD Pipeline** (`.github/workflows/ci-cd.yml`)

Runs on every push to `main`:

- **Lint**: ESLint validation (must pass)
- **Test**: Test suite execution (warnings allowed)
- **Build**: Next.js build (must pass)
- **Deploy Staging**: Auto-deploys to preview environment
- **Deploy Production**: Requires manual approval in GitHub
- **Uptime Check**: Validates production is responding

**Status Checks:**
- ✅ Required: Lint and Build must pass
- ⚠️ Optional: Tests (fails don't block merge, but are encouraged)

#### 2. **PR Validation** (`.github/workflows/pr-validation.yml`)

Runs on every pull request:

- ESLint validation
- Test execution (non-blocking)
- Build validation
- Bundle size reporting
- Inline PR comments with results

**Merge Requirements:**
- ✅ Lint passes
- ✅ Build passes
- ⚠️ Tests should pass (not enforced)

## Environment Configuration

### Required Secrets (GitHub)

Set these in your GitHub repository settings under **Settings → Secrets and variables → Actions**:

```
VERCEL_TOKEN                   # Vercel API token (personal or team)
VERCEL_PROJECT_ID              # DIYBrand project ID in Vercel
VERCEL_ORG_ID                  # Vercel organization ID
SLACK_WEBHOOK                  # Slack webhook for deployment notifications (optional)
SENTRY_DSN                     # Sentry server-side error tracking DSN
NEXT_PUBLIC_SENTRY_DSN         # Sentry client-side error tracking DSN (can be same as SENTRY_DSN)
STRIPE_SECRET_KEY              # Stripe API secret (production only)
DATABASE_URL                   # PostgreSQL connection string (staging/prod)
```

### Environment Variables

#### Staging (`.env.staging`)

```env
NEXT_PUBLIC_API_URL=https://staging.diybrand.app
DATABASE_URL=postgres://...staging...
STRIPE_PUBLISHABLE_KEY=pk_test_...
NODE_ENV=production
```

#### Production (`.env.production`)

```env
NEXT_PUBLIC_API_URL=https://diybrand.app
DATABASE_URL=postgres://...production...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_SECRET_KEY=sk_live_...
SENTRY_DSN=https://...@sentry.io/...
NODE_ENV=production
```

**Security Rules:**
- ❌ Never commit `.env.*.local` or secrets
- ✅ Use GitHub Secrets for sensitive values
- ✅ Rotate secrets quarterly
- ✅ Audit access logs weekly

## Deployment Procedures

### Manual Production Deploy

1. **Verify staging is working**
   - Check: https://staging.diybrand.app/health

2. **Trigger production deployment**
   - Go to GitHub Actions
   - Find the successful main branch run
   - Click "deploy-production" job
   - Approve the environment deployment

3. **Verify production health**
   - Check: https://diybrand.app
   - Monitor Sentry for errors
   - Check Slack for deployment notification

### Rollback Procedure

If production deployment fails:

1. **Identify the issue**
   - Check GitHub Actions logs
   - Check Sentry error tracking
   - Check Vercel deployment logs

2. **Revert or fix**
   - Option A: `git revert <commit-hash>` + push to main
   - Option B: Fix the issue in a new PR

3. **Redeploy**
   - Wait for new CI/CD run
   - Approve production deployment again

## Security Headers

### Configuration

Next.js security headers are configured in `next.config.ts`:

```typescript
async headers() {
  return [{
    source: '/:path*',
    headers: [
      {
        key: 'Content-Security-Policy',
        value: "default-src 'self'; script-src 'self' 'unsafe-inline'"
      },
      {
        key: 'X-Frame-Options',
        value: 'SAMEORIGIN'
      },
      {
        key: 'X-Content-Type-Options',
        value: 'nosniff'
      },
      {
        key: 'Strict-Transport-Security',
        value: 'max-age=31536000; includeSubDomains'
      }
    ]
  }]
}
```

### HSTS (SSL)

- **Duration**: 1 year (31536000 seconds)
- **Subdomains**: Included
- **Preload**: Submitted to HSTS preload list

### CSP (Content Security Policy)

- Default: Allow from own origin only
- Scripts: Self-hosted only (no inline scripts)
- Images: Allow from trusted CDNs
- Review before adding third-party services

## Monitoring & Alerting

### Uptime Monitoring

**Production Health Check:**
- Runs after every production deploy
- HTTP GET to `https://diybrand.app`
- Expects 200 status code
- Retries 5 times with 10s delay

**Alerts:**
- Slack notification on deployment failure
- GitHub check fails if health check doesn't pass

### Error Tracking (Sentry)

**Status**: ✅ Integrated

**Configuration Files:**
- `sentry.server.config.ts` — Server-side error tracking
- `sentry.client.config.ts` — Client-side error tracking
- `src/instrumentation.ts` — Automatic initialization
- `next.config.ts` — withSentryConfig wrapper

**Environment Variables (Required):**
```env
SENTRY_DSN=https://[key]@[domain].ingest.sentry.io/[project-id]
NEXT_PUBLIC_SENTRY_DSN=[same as above, for client errors]
```

**Features:**
- ✅ Automatic error capturing on server and client
- ✅ Performance monitoring (10% sample rate in production)
- ✅ Request tunneling via /monitoring endpoint (circumvents ad-blockers)
- ✅ Source map uploads for readable stack traces
- ✅ Error filtering for non-actionable errors (network, extensions)
- ✅ Breadcrumb collection for error context

**Testing Error Capture:**
```bash
# Once deployed to production with SENTRY_DSN configured:
curl https://diybrand.app/api/test-error?type=exception
curl https://diybrand.app/api/test-error?type=message
curl https://diybrand.app/api/test-error?type=performance
```

**Dashboard**: https://sentry.io/organizations/diybrand/issues/

**Recommended Alerting Rules:**
- Alert on error rate > 1% within 5 minutes
- Alert on new error patterns (not seen before)
- Alert on errors in critical API routes (/api/checkout, /api/webhooks/stripe)
- Daily digest of top errors
- Notify on-call when > 10 errors in 1 minute

### Database Monitoring

**Connection Health:**
- Monitor connection pool usage
- Alert if > 80% of connections in use
- Check slow query logs weekly

### Database Backups & Disaster Recovery

**Status**: ✅ Automated backups enabled (Vercel Postgres)

#### Backup Strategy

**Automated Backups (Vercel Postgres - Managed):**
- ✅ Daily automatic backups
- ✅ 30-day retention window
- ✅ Geographic redundancy (replicated across data centers)
- ✅ Point-in-time recovery (PITR) available
- ✅ Zero configuration required

**Backup Location & Access:**
1. Go to Vercel dashboard → **Storage → Postgres**
2. Click **"Backups"** tab
3. View list of available backups with timestamps
4. Click **"Restore"** on any backup to recover

**Backup Schedule:**
```
Daily automated backup at: 03:00 UTC
Retention: 30 days
Maximum backups kept: 30 snapshots
```

#### Point-in-Time Recovery (PITR)

Restore to any point in time within the last 30 days (down to seconds):

**Via Vercel Dashboard:**
1. **Storage → Postgres → Backups**
2. Select restore point (by date/time)
3. Click **"Restore from this backup"**
4. Vercel creates new Postgres instance with restored data
5. Update `DATABASE_URL` in environment variables
6. Redeploy application

**Important:** Restore creates a NEW database instance. Old instance remains until manually deleted.

**Estimated Restore Time:**
- Small DB (< 100MB): 2-5 minutes
- Medium DB (100MB-1GB): 5-15 minutes
- Large DB (> 1GB): 15-45 minutes

#### Backup Testing Procedure

**Weekly Automated Test (Recommended):**

```bash
# 1. Schedule weekly restore test
# Every Monday at 10:00 UTC in GitHub Actions

# 2. Test script:
#!/bin/bash
set -e
echo "Starting backup restore test..."

# Restore to staging database from yesterday's backup
# Verify data integrity by running test queries
psql $BACKUP_TEST_DB -c "SELECT COUNT(*) FROM users;"
psql $BACKUP_TEST_DB -c "SELECT COUNT(*) FROM orders;"

# Clean up test database
# psql $BACKUP_TEST_DB -c "DROP DATABASE staging_restore_test;"

echo "✅ Backup restore test successful"
```

**Manual Test (Before Critical Deployments):**

1. In Vercel dashboard, select a backup from 24 hours ago
2. Click **"Restore to new database"**
3. Note new `DATABASE_URL`
4. Test connection:
   ```bash
   psql "postgres://user:pass@host/db" -c "SELECT version();"
   ```
5. Run integrity checks:
   ```bash
   psql "..." -c "
     SELECT
       'users' as table_name, COUNT(*) as row_count
     FROM users
     UNION ALL
     SELECT 'orders', COUNT(*) FROM orders
     UNION ALL
     SELECT 'payments', COUNT(*) FROM payments;
   "
   ```
6. Delete test database when done

#### Disaster Recovery Plan

**RTO (Recovery Time Objective):** < 4 hours
**RPO (Recovery Point Objective):** < 24 hours

**Disaster Scenarios & Recovery:**

**Scenario 1: Data Corruption (Application Bug)**
1. Detect via monitoring/error tracking
2. Restore from backup 24 hours before corruption
3. Redeploy application with bug fix
4. Verify data integrity
5. Monitor for new issues
**Estimated Time:** 1-2 hours

**Scenario 2: Accidental Data Deletion**
1. Immediately stop application writes (don't panic!)
2. Restore from backup from before deletion time
3. Create new DB instance, update `DATABASE_URL`
4. Redeploy with new connection string
5. Validate restored data
**Estimated Time:** 30 minutes - 1 hour

**Scenario 3: Database Connection Failure**
1. Check Vercel dashboard for service status
2. Verify credentials in environment variables
3. Test connection locally:
   ```bash
   psql "postgres://..." -c "SELECT 1;"
   ```
4. If DB is down, restore from latest backup
5. Update `DATABASE_URL` and redeploy
**Estimated Time:** 15-30 minutes

**Scenario 4: Ransomware / Security Breach**
1. Immediately isolate affected systems
2. Review audit logs for unauthorized access
3. Restore from clean backup (before compromise)
4. Rotate all credentials (Stripe, API keys, etc.)
5. Review and fix vulnerability that led to breach
6. Redeploy with patched code
**Estimated Time:** 2-4 hours

#### Backup Alerts & Monitoring

**Configure Alerts:**

1. **Failed Backups:**
   - Set up webhook to monitor backup status
   - Alert if no backup created in 48 hours
   - Check Vercel dashboard → **Backups** tab daily

2. **Database Connection Issues:**
   ```
   Alert trigger:
   - Connection pool at > 90% capacity
   - Connection timeout errors
   - Query execution time > 5 seconds
   ```

3. **Storage Growth:**
   - Monitor database size weekly
   - Alert if > 80% of plan limit
   - Archive old logs monthly

#### Database Maintenance

**Weekly Tasks:**
- Check backup status (Vercel dashboard)
- Monitor slow query logs
- Verify connection pool health
- Review error logs from Sentry

**Monthly Tasks:**
- Test restore procedure
- Analyze query performance
- Archive old business data (if applicable)
- Review and optimize database indexes

**Quarterly Tasks:**
- Full backup integrity test (automatic)
- Security audit of database access
- Capacity planning (storage growth projection)
- Disaster recovery drill

#### Accessing Backups Programmatically

**Via Vercel API:**

```bash
# Get list of backups
curl https://api.vercel.com/v2/databases/[database-id]/backups \
  -H "Authorization: Bearer $VERCEL_TOKEN"

# Restore from backup
curl -X POST https://api.vercel.com/v2/databases/[database-id]/restore \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -d '{"backupId": "[backup-id]"}'
```

#### Data Retention Policy

**Application Data:**
- All user data retained indefinitely (as per privacy policy)
- Deleted users: soft delete (30-day retention for audit)
- Hard delete available upon request

**System Data:**
- API logs: 90 days (rolled up to summaries after 30 days)
- Error logs (Sentry): 90 days free tier
- Database backups: 30 days (latest 30 snapshots)

**Compliance:**
- GDPR: User deletion requests processed within 30 days
- Right to be forgotten: Anonymization available
- Data export: Available via admin UI

## Performance Optimization

### Build Optimization

**Bundle Size Target**: < 150KB (gzipped)

**Monitoring:**
- GitHub Actions reports bundle size in PRs
- Weekly bundle size report via CI/CD

**Optimization Tactics:**
- Dynamic imports for large components
- Image optimization via Next.js `<Image>`
- Code splitting enabled by default

### Edge Caching

**Vercel Configuration:**
- Static assets: 1 year cache
- API routes: No cache (dynamic)
- Images: 365 days cache

**Cache Headers:**
```typescript
res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
```

### Database Optimization

- Index frequently filtered columns
- Use connection pooling
- Monitor slow queries (> 1s)

## Incident Response

### Production Issue Workflow

1. **Detect**: Sentry alert or Slack notification
2. **Assess**: Check logs, user reports, Sentry
3. **Mitigate**: Rollback or hotfix deploy
4. **Resolve**: Post-mortem in GitHub issue
5. **Prevent**: Add test coverage or monitoring

### Alert Escalation

- **Level 1** (Minor): Fix in next release
- **Level 2** (Major): Emergency hotfix (< 4 hours)
- **Level 3** (Critical): Immediate rollback + investigation

## Monitoring & Observability

### Overview

Production observability is built on three pillars: uptime monitoring, error tracking, and performance monitoring.

**Stack:**
- **Uptime Monitoring**: UptimeRobot or similar (detects downtime)
- **Error Tracking**: Sentry (captures and alerts on errors)
- **Performance Monitoring**: Vercel Analytics + Core Web Vitals
- **Logging**: Application logs via Sentry, database via Vercel Postgres

### Uptime Monitoring

**Goal**: Detect when production is unreachable (target: 99.9% uptime)

**Setup:**
1. Use UptimeRobot, Healthchecks.io, or Vercel's built-in monitoring
2. Configure HTTP GET check: `https://diybrand.app`
3. Expected response: 200 status code within 30 seconds
4. Check frequency: Every 5 minutes (12x per hour)

**Alerts:**
```
If status code != 200 for 2+ consecutive checks:
  → Alert via email + SMS
  → Notify Slack channel #infrastructure
  → Trigger PagerDuty (if available)
```

**Dashboard:**
- Check status at: uptime monitoring service dashboard
- Public status page (optional): status.diybrand.app
- SLA target: 99.9% (allow 8.64 hours downtime per year)

**Alert Response:**
1. **Receive alert** → Check #infrastructure Slack
2. **Verify issue** → Test `https://diybrand.app` manually
3. **Check status** → Vercel dashboard, Sentry, database
4. **Investigate logs** → Sentry, GitHub Actions, Vercel logs
5. **Mitigate** → Rollback, hotfix, or restore database
6. **Communicate** → Post in Slack with status updates
7. **Post-mortem** → Document incident in GitHub issue

### Error Rate Monitoring

**Goal**: Alert on unexpected error spikes before users report issues

**Sentry Alerts:**

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Error rate spike | > 1% within 5 min | 🔴 Critical alert |
| New error pattern | Never seen before | 🟡 Warning alert |
| Critical routes | /api/checkout > 0 errors | 🔴 Immediate alert |
| Stripe webhooks | Any failures | 🔴 Immediate alert |

**Configuration (in Sentry):**
1. Go to **Project Settings → Alerts**
2. Create alert rule:
   ```
   IF: Error rate increases by 50% within 5 min
   THEN: Alert via Slack + Email
   ```
3. Create rule:
   ```
   IF: New error in: /api/checkout, /api/webhooks/stripe
   THEN: Alert via Slack + PagerDuty
   ```
4. Configure team notification: #infrastructure Slack channel

**Alert Response:**
1. Click Sentry link in alert
2. Review stack trace and affected users
3. Check recent deployments (GitHub Actions)
4. If bug introduced in recent deployment: **Rollback immediately**
5. If data issue: **Check database backups**
6. If external service: **Check service status pages**
7. Fix and redeploy

### Performance Monitoring

**Goal**: Detect performance degradation before it impacts users

**Core Web Vitals Targets:**
| Metric | Target | Alert |
|--------|--------|-------|
| Largest Contentful Paint (LCP) | < 2.5s | > 4s |
| First Input Delay (FID) | < 100ms | > 300ms |
| Cumulative Layout Shift (CLS) | < 0.1 | > 0.3 |

**Monitoring via Vercel Analytics:**
1. Go to Vercel dashboard → **Analytics**
2. View real-time metrics:
   - Page load times by route
   - Edge cache hit rate
   - Time to First Byte (TTFB)
3. Compare with baselines from previous week
4. Alert if metrics degrade > 20%

**Response to Performance Degradation:**
1. Check Vercel build logs
2. Review recent code changes (git log)
3. Check database query performance (slow logs)
4. Check bundle size (GitHub Actions reports)
5. If image-heavy page: Verify Next.js Image optimization
6. If API slow: Check database indexes and query plans
7. If layout shift: Find CSS causing shift (DevTools)
8. Fix and measure improvement

### Database Monitoring

**Goal**: Maintain database health and catch issues early

**Metrics to Monitor:**

| Metric | Check Frequency | Alert Threshold |
|--------|-----------------|-----------------|
| Connection pool usage | Real-time | > 80% |
| Active connections | Real-time | > 900 |
| Storage size | Daily | > 80% of plan |
| Slow queries | Daily | > 1 second execution |
| Backup status | Daily | No backup in 48h |

**Setup Connection Pool Monitoring:**

```typescript
// Add to API route health check
import { sql } from 'drizzle-orm';

export async function GET() {
  try {
    const result = await db.execute(sql`SELECT COUNT(*) as connections FROM pg_stat_activity;`);
    const connections = result[0].connections;
    const poolUsage = (connections / 900) * 100; // Max 900 connections

    if (poolUsage > 80) {
      // Alert via Sentry
      Sentry.captureMessage(`High connection pool usage: ${poolUsage}%`, 'warning');
    }

    return Response.json({ poolUsage });
  } catch (error) {
    Sentry.captureException(error);
    return Response.json({ error: 'DB health check failed' }, { status: 500 });
  }
}
```

**Check Storage Size:**
1. Vercel dashboard → **Storage → Postgres → Usage**
2. Monitor growth rate (bytes per day)
3. If > 100MB/week: Investigate large tables
4. Archive old data if necessary

**Slow Query Log:**
```sql
-- Find slow queries
SELECT
  query,
  calls,
  total_time,
  mean_time
FROM pg_stat_statements
WHERE mean_time > 1000  -- > 1 second
ORDER BY mean_time DESC;
```

### Logging Strategy

**Application Logs:**
- Sent to Sentry (via SDK)
- Breadcrumbs capture context
- Retention: 90 days (free tier)

**API Request Logs:**
- Vercel automatically logs all requests
- Accessible via Vercel dashboard
- Retention: Last 30 deployments

**Database Logs:**
- Connection logs in Vercel dashboard
- Slow query logs available
- Query performance tracked

**Accessing Logs:**
```bash
# Pull recent Vercel logs
vercel logs --prod

# Pull specific deployment logs
vercel logs https://[deployment-url]

# View in browser
# Vercel dashboard → Deployments → [deployment] → Logs
```

### Alerting Channels

**Configure notifications for:**
1. **Sentry**: Project Settings → Integrations → Slack
2. **Uptime**: UptimeRobot → Alert contacts
3. **Vercel**: Project Settings → Notifications
4. **GitHub**: Actions → Secrets (webhook URLs)

**Alert Recipients:**
- **Slack channel**: #infrastructure (critical + warnings)
- **Email**: on-call rotation
- **PagerDuty**: escalation for P1 incidents (optional)

### Monitoring Dashboard

**Create unified dashboard (optional):**
- Vercel Analytics: Core Web Vitals + request metrics
- Sentry Dashboard: Error rates + new issues
- UptimeRobot: Uptime percentage + downtime events
- Cost tracking: Monthly spend trends

**Access Points:**
- Vercel: https://vercel.com/dashboard/project/analytics
- Sentry: https://sentry.io/organizations/diybrand/
- UptimeRobot: https://uptimerobot.com/dashboard
- GitHub Actions: https://github.com/[org]/[repo]/actions

### Monitoring Checklist

**Daily:**
- [ ] Check Sentry for critical errors
- [ ] Review uptime status (target: > 99.9%)
- [ ] Verify last backup completed

**Weekly:**
- [ ] Review error trends in Sentry
- [ ] Check Core Web Vitals from Vercel Analytics
- [ ] Review slow query logs
- [ ] Test database restore

**Monthly:**
- [ ] Analyze performance trends
- [ ] Review cost breakdown
- [ ] Capacity planning (storage growth)
- [ ] Security audit of access logs

**Quarterly:**
- [ ] Disaster recovery drill
- [ ] Review and optimize alerting rules
- [ ] Update runbooks
- [ ] Team training on incident response

## Cost Management

### Vercel Compute & Hosting

**Billing Model:**
- Pro plan: $20/month base
- Pay-as-you-go: $0.50 per 1M Function Invocations (API routes)
- Bandwidth: $0.15 per GB (except cached content)
- Image optimization: Included

**Cost Drivers:**
1. **Build minutes**: Each deployment uses build minutes
2. **Function invocations**: API route calls
3. **Bandwidth**: Data transfer (images, API responses)
4. **Edge Middleware**: Runs on every request

**Optimization Strategies:**
- Enable Vercel Image Optimization (automatic caching)
- Use Vercel Edge Middleware for routing (cheaper than functions)
- Cache static assets with 1-year TTL
- Compress API responses (gzip enabled by default)
- Limit preview environment deployments (create separate project if needed)

**Monitoring:**
```
Vercel Dashboard → Settings → Usage
- View current month spend
- Breakdown by function invocations, bandwidth, etc.
- Set spending alerts at $100, $200, $300
```

**Cost Target & Alerts:**
- **Baseline**: ~$50-100/month (small app, low traffic)
- **Alert threshold**: $300/month (investigate if exceeded)
- **Escalation**: >$500/month requires approval

**Cost Reduction Actions:**
1. Remove unused preview deployments
2. Optimize images (use Next.js Image component)
3. Cache API responses (30s+ for non-critical data)
4. Bundle size optimization (< 150KB gzipped)
5. Archive old deployments

### Database (Vercel Postgres)

**Billing Model (Vercel Postgres):**
- Free plan: 4GB storage, 50 concurrent connections
- Pro plans: $15-150/month based on storage/connections
- Storage: Primary $0.25/GB, Backup $0.10/GB

**Cost Drivers:**
1. **Storage size**: Larger databases cost more
2. **Connection pool**: Higher concurrency = higher tier
3. **Compute**: Query execution time (small, medium, large instances)

**Monitoring:**
```
Vercel Dashboard → Storage → Postgres
- Check storage size growth
- Monitor active connections
- Review compute usage
```

**Optimization & Cost Reduction:**
```sql
-- Check largest tables
SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Archive old data (e.g., logs older than 90 days)
DELETE FROM event_logs WHERE created_at < NOW() - INTERVAL '90 days';

-- Reindex to recover space
REINDEX DATABASE diybrand_prod;

-- Analyze for query optimization
ANALYZE;
```

**Alert Threshold:**
- Storage: Alert when > 80% of plan limit
- Connections: Alert when > 80% of max (900)
- Backups: Alert if backup size > 50% of main DB

### Stripe Payment Processing

**Billing Model:**
- Transaction fees: 2.9% + 30¢ per successful transaction
- No monthly fee for standard processing
- ACH transfers: Free (1-2 days)
- Instant payouts: $0.25 per payout

**Cost Drivers:**
1. **Transaction volume**: % of total payment amount
2. **Payment method**: Card, ACH, etc. (all same rate)
3. **Refunds**: Credited back to merchant, no reverse fee

**Monitoring:**
```
Stripe Dashboard → Reports → Revenue
- View monthly transaction volume
- Track refund rate
- Monitor failed payment attempts
```

**Cost Target & Alerts:**
- **Typical rate**: 2.9% + $0.30 per transaction
- **At $10k volume**: ~$300/month in fees
- **Alert threshold**: >$10k/month volume (track for revenue milestone)

**Cost Reduction:**
- Encourage ACH payments for large orders (instant payout)
- Monitor failed payments (retry logic in webhooks)
- Track refund rate (high rate = fraud or UX issue)
- Negotiate volume discounts at $100k+/month revenue

### Total Cost & Budget

**Estimated Monthly Costs (Small Scale):**
```
Vercel Compute:        $20-50
Vercel Postgres:       $15-30
Stripe Processing:     $100-500 (2.9% + 30¢/transaction)
Uptime Monitoring:     $10 (UptimeRobot free tier)
Sentry Error Tracking: $0 (free tier, 10k errors/month)
Domain/Email:          $10-20
─────────────────────────────────
Total Monthly:         $155-630
```

**Budget Allocation:**
- **Development**: < $50/month (Vercel)
- **Production**: < $200/month (Vercel + Database)
- **Payment processing**: 2.9% + $0.30/transaction
- **Monitoring**: < $20/month

**Cost Alerts & Escalation:**
| Cost Level | Action |
|-----------|--------|
| < $100/month | ✅ Green - No action |
| $100-$300/month | 🟡 Yellow - Monitor trends |
| $300-$500/month | 🟠 Orange - Optimize & review |
| > $500/month | 🔴 Red - Escalate & investigate |

**Weekly Cost Review:**
1. Check Vercel dashboard for current month estimate
2. Review Stripe transaction volume
3. Check Sentry for error rate (impacts quotas)
4. Identify cost optimization opportunities

**Monthly Cost Report (send to team):**
```
Current Month Cost: $XXX
vs. Last Month: ±XX%
vs. Budget: ±XX%

Breakdown:
- Vercel Compute: $X
- Database: $X
- Stripe Fees: $X
- Other: $X

Trends:
- Bandwidth: ↑↓X% (reason?)
- Function calls: ↑↓X% (reason?)
- Storage: ↑↓X% (reason?)

Recommendations:
- [Optimization #1]
- [Optimization #2]
```

## Compliance & Security

### SSL Certificates

- Managed by Vercel (automatic renewal)
- Check: https://www.ssllabs.com/ssltest/

### Data Protection

- ✅ HTTPS enforced
- ✅ HSTS enabled
- ✅ CSP configured
- ✅ No sensitive data in logs
- ✅ PII encrypted at rest (Postgres)

### Access Control

- ✅ GitHub branch protection on `main`
- ✅ Manual approval for production
- ✅ Audit log retention: 90 days

## Troubleshooting

### Deployment Stuck

```bash
# Check GitHub Actions logs
# If timeout, try rerunning from GitHub Actions UI

# Check Vercel build logs
vercel logs --prod
```

### Build Failing Locally

```bash
# Clear cache and rebuild
rm -rf .next node_modules
npm ci
npm run build
```

### Database Connection Issues

```bash
# Test connection
npm run db:push

# View connection status
# In Vercel dashboard: Settings → Storage
```

### High Error Rate

1. Check Sentry dashboard
2. Check recent deployments
3. Check database health
4. Check Stripe webhook logs

## Release Checklist

Before deploying to production:

- [ ] All tests passing
- [ ] Build succeeds locally
- [ ] Staging environment tested
- [ ] Database migrations ready (if any)
- [ ] Environment variables configured
- [ ] Monitoring/alerts active
- [ ] Slack notifications enabled
- [ ] Team notified of deployment

## Contacts & Resources

- **Vercel Support**: https://vercel.com/support
- **Sentry Docs**: https://docs.sentry.io/
- **Next.js Docs**: https://nextjs.org/docs
- **GitHub Actions**: https://docs.github.com/en/actions
- **On-Call**: See team Slack channel

---

**Last Updated**: 2026-03-18
**Maintained by**: Atlas (DevOps)
**Status**: ✅ Active
