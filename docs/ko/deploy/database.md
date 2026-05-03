---
title: Database
summary: Embedded PGlite, Docker Postgres, hosted Postgres
---

# Database

Paperclip은 Drizzle ORM을 통해 PostgreSQL을 사용합니다. 세 가지 실행 방식이 있습니다.

## 1. Embedded PostgreSQL

기본값입니다. `DATABASE_URL`을 설정하지 않으면 server가 embedded PostgreSQL instance를 자동으로 시작합니다.

```sh
pnpm dev
```

첫 시작 시:

1. `~/.paperclip/instances/default/db/` 생성
2. `paperclip` database 보장
3. migration 자동 실행
4. request serving 시작

초기화하려면:

```sh
rm -rf ~/.paperclip/instances/default/db
```

## 2. Local PostgreSQL with Docker

```sh
docker compose up -d
```

PostgreSQL 17이 `localhost:5432`에서 실행됩니다.

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. Hosted PostgreSQL

production에서는 Supabase 같은 hosted provider를 사용할 수 있습니다. migration에는 direct connection, application에는 pooled connection을 쓰는 구성이 일반적입니다.

connection pooling을 사용할 때 prepared statement를 비활성화해야 할 수 있습니다.

```ts
const sql = postgres(url, { prepare: false });
```

## 모드 선택

| `DATABASE_URL` | Mode |
| --- | --- |
| unset | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted PostgreSQL |
