---
name: setup
description: COS v2 개발 환경 자동 셋업. 새 머신에서 /cos-v2:setup 실행하면 의존성 설치 + DB 연결 + 서버 시작까지 완료.
---

# COS v2 환경 셋업

새 머신이나 포맷 후 COS v2를 바로 실행 가능하게 만든다.
**직접 실행(로컬)과 SSH 원격 실행 모두 지원.**

## 자동 스크립트 (권장)

```bash
./scripts/setup.sh
```

환경변수로 커스터마이즈:
```bash
COS_DB_URL="postgresql://cloud_admin@localhost:55433/cos" \
COS_PORT=3100 \
COS_HOST=0.0.0.0 \
COS_TAILSCALE_HOST="mac-studio.tail9b5d74.ts.net" \
./scripts/setup.sh
```

스크립트가 처리하는 항목:
1. Homebrew 설치
2. Node.js 24 설치 (node-pty ABI: <25 필수)
3. `.zshenv` PATH 설정 (SSH non-interactive에서도 동작)
4. Docker 확인
5. `pnpm install` + 워크스페이스 빌드
6. `~/.paperclip/instances/default/config.json` 생성
7. `.env` 생성
8. PM2 + `ecosystem.config.cjs` 생성
9. macOS 방화벽 Node.js 허용

## 수동 셋업 (스크립트 불가 시)

### 1. 의존성 설치 + 빌드
```bash
pnpm install
pnpm --filter @paperclipai/shared build
pnpm --filter @paperclipai/db build
pnpm --filter @paperclipai/plugin-sdk build
```

### 2. config.json — `~/.paperclip/instances/default/config.json`

**Embedded PG (기본 — 로컬 개발):**
```json
{
  "$meta": { "version": 1, "source": "cos-v2-setup" },
  "database": {
    "mode": "embedded-postgres",
    "embeddedPostgresPort": 54329
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

**외부 Neon DB (Mac Studio 배포용):**
```json
{
  "$meta": { "version": 1, "source": "cos-v2-setup" },
  "database": {
    "mode": "postgres",
    "connectionString": "postgresql://cloud_admin@localhost:55433/cos"
  },
  "server": {
    "deploymentMode": "authenticated",
    "exposure": "private",
    "host": "0.0.0.0",
    "port": 3100,
    "serveUi": true,
    "allowedHostnames": ["mac-studio.tail9b5d74.ts.net", "100.98.136.93"]
  },
  "auth": { "baseUrlMode": "auto" }
}
```

### 3. .env
```
PORT=3100
DATABASE_URL=postgresql://cloud_admin@localhost:55433/cos
```

### 4. 서버 시작
```bash
# PM2 (권장 — 재부팅 시 자동 복구)
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # 시스템 부팅 시 자동 시작

# 직접 실행
pnpm dev
```

### 5. Health 확인
```bash
curl http://localhost:3100/api/health
```

## 포맷 후 전체 복구 순서

```bash
# 1. repo 클론
git clone <repo-url> ~/Projects/company-os-v2
cd ~/Projects/company-os-v2

# 2. setup 실행
COS_DB_URL="postgresql://cloud_admin@localhost:55433/cos" \
COS_PORT=3100 \
COS_TAILSCALE_HOST="mac-studio.tail9b5d74.ts.net" \
./scripts/setup.sh

# 3. Neon Docker (외부 DB 사용 시)
./scripts/setup-local-postgres.sh

# 4. PM2로 서비스 등록
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup

# 5. 확인
curl http://localhost:3100/api/health
```

## SSH 원격 작업

`.zshenv`에 PATH가 설정되므로 아래가 바로 동작:
```bash
ssh mac-studio "node --version"
ssh mac-studio "pm2 list"
ssh mac-studio "pm2 restart cos-v2-server"
ssh mac-studio "cd ~/Projects/company-os-v2 && git pull && pm2 restart cos-v2-server"
```

## 주의

- **Node.js <25 필수** — node-pty ABI 호환성. `.nvmrc`에 `24` 고정.
- `company/private-data/`는 gitignore. 별도 복사 필요하면 안내.
- macOS 방화벽: Node.js 수신 연결 허용 필요 (Tailscale 접속 시).
- PM2 데몬은 Node 24 PATH가 활성화된 셸에서 시작할 것.
