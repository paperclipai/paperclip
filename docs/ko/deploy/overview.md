---
title: Deployment Overview
summary: Paperclip 배포 모드 요약
---

# Deployment Overview

Paperclip은 로컬 실험부터 인터넷 공개 운영까지 세 가지 배포 구성을 지원합니다.

## Deployment modes

| Mode | Auth | 적합한 경우 |
| --- | --- | --- |
| `local_trusted` | 로그인 없음 | 단일 운영자의 로컬 머신 |
| `authenticated` + `private` | 로그인 필요 | Tailscale, VPN, LAN 같은 private network |
| `authenticated` + `public` | 로그인 필요 | 인터넷 공개 cloud deployment |

## Local trusted

- loopback only binding, localhost에서만 접근
- human login flow 없음
- 가장 빠르게 시작 가능
- solo development와 실험에 적합

## Authenticated + private

- Better Auth 기반 로그인 필요
- 네트워크 접근을 위해 all interfaces에 bind
- private network 내부 팀 접근에 적합
- Tailscale, VPN, LAN 환경에 맞음

## Authenticated + public

- 로그인 필요
- 명시적인 public URL 필요
- 보안 체크가 더 엄격함
- cloud hosting, internet-facing deployment에 적합

## 선택 기준

- 그냥 써보는 중이면 기본값인 `local_trusted`
- 팀이 private network에서 함께 쓰면 `authenticated` + `private`
- cloud에 올리면 `authenticated` + `public`

onboarding 중 설정할 수 있습니다.

```sh
pnpm paperclipai onboard
```

나중에 변경하려면:

```sh
pnpm paperclipai configure --section server
```
