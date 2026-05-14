---
title: 数据库
summary: 嵌入式 PGlite vs Docker Postgres vs 托管
---

Paperclip 通过 Drizzle ORM 使用 PostgreSQL。有三种运行数据库的方式。

## 1. 嵌入式 PostgreSQL（默认）

零配置。如果你不设置 `DATABASE_URL`，服务器会自动启动嵌入式 PostgreSQL 实例。

```sh
pnpm dev
```

首次启动时，服务器：

1. 为存储创建 `~/.paperclip/instances/default/db/`
2. 确保 `paperclip` 数据库存在
3. 自动运行迁移
4. 开始处理请求

数据在重新启动后持续存在。要重置：`rm -rf ~/.paperclip/instances/default/db`。

Docker 快速入门默认也使用嵌入式 PostgreSQL。

## 2. 本地 PostgreSQL（Docker）

对于完整的本地 PostgreSQL 服务器：

```sh
docker compose up -d
```

这在 `localhost:5432` 上启动 PostgreSQL 17。设置连接字符串：

```sh
cp .env.example .env
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

推送模式：

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. 托管 PostgreSQL（Supabase）

对于生产，使用托管提供商，如 [Supabase](https://supabase.com/)。

1. 在 [database.new](https://database.new) 创建一个项目
2. 从项目设置 > 数据库复制连接字符串
3. 在你的 `.env` 中设置 `DATABASE_URL`

对于迁移使用**直接连接**（端口 5432），对于应用程序使用**池化连接**（端口 6543）。

如果使用连接池，请禁用预处理语句：

```ts
// packages/db/src/client.ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

## 模式切换

| `DATABASE_URL` | 模式 |
|----------------|------|
| 未设置 | 嵌入式 PostgreSQL |
| `postgres://...localhost...` | 本地 Docker PostgreSQL |
| `postgres://...supabase.com...` | 托管 Supabase |

无论模式如何，Drizzle 模式（`packages/db/src/schema/`）都是相同的。