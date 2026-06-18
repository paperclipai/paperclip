# Vercel Upstash Configuration Guide

Once Upstash Redis instance is created (JJC-69), use this guide to configure Vercel.

## Quick Setup (3 steps)

### Step 1: Get Credentials from Upstash

From your Upstash Redis database dashboard:
1. Click **REST API** tab
2. Copy:
   - `UPSTASH_REDIS_REST_URL` (full REST endpoint)
   - `UPSTASH_REDIS_REST_TOKEN` (authentication token)

### Step 2: Add to Vercel via Dashboard

1. Go to your Vercel project: https://vercel.com/dashboard
2. Click **Settings** → **Environment Variables**
3. Add two new variables:

**Variable 1:**
```
Name: UPSTASH_REDIS_REST_URL
Value: https://YOUR-HASH.upstash.io
Environment: Production, Preview, Development
```

**Variable 2:**
```
Name: UPSTASH_REDIS_REST_TOKEN
Value: YOUR_TOKEN_HERE
Environment: Production, Preview, Development
✓ Mark as "Secret" for security
```

### Step 3: Deploy & Verify

1. Trigger a new deployment:
   ```bash
   vercel deploy --prod
   ```

2. Verify rate limiting works:
   ```bash
   # Run tests
   pnpm test:run
   
   # Expected: All tests pass
   ```

## CLI Alternative

If you prefer command line:

```bash
# Login to Vercel
vercel login

# Add environment variables
vercel env add UPSTASH_REDIS_REST_URL
# Paste: https://YOUR-HASH.upstash.io

vercel env add UPSTASH_REDIS_REST_TOKEN
# Paste: YOUR_TOKEN_HERE

# Deploy
vercel deploy --prod
```

## Verification Checklist

- [ ] Both environment variables added to Vercel
- [ ] Token marked as "Secret"
- [ ] Set for all environments (Production, Preview, Development)
- [ ] New deployment triggered
- [ ] Tests passing in Vercel logs
- [ ] Rate limiter working (make 60+ requests, verify blocking)

## Troubleshooting

### Deployment Still Shows Old Env Vars

**Solution**: 
1. Verify variables are saved in Vercel dashboard
2. Force a new deployment (don't use cached one)
3. Check deployment logs for environment variable loading

### Rate Limiting Not Active

**Solution**:
1. Confirm `NODE_ENV=production` is set
2. Verify token is marked as Secret
3. Check Upstash dashboard for connection errors
4. Review Vercel deployment logs

### Token Appears in Logs

**Solution**:
1. Rotate the token in Upstash immediately
2. Update Vercel environment variable
3. Redeploy

## Acceptance Criteria

- [x] Documentation created (this file)
- [ ] Upstash credentials obtained (JJC-69)
- [ ] Vercel environment variables configured
- [ ] Production deployment verified
- [ ] Rate limiting tests passing
- [ ] Distributed rate limiting verified across instances

## Next Steps

1. Complete JJC-69 to get credentials
2. Follow this guide to add credentials to Vercel
3. Verify rate limiting in production
4. Mark JJC-31 complete

---

**Related**: JJC-31, JJC-69, docs/UPSTASH_REDIS_SETUP.md
