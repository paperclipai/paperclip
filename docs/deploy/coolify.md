---
title: Coolify
summary: Deploy Paperclip to Coolify with the bundled Docker Compose file
---

Paperclip ships a production [`Dockerfile`](https://github.com/paperclipai/paperclip/blob/main/Dockerfile) plus a Compose file tailored for Coolify's "Docker Compose" resource type: `docker/docker-compose.coolify.yml`. It bundles the app with its own Postgres instance and keeps the database off the public network.

## 1. Create the resource

1. In Coolify: **New Resource -> Docker Compose**.
2. Connect the `paperclipai/paperclip` repo (or your fork) and pick the branch to deploy.
3. Set **Docker Compose Location** to `docker/docker-compose.coolify.yml`.
4. Coolify detects two services: `app` and `db`.

## 2. Set environment variables

In the resource's **Environment Variables** tab, add:

| Variable | Required | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | yes | password for the bundled Postgres instance |
| `BETTER_AUTH_SECRET` | yes | generate with `openssl rand -base64 32` |
| `PAPERCLIP_PUBLIC_URL` | yes | the https domain you assign the `app` service, e.g. `https://paperclip.example.com` |
| `ANTHROPIC_API_KEY` | optional | lets agents use Claude out of the box |
| `OPENAI_API_KEY` | optional | lets agents use OpenAI out of the box |
| `GITHUB_TOKEN` | optional | needed for GitHub-integrated workflows |

See [`docker/.env.coolify.example`](https://github.com/paperclipai/paperclip/blob/main/docker/.env.coolify.example) for a reference list (don't commit real secrets into it — set them in Coolify's UI instead).

## 3. Assign a domain

Under the `app` service, add a domain pointing at container port `3100`. Set `PAPERCLIP_PUBLIC_URL` to that exact domain (with `https://`) so auth/session cookies and OAuth callback URLs resolve correctly, then redeploy.

## 4. Deploy

Click **Deploy**. Coolify builds the image from the root `Dockerfile` and starts both services. First boot runs database migrations automatically (`PAPERCLIP_MIGRATION_AUTO_APPLY=true`).

Data persists in two named volumes: `pgdata` (Postgres) and `paperclip-data` (`/paperclip` — instance config, local secrets, file storage). Both survive redeploys; don't delete them unless you want a clean slate.

## 5. Harden after first sign-up

Once you've created your admin account, consider setting:

```
PAPERCLIP_AUTH_DISABLE_SIGN_UP=true
```

to stop further public sign-ups on an internet-exposed instance. Use the invite flow to grant access to additional users afterward.

## Troubleshooting

- **Healthcheck failing / container restarting**: check the `app` service logs in Coolify. The healthcheck hits `GET /api/health` on port `3100` — if the app crashes before binding, a missing `BETTER_AUTH_SECRET`/`POSTGRES_PASSWORD` or a `db` connection failure are the usual causes.
- **Redirect loop or broken login**: `PAPERCLIP_PUBLIC_URL` doesn't match the domain you're visiting. Update it and redeploy.
- **Slow first deploy**: the image builds the whole pnpm workspace (server, UI, adapters). Subsequent deploys reuse Docker layer cache unless `pnpm-lock.yaml` changes.
