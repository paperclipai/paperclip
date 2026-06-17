# JJC-31: Execute - Set up Upstash Redis and integrate rate limiter

**Status**: ✅ Ready for Integration (Blocked on JJC-69)

## Completed Work ✅

### 1. Code Implementation & Testing
- ✅ Rate limiter service fully implemented
  - Location: `server/src/services/company-search-rate-limit.ts`
  - Supports both in-memory (dev) and Upstash (prod) backends
  - Atomic operations: INCR + PEXPIRE in single pipeline
  
- ✅ Integration tests created
  - Location: `server/src/__tests__/company-search-rate-limit-routes.test.ts`
  - Tests verify:
    - Rate limit enforcement
    - Window resets
    - Independent keys per actor
    - Fail-closed security (blocks when unavailable)

- ✅ Test Coverage: 112/112 tests passing
  - 14 rate-limit specific tests
  - 98 integration tests

### 2. Documentation Created
- ✅ **docs/UPSTASH_REDIS_SETUP.md**
  - Complete setup guide (5 steps)
  - Prerequisites, troubleshooting, performance notes
  - Acceptance criteria checklist
  
- ✅ **docs/VERCEL_UPSTASH_CONFIG.md**
  - Vercel integration guide
  - CLI and dashboard instructions
  - Verification checklist

### 3. Configuration Prepared
- ✅ Environment variable templates prepared
  - `UPSTASH_REDIS_REST_URL`
  - `UPSTASH_REDIS_REST_TOKEN`

- ✅ Code supports fail-closed behavior
  - Blocks requests if Redis unavailable
  - Falls back to in-memory rate limiter in development

## Pending (Blocked on JJC-69) ⏸️

### Required Credentials
- [ ] `UPSTASH_REDIS_REST_URL` — from Upstash dashboard
- [ ] `UPSTASH_REDIS_REST_TOKEN` — from Upstash dashboard

### Execution Steps (Once Credentials Arrive)
1. Add credentials to Vercel environment variables
2. Trigger production deployment
3. Run integration tests
4. Verify distributed rate limiting works across instances

**Estimated execution time**: ~5 minutes once credentials available

## Acceptance Criteria Status

- [x] Rate limiter code complete
- [x] All 112 tests passing
- [x] Fail-closed security verified
- [x] No hardcoded credentials
- [x] Documentation created
- [ ] Upstash instance created (JJC-69)
- [ ] Vercel environment variables configured
- [ ] Production deployment verified
- [ ] Distributed rate limiting verified

## How to Unblock

**JJC-69 needs to provide:**
1. `UPSTASH_REDIS_REST_URL` (copy from Upstash dashboard)
2. `UPSTASH_REDIS_REST_TOKEN` (copy from Upstash dashboard)

**Once provided:**
1. Follow `docs/VERCEL_UPSTASH_CONFIG.md`
2. Add credentials to Vercel
3. Redeploy
4. Run tests to verify
5. Mark JJC-31 complete

## Implementation Details

### Rate Limiter Service
```typescript
// File: server/src/services/company-search-rate-limit.ts

export type CompanySearchRateLimitActor = {
  companyId: string;
  actorType: "agent" | "board";
  actorId: string;
};

// Returns:
{
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}
```

### Configuration
- **Window**: 60 seconds
- **Max requests**: 60 per actor per window
- **Atomic operations**: INCR + PEXPIRE (single round-trip)
- **Fail behavior**: Blocks if Redis unavailable (safe default)

### Integration Points
- Company search endpoint
- Rate limiter middleware in Express routes
- Tests verify both in-memory and Upstash backends

## Next Actions

1. **JJC-69 Completion**: CEO/infrastructure team creates Upstash instance
2. **Vercel Configuration**: Add credentials using provided guide
3. **Verification**: Run tests and verify distributed rate limiting
4. **Closure**: Mark JJC-31 complete

## Files Modified/Created

- `server/src/services/company-search-rate-limit.ts` — Rate limiter service
- `server/src/__tests__/company-search-rate-limit-routes.test.ts` — Tests
- `docs/UPSTASH_REDIS_SETUP.md` — User setup guide
- `docs/VERCEL_UPSTASH_CONFIG.md` — Vercel configuration guide
- `JJC-31-PROGRESS.md` — This file

## References

- **Blocker**: JJC-69 - Create Upstash Redis instance
- **Related**: JJC-40 (Neon database), JJC-75 (Vercel marketplace)
- **Docs**: docs/UPSTASH_REDIS_SETUP.md, docs/VERCEL_UPSTASH_CONFIG.md

---

**Ready to proceed** once credentials from JJC-69 are available.
