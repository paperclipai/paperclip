---
title: Tailscale Private Access
summary: Tailscale 또는 private LAN/VPN에서 Paperclip 접근
---

# Tailscale Private Access

`localhost`가 아니라 Tailscale, LAN, VPN을 통해 다른 기기에서 Paperclip에 접근하려면 이 설정을 사용합니다.

## 1. Private authenticated mode로 시작

```sh
pnpm dev --bind tailnet
```

권장 동작:

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
- `PAPERCLIP_BIND=tailnet`

LAN 전체에 열려면:

```sh
pnpm dev --bind lan
```

## 2. Tailscale 주소 확인

```sh
tailscale ip -4
```

또는 MagicDNS hostname을 사용할 수 있습니다.

## 3. 다른 기기에서 열기

```text
http://<tailscale-host-or-ip>:3100
```

## 4. Custom private hostname 허용

```sh
pnpm paperclipai allowed-hostname my-macbook.tailnet.ts.net
```

## 5. Reachability 확인

```sh
curl http://<tailscale-host-or-ip>:3100/api/health
```

예상 응답:

```json
{"status":"ok"}
```

## Troubleshooting

- private hostname에서 login/redirect error가 나면 `allowed-hostname`에 추가합니다.
- `localhost`에서만 되면 `--bind lan` 또는 `--bind tailnet`으로 시작했는지 확인합니다.
- 원격에서 접속 안 되면 두 기기가 같은 Tailscale network에 있고 port `3100`이 reachable한지 확인합니다.
