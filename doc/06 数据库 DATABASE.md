# 数据库（Database）

> **路径（path）**：`doc/DATABASE.md`。连接串、命令与 JSON 保持可执行英文原文。

Paperclip 通过 [Drizzle ORM](https://orm.drizzle.team/) 使用 PostgreSQL。数据库有三种跑法，从简到生产依次为：

## 1. 嵌入式 PostgreSQL（Embedded PostgreSQL）——零配置

若**未设置** `DATABASE_URL`，服务器会自动启动嵌入式 PostgreSQL，并管理本地数据目录。

```sh
pnpm dev
```

首次启动时服务器会：

1. 创建 `~/.paperclip/instances/default/db/` 目录存放数据  
2. 确保 `paperclip` 数据库存在  
3. 对空库自动执行 **migrations（迁移）**  
4. 开始处理请求  

数据持久化在 `~/.paperclip/instances/default/db/`，重启后仍在。若要清空本地开发数据，删除该目录即可。

若需**手动**应用待处理迁移：

```sh
pnpm db:migrate
```

当 `DATABASE_URL` **未设置**时，该命令作用于当前嵌入式 PostgreSQL 实例（与当前 Paperclip **config / instance** 对应）。

Issue **reference mentions（引用提及）** 跟踪走正常迁移路径：schema 迁移会建表，但**不会**自动回填历史 issue 标题、描述、评论或文档。

迁移后若要**手工回填**已有内容，运行：

```sh
pnpm issue-references:backfill
# 可选：只处理一家公司
pnpm issue-references:backfill -- --company <company-id>
```

此后新的 issue、评论、文档写入会自动同步引用，无需再跑回填命令。

该模式适合本地开发与一键安装。

Docker 说明：Docker quickstart 镜像默认也用嵌入式 PostgreSQL。持久化 `/paperclip` 以在容器重启间保留 DB 状态（见 `doc/DOCKER.md`）。

## 2. 本地 PostgreSQL（Docker）

若要完整本地 PostgreSQL 服务，可用自带 Docker Compose：

```sh
docker compose up -d
```

会在 `localhost:5432` 启动 PostgreSQL 17。然后设置连接串：

```sh
cp .env.example .env
# .env 中已含：
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

执行迁移：

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  pnpm db:migrate
```

启动服务：

```sh
pnpm dev
```

## 3. 托管 PostgreSQL（Supabase）

生产环境可使用托管 PostgreSQL。[Supabase](https://supabase.com/) 提供免费档，较易上手。

### 配置步骤

1. 在 [database.new](https://database.new) 创建项目  
2. 打开 **Project Settings > Database > Connection string**  
3. 复制 URI，把密码占位符换成你的数据库密码  

### 连接串（connection string）

Supabase 提供两种连接模式：

**直连（Direct）**（端口 `5432`）——用于迁移与一次性脚本：

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**连接池 Supavisor**（端口 `6543`）——用于应用运行时：

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

### 配置应用

应用运行时，除非数据库客户端对所用 pooling 模式有明确的 **prepared statement（预编译语句）** 配置，否则应使用**直连** PostgreSQL：

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

若运行时用**池化** URL，请另设 `DATABASE_MIGRATION_URL` 指向**直连** URL。Paperclip 用它做启动 schema 检查/迁移与插件命名空间迁移；应用查询仍用 `DATABASE_URL`：

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
DATABASE_MIGRATION_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

若托管库**仅允许 transaction pooling（事务级池化）**连接，在本文档记录 runtime pooling 支持之前，请对 Paperclip 使用直连或 session 池化连接。**不要**为了部署去改数据库客户端源码。

### 推送 schema

```sh
# schema 变更请用直连（端口 5432）
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@...5432/postgres \
  pnpm db:migrate
```

### 免费档限制

- 数据库约 500 MB  
- 约 200 并发连接  
- 项目约 1 周无活动会暂停  

当前细则见 [Supabase pricing](https://supabase.com/pricing)。

## 模式切换（Switching between modes）

由 `DATABASE_URL` 决定模式：

| `DATABASE_URL` | 模式 |
|---|---|
| 未设置 | 嵌入式 PostgreSQL（`~/.paperclip/instances/default/db/`） |
| `postgres://...localhost...` | 本地 Docker PostgreSQL |
| `postgres://...supabase.com...` | 托管 Supabase |

你的 Drizzle schema（`packages/db/src/schema/`）在各模式下保持一致。

## 插件数据库命名空间（Plugin database namespaces）

插件运行时跟踪插件拥有的 DB 命名空间与迁移，表为 `plugin_database_namespaces`、`plugin_migrations`。若托管部署把运行时与迁移连接分开，应设置 `DATABASE_MIGRATION_URL`；存在时，插件命名空间迁移走迁移连接。

## 备份（Backups）

Paperclip 支持自动与手动**逻辑备份**（logical database backups）。备份包含非系统 schema（如 `public`）、Drizzle 迁移日志以及插件拥有的 schema。当前 `paperclipai db:backup` / `pnpm db:backup` 命令与保留策略见 `doc/DEVELOPING.md`。

数据库备份**不包含**非数据库实例文件：本地上传、工作区文件或本地加密 secrets 的 master key 等。需要完整实例灾备时，请**另行**备份这些路径。

## 秘钥存储（Secret storage）

Paperclip 在下列表中存放秘钥元数据与版本：

- `company_secrets`  
- `company_secret_versions`  

本地/默认安装下，激活的 provider 为 `local_encrypted`：

- 秘钥材料使用本地 **master key（主密钥）** 静态加密。  
- 默认密钥文件：`~/.paperclip/instances/default/secrets/master.key`（缺失时可自动创建）。  
- CLI 配置位置：`~/.paperclip/instances/default/config.json` 内 `secrets.localEncrypted.keyFilePath`。  
- 备份/恢复需同时有数据库元数据与本地 master key 文件；单独任一都不足以恢复。  
- 服务器会尽力强制密钥文件权限 `0600`；provider 健康检查会报告权限告警。  

可选覆盖：

- `PAPERCLIP_SECRETS_MASTER_KEY`（32 字节密钥，base64 / hex / 原始 32 字符）  
- `PAPERCLIP_SECRETS_MASTER_KEY_FILE`（自定义密钥文件路径）  

阻止新的内联敏感环境值的 **strict mode（严格模式）**：

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

可通过：

```sh
pnpm paperclipai configure --section secrets
```

设置严格模式与 provider 默认值。

内联秘钥迁移命令：

```sh
pnpm paperclipai secrets migrate-inline-env --company-id <company-id> --apply

# 直接维护数据库时的兜底
pnpm secrets:migrate-inline-env --apply
```

托管 AWS provider 的补充说明见 [`SECRETS-AWS-PROVIDER.md`](./SECRETS-AWS-PROVIDER.md)。
