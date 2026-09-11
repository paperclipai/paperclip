# Coolie 本地启动笔记 (M-A 验证记录)

> 定开分支：`coolie/customization`（fork 自 paperclip，MIT）
> 本文件是新增笔记，未改动 paperclip 核心代码。

## 环境要求

- Node **24**（仓库 `.nvmrc` 指定；沙箱默认 22，需 `nvm use 24`）
- pnpm 9.x
- 无需外部数据库：不设 `DATABASE_URL` 时自动使用内嵌 PostgreSQL 18

## 安装 + 构建

```sh
nvm use 24
pnpm install

# 服务端依赖的 TS 工作区包需先构建（否则报 ERR_MODULE_NOT_FOUND: plugin-sdk/dist）
pnpm --filter @paperclipai/shared build
pnpm --filter @paperclipai/db build
pnpm --filter @paperclipai/adapter-utils build
pnpm --filter @paperclipai/plugin-sdk build
pnpm --filter @paperclipai/skills-catalog build
pnpm --filter @paperclipai/teams-catalog build
```

> 注：`pnpm build`（全量）会编译 `packages/paperclip-runner` 的 Rust 组件
> （aws-lc-sys / ring 等），非常耗时，且**控制平面冒烟不需要**。只在做本地
> coding-agent adapter（ACP runtime）时才需要那块。

## 启动（控制平面 headless，端口 3100）

```sh
PORT=3100 SERVE_UI=false \
BETTER_AUTH_SECRET=dev-secret \
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=dev-tool-secret \
HOST=127.0.0.1 \
pnpm --filter @paperclipai/server dev
```

健康检查：

```sh
curl http://127.0.0.1:3100/api/health   # -> {"status":"ok", ...}
```

## Root 容器环境的两个坑（如在 root 沙箱里跑）

内嵌 PostgreSQL **不允许以 root 运行**。在 root 容器里需要：

1. **建一个非 root 用户来跑 server**（PG 拒绝 root）：
   ```sh
   useradd -m coolie
   # 数据目录默认落在该用户 HOME：~/.paperclip/instances/default/db
   ```
2. **保证 `/tmp` 可写**（PG 的 unix socket / lock 文件放 `/tmp`）：
   ```sh
   chmod 1777 /tmp
   ```
   否则报 `could not create lock file "/tmp/.s.PGSQL.<port>.lock": Permission denied`。

普通 Linux/Mac 开发机（非 root）无需这两步，直接 `pnpm --filter @paperclipai/server dev` 即可。

## M-A 验证结果（已通过）✅

- Node 24 + `pnpm install` 成功
- 6 个核心 TS 包构建成功
- server 启动：embedded PostgreSQL 18.1、迁移自动应用、心跳启用、备份启用
- `GET /api/health` → `{"status":"ok","version":"0.3.1","deploymentMode":"local_trusted","authReady":true,"bootstrapStatus":"ready"}`
