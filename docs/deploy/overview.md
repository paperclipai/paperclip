---
title: Deployment Overview
summary: Deployment modes at a glance
---

ValAdrien OS supports three deployment configurations, from zero-friction local to internet-facing production.

## Deployment Modes

| Mode | Auth | Best For |
|------|------|----------|
| `local_trusted` | No login required | Single-operator local machine |
| `authenticated` + `private` | Login required | Private network (Tailscale, VPN, LAN) |
| `authenticated` + `public` | Login required | Internet-facing cloud deployment |

## Quick Comparison

### Local Trusted (Default)

- Loopback-only host binding (localhost)
- No human login flow
- Fastest local startup
- Best for: solo development and experimentation

### Authenticated + Private

- Login required via Better Auth
- Binds to all interfaces for network access
- Auto base URL mode (lower friction)
- Best for: team access over Tailscale or local network

### Authenticated + Public

- Login required
- Explicit public URL required
- Stricter security checks
- Best for: cloud hosting, internet-facing deployment

## Choosing a Mode

- **Just trying ValAdrien OS?** Use `local_trusted` (the default)
- **Sharing with a team on private network?** Use `authenticated` + `private`
- **Deploying to the cloud?** Use `authenticated` + `public`:
  - **ValAdrien.DEV reference:** GitHub → [Vercel + Supabase](../../doc/plans/2026-06-02-host-valadrien-vercel-supabase-walkthrough.md) — see [Architecture.md](../../Architecture.md#14-hosted-reference-topology-vercel--supabase)
  - **Self-hosted AWS:** [AWS ECS Fargate guide](aws-ecs.md)
  - **Failures:** [troubleshooting.md](./troubleshooting.md)

Set the mode during onboarding:

```sh
pnpm valadrien-os onboard
```

Or update it later:

```sh
pnpm valadrien-os configure --section server
```

## Vercel + Supabase (operator cloud)

| Concern | Doc |
| ------- | --- |
| Step-by-step setup | [Host walkthrough](../../doc/plans/2026-06-02-host-valadrien-vercel-supabase-walkthrough.md) |
| Architecture | [Architecture.md §14](../../Architecture.md#14-hosted-reference-topology-vercel--supabase) |
| Database URLs | [database.md](./database.md) |
| Env vars | [environment-variables.md](./environment-variables.md) |
| Failures | [troubleshooting.md](./troubleshooting.md) |

Build entrypoint: `pnpm run build:vercel` (see root `vercel.json`).
