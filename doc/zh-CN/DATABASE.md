# 数据库

Paperclip 通过 [Drizzle ORM](https://orm.drizzle.team/) 使用 PostgreSQL。运行数据库的方法有三种，从最简单到最适合生产。

## 1. 嵌入式 PostgreSQL — 零配置

如果不设置`DATABASE_URL`，服务器会自动启动一个嵌入的PostgreSQL实例并管理本地数据目录。

```sh
pnpm dev
```

就是这样。首次启动服务器时：

1、创建`~/.paperclip/instances/default/db/`目录用于存储
2. 确保`paperclip`数据库存在
3. 对空数据库自动运行迁移
4. 开始处理请求

重新启动后数据仍保留在 `~/.paperclip/instances/default/db/` 中。要重置本地开发数据，请删除该目录。

如果您需要手动应用挂起的迁移，请运行：

```sh
pnpm db:migrate
```

当 `DATABASE_URL` 未设置时，此命令针对活动 Paperclip 配置/实例的当前嵌入 PostgreSQL 实例。

此模式非常适合本地开发和单命令安装。

Docker 注意：Docker 快速入门映像默认也使用嵌入的 PostgreSQL。保留 `/paperclip` 以在容器重新启动时保留数据库状态（请参阅 `doc/DOCKER.md`）。

## 2.本地PostgreSQL (Docker)

对于本地完整的 PostgreSQL 服务器，请使用附带的 Docker Compose 设置：

```sh
docker compose up -d
```

这将在 `localhost:5432` 上启动 PostgreSQL 17。然后设置连接字符串：

```sh
cp .env.example .env
# .env already contains:
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

运行迁移（一旦迁移生成问题得到解决）或使用 `drizzle-kit push`：

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

启动服务器：

```sh
pnpm dev
```

## 3. 托管PostgreSQL (Supabase)

对于生产，请使用托管 PostgreSQL 提供程序。 [Supabase](https://supabase.com/) 是一个不错的选择，具有免费套餐。

### 设置

1. 在[database.new](https://database.new)创建一个项目
2. 转到 **项目设置 > 数据库 > 连接字符串**
3. 复制 URI 并将密码占位符替换为您的数据库密码

### 连接字符串

Supabase提供两种连接方式：

**直接连接**（端口 5432）- 用于迁移和一次性脚本：

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**通过 Supavisor 进行连接池**（端口 6543）— 用于应用程序：

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

### 配置

在您的 `.env` 中设置 `DATABASE_URL`：

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

如果使用连接池（端口 6543），`postgres` 客户端必须禁用准备好的语句。更新`packages/db/src/client.ts`：

```ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

### 推送模式

```sh
# Use the direct connection (port 5432) for schema changes
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@...5432/postgres \
  npx drizzle-kit push
```

### 免费等级限制

- 500 MB 数据库存储
- 200个并发连接
- 项目在 1 周不活动后暂停

有关当前详细信息，请参阅 [Supabase 定价](https://supabase.com/pricing)。

## 模式切换

数据库模式由`DATABASE_URL`控制：| `DATABASE_URL` |模式|
|---|---|
|未设置 |嵌入式 PostgreSQL (`~/.paperclip/instances/default/db/`) |
| `postgres://...localhost...` |本地 Docker PostgreSQL |
| `postgres://...supabase.com...` |主办 Supabase |

无论模式如何，您的 Drizzle 架构 (`packages/db/src/schema/`) 都保持不变。

## 秘密存储

Paperclip 将秘密元数据和版本存储在：

- `company_secrets`
- `company_secret_versions`

对于本地/默认安装，活动提供程序是 `local_encrypted`：

- 秘密材料使用本地主密钥进行静态加密。
- 默认密钥文件：`~/.paperclip/instances/default/secrets/master.key`（如果丢失则自动创建）。
- CLI 配置位置：`secrets.localEncrypted.keyFilePath` 下的 `~/.paperclip/instances/default/config.json`。

可选覆盖：

- `PAPERCLIP_SECRETS_MASTER_KEY`（32 字节密钥为 base64、十六进制或原始 32 字符字符串）
- `PAPERCLIP_SECRETS_MASTER_KEY_FILE`（自定义密钥文件路径）

严格模式阻止新的内联敏感环境值：

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

您可以通过以下方式设置严格模式和提供程序默认值：

```sh
pnpm paperclipai configure --section secrets
```

内联秘密迁移命令：

```sh
pnpm secrets:migrate-inline-env --apply
```