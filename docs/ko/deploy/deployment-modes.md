---
title: Deployment Modes
summary: local_trusted vs authenticated(private/public)
---

# Deployment Modes

Paperclip은 보안 profile이 다른 runtime mode를 지원합니다. 실제 reachability는 `bind` 설정으로 별도 제어합니다.

## `local_trusted`

단일 운영자의 로컬 사용에 최적화된 기본 모드입니다.

- host binding: loopback only
- bind: `loopback`
- auth: 로그인 없음
- board identity: local board user 자동 생성

## `authenticated` + `private`

Tailscale, VPN, LAN 같은 private network 접근용입니다.

- Better Auth login 필요
- auto base URL mode
- private-host trust policy 필요
- bind는 `loopback`, `lan`, `tailnet`, `custom` 중 선택

custom Tailscale hostname 허용:

```sh
pnpm paperclipai allowed-hostname my-machine
```

## `authenticated` + `public`

internet-facing deployment용입니다.

- 로그인 필요
- explicit public URL 필요
- doctor에서 더 엄격한 deployment check
- 보통 reverse proxy 뒤에서 `loopback` bind

## Board claim flow

`local_trusted`에서 `authenticated`로 이동하면 startup 때 one-time claim URL이 출력됩니다.

```text
/board-claim/<token>?code=<code>
```

로그인한 user가 이 URL을 방문하면 board ownership을 claim하고 instance admin이 됩니다.

## 모드 변경

```sh
pnpm paperclipai configure --section server
```

환경 변수 override:

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_BIND=lan pnpm paperclipai run
```
