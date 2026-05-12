# Deploy Paperclip to Render

A click-through guide for non-developers. The repo includes a
[`render.yaml`](../render.yaml) Blueprint, so most of the work is "click,
confirm, wait."

Estimated time: ~15 minutes (most of it is Render building the Docker image).

## What you need

- A [Render](https://render.com) account
- A GitHub account that can grant Render access to this fork
- Roughly $7/month for the smallest paid Postgres plan (recommended for any
  non-toy deployment); the web service can run on the free Hobby plan to start
- That's it. No keys to paste, no secrets to generate.

## Step 1 — Sync this branch to your fork

If you're reading this from a feature branch, push it:

```sh
git push origin sync/upstream-2026-05-12
```

…then merge to `master` (or whichever branch Render is watching).

## Step 2 — Create the Blueprint in Render

1. In Render, click **New +** → **Blueprint**.
2. Connect your GitHub account if you haven't already, and pick this repo.
3. Pick the branch (`master`).
4. Render will read `render.yaml` and show a preview:
   - 1 Web service: `paperclip` (Docker)
   - 1 Postgres: `paperclip-db`
5. Click **Apply** / **Create Blueprint Instance**.

Render now provisions Postgres, then builds the Docker image (this is the slow
part — typically 5–10 minutes the first time). You can watch the live build log.

## Step 3 — First boot

Once the build is green, Render will give you a public URL like
`https://paperclip-XYZ.onrender.com`. Open it.

You'll be asked to claim the board. Pick a username + password — that's now
your operator login. Done; Paperclip is live.

## Step 4 — (Optional) Set `PAPERCLIP_PUBLIC_URL` explicitly

The `docker-entrypoint.sh` falls back to Render's `RENDER_EXTERNAL_URL`, so
sign-in links in invite emails will work out of the box. If you want them to
use a custom domain, add it under **Settings → Custom Domains** in Render and
set `PAPERCLIP_PUBLIC_URL` to that domain.

## Step 5 — (Optional) Wire up Langfuse tracing

Heartbeat runs are instrumented with Langfuse spans (fork-curated feature). To
see them:

1. Sign up at [Langfuse](https://us.cloud.langfuse.com).
2. Create a project, grab the public + secret keys.
3. In Render → your service → **Environment**, paste `LANGFUSE_PUBLIC_KEY` and
   `LANGFUSE_SECRET_KEY`.
4. Redeploy. Tracing now flows on every heartbeat.

## Step 6 — (Optional) Connect your agent runtimes

This is configured inside Paperclip's UI, not Render. See
[`doc/ADAPTERS-EXTERNAL.md`](./ADAPTERS-EXTERNAL.md) for the OpenClaw-HQ,
Hermes, and OpenSwarm wiring guide.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Build fails on `pnpm install` | Outdated lockfile vs `package.json` | Pull latest `master`; the sync PR keeps these in lockstep |
| 502 on first request | Service is still starting (PGlite migrations) | Wait ~30s; check Render logs for "API listening" |
| `BETTER_AUTH_SECRET must be set` | Blueprint was hand-edited and the var lost its `generateValue` | In Render env vars, click "Generate" next to `BETTER_AUTH_SECRET` |
| Sign-in link points to localhost | `PAPERCLIP_PUBLIC_URL` is empty *and* Render hasn't injected `RENDER_EXTERNAL_URL` yet | Paste the Render service URL into `PAPERCLIP_PUBLIC_URL` manually and redeploy |

## Why Render?

OpenClaw-HQ is already on Render (per your inventory), so co-locating
Paperclip there keeps the gateway hop short and gives you one billing surface.
Fly, Railway, and a self-managed VPS via `docker/docker-compose.yml` all work
the same way; only the dashboard differs.
