# Docker Quickstart

Run Paperclip in Docker without installing Node or pnpm locally.

## One-liner (build + run)

```sh
docker build -t paperclip-local . && \
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Open: `http://localhost:3100`

Data persistence:

- Embedded PostgreSQL data
- uploaded assets
- local secrets key
- local agent workspace data

All persisted under your bind mount (`./data/docker-paperclip` in the example above).

## Compose Quickstart

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

Defaults:

- host port: `3100`
- persistent data dir: `./data/docker-paperclip`

Optional overrides:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=./data/pc docker compose -f docker-compose.quickstart.yml up --build
```

If you change host port or use a non-local domain, set `PAPERCLIP_PUBLIC_URL` to the external URL you will use in browser/auth flows.

## Authenticated Compose (Single Public URL)

For authenticated deployments, set one canonical public URL and let Paperclip derive auth/callback defaults:

```yaml
services:
  paperclip:
    environment:
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: private
      PAPERCLIP_PUBLIC_URL: https://desk.koker.net
```

`PAPERCLIP_PUBLIC_URL` is used as the primary source for:

- auth public base URL
- Better Auth base URL defaults
- bootstrap invite URL defaults
- hostname allowlist defaults (hostname extracted from URL)

Granular overrides remain available if needed (`PAPERCLIP_AUTH_PUBLIC_BASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `PAPERCLIP_ALLOWED_HOSTNAMES`).

Set `PAPERCLIP_ALLOWED_HOSTNAMES` explicitly only when you need additional hostnames beyond the public URL host (for example Tailscale/LAN aliases or multiple private hostnames).

## Claude + Codex Local Adapters in Docker

The image pre-installs:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)

If you want local adapter runs inside the container, pass API keys when starting the container:

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e OPENAI_API_KEY=... \
  -e ANTHROPIC_API_KEY=... \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Notes:

- Without API keys, the app still runs normally.
- Adapter environment checks in Paperclip will surface missing auth/CLI prerequisites.

## Stripe (test / integration)

Paperclip reads Stripe keys from the environment (no billing routes ship yet; keys are normalized for upcoming use and for Stripe SDK defaults).

**Preferred names (test keys):**

- `STRIPE_TEST_PUBLISHABLE_KEY`
- `STRIPE_TEST_SECRET_KEY`

**Backward-compatible aliases:**

- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_SECRET_KEY`

If both prefixed and generic variables are set, **`STRIPE_TEST_*` wins**. On startup the server sets `STRIPE_PUBLISHABLE_KEY` and `STRIPE_SECRET_KEY` to the resolved values so libraries that only read the standard names still work.

`GET /api/health` includes `features.stripe.publishableKey` and `features.stripe.secretKey` as booleans (never key material).

**VPS:** add the variables to `/opt/paperclip/.env` on the host; `docker-compose.vps.yml` passes them into the server container. Use test keys until live billing is intentional.

## VPS Production Deployment

For production deployment to a VPS with automated CI/CD, use the dedicated VPS setup:

```sh
# Production deployment (automated via GitHub Actions)
# See doc/VPS-DEPLOYMENT.md for full details
```

**Key differences from local quickstart:**

| Aspect | Local Quickstart | VPS Production |
|--------|-----------------|----------------|
| Compose file | `docker-compose.quickstart.yml` | `docker-compose.vps.yml` |
| Dockerfile | `Dockerfile` (full build) | `Dockerfile.vps` (fast, uses prebuilt `ui/dist`) |
| Database | Exposed on host port 5432 | Internal only (not exposed) |
| OpenCode | Optional | Required with API keys |
| Public URL | Defaults to localhost | Must be explicit external URL |

**Files:**
- `docker-compose.vps.yml` - Production orchestration
- `Dockerfile.vps` - Optimized build for VPS (expects prebuilt UI)
- `.github/workflows/deploy-vultr.yml` - GitHub Actions CI/CD
- `scripts/docker-entrypoint.sh` - Container bootstrap

See [VPS-DEPLOYMENT.md](VPS-DEPLOYMENT.md) for complete setup instructions including:
- Required GitHub secrets
- VPS environment configuration
- SSH key setup
- Deployment validation
- Recovery procedures

## Untrusted PR Review Container

If you want a separate Docker environment for reviewing untrusted pull requests with `codex` or `claude`, use the dedicated review workflow in `doc/UNTRUSTED-PR-REVIEW.md`.

That setup keeps CLI auth state in Docker volumes instead of your host home directory and uses a separate scratch workspace for PR checkouts and preview runs.

## Onboard Smoke Test (Ubuntu + npm only)

Use this when you want to mimic a fresh machine that only has Ubuntu + npm and verify:

- `npx paperclipai onboard --yes` completes
- the server binds to `0.0.0.0:3100` so host access works
- onboard/run banners and startup logs are visible in your terminal

Build + run:

```sh
./scripts/docker-onboard-smoke.sh
```

Open: `http://localhost:3131` (default smoke host port)

Useful overrides:

```sh
HOST_PORT=3200 PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private ./scripts/docker-onboard-smoke.sh
SMOKE_DETACH=true SMOKE_METADATA_FILE=/tmp/paperclip-smoke.env PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

Notes:

- Persistent data is mounted at `./data/docker-onboard-smoke` by default.
- Container runtime user id defaults to your local `id -u` so the mounted data dir stays writable while avoiding root runtime.
- Smoke script defaults to `authenticated/private` mode so `HOST=0.0.0.0` can be exposed to the host.
- Smoke script defaults host port to `3131` to avoid conflicts with local Paperclip on `3100`.
- Smoke script also defaults `PAPERCLIP_PUBLIC_URL` to `http://localhost:<HOST_PORT>` so bootstrap invite URLs and auth callbacks use the reachable host port instead of the container's internal `3100`.
- In authenticated mode, the smoke script defaults `SMOKE_AUTO_BOOTSTRAP=true` and drives the real bootstrap path automatically: it signs up a real user, runs `paperclipai auth bootstrap-ceo` inside the container to mint a real bootstrap invite, accepts that invite over HTTP, and verifies board session access.
- Run the script in the foreground to watch the onboarding flow; stop with `Ctrl+C` after validation.
- Set `SMOKE_DETACH=true` to leave the container running for automation and optionally write shell-ready metadata to `SMOKE_METADATA_FILE`.
- The image definition is in `Dockerfile.onboard-smoke`.
