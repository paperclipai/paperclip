# Docker Deployment

Run Paperclip in Docker with persistent data, automatic restarts, and agent support.

## Prerequisites

- Docker and Docker Compose
- Node.js 20+ and pnpm 9.15+ (for the CLI bootstrap command only)

## Quick Start

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in secrets:

```bash
cat > .env <<EOF
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -hex 32)
PAPERCLIP_PUBLIC_URL=http://localhost:3100
EOF
```

| Variable | Required | Description |
|---|---|---|
| `BETTER_AUTH_SECRET` | Yes | Session encryption secret |
| `PAPERCLIP_AGENT_JWT_SECRET` | Yes | JWT secret for agent authentication |
| `PAPERCLIP_PUBLIC_URL` | Yes | Public URL for auth callbacks and invite links |

> **Do NOT put `DATABASE_URL`, `PORT`, or `SERVE_UI` in `.env`** — the compose file sets these internally. Adding them to `.env` will override the container values and break things.

### 2. Build and start

```bash
docker compose up -d --build
```

This starts:
- **Postgres** on port 5432 (with health checks)
- **Paperclip server + UI** on port 3100

Both services have `restart: always` and will survive reboots.

### 3. Create your admin account

The CLI connects directly to the Postgres container (exposed on `localhost:5432`):

```bash
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
pnpm paperclipai auth bootstrap-ceo
```

This prints an invite URL. Open it in your browser to create your account.

> **Note:** If you previously ran `pnpm paperclipai onboard` locally, your config at `~/.paperclip/instances/default/config.json` may be set to `local_trusted` mode. The CLI will refuse to bootstrap in that mode. Fix it:
> ```bash
> sed -i 's/local_trusted/authenticated/' ~/.paperclip/instances/default/config.json
> ```

### 4. Log into Claude inside the container

Claude Code needs to be authenticated inside the container. The host login doesn't carry over.

```bash
docker compose exec -it server claude login
```

Complete the OAuth flow. The session persists in the `paperclip-data` volume across restarts.

### 5. Set up SSH keys for Git access

Agents need SSH keys to clone and push to private repos:

```bash
sudo ./scripts/docker-ssh-setup.sh
```

This generates an ed25519 key locally, copies it into the container, and prints the public key. Add it to GitHub at https://github.com/settings/ssh/new.

Keys are:
- Stored in the `paperclip-data` volume at `/paperclip/.ssh/` (persists across restarts)
- Backed up locally at `docker/.ssh/` (gitignored)

## Tailscale (Remote Access)

Set `PAPERCLIP_PUBLIC_URL` in your `.env` to your Tailscale hostname:

```
PAPERCLIP_PUBLIC_URL=http://your-tailscale-hostname:3100
```

Then access `http://your-tailscale-hostname:3100` from any device on your Tailnet.

## Data Persistence

Docker Compose uses two named volumes:

| Volume | Mount | Contents |
|---|---|---|
| `pgdata` | `/var/lib/postgresql/data` | Postgres database |
| `paperclip-data` | `/paperclip` | Config, secrets, agent sessions, SSH keys, backups |

Data persists across `docker compose down` and `docker compose up`.

**To destroy all data:** `docker compose down -v` (the `-v` flag deletes volumes).

## Agent Working Directory

The container's working directory is `/app`. When configuring agents in the dashboard, set their `cwd` to `/app` or a subdirectory. Do **not** use host paths like `/home/user/...` — they don't exist inside the container.

For agents working on code:
- Agents clone repos from GitHub inside the container, do work, and push commits
- SSH keys (from step 5) enable access to private repos

## Claude Code Agents (Subscription Auth)

The container runs as a non-root `paperclip` user, which is required for Claude Code's `--dangerously-skip-permissions` flag.

If using Claude Code with subscription auth (not API keys):
1. Run `claude login` inside the container (step 4 above)
2. Do **not** set `ANTHROPIC_API_KEY` — Claude will use the subscription session

If using API key auth instead, add `ANTHROPIC_API_KEY` to your `.env` and add it to the `environment:` block in `docker-compose.yml`.

## Standalone Docker (without Compose)

```bash
docker build -t paperclip-local . && \
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  -e PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -hex 32) \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

This uses the embedded PGlite database (no external Postgres needed).

## Troubleshooting

**`BETTER_AUTH_SECRET must be set`**
Your `.env` file is missing or not in the same directory as `docker-compose.yml`.

**`permission denied` on `/paperclip`**
The volume was created by an older image that ran as root. Fix ownership:
```bash
docker compose exec -u root server chown -R paperclip:paperclip /paperclip
```

**Claude CLI silently exits / produces no output**
Claude isn't logged in inside the container. Run `docker compose exec -it server claude login`.

**Agent can't clone repos**
SSH keys aren't set up. Run `sudo ./scripts/docker-ssh-setup.sh` and add the public key to GitHub.

**`connect ECONNREFUSED 127.0.0.1:54329`**
The CLI is connecting to the embedded database instead of the Docker Postgres. Pass `DATABASE_URL` explicitly:
```bash
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip pnpm paperclipai auth bootstrap-ceo
```

**Adapter environment test says `cwd` permission denied**
The agent's `cwd` is set to a host path. Change it to `/app` in the dashboard.

## Useful Commands

```bash
docker compose logs -f          # Watch logs
docker compose logs -f server   # Server logs only
docker compose down             # Stop services
docker compose up -d --build    # Rebuild and restart
docker compose exec -it server /bin/bash  # Shell into container
docker compose exec -it server claude login  # Auth Claude
```

## Onboard Smoke Test

For CI or testing a fresh install:

```bash
./scripts/docker-onboard-smoke.sh
```

See `Dockerfile.onboard-smoke` for details. Opens on `http://localhost:3131` by default.
