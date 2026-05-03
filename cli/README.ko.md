# Paperclip CLI

Paperclip CLI는 instance setup, diagnostics, control-plane operation을 담당합니다.

## 빠른 시작

```sh
pnpm paperclipai run
```

이 명령은 config가 없으면 onboard하고, doctor check를 실행한 뒤 server를 시작합니다.

기본 UI:

```text
http://localhost:3100
```

## 주요 명령

- `paperclipai onboard` — 첫 설치 설정
- `paperclipai run` — 설정 확인 후 server 시작
- `paperclipai doctor` — 환경 점검과 repair
- `paperclipai configure` — server/secrets/storage 설정 변경
- `paperclipai issue *` — issue 조회, 생성, 업데이트, checkout
- `paperclipai agent *` — agent 조회
- `paperclipai approval *` — approval 조회와 결정
- `paperclipai company *` — company 조회, import/export

자세한 한국어 문서는 [CLI 개요](../docs/ko/cli/overview.md), [setup commands](../docs/ko/cli/setup-commands.md), [control-plane commands](../docs/ko/cli/control-plane-commands.md)를 보세요.
