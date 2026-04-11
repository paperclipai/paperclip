# COS v2 — 새 머신 셋업

## 1. 필수 설치
```bash
pnpm install && pnpm --filter @paperclipai/shared build && pnpm --filter @paperclipai/db build
```

## 2. DB 설정 (택 1)

### A. Neon (클라우드 — 멀티머신 공유)
`~/.paperclip/instances/default/config.json`의 database 섹션:
```json
{
  "database": {
    "mode": "external",
    "url": "<company/private-data/env/cos-v2.env의 DATABASE_URL>"
  }
}
```

### B. Embedded PG (로컬 — 빠름)
```json
{
  "database": {
    "mode": "embedded-postgres",
    "embeddedPostgresPort": 54329
  }
}
```
첫 실행 시 자동 마이그레이션.

## 3. 서버 시작
```bash
PORT=3101 pnpm dev
```

## 4. 최초 실행 시 (embedded만)
```bash
pnpm paperclipai onboard
# 또는 seed: pnpm tsx scripts/seed-cos-v2.ts --port 3101
```
