---
title: Local Development
summary: 로컬 개발 환경 설정
---

# Local Development

외부 dependency 없이 Paperclip을 로컬에서 실행합니다.

## Prerequisites

- Node.js 20+
- pnpm 9+

## Dev server 시작

```sh
pnpm install
pnpm dev
```

실행되는 것:

- API server: `http://localhost:3100`
- UI: API server와 same origin dev middleware

Docker나 외부 database는 필요 없습니다. embedded PostgreSQL을 자동 사용합니다.

## One-command bootstrap

```sh
pnpm paperclipai run
```

config가 없으면 onboard하고, doctor를 repair enabled로 실행한 뒤 server를 시작합니다.

## Private network bind

기본 `pnpm dev`는 `local_trusted`와 loopback binding입니다.

private network에서 login enabled로 열려면:

```sh
pnpm dev --bind lan
```

Tailscale 주소에 bind:

```sh
pnpm dev --bind tailnet
```

추가 private hostname 허용:

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

## Health checks

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

## Reset dev data

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## Data locations

| Data | Path |
| --- | --- |
| Config | `~/.paperclip/instances/default/config.json` |
| Database | `~/.paperclip/instances/default/db` |
| Storage | `~/.paperclip/instances/default/data/storage` |
| Secrets key | `~/.paperclip/instances/default/secrets/master.key` |
| Logs | `~/.paperclip/instances/default/logs` |
