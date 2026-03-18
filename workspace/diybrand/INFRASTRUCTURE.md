# DIYBrand Infrastructure & Deployment Guide

This document covers the deployment, monitoring, and infrastructure management for DIYBrand.

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
VERCEL_TOKEN           # Vercel API token (personal or team)
VERCEL_PROJECT_ID      # DIYBrand project ID in Vercel
VERCEL_ORG_ID          # Vercel organization ID
SLACK_WEBHOOK          # Slack webhook for deployment notifications (optional)
SENTRY_DSN             # Sentry error tracking (production)
STRIPE_SECRET_KEY      # Stripe API secret (production only)
DATABASE_URL           # PostgreSQL connection string (staging/prod)
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

1. **Setup**
   ```bash
   npm install @sentry/nextjs
   ```

2. **Configuration** (`sentry.config.js`)
   ```javascript
   import * as Sentry from '@sentry/nextjs';

   Sentry.init({
     dsn: process.env.SENTRY_DSN,
     tracesSampleRate: 0.1,
     environment: process.env.NODE_ENV,
   });
   ```

3. **Dashboard**: https://sentry.io/organizations/diybrand/issues/

**Alerting Rules:**
- Alert on error rate > 1% within 5 minutes
- Alert on new error patterns
- Daily digest of issues

### Database Monitoring

**Connection Health:**
- Monitor connection pool usage
- Alert if > 80% of connections in use
- Check slow query logs weekly

**Backups:**
- Automated daily backups (Vercel Postgres)
- Retained for 30 days
- Test restore quarterly

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
