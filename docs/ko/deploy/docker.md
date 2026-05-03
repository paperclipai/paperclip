---
title: Docker
summary: Docker Compose quickstart
---

# Docker

Node나 pnpm을 로컬에 설치하지 않고 Docker에서 Paperclip을 실행합니다.

## Compose quickstart

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

브라우저에서 `http://localhost:3100`을 엽니다.

기본값:

- host port: `3100`
- data directory: `./data/docker-paperclip`

override:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

`PAPERCLIP_DATA_DIR`는 compose file(`docker/`) 기준 상대 경로로 해석됩니다.

## Manual docker build

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

## Data persistence

bind mount 아래에 다음이 저장됩니다.

- embedded PostgreSQL data
- uploaded assets
- local secrets key
- agent workspace data

## Claude/Codex adapter

Docker image에는 `claude`와 `codex` CLI가 포함됩니다. container 내부 adapter run을 쓰려면 API key를 환경 변수로 전달합니다.

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
