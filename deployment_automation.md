# Automated Deployment Setup

Paperclip now supports fully automated "zero-config" deployment via Docker.

## How it Works

The deployment is powered by a custom entrypoint script: `docker/docker-entrypoint.sh`.

### 1. Automatic Onboarding
When the container starts, it checks for an existing configuration in the `/paperclip` volume. If no configuration is found (first-run):
- It executes `paperclipai onboard --yes` to generate a default `config.json`.
- It automatically configures the `deploymentMode` to `authenticated` to ensure secure access.

### 2. Automatic Admin Setup & Redirect
Immediately after onboarding, the script:
- Generates a one-time **CEO Bootstrap Invite URL**.
- Exports the invite token to the environment.
- The Paperclip server detects this token and exposes it via the `/api/health` endpoint.
- When you open Paperclip in your browser (`http://localhost:3100`), the UI will **automatically redirect** you to the admin creation page.

## Viewing the Admin Invite Alternatively
If for some reason the redirect doesn't work, you can still find the link in the logs:

To get your initial login link on a fresh deployment, run:

```bash
docker compose logs -f paperclip
```

Look for the block labeled `INITIAL ADMIN SETUP REQUIRED`.

## Manual Configuration
If you need to change the configuration later, you can still use the CLI inside the container:

```bash
docker exec -it paperclip-paperclip-1 pnpm paperclipai configure
```

## Signals and Persistence
- The entrypoint uses `exec` to forward system signals (like `SIGTERM`) directly to the Paperclip process for graceful shutdowns.
- All configuration and state are persisted in the `paperclip_app_data` and `paperclip_db_data` Docker volumes.
