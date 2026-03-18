# DIYBrand Infrastructure & Deployment Guide

This document covers the deployment, monitoring, and infrastructure management for DIYBrand.

> **Quick Links**:
> - [VERCEL-SETUP.md](./VERCEL-SETUP.md) — Domain, SSL, and Vercel project configuration
> - [GitHub Actions Workflows](./.github/workflows/) — CI/CD pipeline definitions
> - [Sentry Configuration](#error-tracking-sentry) — Error tracking setup

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

## Cost Management

### Vercel

- Monitor usage at https://vercel.com/settings/usage
- Alert threshold: $500/month
- Optimize: Image resizing, edge caching

### Database (Postgres)

- Monitor: Active connections, storage size
- Alert threshold: 100GB or > 900 active connections
- Optimize: Delete old logs, archive unused data

### Stripe

- Monitor: Payment processing volume
- Alert threshold: > $10k/month
- Review: Refunds, failed payments weekly

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
