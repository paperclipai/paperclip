---
title: 資料庫
summary: 嵌入式 PGlite 與 Docker Postgres 與託管
---
Paperclip 透過 Drizzle ORM 使用 PostgreSQL。可以透過三種方式來運行資料庫。

## 1. 嵌入PostgreSQL（預設）

零配置。如果不設定`DATABASE_URL`，伺服器會自動啟動一個嵌入的PostgreSQL實例。

```sh
pnpm dev
```

第一次啟動時，伺服器：

1. 創建`~/.paperclip/instances/default/db/`進行存儲
2. 確保`paperclip`資料庫存在
3. 自動運行遷移
4. 開始處理請求

數據在重新啟動後仍然存在。重置：`rm -rf ~/.paperclip/instances/default/db`。

Docker 快速入門預設也使用嵌入式 PostgreSQL。

## 2.本地PostgreSQL（Docker）

對於本地完整的 PostgreSQL 伺服器：

```sh
docker compose up -d
```

這將在 `localhost:5432` 上啟動 PostgreSQL 17。設定連接字串：

```sh
cp .env.example .env
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

推送架構：

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. 託管PostgreSQL (Supabase)

對於生產，請使用託管供應商，例如 [Supabase](https://supabase.com/)。

1. 在[database.new](https://database.new)建立一個項目
2. 從專案設定 > 資料庫複製連接字串
3. 在你的`.env`中設定`DATABASE_URL`

使用**直接連接**（連接埠 5432）進行遷移，使用**池連接**（連接埠 6543）進行應用程式。

如果使用連線池，請停用準備好的語句：

```ts
// packages/db/src/client.ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

## 模式切換

| `DATABASE_URL` |模式|
|----------------|------|
|未設定 |嵌入式 PostgreSQL |
| `postgres://...localhost...` |本地 Docker PostgreSQL |
| `postgres://...supabase.com...` |主辦 Supabase |

無論模式為何，Drizzle 架構 (`packages/db/src/schema/`) 都是相同的。