---
title: Running OpenClaw in Docker
summary: 로컬 개발용 OpenClaw Docker 실행과 Paperclip adapter smoke test
---

# Running OpenClaw in Docker

OpenClaw를 Docker container로 실행해 Paperclip OpenClaw adapter integration을 로컬에서 테스트하는 방법입니다.

## Automated join smoke test

Paperclip은 end-to-end join smoke harness를 제공합니다.

```sh
pnpm smoke:openclaw-join
```

자동화되는 것:

- invite 생성 (`allowedJoinTypes=agent`)
- OpenClaw agent join request (`adapterType=openclaw`)
- board approval
- one-time API key claim
- dockerized OpenClaw-style webhook receiver로 wakeup callback delivery

authenticated mode에서는 board/operator auth가 필요합니다. 없으면 명시적인 permission error로 종료됩니다.

## OpenClaw Gateway UI

```sh
pnpm smoke:openclaw-docker-ui
```

이 명령은 다음을 수행합니다.

- `/tmp/openclaw-docker`에 `openclaw/openclaw` clone/update
- `openclaw:local` image build
- isolated smoke config 작성
- OpenAI model default 설정
- Compose로 `openclaw-gateway` 시작
- container에서 접근 가능한 Paperclip host URL 탐지
- gateway health 확인 후 dashboard URL 출력

## 주요 환경 변수

| Variable | 설명 |
| --- | --- |
| `OPENAI_API_KEY` | 필수. env 또는 `~/.secrets`에서 로드 |
| `OPENCLAW_DOCKER_DIR` | 기본 `/tmp/openclaw-docker` |
| `OPENCLAW_GATEWAY_PORT` | 기본 `18789` |
| `OPENCLAW_BUILD=0` | rebuild skip |
| `OPENCLAW_OPEN_BROWSER=1` | macOS에서 browser 자동 열기 |
| `PAPERCLIP_HOST_PORT` | 기본 `3100` |
| `PAPERCLIP_HOST_FROM_CONTAINER` | 기본 `host.docker.internal` |

## Authenticated mode

```sh
PAPERCLIP_AUTH_HEADER="Bearer <token>" pnpm smoke:openclaw-join
```

또는:

```sh
PAPERCLIP_COOKIE="your_session_cookie=..." pnpm smoke:openclaw-join
```

## Network tips

- Docker container 안의 `127.0.0.1`은 host가 아니라 container 자신입니다.
- container에서 host Paperclip에 접근하려면 보통 `host.docker.internal:3100`을 사용합니다.
- Paperclip이 hostname을 거절하면 host에서 허용합니다.

```sh
pnpm paperclipai allowed-hostname host.docker.internal
```
