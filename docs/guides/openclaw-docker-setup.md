# Running OpenClaw in Docker (Local Development)

How to get OpenClaw running in a Docker container for local development and testing the Paperclip OpenClaw adapter integration.

## Automated Join Smoke Test (Recommended First)

Paperclip includes an end-to-end join smoke harness:

```bash
pnpm smoke:openclaw-join
```

The harness automates:

- invite creation (`allowedJoinTypes=agent`)
- OpenClaw agent join request (`adapterType=openclaw`)
- board approval
- one-time API key claim (including invalid/replay claim checks)
- wakeup callback delivery to a dockerized OpenClaw-style webhook receiver

By default, this uses a preconfigured Docker receiver image (`docker/openclaw-smoke`) so the run is deterministic and requires no manual OpenClaw config edits.

Permissions note:

- The harness performs board-governed actions (invite creation, join approval, wakeup of the new agent).
- In authenticated mode, provide board/operator auth or the run exits early with an explicit permissions error.

## One-Command OpenClaw Gateway UI (Manual Docker Flow)

To spin up OpenClaw in Docker and print a host-browser dashboard URL in one command:

```bash
pnpm smoke:openclaw-docker-ui
```

What this command does:

- clones/updates `openclaw/openclaw` in `/tmp/openclaw-docker`
- builds `openclaw:local` (unless `OPENCLAW_BUILD=0`)
- writes `~/.openclaw/openclaw.json` and Docker `.env`
- starts `openclaw-gateway` via Compose (with required `/tmp` tmpfs override)
- waits for health and prints:
  - `http://127.0.0.1:18789/#token=...`
- disables Control UI device pairing by default for local smoke ergonomics

Environment knobs:

- `OPENAI_API_KEY` (required; loaded from env or `~/.secrets`)
- `OPENCLAW_DOCKER_DIR` (default `/tmp/openclaw-docker`)
- `OPENCLAW_GATEWAY_PORT` (default `18789`)
- `OPENCLAW_GATEWAY_TOKEN` (default random)
- `OPENCLAW_BUILD=0` to skip rebuild
- `OPENCLAW_OPEN_BROWSER=1` to auto-open the URL on macOS
- `OPENCLAW_DISABLE_DEVICE_AUTH=1` (default) disables Control UI device pairing for local smoke
- `OPENCLAW_DISABLE_DEVICE_AUTH=0` keeps pairing enabled (then approve browser with `devices` CLI commands)

### Authenticated mode

If your Paperclip deployment is `authenticated`, provide auth context:

```bash
PAPERCLIP_AUTH_HEADER="Bearer <token>" pnpm smoke:openclaw-join
# or
PAPERCLIP_COOKIE="your_session_cookie=..." pnpm smoke:openclaw-join
```

### Network topology tips

- Local same-host smoke: default callback uses `http://127.0.0.1:<port>/webhook`.
- Docker/remote OpenClaw: prefer a reachable hostname (Docker host alias, Tailscale hostname, or public domain).
- Authenticated/private mode: ensure hostnames are in the allowed list when required:

```bash
pnpm paperclipai allowed-hostname <host>
```

## Prerequisites

- **Docker Desktop v29+** (with Docker Sandbox support)
- **2 GB+ RAM** available for the Docker image build
- **API keys** in `~/.secrets` (at minimum `OPENAI_API_KEY`)

## Option A: Docker Sandbox (Recommended)

Docker Sandbox provides better isolation (microVM-based) and simpler setup than Docker Compose. Requires Docker Desktop v29+ / Docker Sandbox v0.12+.

```bash
# 1. Clone the OpenClaw repo and build the image
git clone https://github.com/openclaw/openclaw.git /tmp/openclaw-docker
cd /tmp/openclaw-docker
docker build -t openclaw:local -f Dockerfile .

# 2. Create the sandbox using the built image
docker sandbox create --name openclaw -t openclaw:local shell ~/.openclaw/workspace

# 3. Allow network access to OpenAI API
docker sandbox network proxy openclaw \
  --allow-host api.openai.com \
  --allow-host localhost

# 4. Write the config inside the sandbox
docker sandbox exec openclaw sh -c '
mkdir -p /home/node/.openclaw/workspace /home/node/.openclaw/identity /home/node/.openclaw/credentials
cat > /home/node/.openclaw/openclaw.json << INNEREOF
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "sandbox-dev-token-12345"
    },
    "controlUi": { "enabled": true }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-5.2",
        "fallbacks": ["openai/gpt-5.2-chat-latest"]
      },
      "workspace": "/home/node/.openclaw/workspace"
    }
  }
}
INNEREOF
chmod 600 /home/node/.openclaw/openclaw.json
'

# 5. Start the gateway (pass your API key from ~/.secrets)
source ~/.secrets
docker sandbox exec -d \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -w /app openclaw \
  node dist/index.js gateway --bind loopback --port 18789

# 6. Wait ~15 seconds, then verify
sleep 15
docker sandbox exec openclaw curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/
# Should print: 200

# 7. Check status
docker sandbox exec -e OPENAI_API_KEY="$OPENAI_API_KEY" -w /app openclaw \
  node dist/index.js status
```

### Sandbox Management

```bash
# List sandboxes
docker sandbox ls

# Shell into the sandbox
docker sandbox exec -it openclaw bash

# Stop the sandbox (preserves state)
docker sandbox stop openclaw

# Remove the sandbox
docker sandbox rm openclaw

# Check sandbox version
docker sandbox version
```

## Option B: Docker Compose (Fallback)

Use this if Docker Sandbox is not available (Docker Desktop < v29).

```bash
# 1. Clone the OpenClaw repo
git clone https://github.com/openclaw/openclaw.git /tmp/openclaw-docker
cd /tmp/openclaw-docker

# 2. Build the Docker image (~5-10 min on first run)
docker build -t openclaw:local -f Dockerfile .

# 3. Create config directories
mkdir -p ~/.openclaw/workspace ~/.openclaw/identity ~/.openclaw/credentials
chmod 700 ~/.openclaw ~/.openclaw/credentials

# 4. Generate a gateway token
export OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "Your gateway token: $OPENCLAW_GATEWAY_TOKEN"

# 5. Create the config file
cat > ~/.openclaw/openclaw.json << EOF
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "$OPENCLAW_GATEWAY_TOKEN"
    },
    "controlUi": {
      "enabled": true,
      "allowedOrigins": ["http://127.0.0.1:18789"]
    }
  },
  "env": {
    "OPENAI_API_KEY": "\${OPENAI_API_KEY}"
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-5.2",
        "fallbacks": ["openai/gpt-5.2-chat-latest"]
      },
      "workspace": "/home/node/.openclaw/workspace"
    }
  }
}
EOF
chmod 600 ~/.openclaw/openclaw.json

# 6. Create the .env file (load API keys from ~/.secrets)
source ~/.secrets
cat > .env << EOF
OPENCLAW_CONFIG_DIR=$HOME/.openclaw
OPENCLAW_WORKSPACE_DIR=$HOME/.openclaw/workspace
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN
OPENCLAW_IMAGE=openclaw:local
OPENAI_API_KEY=$OPENAI_API_KEY
OPENCLAW_EXTRA_MOUNTS=
OPENCLAW_HOME_VOLUME=
OPENCLAW_DOCKER_APT_PACKAGES=
EOF

# 7. Add tmpfs to docker-compose.yml (required — see Known Issues)
# Add to BOTH openclaw-gateway and openclaw-cli services:
#   tmpfs:
#     - /tmp:exec,size=512M

# 8. Start the gateway
docker compose up -d openclaw-gateway

# 9. Wait ~15 seconds for startup, then get the dashboard URL
sleep 15
docker compose run --rm openclaw-cli dashboard --no-open
```

The dashboard URL will look like: `http://127.0.0.1:18789/#token=<your-token>`

### Docker Compose Management

```bash
cd /tmp/openclaw-docker

# Stop
docker compose down

# Start again (no rebuild needed)
docker compose up -d openclaw-gateway

# View logs
docker compose logs -f openclaw-gateway

# Check status
docker compose run --rm openclaw-cli status

# Get dashboard URL
docker compose run --rm openclaw-cli dashboard --no-open
```

## Known Issues and Fixes

### "no space left on device" when starting containers

Docker Desktop's virtual disk may be full.

```bash
docker system df                   # check usage
docker system prune -f             # remove stopped containers, unused networks
docker image prune -f              # remove dangling images
```

### "Unable to create fallback OpenClaw temp dir: /tmp/openclaw-1000" (Compose only)

The container can't write to `/tmp`. Add a `tmpfs` mount to `docker-compose.yml` for **both** services:

```yaml
services:
  openclaw-gateway:
    tmpfs:
      - /tmp:exec,size=512M
  openclaw-cli:
    tmpfs:
      - /tmp:exec,size=512M
```

This issue does not affect the Docker Sandbox approach.

### Node version mismatch in community template images

Some community-built sandbox templates (e.g. `olegselajev241/openclaw-dmr:latest`) ship Node 20, but OpenClaw requires Node >=22.12.0. Use our locally built `openclaw:local` image as the sandbox template instead, which includes Node 22.

### Gateway takes ~15 seconds to respond after start

The Node.js gateway needs time to initialize. Wait 15 seconds before hitting `http://127.0.0.1:18789/`.

### CLAUDE_AI_SESSION_KEY warnings (Compose only)

These Docker Compose warnings are harmless and can be ignored:
```
level=warning msg="The \"CLAUDE_AI_SESSION_KEY\" variable is not set. Defaulting to a blank string."
```

## Configuration

Config file: `~/.openclaw/openclaw.json` (JSON5 format)

Key settings:
- `gateway.auth.token` — the auth token for the web UI and API
- `agents.defaults.model.primary` — the AI model (use `openai/gpt-5.2` or newer)
- `env.OPENAI_API_KEY` — references the `OPENAI_API_KEY` env var (Compose approach)

API keys are stored in `~/.secrets` and passed into containers via env vars.

## Reference

- [OpenClaw Docker docs](https://docs.openclaw.ai/install/docker)
- [OpenClaw Configuration Reference](https://docs.openclaw.ai/gateway/configuration-reference)
- [Docker blog: Run OpenClaw Securely in Docker Sandboxes](https://www.docker.com/blog/run-openclaw-securely-in-docker-sandboxes/)
- [Docker Sandbox docs](https://docs.docker.com/ai/sandboxes)
- [OpenAI Models](https://platform.openai.com/docs/models) — current models: gpt-5.2, gpt-5.2-chat-latest, gpt-5.2-pro
