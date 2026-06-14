# Compliance & Billing Technical Scaffolding

## Overview

This directory contains the legal, privacy, billing, and compliance
infrastructure for the AI Code Review Platform.

## Structure

- `privacy/` — Data deletion endpoints, GDPR/CCPA request handlers,
  privacy policy templates
- `billing/` — Stripe integration, subscription plans, metering,
  invoicing logic
- `terms/` — Terms of service, DPA, SLA templates (to be reviewed
  by legal counsel)
- `audit/` — Immutable audit log schema, retention config,
  admin action tracking

## Billing Integration

### Stripe Setup

Required environment variables:
- `STRIPE_SECRET_KEY` — Live/Test secret key
- `STRIPE_WEBHOOK_SECRET` — Webhook signing secret
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — Public key for frontend

### Subscription Plans

| Plan     | Reviews/mo | Seats | Price     |
|----------|------------|-------|-----------|
| Free     | 100        | 5     | $0        |
| Pro      | 10,000     | 25    | $99/mo    |
| Team     | 50,000     | 100   | $299/mo   |
| Enterprise | Custom   | Custom| Custom    |

### Metering

- Usage tracked per-org in `billing_usage` table
- Counter increments on review completion
- Hard cap enforced by API Gateway (returns 429 with
  `X-RateLimit-Reset` header)
- Soft cap triggers email notification at 80% usage

## Privacy & Data Retention

- **Default retention:** 90 days for code diffs and review artifacts
- **Configurable:** Org admins can set 30/60/90/180 day retention
- **Deletion:** `DELETE /v1/account/data` triggers async purge of
  all org data within 24 hours
- **GDPR export:** `GET /v1/account/export` returns JSON archive
  of all stored user data

## Compliance Targets

- SOC 2 Type II: Target certification within 12 months of launch
- GDPR: Compliant from day one (data model supports deletion,
  export, DPA)
- CCPA: Compliant from day one (opt-out tracking, data deletion)
- ISO 27001: Target within 18 months (post-SOC 2)
