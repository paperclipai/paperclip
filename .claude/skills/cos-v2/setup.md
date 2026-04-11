---
name: setup
description: COS v2 개발 환경 자동 셋업. 새 머신에서 /cos-v2:setup 실행하면 의존성 설치 + DB 연결 + 서버 시작까지 완료.
---

# COS v2 환경 셋업

새 머신이나 클린 clone에서 COS v2를 바로 실행 가능하게 만든다.

## 순서

1. **의존성 설치 + 빌드**
```bash
pnpm install
pnpm --filter @paperclipai/shared build
pnpm --filter @paperclipai/db build
pnpm --filter @paperclipai/plugin-sdk build
```

2. **Paperclip config 디렉토리 생성**
```bash
mkdir -p ~/.paperclip/instances/default
```

3. **config.json 생성** — `~/.paperclip/instances/default/config.json`
   - DB URL은 `company/private-data/env/cos-v2.env`에서 읽기
   - 파일이 없으면 사용자에게 DATABASE_URL 물어보기
   - config 템플릿:
```json
{
  "$meta": { "version": 1, "source": "cos-v2-setup" },
  "database": {
    "mode": "external",
    "url": "<DATABASE_URL from cos-v2.env>"
  },
  "server": {
    "deploymentMode": "local_trusted",
    "exposure": "private",
    "host": "127.0.0.1",
    "port": 3101,
    "serveUi": true
  },
  "auth": { "baseUrlMode": "auto" },
  "storage": {
    "provider": "local_disk",
    "localDisk": { "baseDir": "~/.paperclip/instances/default/data/storage" }
  },
  "secrets": {
    "provider": "local_encrypted",
    "strictMode": false,
    "localEncrypted": { "keyFilePath": "~/.paperclip/instances/default/secrets/master.key" }
  }
}
```
   - `~` 경로는 실제 홈 디렉토리로 치환
   - 이미 config.json이 있으면 database.url만 업데이트

4. **PORT 환경변수 설정** — `.env` 파일에 `PORT=3101` 쓰기 (없으면)

5. **마이그레이션 실행**
```bash
pnpm --filter @paperclipai/db migrate
```

6. **서버 시작**
```bash
PORT=3101 pnpm dev
```

7. **Health 확인** — `curl http://127.0.0.1:3101/api/health` 응답 대기

8. **완료 메시지** — URL 안내: `http://127.0.0.1:3101`

## 주의

- `company/private-data/`는 gitignore. 별도 복사 필요하면 안내.
- embedded PG를 쓰려면 config의 `database.mode`를 `embedded-postgres`로 변경하라고 안내.
- Mac Studio 배포는 `/cos-v2` 스킬의 별도 플로우.
