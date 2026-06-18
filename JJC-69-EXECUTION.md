# JJC-69: Create Upstash Redis instance and provide credentials

**Task**: Create Upstash Redis database and provide REST credentials to JJC-31

**Status**: Ready to execute

## Quick Summary

This task unblocks **JJC-31** (rate limiter integration). We need to:
1. ✅ Create Upstash Redis instance
2. ✅ Get REST API credentials
3. ✅ Provide credentials to JJC-31

**Estimated time**: ~5 minutes

## Option A: Manual Setup (Recommended for First Time)

### Step 1: Create Upstash Account

1. Go to https://upstash.com
2. Click **Sign Up**
3. Use email or OAuth to create account
4. Verify email if needed

### Step 2: Create Redis Database

1. From dashboard, click **Create Database**
2. Configure:
   - **Name**: `pulse-redis`
   - **Region**: `us-east-1` (or closest to your deployment)
   - **Type**: Redis
3. Click **Create**
4. Wait for database to be "Running" (~30 seconds)

### Step 3: Get REST API Credentials

1. Open your `pulse-redis` database
2. Click **REST API** tab
3. Copy both values:

```
UPSTASH_REDIS_REST_URL=https://YOUR-HASH.upstash.io
UPSTASH_REDIS_REST_TOKEN=YOUR_TOKEN_HERE
```

### Step 4: Verify Connection

```bash
# Test the endpoint
curl -X GET https://YOUR-HASH.upstash.io/ping \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"

# Expected response: {"result":"PONG"}
```

### Step 5: Add to Environment

Local development:
```bash
# .env
UPSTASH_REDIS_REST_URL=https://YOUR-HASH.upstash.io
UPSTASH_REDIS_REST_TOKEN=YOUR_TOKEN_HERE
```

Then test locally:
```bash
pnpm test -- rate-limit
```

## Option B: Automated Setup (Advanced)

If you have Upstash Management API access:

```bash
# Get your API key from: https://upstash.com/docs/management-api
export UPSTASH_API_KEY="your-management-api-key"

# Create database via API
curl -X POST https://api.upstash.com/v1/redis/databases \
  -H "Authorization: Bearer $UPSTASH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "pulse-redis",
    "region": "us-east-1",
    "database_type": "pay_as_you_go"
  }'

# Response includes REST credentials
```

## Troubleshooting

### Can't Create Account
- Try OAuth (Google, GitHub) as alternative
- Check spam folder for verification email

### Database Creation Fails
- Verify region is available
- Check account billing status
- Try a different region (e.g., `eu-west-1`)

### Can't Copy Credentials
- Refresh the page
- Try incognito/private browsing
- Clear browser cache

### REST API Test Returns 401
- Verify token is complete (no truncation)
- Check URL format (should start with `https://`)
- Regenerate token in dashboard if needed

## What to Provide to JJC-31

Once you have credentials, provide:

```
UPSTASH_REDIS_REST_URL=https://YOUR-HASH.upstash.io
UPSTASH_REDIS_REST_TOKEN=YOUR_TOKEN_HERE
```

These will be added to:
- Local `.env` for development
- Vercel environment variables for production

## Acceptance Criteria

- [ ] Upstash account created
- [ ] Redis database created (name: `pulse-redis`)
- [ ] Database status: Running
- [ ] REST credentials obtained
- [ ] Credentials verified (ping test passes)
- [ ] Credentials provided to JJC-31
- [ ] JJC-31 can integrate and deploy

## Security Notes

⚠️ **The REST token is sensitive!**
- Don't commit to git
- Don't share in public channels
- Treat like a password
- Can be rotated in Upstash dashboard if exposed

## Next Steps After Completion

1. Comment on JJC-31 with credentials
2. JJC-31 will:
   - Add to Vercel environment variables
   - Deploy to production
   - Run tests
   - Verify rate limiting works

3. Mark JJC-69 complete
4. Rate limiter will be live! ✅

## Related Documentation

- Setup guide: `docs/UPSTASH_REDIS_SETUP.md`
- Vercel config: `docs/VERCEL_UPSTASH_CONFIG.md`
- Rate limiter code: `server/src/services/company-search-rate-limit.ts`

## Reference Links

- Upstash: https://upstash.com
- REST API Docs: https://upstash.com/docs/redis/features/rest-api
- Management API: https://upstash.com/docs/management-api

---

**Status**: Ready to execute  
**Blocked by**: None (ready to go!)  
**Blocking**: JJC-31 (rate limiter integration)

**Recommendation**: Start with Option A (manual setup) — it's faster and gives you familiarity with the Upstash dashboard.
