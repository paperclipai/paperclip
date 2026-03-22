# Cursor 云端智能体适配器——技术计划

## 概述

本文档定义了 Paperclip 适配器的 V1 设计，该适配器通过 Cursor REST API 与 Cursor Background Agents 集成。

主要参考：

- https://docs.cursor.com/background-agent/api/overview
- https://docs.cursor.com/background-agent/api
- https://docs.cursor.com/background-agent/api/webhooks

与 `claude_local` 和 `codex_local` 不同，这个适配器不是本地子进程。它是一个远程编排适配器，具有：

1. 通过 HTTP 启动/跟进
2. 尽可能使用 webhook 驱动的状态更新
3. 轮询作为可靠性备选方案
4. 为 Paperclip UI/CLI 合成的 stdout 事件

## V1 关键决策

1. **Cursor API 认证**使用 `Authorization: Bearer <CURSOR_API_KEY>`。
2. **回调 URL** 必须可被 Cursor VM 公开访问：
   - 本地：Tailscale URL
   - 生产：公共服务器 URL
3. **智能体回调到 Paperclip 的认证**使用引导交换流程（prompt 中不包含长期 Paperclip 密钥）。
4. **Webhook 是 V1 方案**，轮询作为备选。
5. **技能交付**是按需从 Paperclip 端点获取，而非完整 SKILL.md prompt 注入。

---

## Cursor API 参考（当前版本）

基础 URL：`https://api.cursor.com`

认证头：

- `Authorization: Bearer <CURSOR_API_KEY>`

核心端点：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/v0/agents` | POST | 启动智能体 |
| `/v0/agents/{id}` | GET | 智能体状态 |
| `/v0/agents/{id}/conversation` | GET | 对话历史 |
| `/v0/agents/{id}/followup` | POST | 跟进 prompt |
| `/v0/agents/{id}/stop` | POST | 停止/暂停运行中的智能体 |
| `/v0/models` | GET | 推荐模型列表 |
| `/v0/me` | GET | API 密钥元数据 |
| `/v0/repositories` | GET | 可访问的仓库（严格限流） |

适配器的状态处理策略：

- 将 `CREATING` 和 `RUNNING` 视为非终态。
- 将 `FINISHED` 视为成功终态。
- 将 `ERROR` 视为失败终态。
- 将未知的非活跃状态视为终态失败，并在 `resultJson` 中保留原始状态。

与 V1 相关的 Webhook 事实：

- Cursor 发出 `statusChange` webhook。
- 终态 webhook 状态包括 `ERROR` 和 `FINISHED`。
- Webhook 签名使用 HMAC SHA256（`X-Webhook-Signature: sha256=...`）。

操作限制：

- `/v0/repositories`：每用户每分钟 1 次请求，每用户每小时 30 次请求。
- Cursor background agents 不支持 MCP。

---

## 包结构

```
packages/adapters/cursor-cloud/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── api.ts
    ├── server/
    │   ├── index.ts
    │   ├── execute.ts
    │   ├── parse.ts
    │   ├── test.ts
    │   └── webhook.ts
    ├── ui/
    │   ├── index.ts
    │   ├── parse-stdout.ts
    │   └── build-config.ts
    └── cli/
        ├── index.ts
        └── format-event.ts
```

`package.json` 使用标准的四个导出（`.`、`./server`、`./ui`、`./cli`）。

---

## API 客户端（`src/api.ts`）

`src/api.ts` 是 Cursor 端点的类型化封装。

```ts
interface CursorClientConfig {
  apiKey: string;
  baseUrl?: string; // 默认 https://api.cursor.com
}

interface CursorAgent {
  id: string;
  name: string;
  status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | string;
  source: { repository: string; ref: string };
  target: {
    branchName?: string;
    prUrl?: string;
    url?: string;
    autoCreatePr?: boolean;
    openAsCursorGithubApp?: boolean;
    skipReviewerRequest?: boolean;
  };
  summary?: string;
  createdAt: string;
}
```

客户端要求：

- 所有请求发送 `Authorization: Bearer ...`
- 抛出类型化的 `CursorApiError`，包含 `status`、解析后的 body 和请求上下文
- 在错误元数据中保留原始未知字段用于调试

---

## 适配器配置合约（`src/index.ts`）

```ts
export const type = "cursor_cloud";
export const label = "Cursor Cloud Agent";
```

V1 配置字段：

- `repository`（必需）：GitHub 仓库 URL
- `ref`（可选，默认 `main`）
- `model`（可选，允许为空 = 自动）
- `autoCreatePr`（可选，默认 `false`）
- `branchName`（可选）
- `promptTemplate`
- `pollIntervalSec`（可选，默认 `10`）
- `timeoutSec`（可选，默认 `0`）
- `graceSec`（可选，默认 `20`）
- `paperclipPublicUrl`（可选覆盖；否则使用 `PAPERCLIP_PUBLIC_URL` 环境变量）
- `enableWebhooks`（可选，默认 `true`）
- `env.CURSOR_API_KEY`（必需，推荐 secret_ref）
- `env.CURSOR_WEBHOOK_SECRET`（如果 `enableWebhooks=true` 则必需，最少 32 位）

重要：不要将 Cursor 密钥存储在顶层的 `apiKey` 字段中。使用 `adapterConfig.env`，这样现有的密钥解析流程可以支持密钥引用。

---

## Paperclip 回调 + 认证流程（V1）

Cursor 智能体远程运行，因此我们无法像 `PAPERCLIP_API_KEY` 那样注入本地环境变量。

### 公共 URL

适配器必须按以下顺序解析回调基础 URL：

1. `adapterConfig.paperclipPublicUrl`
2. `process.env.PAPERCLIP_PUBLIC_URL`

如果为空，`testEnvironment` 和运行时执行应失败并给出明确错误。

### 引导交换

目标：避免在 prompt 文本中放入长期 Paperclip 凭据。

流程：

1. 在启动/跟进之前，Paperclip 生成一个绑定到以下内容的一次性引导 token：
   - `agentId`
   - `companyId`
   - `runId`
   - 短 TTL（例如 10 分钟）
2. 适配器仅包含：
   - `paperclipPublicUrl`
   - 交换端点路径
   - 引导 token
3. Cursor 智能体调用：
   - `POST /api/agent-auth/exchange`
4. Paperclip 验证引导 token 并返回运行范围的 bearer JWT。
5. Cursor 智能体使用返回的 bearer token 进行所有 Paperclip API 调用。

这样可以将长期密钥排除在 prompt 之外，并通过 TTL 支持干净的撤销。

---

## 技能交付策略（V1）

不要将完整的 SKILL.md 内容内联到 prompt 中。

替代方案：

1. Prompt 包含一个精简的指令来从 Paperclip 获取技能。
2. 认证交换后，智能体获取：
   - `GET /api/skills/index`
   - `GET /api/skills/paperclip`
   - 需要时获取 `GET /api/skills/paperclip-create-agent`
3. 智能体按需加载完整技能内容。

优势：

- 避免 prompt 膨胀
- 保持技能文档集中可更新
- 与本地适配器将技能公开为可发现流程的方式保持一致

---

## 执行流程（`src/server/execute.ts`）

### 步骤 1：解析配置和密钥

- 通过 `asString/asBoolean/asNumber/parseObject` 解析适配器配置
- 解析 `env.CURSOR_API_KEY`
- 解析 `paperclipPublicUrl`
- 启用 webhook 时验证 webhook 密钥

### 步骤 2：会话解析

会话标识是 Cursor `agentId`（存储在 `sessionParams` 中）。仅在仓库匹配时复用。

### 步骤 3：渲染 Prompt

照常渲染模板，然后附加一个精简的回调块：

- 公共 Paperclip URL
- 引导交换端点
- 引导 token
- 技能索引端点
- 必需的运行 header 行为

### 步骤 4：启动/跟进

- 恢复时：`POST /followup`
- 否则：`POST /agents`
- 启用 webhook 时包含 webhook 对象：
  - `url: <paperclipPublicUrl>/api/adapters/cursor-cloud/webhooks`
  - `secret: CURSOR_WEBHOOK_SECRET`

### 步骤 5：进度 + 完成

使用混合策略：

- webhook 事件是主要状态信号
- 轮询是备选方案和对话记录来源（`/conversation`）

向 stdout 发出合成事件（`init`、`status`、`assistant`、`user`、`result`）。

完成逻辑：

- 成功：`status === FINISHED`
- 失败：`status === ERROR` 或未知终态
- 超时：停止智能体，标记 timedOut

### 步骤 6：结果映射

`AdapterExecutionResult`：

- `exitCode: 0` 表示成功，`1` 表示终态失败
- 失败/超时时填充 `errorMessage`
- `sessionParams: { agentId, repository }`
- `provider: "cursor"`
- `usage` 和 `costUsd`：不可用/null
- `resultJson`：包含原始状态/目标/对话快照

同时确保在返回前向 stdout 发出 `result` 事件。

---

## Webhook 处理（`src/server/webhook.ts` + 服务器路由）

添加服务器端点以接收 Cursor webhook 投递。

职责：

1. 验证来自 `X-Webhook-Signature` 的 HMAC 签名。
2. 通过 `X-Webhook-ID` 去重。
3. 验证事件类型（`statusChange`）。
4. 通过 Cursor `agentId` 路由到活跃的 Paperclip 运行上下文。
5. 追加 `heartbeat_run_events` 条目用于审计/调试。
6. 更新内存中的运行信号，使执行循环可以快速短路。

安全性：

- 拒绝无效签名（`401`）
- 拒绝格式错误的负载（`400`）
- 持久化后始终快速返回（`2xx`）

---

## 环境测试（`src/server/test.ts`）

检查项：

1. `CURSOR_API_KEY` 存在
2. 通过 `GET /v0/me` 验证密钥有效性
3. 仓库已配置且 URL 格式有效
4. 模型存在（如果设置了）通过 `/v0/models`
5. `paperclipPublicUrl` 存在且可达且格式有效
6. 启用 webhook 时 webhook 密钥存在/长度有效

由于严格的限流，通过 `/v0/repositories` 进行仓库访问验证应该是可选的。仅在设置了显式 `verifyRepositoryAccess` 选项时使用警告级别检查。

---

## UI + CLI

### UI 解析器（`src/ui/parse-stdout.ts`）

处理事件类型：

- `init`
- `status`
- `assistant`
- `user`
- `result`
- 回退 `stdout`

失败结果时，设置 `isError=true` 并包含错误文本。

### 配置构建器（`src/ui/build-config.ts`）

- 映射 `CreateConfigValues.url -> repository`
- 保留 env 绑定格式（`plain`/`secret_ref`）
- 包含默认值（`pollIntervalSec`、`timeoutSec`、`graceSec`、`enableWebhooks`）

### 适配器字段（`ui/src/adapters/cursor-cloud/config-fields.tsx`）

添加控件：

- repository
- ref
- model
- autoCreatePr
- branchName
- 轮询间隔
- 超时/宽限期
- Paperclip 公共 URL 覆盖
- 启用 webhook
- `CURSOR_API_KEY` 和 `CURSOR_WEBHOOK_SECRET` 的 env 绑定

### CLI 格式化器（`src/cli/format-event.ts`）

与本地适配器类似地格式化合成事件。清晰突出终态失败。

---

## 服务器注册和跨层合约同步

### 适配器注册

- `server/src/adapters/registry.ts`
- `ui/src/adapters/registry.ts`
- `cli/src/adapters/registry.ts`

### 共享合约更新（必需）

- 在 `packages/shared/src/constants.ts`（`AGENT_ADAPTER_TYPES`）中添加 `cursor_cloud`
- 确保验证器接受它（`packages/shared/src/validators/agent.ts`）
- 在枚举适配器名称的 UI 标签/映射中更新，包括：
  - `ui/src/components/agent-config-primitives.tsx`
  - `ui/src/components/AgentProperties.tsx`
  - `ui/src/pages/Agents.tsx`
- 考虑入职向导对适配器选择的支持（`ui/src/components/OnboardingWizard.tsx`）

没有这些更新，即使包代码存在，创建/编辑流程也会拒绝新适配器。

---

## 取消语义

长轮询 HTTP 适配器必须支持运行取消。

V1 要求：

- 为每个运行中的适配器调用注册一个取消处理器
- `cancelRun` 应调用该处理器（中止 fetch/轮询循环 + 可选的 Cursor 停止调用）

当前仅面向进程的取消映射对 Cursor 来说本身不够用。

---

## 与 `claude_local` 的比较

| 方面 | `claude_local` | `cursor_cloud` |
|---|---|---|
| 执行模型 | 本地子进程 | 远程 API |
| 更新方式 | stream-json stdout | webhook + 轮询 + 合成 stdout |
| 会话 ID | Claude 会话 ID | Cursor 智能体 ID |
| 技能交付 | 本地技能目录注入 | 从 Paperclip 技能端点认证获取 |
| Paperclip 认证 | 注入本地运行 JWT 环境变量 | 引导 token 交换 -> 运行 JWT |
| 取消 | 操作系统信号 | 中止轮询 + Cursor 停止端点 |
| 用量/成本 | 丰富 | Cursor API 未暴露 |

---

## V1 限制

1. Cursor 不在 API 响应中暴露 token/成本用量。
2. 对话流仅文本（`user_message`/`assistant_message`）。
3. MCP/工具调用粒度不可用。
4. Webhook 目前仅投递状态变更事件，不包含完整的对话增量。

---

## 未来增强

1. 当 webhook 可靠性高时进一步降低轮询频率。
2. 从 Paperclip 上下文附加图片负载。
3. 在 Paperclip UI 中添加更丰富的 PR 元数据展示。
4. 添加用于调试的 webhook 重放 UI。

---

## 实施检查清单

### 适配器包

- [ ] `packages/adapters/cursor-cloud/package.json` 导出已接线
- [ ] `packages/adapters/cursor-cloud/tsconfig.json`
- [ ] `src/index.ts` 元数据 + 配置文档
- [ ] `src/api.ts` bearer 认证客户端 + 类型化错误
- [ ] `src/server/execute.ts` 混合 webhook/轮询编排
- [ ] `src/server/parse.ts` 流解析器 + 未找到检测
- [ ] `src/server/test.ts` 环境诊断
- [ ] `src/server/webhook.ts` 签名验证 + 负载辅助函数
- [ ] `src/server/index.ts` 导出 + 会话编解码器
- [ ] `src/ui/parse-stdout.ts`
- [ ] `src/ui/build-config.ts`
- [ ] `src/ui/index.ts`
- [ ] `src/cli/format-event.ts`
- [ ] `src/cli/index.ts`

### 应用集成

- [ ] 在 server/ui/cli 注册中心注册适配器
- [ ] 在共享适配器常量/验证器中添加 `cursor_cloud`
- [ ] 在 UI 界面中添加适配器标签
- [ ] 在服务器添加 Cursor webhook 路由（`/api/adapters/cursor-cloud/webhooks`）
- [ ] 添加认证交换路由（`/api/agent-auth/exchange`）
- [ ] 添加技能服务路由（`/api/skills/index`、`/api/skills/:name`）
- [ ] 为非子进程适配器添加通用取消钩子

### 测试

- [ ] API 客户端认证/错误映射
- [ ] 终态状态映射（`FINISHED`、`ERROR`、未知终态）
- [ ] 会话编解码器往返
- [ ] 配置构建器 env 绑定处理
- [ ] webhook 签名验证 + 去重
- [ ] 引导交换成功路径 + 过期/无效 token

### 验证

- [ ] `pnpm -r typecheck`
- [ ] `pnpm test:run`
- [ ] `pnpm build`
