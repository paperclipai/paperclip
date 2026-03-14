# Cursor 云智能体适配器 — 技术方案

## 概述

本文档定义了 Paperclip 适配器的 V1 设计，该适配器集成了
Cursor 后台智能体通过 Cursor REST API。

主要参考资料：

- https://docs.cursor.com/background-agent/api/overview
- https://docs.cursor.com/background-agent/api
- https://docs.cursor.com/background-agent/api/webhooks

与 `claude_local` 和 `codex_local` 不同，此适配器不是本地子进程。
它是一个远程编排适配器，具有：

1. HTTP 的启动/跟进
2. 尽可能进行 webhook 驱动的状态更新
3. 轮询可靠性的后备方案
4. 为 Paperclip UI/CLI 合成标准输出事件

## V1 关键决策

1. **授权Cursor API**使用`Authorization: Bearer <CURSOR_API_KEY>`。
2. **回调 URL** 必须可由 Cursor 虚拟机公开访问：
   - 本地：Tailscale URL
   - prod: 公共服务器 URL
3. **对 Paperclip 的智能体回调身份验证**使用引导交换流程（提示中没有长期存在的 Paperclip 密钥）。
4. **Webhooks 是 V1**，轮询仍然是后备方案。
5. **技能交付**是从 Paperclip 端点按需获取，而不是完整的 SKILL.md 提示注入。

---

## Cursor API 参考（当前）

基本网址：`https://api.cursor.com`

身份验证标头：

- `Authorization: Bearer <CURSOR_API_KEY>`

核心端点：

|端点|方法|目的|
|---|---|---|
| `/v0/agents` |发布 |推出智能体|
| `/v0/agents/{id}` |获取 |智能体状态 |
| `/v0/agents/{id}/conversation` |获取 |对话历史 |
| `/v0/agents/{id}/followup` |发布 |后续提示|
| `/v0/agents/{id}/stop` |发布 |停止/暂停正在运行的智能体 |
| `/v0/models` |获取 |推荐型号列表|
| `/v0/me` |获取 | API 密钥元数据 |
| `/v0/repositories` |获取 |可访问的存储库（严格限制速率）|

适配器的状态处理策略：

- 将 `CREATING` 和 `RUNNING` 视为非终端。
- 将`FINISHED`视为成功终端。
- 将`ERROR`视为故障终端。
- 将未知的非活动状态视为终端故障并在 `resultJson` 中保留原始状态。

与 V1 相关的 Webhook 事实：

- Cursor 发出 `statusChange` webhooks。
- 终端 webhook 状态包括 `ERROR` 和 `FINISHED`。
- Webhook 签名使用 HMAC SHA256 (`X-Webhook-Signature: sha256=...`)。

操作限制：

- `/v0/repositories`：1 个请求/用户/分钟，30 个请求/用户/小时。
- Cursor 后台智能体不支持 MCP。

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

`package.json` 使用标准四个出口（`.`、`./server`、`./ui`、`./cli`）。

---

## API 客户端 (`src/api.ts`)

`src/api.ts` 是 Cursor 端点的类型化包装器。

```ts
interface CursorClientConfig {
  apiKey: string;
  baseUrl?: string; // default https://api.cursor.com
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

客户要求：

- 对所有请求发送 `Authorization: Bearer ...`
- 抛出带有 `status` 的类型 `CursorApiError`、已解析的正文和请求上下文
- 保留原始未知字段以在错误元数据中进行调试

---## 适配器配置合约 (`src/index.ts`)

```ts
export const type = "cursor_cloud";
export const label = "Cursor Cloud Agent";
```

V1 配置字段：

- `repository`（必填）：GitHub 仓库 URL
- `ref`（可选，默认`main`）
- `model`（可选，允许为空=自动）
- `autoCreatePr`（可选，默认`false`）
- `branchName`（可选）
- `promptTemplate`
- `pollIntervalSec`（可选，默认`10`）
- `timeoutSec`（可选，默认`0`）
- `graceSec`（可选，默认`20`）
- `paperclipPublicUrl`（可选覆盖；其他 `PAPERCLIP_PUBLIC_URL` 环境）
- `enableWebhooks`（可选，默认`true`）
- `env.CURSOR_API_KEY`（必需，secret_ref 首选）
- `env.CURSOR_WEBHOOK_SECRET`（如果是 `enableWebhooks=true`，则需要，最少 32）

重要提示：请勿将 Cursor 密钥存储在普通 `apiKey` 顶级字段中。
使用 `adapterConfig.env`，以便现有秘密解析流支持秘密引用。

---

## Paperclip 回调+认证流程（V1）

Cursor智能体远程运行，因此我们不能像`PAPERCLIP_API_KEY`那样注入本地环境。

### 公共网址

适配器必须按以下顺序解析回调基本 URL：

1. `adapterConfig.paperclipPublicUrl`
2. `process.env.PAPERCLIP_PUBLIC_URL`

如果为空，则 `testEnvironment` 和运行时执行失败，并出现明显错误。

### 引导交换

目标：避免将长期存在的 Paperclip 凭据放入提示文本中。

流程：

1. 在启动/后续之前，Paperclip 铸造一个一次性引导令牌，绑定到：
   - `agentId`
   - `companyId`
   - `runId`
   - 短 TTL（例如 10 分钟）
2. 适配器仅包括：
   - `paperclipPublicUrl`
   - 交换端点路径
   - 引导令牌
3. Cursor 智能体电话：
   - `POST /api/agent-auth/exchange`
4. Paperclip 验证引导令牌并返回运行范围的承载 JWT。
5. Cursor 智能体将返回的承载令牌用于所有 Paperclip API 呼叫。

这使得长期密钥不会被提示并支持通过 TTL 进行干净撤销。

---

## 技能交付策略（V1）

不要将完整的 SKILL.md 内容内联到提示中。

相反：

1. 提示包含一条从 Paperclip 获取技能的紧凑指令。
2. 身份验证交换后，智能体获取：
   - `GET /api/skills/index`
   - `GET /api/skills/paperclip`
   - `GET /api/skills/paperclip-create-agent` 需要时
3. Agent按需加载全技能内容。

好处：

- 避免迅速膨胀
- 保持技能文档集中更新
- 与本地适配器如何将技能公开为可发现的过程保持一致

---

## 执行流程（`src/server/execute.ts`）

### 第 1 步：解析配置和机密

- 通过 `asString/asBoolean/asNumber/parseObject` 解析适配器配置
- 解析`env.CURSOR_API_KEY`
- 解析`paperclipPublicUrl`
- 启用 Webhook 时验证 Webhook 机密

### 第 2 步：会话解决

会话标识为Cursor `agentId`（存储在`sessionParams`中）。
仅当存储库匹配时重用。

### 第 3 步：渲染提示像往常一样渲染模板，然后附加一个紧凑的回调块：

- 公开 Paperclip 网址
- 引导交换端点
- 引导令牌
- 技能指数终点
- 所需的运行头行为

### 第 4 步：启动/跟进

- 简历：`POST /followup`
- 其他：`POST /agents`
- 启用时包括 webhook 对象：
  - `url: <paperclipPublicUrl>/api/adapters/cursor-cloud/webhooks`
  - `secret: CURSOR_WEBHOOK_SECRET`

### 第 5 步：进度 + 完成

使用混合策略：

- webhook 事件是主要状态信号
- 轮询是后备和转录来源（`/conversation`）

将合成事件发送到标准输出（`init`、`status`、`assistant`、`user`、`result`）。

完成逻辑：

- 成功：`status === FINISHED`
- 失败：`status === ERROR` 或未知终端
- 超时：停止智能体，标记超时

### 步骤 6：结果映射

`AdapterExecutionResult`:

- `exitCode: 0` 成功，`1` 终端失败
- `errorMessage` 失败/超时时填充
- `sessionParams: { agentId, repository }`
- `provider: "cursor"`
- `usage` 和 `costUsd`：不可用/空
- `resultJson`：包括原始状态/目标/对话快照

还要确保在返回之前将 `result` 事件发送到 stdout。

---

## Webhook 处理（`src/server/webhook.ts` + 服务器路由）

添加服务器端点以接收 Cursor Webhook 传送。

职责：

1. 验证来自`X-Webhook-Signature`的HMAC签名。
2. 通过`X-Webhook-ID`去重。
3. 验证事件类型（`statusChange`）。
4. 通过 Cursor `agentId` 路由到活动的 Paperclip 运行上下文。
5. 附加 `heartbeat_run_events` 条目以进行审核/调试。
6. 更新内存中的运行信号，以便执行循环可以快速短路。

安全性：

- 拒绝无效签名（`401`）
- 拒绝格式错误的有效负载（`400`）
- 坚持后总是很快返回(`2xx`)

---

## 环境测试（`src/server/test.ts`）

检查：

1. `CURSOR_API_KEY` 存在
2. 通过`GET /v0/me`验证密钥有效性
3. 存储库已配置且 URL 形状有效
4. 模型存在（如果设置）通过`/v0/models`
5. `paperclipPublicUrl` 存在且可达形状有效
6. 当启用 webhook 时，webhook 秘密存在/长度有效

由于严格的速率限制，通过 `/v0/repositories` 进行的存储库访问验证应该是可选的。
仅当设置了显式 `verifyRepositoryAccess` 选项时才使用警告级别检查。

---

## 用户界面 + CLI

### UI解析器(`src/ui/parse-stdout.ts`)

处理事件类型：

- `init`
- `status`
- `assistant`
- `user`
- `result`
- 后备 `stdout`

如果结果失败，请设置 `isError=true` 并包含错误文本。

### 配置生成器 (`src/ui/build-config.ts`)

- 地图 `CreateConfigValues.url -> repository`
- 保留环境绑定形状（`plain`/`secret_ref`）
- 包括默认值（`pollIntervalSec`、`timeoutSec`、`graceSec`、`enableWebhooks`）

### 适配器字段 (`ui/src/adapters/cursor-cloud/config-fields.tsx`)

添加控件：- 存储库
- 参考
- 型号
- 自动创建Pr
- 分行名称
- 轮询间隔
- 超时/宽限
- Paperclip公共 URL 覆盖
- 启用网络钩子
- `CURSOR_API_KEY` 和 `CURSOR_WEBHOOK_SECRET` 的环境绑定

### CLI 格式化程序 (`src/cli/format-event.ts`)

与本地适配器类似地格式化合成事件。
清楚地突出显示终端故障。

---

## 服务器注册和跨层合约同步

### 适配器注册

- `server/src/adapters/registry.ts`
- `ui/src/adapters/registry.ts`
- `cli/src/adapters/registry.ts`

### 共享合约更新（必需）

- 将 `cursor_cloud` 添加到 `packages/shared/src/constants.ts` (`AGENT_ADAPTER_TYPES`)
- 确保验证者接受它（`packages/shared/src/validators/agent.ts`）
- 更新枚举适配器名称的 UI 标签/地图，包括：
  - `ui/src/components/agent-config-primitives.tsx`
  - `ui/src/components/AgentProperties.tsx`
  - `ui/src/pages/Agents.tsx`
- 考虑加入向导支持适配器选择 (`ui/src/components/OnboardingWizard.tsx`)

如果没有这些更新，即使包代码存在，创建/编辑流程也会拒绝新适配器。

---

## 取消语义

长轮询 HTTP 适配器必须支持运行取消。

V1要求：

- 每次运行适配器调用时注册一个取消处理程序
- `cancelRun` 应调用该处理程序（中止获取/轮询循环+可选的 Cursor 停止调用）

对于 Cursor，当前的仅处理取消映射本身是不够的。

---

## 与`claude_local`的比较

|方面| `claude_local` | `cursor_cloud` |
|---|---|---|
|执行模型|本地子进程 |远程 API |
|更新 |流 json 标准输出 | webhook + 轮询 + 合成标准输出 |
|会话 ID | Claude 会话 ID | Cursor 智能体编号 |
|技能交付 |本地技能dir注入|从 Paperclip 技能端点进行身份验证的获取 |
| Paperclip 授权 |注入本地运行 JWT 环境变量 |引导代币交换 -> 运行 JWT |
|取消 |操作系统信号 |中止轮询 + Cursor 停止端点 |
|使用/成本|丰富| Cursor 未暴露 API |

---

## V1 限制

1. Cursor 不会在 API 响应中公开令牌/成本使用情况。
2. 对话流仅为文本（`user_message`/`assistant_message`）。
3. MCP/工具调用粒度不可用。
4. Webhooks 目前提供状态更改事件，而不是完整的转录增量。

---

## 未来的增强

1. 当webhook可靠性较高时，进一步降低轮询频率。
2. 从 Paperclip 上下文附加图像有效负载。
3. 在Paperclip UI中添加更丰富的PR元数据展示。
4. 添加用于调试的 webhook 重播 UI。

---

## 实施清单

### 适配器包- [ ] `packages/adapters/cursor-cloud/package.json` 出口有线
- [ ] `packages/adapters/cursor-cloud/tsconfig.json`
- [ ] `src/index.ts` 元数据+配置文档
- [ ] `src/api.ts` 持有者身份验证客户端 + 输入错误
- [ ] `src/server/execute.ts` 混合 webhook/投票编排
- [ ] `src/server/parse.ts` 流解析器 + 未找到检测
- [ ] `src/server/test.ts` 环境诊断
- [ ] `src/server/webhook.ts` 签名验证+有效负载助手
- [ ] `src/server/index.ts` 导出 + 会话编解码器
- [ ] `src/ui/parse-stdout.ts`
- [ ] `src/ui/build-config.ts`
- [ ] `src/ui/index.ts`
- [ ] `src/cli/format-event.ts`
- [ ] `src/cli/index.ts`

### 应用程序集成

- [ ] 在 server/ui/cli 注册表中注册适配器
- [ ] 将 `cursor_cloud` 添加到共享适配器常量/验证器
- [ ] 在 UI 表面添加适配器标签
- [ ] 在服务器上添加 Cursor webhook 路由 (`/api/adapters/cursor-cloud/webhooks`)
- [ ]添加认证交换路由(`/api/agent-auth/exchange`)
- [ ]添加技能服务路线（`/api/skills/index`、`/api/skills/:name`）
- [ ] 为非子进程适配器添加通用取消钩子

### 测试

- [ ] api 客户端验证/错误映射
- [ ] 终端状态映射（`FINISHED`、`ERROR`、未知终端）
- [ ] 会话编解码器往返
- [ ] 配置构建器环境绑定处理
- [ ] webhook签名验证+重复数据删除
- [ ] bootstrap 交换快乐路径 + 过期/无效令牌

### 验证

- [ ] `pnpm -r typecheck`
- [ ] `pnpm test:run`
- [ ] `pnpm build`