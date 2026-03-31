---
title: SaaS Beta Deployment
summary: Staged invite-only rollout for app.tye.ai
---

This guide sets Paperclip for an internet-facing invite-only SaaS beta.

## Topology

- Marketing site: `https://tye.ai`
- Product app/api: `https://app.tye.ai`
- SaaS control/admin: `https://control.tye.ai`
- Runtime mode: `authenticated` + `public`
- DB: Neon Postgres (`DATABASE_URL`)
- Storage: Cloudflare R2 (`PAPERCLIP_STORAGE_PROVIDER=s3`)
- Edge: Cloudflare DNS/TLS/WAF/rate limits

## Required server env

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=public
PAPERCLIP_AUTH_BASE_URL_MODE=explicit
PAPERCLIP_AUTH_PUBLIC_BASE_URL=https://app.tye.ai
HOST=0.0.0.0
BETTER_AUTH_SECRET=<strong secret>
GOOGLE_CLIENT_ID=<google oauth client id>
GOOGLE_CLIENT_SECRET=<google oauth client secret>
MICROSOFT_CLIENT_ID=<microsoft app client id>
MICROSOFT_CLIENT_SECRET=<microsoft app client secret>
PAPERCLIP_SECRETS_STRICT_MODE=true
PAPERCLIP_SAAS_CONTROL_TOKEN=<internal shared token>
DATABASE_URL=<neon postgres url>
PAPERCLIP_STORAGE_PROVIDER=s3
PAPERCLIP_STORAGE_S3_BUCKET=<r2 bucket>
PAPERCLIP_STORAGE_S3_REGION=auto
PAPERCLIP_STORAGE_S3_ENDPOINT=<r2 endpoint>
PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE=true
```

OAuth redirect URIs to configure:

- Google: `https://app.tye.ai/api/auth/callback/google`
- Microsoft (Entra Web redirect URI): `https://app.tye.ai/api/auth/callback/microsoft`

## Deploy gate

Use the deploy gate before each release:

```sh
bash scripts/deploy-gate.sh
```

The release must stop if `pnpm paperclipai doctor` fails.

## Internal SaaS control APIs

New internal endpoints are mounted under `/api/internal` and authenticated by bearer token:

- `POST /api/internal/companies/provision`
- `POST /api/internal/companies/:companyId/provision-runner`
- `POST /api/internal/companies/:companyId/deactivate`

Set `PAPERCLIP_SAAS_CONTROL_TOKEN` and send `Authorization: Bearer <token>`.

The external `saas-control` service proxies these for waitlist/beta ops:

- `POST /waitlist`
- `GET /admin/waitlist`
- `POST /admin/waitlist/:id/approve`
- `POST /admin/waitlist/:id/resend-invite`

## Provider onboarding UI

Company-level BYOK onboarding is available at:

- `/<companyPrefix>/onboarding/connect-providers`

It validates and stores `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` as encrypted secret refs.
