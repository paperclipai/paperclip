---
title: 数据库
summary: 嵌入式 PGlite 与 Docker Postgres 与托管
---
Paperclip 通过 Drizzle ORM 使用 PostgreSQL。可以通过三种方式来运行数据库。

## 1. 嵌入PostgreSQL（默认）

零配置。如果不设置`DATABASE_URL`，服务器会自动启动一个嵌入的PostgreSQL实例。

```sh
pnpm dev
```

第一次启动时，服务器：

1、创建`~/.paperclip/instances/default/db/`进行存储
2. 确保`paperclip`数据库存在
3. 自动运行迁移
4. 开始处理请求

数据在重新启动后仍然存在。重置：`rm -rf ~/.paperclip/instances/default/db`。

Docker 快速入门默认情况下也使用嵌入式 PostgreSQL。

## 2.本地PostgreSQL（Docker）

对于本地完整的 PostgreSQL 服务器：

```sh
docker compose up -d
```

这将在 `localhost:5432` 上启动 PostgreSQL 17。设置连接字符串：

```sh
cp .env.example .env
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

推送架构：

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. 托管PostgreSQL (Supabase)

对于生产，请使用托管提供商，例如 [Supabase](https://supabase.com/)。

1. 在[database.new](https://database.new)创建一个项目
2. 从项目设置 > 数据库复制连接字符串
3. 在你的`.env`中设置`DATABASE_URL`

使用**直接连接**（端口 5432）进行迁移，使用**池连接**（端口 6543）进行应用程序。

如果使用连接池，请禁用准备好的语句：

```ts
// packages/db/src/client.ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

## 模式切换

| `DATABASE_URL` |模式|
|----------------|------|
|未设置 |嵌入式 PostgreSQL |
| `postgres://...localhost...` |本地 Docker PostgreSQL |
| `postgres://...supabase.com...` |主办 Supabase |

无论模式如何，Drizzle 架构 (`packages/db/src/schema/`) 都是相同的。