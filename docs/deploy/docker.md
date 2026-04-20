---
title: Docker
summary: Docker Compose quickstart
---

Run AiTeamCorp in Docker without installing Node or pnpm locally.

## Compose Quickstart (Recommended)

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

Open [http://localhost:3100](http://localhost:3100).

Defaults:

- Host port: `3100`
- Data directory: `./data/docker-aiteamcorp`

Override with environment variables:

```sh
AITEAMCORP_PORT=3200 AITEAMCORP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**Note:** `AITEAMCORP_DATA_DIR` is resolved relative to the compose file (`docker/`), so `../data/pc` maps to `data/pc` in the project root.

## Manual Docker Build

```sh
docker build -t aiteamcorp-local .
docker run --name aiteamcorp \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e AITEAMCORP_HOME=/aiteamcorp \
  -v "$(pwd)/data/docker-aiteamcorp:/aiteamcorp" \
  aiteamcorp-local
```

## Data Persistence

All data is persisted under the bind mount (`./data/docker-aiteamcorp`):

- Embedded PostgreSQL data
- Uploaded assets
- Local secrets key
- Agent workspace data

## Claude and Codex Adapters in Docker

The Docker image pre-installs:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)

Pass API keys to enable local adapter runs inside the container:

```sh
docker run --name aiteamcorp \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e AITEAMCORP_HOME=/aiteamcorp \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-... \
  -v "$(pwd)/data/docker-aiteamcorp:/aiteamcorp" \
  aiteamcorp-local
```

Without API keys, the app runs normally — adapter environment checks will surface missing prerequisites.
