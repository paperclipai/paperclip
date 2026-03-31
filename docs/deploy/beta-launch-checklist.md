---
title: Beta Launch Checklist
summary: Minimum steps to start sending waitlist and beta invites
---

## 1) Deploy app and control planes

- Deploy Paperclip (`app.tye.ai`) using `fly.prod.toml`.
- Deploy SaaS control (`control.tye.ai`) using `saas-control/fly.toml`.
- Ensure Cloudflare DNS/WAF/TLS are active for both hosts.

## 2) Set required secrets

Paperclip:

- `DATABASE_URL` (Neon)
- `BETTER_AUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `PAPERCLIP_SAAS_CONTROL_TOKEN`
- `PAPERCLIP_AUTH_PUBLIC_BASE_URL=https://app.tye.ai`
- `PAPERCLIP_SECRETS_STRICT_MODE=true`
- R2 env (`PAPERCLIP_STORAGE_S3_*`)

OAuth redirect URIs:

- Google: `https://app.tye.ai/api/auth/callback/google`
- Microsoft: `https://app.tye.ai/api/auth/callback/microsoft`

SaaS control:

- `PAPERCLIP_API_BASE_URL=https://app.tye.ai`
- `PAPERCLIP_INTERNAL_TOKEN=<same as PAPERCLIP_SAAS_CONTROL_TOKEN>`
- `SAAS_CONTROL_ADMIN_TOKEN=<admin token>`
- `APP_PUBLIC_BASE_URL=https://app.tye.ai`
- `RESEND_API_KEY`
- `INVITE_FROM_EMAIL`

## 3) Smoke checks

- `https://app.tye.ai/api/health` returns `status: ok`.
- `https://control.tye.ai/health` returns `status: ok`.
- Sign up/sign in works at `https://app.tye.ai/login` and `https://app.tye.ai/signup`.
- Waitlist submit works from `/waitlist/`.
- Approving one waitlist record creates company invite and sends email.

## 4) Start invite wave

1. Share waitlist URL publicly.
2. Approve first cohort in `/admin/waitlist/` (or run bulk script).
3. Track acceptance rate and first-run completion.
4. Expand approvals in batches while monitoring error rate and uptime.
