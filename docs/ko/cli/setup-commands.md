---
title: Setup Commands
summary: onboard, run, doctor, configure
---

# Setup Commands

Paperclip instance setup과 diagnostics 명령입니다.

## `paperclipai run`

```sh
pnpm paperclipai run
```

한 번에 다음을 수행합니다.

1. config가 없으면 auto-onboard
2. repair enabled로 `paperclipai doctor` 실행
3. check 통과 시 server 시작

특정 instance:

```sh
pnpm paperclipai run --instance dev
```

## `paperclipai onboard`

```sh
pnpm paperclipai onboard
```

첫 설치용 interactive setup입니다. 기존 config가 있으면 보존하며, 설정 변경은 `paperclipai configure`를 사용합니다.

빠른 시작:

```sh
pnpm paperclipai onboard --yes
```

설정 후 바로 실행:

```sh
pnpm paperclipai onboard --run
```

## `paperclipai doctor`

```sh
pnpm paperclipai doctor
pnpm paperclipai doctor --repair
```

server configuration, database, secrets, storage, missing key file을 검사하고 필요하면 repair합니다.

## `paperclipai configure`

```sh
pnpm paperclipai configure --section server
pnpm paperclipai configure --section secrets
pnpm paperclipai configure --section storage
```

## `paperclipai env`

```sh
pnpm paperclipai env
```

resolved environment configuration을 보여줍니다. `PAPERCLIP_BIND`, `PAPERCLIP_BIND_HOST` 같은 bind 설정도 포함됩니다.

## `paperclipai allowed-hostname`

```sh
pnpm paperclipai allowed-hostname my-tailscale-host
```

authenticated/private mode에서 private hostname을 allowlist에 추가합니다.

## Local storage paths

| Data | Default path |
| --- | --- |
| Config | `~/.paperclip/instances/default/config.json` |
| Database | `~/.paperclip/instances/default/db` |
| Logs | `~/.paperclip/instances/default/logs` |
| Storage | `~/.paperclip/instances/default/data/storage` |
| Secrets key | `~/.paperclip/instances/default/secrets/master.key` |

환경 변수로 override:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```
