# Upstash Redis Setup Guide

This guide walks through setting up Upstash Redis for distributed rate limiting across Paperclip's serverless instances.

## Overview

Paperclip uses Upstash Redis (REST API) for:
- **Distributed rate limiting** across multiple serverless instances
- **Atomicity**: INCR + PEXPIRE operations in a single pipeline
- **Fail-closed security**: rate limiter blocks requests when Redis is unavailable
- **Zero setup overhead**: REST API, no connection pooling needed

## Prerequisites

- Upstash account (free tier available)
- Vercel project (for deployment)
- Node.js 20+

## Step 1: Create Upstash Account

1. Go to https://upstash.com
2. Sign up or log in
3. Navigate to **Databases**

## Step 2: Create Redis Database

1. Click **Create Database**
2. Configure:
   - **Name**: `pulse-redis` (or your preferred name)
   - **Region**: Select closest to your deployment (e.g., `us-east-1`)
   - **Type**: Redis
   - **Eviction**: Not required for rate limiting
3. Click **Create**

## Step 3: Get REST Credentials

1. Open your newly created database
2. Click **REST API** tab
3. Copy these two values:
   - **UPSTASH_REDIS_REST_URL** - The full REST endpoint URL
   - **UPSTASH_REDIS_REST_TOKEN** - The authentication token

Example format:
```
UPSTASH_REDIS_REST_URL=https://YOUR-HASH.upstash.io
UPSTASH_REDIS_REST_TOKEN=YOUR_TOKEN_HERE
```

⚠️ **Important**: Treat the token like a password. Don't commit it to git.

## Step 4: Add to Environment Variables

### Local Development (.env)

Create or update `.env`:

```bash
# .env (local development)
UPSTASH_REDIS_REST_URL=https://YOUR-HASH.upstash.io
UPSTASH_REDIS_REST_TOKEN=YOUR_TOKEN_HERE
```

### Vercel Deployment

Add environment variables via Vercel dashboard or CLI:

```bash
# Using Vercel CLI
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN

# Mark token as Secret for security
```

Set for **all environments** (Production, Preview, Development).

## Step 5: Verify Integration

Run tests to verify rate limiting works:

```bash
# Run rate limiter tests
pnpm test -- rate-limit

# Expected output:
# ✓ rate-limit tests pass
# ✓ Upstash integration verified
```

## Rate Limiter Configuration

The rate limiter is configured in `server/src/services/company-search-rate-limit.ts`:

- **Window**: 60 seconds
- **Max requests**: 60 per actor
- **Fallback**: In-memory when Redis unavailable (dev mode)

### Environment Variables

```
UPSTASH_REDIS_REST_URL    - REST endpoint
UPSTASH_REDIS_REST_TOKEN  - Authentication token
NODE_ENV                  - Set to "production" for Upstash (dev uses in-memory)
```

## Testing Distributed Rate Limiting

To verify rate limiting works across multiple instances:

```bash
# 1. Deploy to Vercel with credentials
vercel deploy

# 2. Run integration tests
pnpm test:run

# 3. Monitor rate limiter in action
# - Make 60+ requests in 60 seconds
# - Verify request 61+ are blocked
# - Check retry-after header
```

## Troubleshooting

### Connection Refused / Network Error

**Problem**: `ECONNREFUSED` or `ENOTFOUND`

**Solution**:
1. Verify REST URL is correct (should start with `https://`)
2. Check token is complete (no truncation)
3. Ensure Upstash database status is "Running"
4. Verify firewall/network allows HTTPS outbound

### Rate Limiting Not Working

**Problem**: Requests aren't being rate limited

**Solution**:
1. Verify `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set
2. Check `NODE_ENV` is `production` (required for Upstash)
3. Run `pnpm test -- rate-limit` to verify integration
4. Check Upstash dashboard for database activity

### Token Exposed in Logs

**Problem**: Token appears in error messages or logs

**Solution**:
1. Rotate the token immediately in Upstash dashboard
2. Mark the environment variable as "Secret" in Vercel
3. Review logs for exposure
4. Update the token in all environments

## Performance Notes

- **REST API Latency**: ~50-100ms per operation
- **Atomic Operations**: INCR + PEXPIRE in single round-trip
- **Fail-Closed**: Blocks requests if Redis unavailable (safe default)
- **Cost**: Free tier includes 10,000 commands/day (sufficient for most use cases)

## Acceptance Criteria Checklist

- [ ] Upstash Redis database created (us-east-1 region)
- [ ] REST credentials copied to environment
- [ ] Rate limiter tests passing (14/14)
- [ ] Integration tests passing (112/112)
- [ ] Vercel environment variables configured
- [ ] Production deployment verified
- [ ] Rate limiting blocks requests correctly
- [ ] No hardcoded credentials in source code

## Related Tasks

- **JJC-69**: Create Upstash Redis instance
- **JJC-40**: Database setup (Neon)
- **JJC-75**: Vercel marketplace terms acceptance

## References

- Upstash Docs: https://upstash.com/docs
- Rate Limiter Implementation: `server/src/services/company-search-rate-limit.ts`
- Tests: `server/src/__tests__/company-search-rate-limit-routes.test.ts`
