---
title: Docker
summary: Docker Compose quickstart
---

Run Paperclip in Docker without installing Node or pnpm locally.

## Compose Quickstart (Recommended)

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

Open [http://localhost:3100](http://localhost:3100).

Defaults:

- Host port: `3100`
- Data directory: `./data/docker-paperclip`

Override with environment variables:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=./data/pc \
  docker compose -f docker-compose.quickstart.yml up --build
```

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

## Local Adapters in Docker

The Docker image pre-installs:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)
- `opencode` (OpenCode CLI)

### Claude and Codex

Pass API keys as environment variables:

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-... \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

**Alternative: `settings.json` for custom Claude backends (e.g. Alibaba Qwen)**

Instead of `ANTHROPIC_API_KEY`, create a `settings.json` inside the data directory. The container `HOME` is the bind-mounted data directory, so Claude Code reads it automatically:

```sh
mkdir -p ./data/docker-paperclip/.claude
cat > ./data/docker-paperclip/.claude/settings.json << 'EOF'
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-token",
    "ANTHROPIC_BASE_URL": "https://your-qwen-proxy/anthropic",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "qwen3-coder-next",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "qwen3-max-2026-01-23",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "qwen3.5-plus"
  },
  "availableModels": ["sonnet", "opus", "haiku"],
  "skipDangerousModePermissionPrompt": true
}
EOF
```

### OpenCode

OpenCode reads provider credentials from `~/.local/share/opencode/auth.json`. In Docker, `~` resolves to the data directory:

```sh
mkdir -p ./data/docker-paperclip/.local/share/opencode
cat > ./data/docker-paperclip/.local/share/opencode/auth.json << 'EOF'
{
  "zai-coding-plan": {
    "type": "api",
    "key": "your-zai-api-key"
  }
}
EOF
```

Verify the provider is detected:

```sh
docker exec <container> opencode providers list
```

See [OpenCode Local adapter](/adapters/opencode-local) for full configuration details.

Without API keys, the app runs normally — adapter environment checks will surface missing prerequisites.
