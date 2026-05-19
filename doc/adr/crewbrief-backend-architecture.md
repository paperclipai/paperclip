# ADR-001: CrewBrief Backend Architecture

**Date:** 2026-05-17
**Status:** Pending Confirmation (confirmation ccb16224 expired 2026-05-18; fresh confirmation created)
**Author:** Hunter (CTO)

## Context

CrewBrief is a permanent production application for aviation crew briefing delivery. It currently exists as a set of Express API routes and services within the existing Paperclip monorepo server package, plus an Expo/React Native iOS app.

Before proceeding with irreversible infrastructure decisions (production hosting, DNS, database migrations, App Store submission), decide the long-term backend architecture.

## Decision Drivers

| Driver | Requirement |
|--------|-------------|
| Long-term maintainability | Must be supportable by a small team for 3+ years |
| Cost | Monthly infra < $100 at launch, predictable at scale |
| Secrets handling | No secrets in git, env, or build artifacts |
| Database ownership | Full control of schema, migrations, backups |
| Monitoring | Crash reporting, uptime, performance alerting |
| Scaling | Handle 50 → 50,000 users without rearchitecture |
| Vendor lock-in | Avoid proprietary platforms that prevent migration |
| Fit with existing architecture | Should align with the existing Paperclip/AvvA stack |
| Whether a separate API is needed | Must justify a separate long-running service |

## Options

### Option 1: Supabase-Centered Architecture

Migrate CrewBrief backend logic to Supabase using Edge Functions, Database Functions, Row-Level Security, and Supabase Auth.

**Pros:**
- Managed PostgreSQL with automatic backups
- Built-in auth (Supabase Auth, magic links, OAuth)
- Row-Level Security for data access control
- Edge Functions for API endpoints (Deno-based)
- Realtime subscriptions built-in
- Generous free tier ($0/month to start)
- Less infrastructure to manage

**Cons:**
- **Requires full rewrite** of all existing Express routes and services (crewbrief.ts, nurture, email, HubSpot, PostHog, blog)
- Edge Functions run Deno, not Node.js — cannot reuse any existing code from the monorepo
- No Drizzle ORM — must use raw SQL or Supabase JS client
- No Express middleware ecosystem (rate limiting, validation, auth middleware all built from scratch)
- **No existing team expertise** — the entire Paperclip stack is Express/Drizzle/PostgreSQL
- Vendor lock-in to Supabase-specific features (Edge Functions RLS, Realtime, Auth)
- Background job scheduling (cron, email nurture sequences) must be handled externally
- Blog engine (Markdown → HTML) needs separate solution
- Email delivery (Resend/SMTP) needs separate integration
- HubSpot CRM sync needs separate integration
- **Does not simplify the architecture** — would still need external services for email, CRM, analytics

**Cost:** $0–$25/month (free tier + small compute)

### Option 2: Dedicated Express API on Railway (Recommended)

Deploy the Express 5 API to Railway as a standalone service using the existing `Dockerfile.crewbrief`, with direct PostgreSQL on Railway or a managed provider.

**Pros:**
- **Zero rewrite** — all existing routes, services, middleware, and schema run as-is
- Full Express 5 ecosystem (rate limiting, validation, auth middleware)
- Drizzle ORM with existing schema definitions and migration pipeline
- Railway provides: PostgreSQL, secrets management, CI/CD (GitHub integration), automatic HTTPS, custom domains
- Secrets stored in Railway's encrypted secrets store (not in git)
- Existing Secrets provider abstraction (`local_encrypted`, `aws_secrets_manager`) works with minimal config
- Dockerfile.crewbrief already exists and builds a slim API-only image
- Can reuse the monorepo's `@paperclipai/db` package, shared types, and validation schemas
- Team has deep experience with this stack
- **No vendor lock-in** — Railway containers a standard Docker image; can migrate to Fly.io, Render, or any Docker host with a config change
- Background job scheduling via Railway Cron Jobs or external cron service (EasyCron, cron-job.org)
- Blog engine, email, HubSpot, analytics all work without changes

**Cons:**
- Must manage own PostgreSQL (backups, performance, upgrades)
- No built-in auth — must implement JWT auth (already planned in Phase 1)
- No built-in RLS — access control is in application code (already the case)
- Railway costs more than Supabase free tier (~$5–$10/month for starter + PostgreSQL)
- Requires Docker expertise (already have Dockerfile)
- Must set up monitoring externally (Sentry, uptime monitoring)

**Cost:** ~$10–$20/month (Railway Starter + PostgreSQL)

### Option 3: Dedicated Express API on Alternative Platform (Fly.io / Render / AWS)

Same architecture as Option 2 but hosted on Fly.io, Render, or AWS ECS/Fargate.

**Fly.io Pros:**
- Global edge deployment (low latency worldwide)
- Built-in PostgreSQL with automatic failover
- WireGuard VPN for private networking
- Docker containers with fast deploy

**Render Pros:**
- Simple deployment from GitHub (zero Docker config needed)
- Managed PostgreSQL, Redis, cron jobs
- Automatic HTTPS, custom domains
- Predictable pricing

**AWS Pros:**
- Ultimate control over infrastructure
- Full ecosystem (RDS for PostgreSQL, Secrets Manager, CloudWatch, ECS)
- Maximum scalability

**Cons (all alternatives):**
- Still need to set up monitoring, alerting, backups externally
- Fly.io and Render lock-in similar to Railway (Docker-based, easy to migrate)
- AWS is significantly more complex to manage (IAM, VPC, subnets, security groups)
- AWS costs more at small scale (RDS alone is ~$15/month minimum)
- No significant advantage over Railway for this use case

**Cost:** Fly.io ~$10–$20/month, Render ~$7–$15/month, AWS ~$25–$50/month

## Recommendation: Option 2 — Dedicated Express API on Railway

### Rationale

CrewBrief **does** need a long-running Express API for the following reasons:

1. **Email nurture sequences** — scheduled background processing (daily cron for 1,000+ users, trigger-based sends) requires a persistent process
2. **HubSpot CRM sync** — maintains connection state, handles webhooks, manages rate limits
3. **Blog engine** — on-demand Markdown rendering at request time
4. **Future briefing delivery** — the core product involves fetching, processing, and delivering structured aviation data, which benefits from server-side orchestration
5. **Multi-tenant data access** — application-level auth and data isolation is better handled in Express middleware than in RLS policies (more testable, debuggable, portable)

A Supabase-centered approach would require building or integrating all of the above externally or rewriting them in Deno Edge Functions, negating any infrastructure simplicity gains.

### What Should Live in Supabase

Supabase (or just managed PostgreSQL) should serve as the **database layer only**:
- PostgreSQL database for all CrewBrief data
- Drizzle ORM manages schema and migrations
- No Supabase Edge Functions, RLS, Auth, or Realtime

The existing Supabase Edge Function (`chase-telegram`) is unrelated to CrewBrief and can remain as-is.

### Architecture Summary

```
┌─────────────────────────────────────────────────────┐
│                  Railway Platform                     │
│                                                      │
│  ┌──────────────────────────────────────────┐       │
│  │   Docker Container (Dockerfile.crewbrief) │       │
│  │                                          │       │
│  │  Express 5 API (Node.js / TypeScript)    │       │
│  │  ┌────────────────────────────────────┐  │       │
│  │  │ Existing CrewBrief routes/services │  │       │
│  │  │ Drizzle ORM + PostgreSQL client    │  │       │
│  │  │ JWT Auth (Phase 1)                │  │       │
│  │  │ Sentry monitoring (Phase 4)       │  │       │
│  │  └────────────────────────────────────┘  │       │
│  │                                          │       │
│  │  Secrets: Railway Encrypted Store        │       │
│  │  Domain: api.crewbrief.app               │       │
│  └──────────────────────────────────────────┘       │
│                                                      │
│  ┌──────────────────────────────────────────┐       │
│  │   Railway PostgreSQL                      │       │
│  │   (Daily automated backups)               │       │
│  └──────────────────────────────────────────┘       │
│                                                      │
│  ┌──────────────────────────────────────────┐       │
│  │   Railway Cron (daily email processing)   │       │
│  └──────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────┘
```

### Migration Path from Current State

Current state: CrewBrief routes/services live in the main Paperclip server alongside all other Paperclip functionality. The plan is:

1. **Phase 0 (now):** Merge all CrewBrief code to master, verify migrations, fix type issues. No hosting changes.
2. **Phase 1 (next):** Add JWT auth to the existing CrewBrief routes. Still within the main server.
3. **Phase 2:** Deploy a separate CrewBrief API service using Dockerfile.crewbrief to Railway. At launch, both the main server and CrewBrief API can share the same PostgreSQL database (separate schema namespaces). This gives the option to split to a dedicated database later if needed.

This phased approach avoids premature separation while keeping the option open.

### Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Railway goes out of business | Docker container is portable to Fly.io, Render, or any Docker host. No Railway-specific APIs used. |
| Database size exceeds Railway plan | PostgreSQL is standard; can migrate to RDS, Supabase, or any PostgreSQL provider. Drizzle ORM abstracts the connection. |
| Need to scale beyond single container | Docker image can run behind any load balancer. Express is stateless (auth tokens in JWTs). |
| Secrets management | Railway encrypted secrets store + existing Secrets provider abstraction supports migration to AWS Secrets Manager. |
