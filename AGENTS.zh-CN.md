# AGENTS.zh-CN.md

本仓库中人类和 AI 贡献者的工作指南。

## 1. 目的

Paperclip 是 AI 代理公司的控制平面。
当前的实施目标是 V1，具体定义见 `doc/SPEC-implementation.md`。

## 2. 优先阅读

在进行更改之前，请按以下顺序阅读：

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` 是长期的产品上下文。
`doc/SPEC-implementation.md` 是具体的 V1 构建合约。

## 3. 仓库地图

- `server/`: Express REST API 和任务编排服务
- `ui/`: React + Vite 管理面板 UI
- `packages/db/`: Drizzle 模式、迁移和数据库客户端
- `packages/shared/`: 共享类型、常量、验证器和 API 路径常量
- `doc/`: 运营和产品文档

## 4. 开发设置（自动数据库）

在开发环境中，通过不设置 `DATABASE_URL` 来使用嵌入式 PGlite。

```sh
pnpm install
pnpm dev
```

这将启动：

- API: `http://localhost:3100`
- UI: `http://localhost:3100`（在开发中间件模式下由 API 服务器提供服务）

快速检查：

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

重置本地开发数据库：

```sh
rm -rf data/pglite
pnpm dev
```

## 5. 核心工程规则

1. **保持变更以公司为作用域**。
每个领域实体都应归属于一个公司，并且必须在路由/服务中强制执行公司边界。

2. **保持合约同步**。
如果您更改了模式/API 行为，请更新所有受影响的层：
- `packages/db` 模式和导出
- `packages/shared` 类型/常量/验证器
- `server` 路由/服务
- `ui` API 客户端和页面

3. **维护控制平面不变量**。
- 单执行者任务模型
- 原子问题检出语义
- 受控动作的审批门
- 预算硬停止自动暂停行为
- 变动操作的任务日志记录

4. **不要批发替换战略文档**。
除非被要求。倾向于增量更新。保持 `doc/SPEC.md` 和 `doc/SPEC-implementation.md` 一致。

## 6. 数据库变更工作流

更改数据模型时：

1. 编辑 `packages/db/src/schema/*.ts`
2. 确保新表已从 `packages/db/src/schema/index.ts` 导出
3. 生成迁移：

```sh
pnpm db:generate
```

4. 验证编译：

```sh
pnpm -r typecheck
```

注意：
- `packages/db/drizzle.config.ts` 从 `dist/schema/*.js` 读取编译后的模式
- `pnpm db:generate` 首先编译 `packages/db`

## 7. 交付前验证

在声称完成之前运行此完整检查：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

如果任何项无法运行，请明确说明未运行的原因。

## 8. API 和验证预期

- 基础路径: `/api`
- 控制面板访问被视为全权操作员上下文
- 代理（Agent）访问使用持有者 API 密钥（`agent_api_keys`），静态加密存储
- 代理密钥不得访问其他公司

添加端点时：

- 应用公司访问检查
- 强制执行参与者权限（控制面板 vs 代理）
- 为变动操作编写活动日志
- 返回一致的 HTTP 错误码 (`400/401/403/404/409/422/500`)

## 9. UI 预期

- 保持路由和导航与可用的 API 表面一致
- 在公司作用域页面使用公司选择上下文
- 清晰地显示失败信息；不要静默忽略 API 错误

## 10. 完成定义

当以下所有项均为真时，变更即视为完成：

1. 行为符合 `doc/SPEC-implementation.md`
2. 类型检查、测试和构建通过
3. 合约在 db/shared/server/ui 之间同步
4. 当行为或命令发生变化时，文档已更新
