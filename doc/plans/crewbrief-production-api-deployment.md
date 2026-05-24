# CrewBrief Express API — Production Deployment (Historical Reference)

> **This plan is superseded.** It proposed deploying CrewBrief as a standalone
> Express API on Railway. In production, CrewBrief runs as a co-located service
> within the main Paperclip server on the Hostinger VPS.
>
> See **ADR-002** (`doc/adr/crewbrief-deployment-architecture.md`) for the actual
> production deployment architecture.
>
> The `Dockerfile.crewbrief`, `railway.json`, and `.github/workflows/deploy-crewbrief-api.yml`
> remain in the repo as reference material for a potential future extraction to a
> standalone deployment, but are not currently used.

---

## Original Plan (2026-05-17)

The content below was the original Railway-centric deployment plan. It is preserved
for historical reference and as a starting point if CrewBrief is ever extracted to
a standalone service.

---

**Author:** Hunter — CTO
**Status:** Superseded
**Date:** 2026-05-17
**Issue:** CRE-628

---

### 1. Executive Summary

Deploy the CrewBrief Express API backend to production to serve the CrewBrief iOS app and Telegram briefing delivery scripts. The API is a Node.js + Express application using Drizzle ORM over PostgreSQL, sharing the Paperclip monorepo.

**Key requirements:**
- Serve mobile app (Expo/React Native) API requests
- Serve Telegram briefing delivery scripts
- Authenticated endpoints (JWT, per CRE-629 auth design)
- Aviation-grade reliability and monitoring
- SSL termination, secrets management, automated deployment

---

### 2. Architecture (Original)

```
                          ┌──────────────┐
                          │  Cloudflare   │
                          │  DNS + DDoS   │
                          └──────┬───────┘
                                 │
                          ┌──────┴───────┐
                          │   Railway     │
                          │  (or Fly.io)  │
                          │              │
                    ┌─────┴──────┬───────┘
                    │            │
            ┌───────┴──┐  ┌─────┴──────┐
            │  Express  │  │   Express  │
            │  API v1   │  │  API v2    │
            └───────┬──┘  └─────┬──────┘
                    │            │
                    └──────┬─────┘
                           │
                    ┌──────┴──────┐
                    │ PostgreSQL  │
                    │ (Managed)   │
                    └─────────────┘
```

### 2.1 Recommended Platform: Railway (Original)

| Criterion | Railway | Fly.io | AWS ECS |
|-----------|---------|--------|---------|
| Setup effort | Low | Low | High |
| Managed Postgres | ✅ Built-in | ✅ Built-in (needs app) | ✅ RDS |
| SSL termination | ✅ Automatic | ✅ Automatic | ✅ LB |
| Custom domain | ✅ | ✅ | ✅ |
| Container registry | ✅ Built-in | ✅ Built-in | ✅ ECR |
| Cost (estimated) | ~$10-20/mo | ~$15-25/mo | ~$30-50/mo |
| Build from monorepo | ⚠️ Needs Dockerfile context | ⚠️ Same | ✅ Flexible |

**Decision:** Use **Railway** for v1 — lowest ops overhead, built-in PostgreSQL, automatic HTTPS, and well-suited for a single-service Express API.

### 2.2 Alternative: Fly.io

If Railway's per-resource pricing becomes unfavorable or TLS termination flexibility is needed, **Fly.io** is the recommended alternative. Configuration differences are minimal (Dockerfile works on both).

---

### 3. Prerequisites (Before Deployment)

#### 3.1 Code Readiness

- [ ] Merge `fix/crewbrief-live-site` into `master` — all backend routes, services, and schema must be on master
- [ ] Drizzle migration files exist for all 5 tables (`briefing_feedback`, `briefing_quality`, `briefing_negative_rating_alerts`, `crew_rating_flags`, `re_review_queue`) and apply cleanly
- [ ] Tests pass: `pnpm test:run` with CrewBrief test suites
- [ ] Auth implementation (per CRE-629) completed and merged
- [ ] Typecheck: `pnpm -r typecheck` passes

#### 3.2 Infrastructure Pre-requisites

- [ ] Railway account created and billing configured
- [ ] Domain `api.crewbrief.app` (or `crewbrief.avva.aero`) DNS pointed to Railway (CNAME)
- [ ] `JWT_SECRET` generated (openssl rand -hex 64)
- [ ] `BETTER_AUTH_SECRET` generated (openssl rand -hex 32)
- [ ] Production PostgreSQL created (Railway managed or Supabase)

---

### 4. Dockerfile for CrewBrief API (Reference)

The existing monorepo Dockerfile is optimized for the full Paperclip server. For the CrewBrief API, create a slimmer Dockerfile at `Dockerfile.crewbrief`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY server/package.json server/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY patches/ patches/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/server build

FROM base AS production
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
```

**Key difference from main Dockerfile:** No UI build, no agent CLI installation, no UI serving — this is a pure API image.

---

### 5. Environment Configuration (Reference)

#### 5.1 Required Variables

| Variable | Source | Purpose |
|----------|--------|---------|
| `DATABASE_URL` | Railway Postgres | Drizzle connection string |
| `JWT_SECRET` | Generated, stored in Railway secrets | JWT signing |
| `JWT_EXPIRY` | Config | `15m` (default) |
| `REFRESH_TOKEN_EXPIRY` | Config | `7d` (default) |
| `BETTER_AUTH_SECRET` | Generated | Session encryption |
| `PAPERCLIP_DEPLOYMENT_MODE` | Config | `authenticated` |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | Config | `public` |
| `PAPERCLIP_PUBLIC_URL` | Domain | `https://api.crewbrief.app` |
| `NODE_ENV` | Railway | `production` |
| `PORT` | Railway | `3000` |
| `HOST` | Config | `0.0.0.0` |

#### 5.2 Optional Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `BETA_INVITE_CODE` | Gate registration | (empty = open) |
| `BCRYPT_ROUNDS` | Password hash cost | `12` |
| `LOG_LEVEL` | Pino/winston level | `info` |
| `SENTRY_DSN` | Error tracking | (empty = no sentry) |

---

### 6. Database (Reference)

#### 6.1 Managed PostgreSQL (Railway)

- Provision via Railway dashboard: `+ New > Database > PostgreSQL`
- Plan: Starter ($5/mo) — 1GB RAM, 10GB storage — sufficient for beta (10-20 operators)
- Connection string auto-injected into the API service via Railway's service linking
- Automatic daily backups (Railway default)

#### 6.2 Alternative: Supabase

If PostgreSQL management via Supabase is preferred (e.g., for the dashboard UI that exists for quality/feedback review):

- Use Supabase Postgres tier ($0-25/mo)
- Point `DATABASE_URL` to Supabase's pooled connection string
- Run migrations via `pnpm --filter @paperclipai/server db:migrate` in CI

#### 6.3 Migration Strategy

```sh
# Generate migration (local dev)
pnpm --filter @paperclipai/server db:generate

# Apply migration (CI/CD pipeline step)
pnpm --filter @paperclipai/server db:migrate
```

Migrations must run as the first step of the release process, before the new containers start, to ensure schema compatibility.

**Migration safety:**
- All migrations must be additive (no destructive column drops in v1)
- Use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` patterns for idempotency
- Rollbacks: keep the previous migration number, re-deploy the previous image if a rollback is needed

---

### 7. CI/CD Pipeline (Reference)

#### 7.1 GitHub Actions Workflow

File: `.github/workflows/deploy-crewbrief-api.yml`

```yaml
name: Deploy CrewBrief API

on:
  push:
    branches: [master]
    paths:
      - 'server/**'
      - 'packages/db/**'
      - 'packages/shared/**'
      - 'Dockerfile.crewbrief'
      - 'pnpm-lock.yaml'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r typecheck
      - run: pnpm --filter @paperclipai/server test:run

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to Railway
        run: npx railway up --service crewbrief-api
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
```

#### 7.2 Railway Configuration

- **Service name:** `crewbrief-api`
- **Deploy method:** GitHub repo (connect via Railway dashboard)
- **Build command:** `docker build -f Dockerfile.crewbrief -t crewbrief-api .`
- **Start command:** Railway auto-detects from Dockerfile CMD
- **Health check:** `GET /api/health` (endpoint to be created)
- **Automatic deploys:** On push to `master` (via GitHub integration)

---

### 8. Health Check Endpoint (Implemented)

Add a health check endpoint that Railway (or any load balancer) can probe:

```
GET /api/health
Response 200: { "status": "ok", "db": "connected", "uptime": 12345 }
Response 503: { "status": "error", "db": "disconnected" }
```

The health check should:
1. Verify database connectivity (run `SELECT 1`)
2. Return 503 if DB is unreachable
3. Include uptime and version info

> **Note:** The health endpoint exists on the main Paperclip server and is not
> CrewBrief-specific. It serves both Paperclip and CrewBrief health checks since
> they share the same process.

---

### 9. Monitoring & Observability (Reference)

#### 9.1 Application Monitoring

| Tool | Purpose | Cost |
|------|---------|------|
| Railway Logs | Built-in log streaming | Free |
| Sentry | Error tracking & performance | Free tier (5k events/mo) |
| Better Stack / Grafana | Uptime monitoring + status page | Free tier |

#### 9.2 Key Metrics to Track

- Request rate (req/s per endpoint)
- Error rate (5xx responses)
- p50/p95/p99 latency
- Database connection pool usage
- JWT auth failures
- Feedback submission rate
- Quality classification rate

#### 9.3 Alerts

- **P0:** API unreachable (5xx > 1% for 5 min)
- **P1:** Database connection pool exhaustion
- **P1:** Slow queries (>500ms p95)
- **P2:** Auth failure spike (>10/min)

---

### 10. Security (Implemented)

#### 10.1 Network

- Cloudflare in front of Railway for DDoS protection (optional in v1)
- Railway handles TLS termination automatically
- All inter-service communication uses TLS

> **Actual:** TLS is handled by nginx + Let's Encrypt on the VPS, not Railway.

#### 10.2 Secrets Management

- Railway encrypted environment variables for all secrets
- Never commit secrets to git (verified via `.gitignore` + pre-commit hook)
- Secrets rotated if a team member leaves

> **Actual:** Secrets are managed via `.env` file on the VPS, not Railway.

#### 10.3 Auth (Per CRE-629)

- JWT access tokens (15-min expiry) + refresh tokens (7-day, rotated)
- Refresh token reuse detection (compromise protection)
- bcrypt password hashing (cost 12)
- Rate-limit `/api/auth/login` (5 attempts/15min per IP/email)

#### 10.4 API Security Headers

```nginx
# Configured in nginx virtual host
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: default-src 'self'
```

---

### 11. Rollout Strategy (Historical)

#### Phase 1 — Staging/Preview

1. Deploy to a Railway preview environment (auto-created per PR via Railway PR deploys)
2. Verify against staging PostgreSQL
3. Run integration tests
4. Verify auth flow end-to-end (register → login → refresh → protected endpoint)

#### Phase 2 — Beta Production

1. Deploy to production Railway service
2. Migrate production database (additive migrations only)
3. Verify health endpoint
4. Test with a single operator (manual sign-up via login flow)
5. Monitor for 24 hours (error rates, latency, DB CPU)

#### Phase 3 — Full Rollout

1. Enable the deployed API in the CrewBrief iOS app (update `app.json` API URL)
2. Switch Telegram delivery scripts to use the production API URL
3. Monitor for 72 hours
4. Announce beta availability to operators

#### Rollback

- **Container rollback:** Railway supports one-click redeploy of a previous version
- **Database rollback:** If the last migration was additive, re-deploy the previous image against the same DB (new columns are ignored by old code). If the migration was destructive, restore from the nightly backup.

---

### 12. Cost Estimate (Historical)

| Resource | Estimate (Monthly) |
|----------|-------------------|
| Railway compute (1 vCPU, 512MB) | $5-10 |
| Railway PostgreSQL (Starter) | $5 |
| Sentry (Free tier) | $0 |
| Domain renewal | ~$1 |
| **Total** | **~$11-16/mo** |

> **Actual:** CrewBrief shares the existing VPS and PostgreSQL. The marginal cost
> of running CrewBrief on the existing infrastructure is approximately $0 (no
> additional compute or database resources required at current scale).

---

### 13. Operations Runbook (Historical Reference)

```sh
# View logs
railway logs --service crewbrief-api -n 100

# SSH into container (debugging)
railway shell --service crewbrief-api

# Run DB migration manually
railway run --service crewbrief-api "pnpm --filter @paperclipai/server db:migrate"

# Check service status
railway status --service crewbrief-api
```

> **Actual operations:** All services run via Docker Compose on the VPS. See
> ADR-002 for actual ops commands.

### Incident Response (Adapted)

1. **API down:** SSH to VPS → `docker compose logs server` → check container status → `docker compose restart server`
2. **DB connection full:** Check connection pool config → increase `pool.max` → restart server container
3. **Auth failures:** Check `JWT_SECRET` hasn't been rotated → verify clock sync
4. **High latency:** Check VPS CPU/memory → `docker stats` → check for slow queries via DB logs

### Backup Verification

- PostgreSQL `pg_dump` via VPS cron job
- Verify backup integrity weekly by restoring to a local Docker instance
- Export a monthly SQL dump to offsite storage

---

### 14. Next Steps (Historical)

| # | Action | Owner | Depends On |
|---|--------|-------|------------|
| 1 | Merge `fix/crewbrief-live-site` into master | Engineering | — |
| 2 | Implement JWT auth (per CRE-629) | Engineering | #1 |
| 3 | Create `Dockerfile.crewbrief` | Engineering | #1 |
| 4 | Add `/api/health` endpoint | Engineering | #1 |
| 5 | Create Railway project + PostgreSQL | Ops | — |
| 6 | Set up GitHub Actions deploy workflow | Engineering | #3, #5 |
| 7 | DNS: point `api.crewbrief.app` → Railway | Ops | #5 |
| 8 | Seed production database (run migrations) | Engineering | #5 |
| 9 | Deploy to Railway preview (staging) | Engineering | #6 |
| 10 | Staging verification + integration tests | Engineering + QA | #9 |
| 11 | Deploy to production | Engineering | #10 |
| 12 | Verify production health + run e2e smoke | Engineering | #11 |
| 13 | Update iOS app to point at production API | Engineering | #11 |
| 14 | Switch Telegram scripts to production API | Engineering | #11 |

> **Actual:** Steps 5+ (Railway-specific) were never executed. The CrewBrief API
> was deployed by running the existing Paperclip Docker Compose stack on the VPS
> with `CREWBRIEF_*` environment variables configured.

---

### 15. Verification Gates (Historical)

Before marking this plan complete and moving to implementation:

- [ ] Code merged to master
- [ ] Auth implemented and tested
- [ ] Dockerfile.crewbrief builds and runs
- [ ] Health endpoint responds
- [ ] Railway project created
- [ ] CI/CD pipeline deploys successfully
- [ ] DNS resolves
- [ ] Production migration runs cleanly
- [ ] End-to-end smoke test passes (app → API → DB → response)
