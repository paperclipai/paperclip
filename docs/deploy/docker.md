---
title: Docker
summary: Docker Compose quickstart
---

Run Paperclip in Docker without installing Node or pnpm locally.

## Compose Quickstart (Recommended)

The quickstart uses Paperclip's `local_trusted` mode, so it opens without a
login screen. The host port is published on `127.0.0.1` only. Keep that
loopback-only port binding when changing the Compose file; this mode grants
board access without authentication.

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

Open [http://localhost:3100](http://localhost:3100).

The Compose project is named `paperclip-local`; its container is
`paperclip-local-paperclip-1`. The quickstart uses Docker's
`unless-stopped` restart policy. If the container has stopped but still
exists, start it with:

```powershell
docker start paperclip-local-paperclip-1
Invoke-WebRequest http://127.0.0.1:3100/api/health
```

To recreate the Compose container while keeping its existing data and signing
secret, read the secret from the current container without printing it and run:

```powershell
$container = (docker inspect paperclip-local-paperclip-1 | ConvertFrom-Json)[0]
$secret = $container.Config.Env | Where-Object { $_.StartsWith('BETTER_AUTH_SECRET=') } | Select-Object -First 1
$env:BETTER_AUTH_SECRET = $secret.Substring('BETTER_AUTH_SECRET='.Length)
$env:PAPERCLIP_DATA_DIR = '../data/paperclip'
$env:PAPERCLIP_PORT = '3100'
docker compose --project-name paperclip-local -f docker/docker-compose.quickstart.yml up --build --detach
```

Check recent logs with `docker logs --tail 100 paperclip-local-paperclip-1` if
the health endpoint does not report `status: ok`. Keep the published address
loopback-only; `local_trusted` grants unauthenticated board access.

Defaults:

- Host port: `3100`
- Data directory: `./data/docker-paperclip`

Override with environment variables:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**Note:** `PAPERCLIP_DATA_DIR` is resolved relative to the compose file (`docker/`), so `../data/pc` maps to `data/pc` in the project root.

## Manual Docker Build

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

## Data Persistence

All data is persisted under the bind mount (`./data/docker-paperclip`):

- Embedded PostgreSQL data
- Uploaded assets
- Local secrets key
- Agent workspace data

## Local Adapter CLIs in Docker

The Docker image pre-installs these agent CLIs so their `*_local` adapters can run inside the container:

- `claude` (Anthropic Claude Code CLI) — `claude_local`
- `codex` (OpenAI Codex CLI) — `codex_local`
- `opencode` (OpenCode multi-provider CLI) — `opencode_local`
- `gemini` (Google Gemini CLI) — `gemini_local` (experimental)

Pass API keys to enable local adapter runs inside the container:

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-... \
  -e GEMINI_API_KEY=... \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Each adapter reads its provider's standard credentials — for example `ANTHROPIC_API_KEY` (Claude), `OPENAI_API_KEY` (Codex), and `GEMINI_API_KEY` or `GOOGLE_API_KEY` (Gemini). OpenCode is multi-provider and uses whichever provider key you supply.

> **Gemini key restrictions:** Google requires Gemini API keys to be *restricted* to the Gemini API (scoped in the Google Cloud console); unrestricted keys are blocked and `gemini_local` runs will fail with an auth error. Create a restricted key, or authenticate with `gemini auth login` (OAuth) and persist `~/.gemini` via the data volume so the credential survives container restarts.

The image sets `GEMINI_SANDBOX=false` so the Gemini CLI does not try to launch its own (Docker-in-Docker) sandbox inside the container. The `gemini_local` adapter already passes `--sandbox=none` per run, so this env var only matters if you invoke `gemini` manually inside the container; override it if you have nested-container support and want CLI-level sandboxing.

Without API keys, the app runs normally — adapter environment checks will surface missing prerequisites.
