# Paperclip 插件系统规范

状态：V1 之后插件系统的完整拟议规范

本文档是 Paperclip 插件与扩展架构的完整规范。
它扩展了 [doc/SPEC.md](../SPEC.md) 中的简要插件说明，应与 [doc/plugins/ideas-from-opencode.md](./ideas-from-opencode.md) 中的比较分析一同阅读。

本文档不属于 [doc/SPEC-implementation.md](../SPEC-implementation.md) 中 V1 实施合同的范畴。
它是 V1 之后插件系统的完整目标架构。

## 当前实现注意事项

本仓库中的代码已包含早期插件运行时和管理界面，但尚未实现本规范所描述的完整部署模型。

目前，实际部署模型为：

- 单租户
- 自托管
- 单节点或具有文件系统持久化

当前需要注意的限制：

- 插件 UI 包目前作为同源 JavaScript 在 Paperclip 主应用中运行。请将插件 UI 视为受信任代码，而非沙箱化的前端能力边界。
- 清单（Manifest）能力目前仅对 worker 侧的主机 RPC 调用进行管控，无法阻止插件 UI 代码直接调用普通的 Paperclip HTTP API。
- 运行时安装假定插件包目录和插件数据目录所在的本地文件系统可写。
- 运行时 npm 安装假定运行环境中存在 `npm`，且主机能够访问配置的包注册表。
- 已发布的 npm 包是已部署插件的预期安装产物。
- `packages/plugins/examples/` 下的示例插件是开发便利工具，仅在源码检出时可用，不应假定其存在于通用发布构建中（除非该构建明确包含这些插件）。
- 动态插件安装尚未针对水平扩展或临时部署的云环境做好准备。目前尚无共享制品存储、安装协调或跨节点分发层。
- 当前运行时尚未提供真正由主机提供的插件 UI 组件套件，也不支持插件资产的上传/读取。请将这些内容视为本规范中的未来功能设想，而非当前实现承诺。

实际上，当前实现适用于本地开发和自托管持久化部署，但尚不适用于多实例云端插件分发。

## 1. 范围

本规范涵盖：

- 插件打包与安装
- 运行时模型
- 信任模型
- 能力系统
- UI 扩展界面
- 插件设置 UI
- Agent 工具贡献
- 事件、作业和 Webhook 界面
- 插件间通信
- 工作区插件的本地工具方法
- 扩展的 Postgres 持久化
- 卸载与数据生命周期
- 插件可观测性
- 插件开发与测试
- 运营者工作流
- 热插件生命周期（无需重启服务器）
- SDK 版本管理与兼容性规则

本规范不涵盖：

- 公共插件市场
- 云端/SaaS 多租户
- 第一个插件版本中的任意第三方 Schema 迁移
- 第一个插件版本中基于 iframe 沙箱的插件 UI（插件以 ES 模块形式在主机扩展槽中渲染）

## 2. 核心假设

Paperclip 插件设计基于以下假设：

1. Paperclip 是单租户且自托管的。
2. 插件安装对整个实例全局生效。
3. "公司"仍是 Paperclip 的核心业务对象，但不是插件信任边界。
4. 董事会治理、审批关卡、预算硬性限制以及核心任务不变量仍由 Paperclip 核心所有。
5. 项目已通过 `project_workspaces` 拥有真实的工作区模型，本地/运行时插件应基于该模型构建，而不是另起一套工作区抽象。

## 3. 目标

插件系统必须：

1. 允许运营者安装全局实例范围的插件。
2. 允许插件在不修改 Paperclip 核心的情况下添加重要功能。
3. 保持核心治理与审计机制完整。
4. 同时支持本地/运行时插件和外部 SaaS 连接器。
5. 支持未来的插件类别，例如：
   - 新的 Agent 适配器
   - 收入追踪
   - 知识库
   - 问题追踪器同步
   - 指标/仪表板
   - 文件/项目工具
6. 使用简单、明确、有类型的合约。
7. 保持故障隔离，使单个插件不会导致整个实例崩溃。

## 4. 非目标

第一个插件系统不得：

1. 允许任意插件覆盖核心路由或核心不变量。
2. 允许任意插件修改审批、认证、问题签出或预算执行逻辑。
3. 允许任意第三方插件运行自由格式的数据库迁移。
4. 依赖项目本地插件文件夹（如 `.paperclip/plugins`）。
5. 依赖服务器启动时从任意配置文件自动安装并执行的行为。

## 5. 术语

### 5.1 实例（Instance）

运营者安装并管理的单个 Paperclip 部署。

### 5.2 公司（Company）

实例内的 Paperclip 一等业务对象。

### 5.3 项目工作区（Project Workspace）

通过 `project_workspaces` 关联到项目的工作区。
插件从该模型中解析工作区路径，以定位用于文件、终端、git 和进程操作的本地目录。

### 5.4 平台模块（Platform Module）

由 Paperclip 核心直接加载的受信任进程内扩展。

示例：

- Agent 适配器
- 存储提供者
- 密钥提供者
- 运行日志后端

### 5.5 插件（Plugin）

通过 Paperclip 插件运行时加载的、可安装的实例范围扩展包。

示例：

- Linear 同步
- GitHub Issues 同步
- Grafana 小部件
- Stripe 收入同步
- 文件浏览器
- 终端
- git 工作流

### 5.6 插件 Worker（Plugin Worker）

插件使用的运行时进程。
在本规范中，第三方插件默认以进程外方式运行。

### 5.7 能力（Capability）

主机授予插件的命名权限。
插件只能调用其获得授权的能力所覆盖的主机 API。

## 6. 扩展类别

Paperclip 有两种扩展类别。

## 6.1 平台模块

平台模块具有以下特点：

- 受信任
- 进程内
- 与主机集成
- 底层

它们使用显式注册表，而非通用插件 worker 协议。

平台模块界面：

- `registerAgentAdapter()`
- `registerStorageProvider()`
- `registerSecretProvider()`
- `registerRunLogStore()`

平台模块适用于：

- 新的 Agent 适配器包
- 新的存储后端
- 新的密钥后端
- 其他需要直接进程或数据库集成的主机内部系统

## 6.2 插件

插件具有以下特点：

- 按实例全局安装
- 通过插件运行时加载
- 附加式（additive）
- 能力管控
- 通过稳定的 SDK 和主机协议与核心隔离

插件类别：

- `connector`
- `workspace`
- `automation`
- `ui`

一个插件可以声明多个类别。

## 7. 项目工作区

Paperclip 已拥有具体的工作区模型：

- 项目暴露 `workspaces`
- 项目暴露 `primaryWorkspace`
- 数据库包含 `project_workspaces`
- 项目路由已管理工作区

需要本地工具（文件浏览、git、终端、进程追踪）的插件可通过项目工作区 API 解析工作区路径，然后直接操作文件系统、生成进程并运行 git 命令。主机不对这些操作进行封装——插件自行拥有其实现。

## 8. 安装模型

插件安装是全局的，由运营者驱动。

不存在按公司维度的安装表，也没有按公司维度的启用/禁用开关。

如果插件需要与业务对象相关的映射，这些映射将作为插件配置或插件状态存储。

示例：

- 一个全局 Linear 插件安装
- 公司 A 到 Linear 团队 X、公司 B 到 Linear 团队 Y 的映射
- 一个全局 git 插件安装
- 存储在 `project_workspace` 下的按项目工作区状态

## 8.1 磁盘布局

插件位于 Paperclip 实例目录下。

建议布局：

- `~/.paperclip/instances/default/plugins/package.json`
- `~/.paperclip/instances/default/plugins/node_modules/`
- `~/.paperclip/instances/default/plugins/.cache/`
- `~/.paperclip/instances/default/data/plugins/<plugin-id>/`

包安装目录和插件数据目录是分开的。

这种磁盘模型是当前实现需要持久化可写主机文件系统的原因。云安全的制品复制是未来的工作。

## 8.2 运营者命令

Paperclip 应添加以下 CLI 命令：

- `pnpm paperclipai plugin list`
- `pnpm paperclipai plugin install <package[@version]>`
- `pnpm paperclipai plugin uninstall <plugin-id>`
- `pnpm paperclipai plugin upgrade <plugin-id> [version]`
- `pnpm paperclipai plugin doctor <plugin-id>`

这些命令是实例级操作。

## 8.3 安装流程

安装流程如下：

1. 解析 npm 包和版本。
2. 安装到实例插件目录。
3. 读取并验证插件清单。
4. 拒绝不兼容的插件 API 版本。
5. 向运营者显示所请求的能力。
6. 在 Postgres 中持久化安装记录。
7. 启动插件 worker 并运行健康/验证检查。
8. 将插件标记为 `ready` 或 `error`。

对于当前实现，此安装流程应理解为单主机工作流。成功安装后包会写入本地主机，除非未来添加了共享分发机制，否则其他应用节点不会自动获得该插件。

## 9. 加载顺序与优先级

加载顺序必须是确定性的。

1. 核心平台模块
2. 内置第一方插件
3. 已安装插件，排序方式为：
   - 如有运营者显式配置的顺序，则优先使用
   - 否则按清单 `id` 排序

规则：

- 插件贡献默认是附加式的
- 插件不得通过名称冲突覆盖核心路由或核心动作
- UI 槽 ID 会自动以插件 ID 命名空间化（例如 `@paperclip/plugin-linear:sync-health-widget`），因此跨插件冲突在结构上是不可能发生的
- 如果单个插件在其清单中声明了重复的槽 ID，主机必须在安装时拒绝

## 10. 包合约

每个插件包必须导出一个清单、一个 worker 入口点，以及可选的 UI 包。

建议的包布局：

- `dist/manifest.js`
- `dist/worker.js`
- `dist/ui/`（可选，包含插件的前端包）

建议的 `package.json` 键：

```json
{
  "name": "@paperclip/plugin-linear",
  "version": "0.1.0",
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js",
    "ui": "./dist/ui/"
  }
}
```

## 10.1 清单结构

规范性清单结构：

```ts
export interface PaperclipPluginManifestV1 {
  id: string;
  apiVersion: 1;
  version: string;
  displayName: string;
  description: string;
  categories: Array<"connector" | "workspace" | "automation" | "ui">;
  minimumPaperclipVersion?: string;
  capabilities: string[];
  entrypoints: {
    worker: string;
    ui?: string;
  };
  instanceConfigSchema?: JsonSchema;
  jobs?: PluginJobDeclaration[];
  webhooks?: PluginWebhookDeclaration[];
  tools?: Array<{
    name: string;
    displayName: string;
    description: string;
    parametersSchema: JsonSchema;
  }>;
  ui?: {
    slots: Array<{
      type: "page" | "detailTab" | "dashboardWidget" | "sidebar" | "settingsPage";
      id: string;
      displayName: string;
      /** Which export name in the UI bundle provides this component */
      exportName: string;
      /** For detailTab: which entity types this tab appears on */
      entityTypes?: Array<"project" | "issue" | "agent" | "goal" | "run">;
    }>;
  };
}
```

规则：

- `id` 必须全局唯一
- `id` 通常应等于 npm 包名
- `apiVersion` 必须与主机支持的插件 API 版本匹配
- `capabilities` 必须是静态的，并在安装时可见
- 配置 schema 必须与 JSON Schema 兼容
- `entrypoints.ui` 指向包含构建后 UI 包的目录
- `ui.slots` 声明插件填充哪些扩展槽，使主机无需急于加载包即可知道挂载什么；每个槽引用 UI 包中的一个 `exportName`

## 11. Agent 工具

插件可以贡献 Paperclip Agent 在运行期间可使用的工具。

### 11.1 工具声明

插件在其清单中声明工具：

```ts
tools?: Array<{
  name: string;
  displayName: string;
  description: string;
  parametersSchema: JsonSchema;
}>;
```

工具名称在运行时会自动以插件 ID 命名空间化（例如 `linear:search-issues`），因此插件无法遮蔽核心工具或彼此的工具。

### 11.2 工具执行

当 Agent 在运行期间调用插件工具时，主机通过 `executeTool` RPC 方法将调用路由到插件 worker：

- `executeTool(input)` — 接收工具名称、已解析的参数以及运行上下文（Agent ID、运行 ID、公司 ID、项目 ID）

worker 执行工具逻辑并返回类型化结果。主机强制执行能力管控——插件必须声明 `agent.tools.register` 才能贡献工具，单个工具可能还需要额外的能力（例如调用外部 API 的工具需要 `http.outbound`）。

### 11.3 工具可用性

默认情况下，插件工具对所有 Agent 可用。运营者可以通过插件配置按 Agent 或按项目限制工具可用性。

插件工具与核心工具一同出现在 Agent 的工具列表中，但在 UI 中会被视觉上区分为插件贡献的工具。

### 11.4 约束

- 插件工具不得通过名称覆盖或遮蔽核心工具。
- 插件工具应尽可能保持幂等性。
- 工具执行受到与其他插件 worker 调用相同的超时和资源限制。
- 工具结果会包含在运行日志中。

## 12. 运行时模型

## 12.1 进程模型

第三方插件默认以进程外方式运行。

默认运行时：

- Paperclip 服务器为每个已安装的插件启动一个 worker 进程
- worker 进程是 Node 进程
- 主机和 worker 通过 stdio 上的 JSON-RPC 进行通信

该设计提供了：

- 故障隔离
- 更清晰的日志边界
- 更容易的资源限制
- 比任意进程内执行更清晰的信任边界

## 12.2 主机职责

主机负责：

- 包安装
- 清单验证
- 能力执行
- 进程监督
- 作业调度
- Webhook 路由
- 活动日志写入
- 密钥解析
- UI 路由注册

## 12.3 Worker 职责

插件 worker 负责：

- 验证其自身配置
- 处理领域事件
- 处理计划作业
- 处理 Webhook
- 通过 `getData` 和 `performAction` 为插件自身的 UI 提供数据并处理动作
- 通过 SDK 调用主机服务
- 报告健康信息

## 12.4 故障策略

如果 worker 失败：

- 将插件状态标记为 `error`
- 在插件健康 UI 中显示错误
- 保持实例其余部分继续运行
- 以有界退避重试启动
- 不丢弃其他插件或核心服务

## 12.5 优雅关闭策略

当主机需要停止插件 worker 时（用于升级、卸载或实例关闭）：

1. 主机向 worker 发送 `shutdown()`。
2. worker 有 10 秒时间完成进行中的工作并干净退出。
3. 如果 worker 在截止时间内未退出，主机发送 SIGTERM。
4. 如果 worker 在 SIGTERM 后 5 秒内仍未退出，主机发送 SIGKILL。
5. 所有进行中的作业运行将被标记为 `cancelled`，并附注说明是强制关闭。
6. 所有进行中的 `getData` 或 `performAction` 调用向 bridge 返回错误。

对于需要更长排空时间的插件，关闭截止时间应可在插件配置中按插件进行配置。

## 13. 主机-Worker 协议

主机必须支持以下 worker RPC 方法。

必须支持的方法：

- `initialize(input)`
- `health()`
- `shutdown()`

可选方法：

- `validateConfig(input)`
- `configChanged(input)`
- `onEvent(input)`
- `runJob(input)`
- `handleWebhook(input)`
- `getData(input)`
- `performAction(input)`
- `executeTool(input)`

### 13.1 `initialize`

在 worker 启动时调用一次。

输入包括：

- 插件清单
- 已解析的插件配置
- 实例信息
- 主机 API 版本

### 13.2 `health`

返回：

- 状态
- 当前错误（如有）
- 可选的插件报告诊断信息

### 13.3 `validateConfig`

在配置变更和启动后运行。

返回：

- `ok`
- 警告
- 错误

### 13.4 `configChanged`

当运营者在运行时更新插件的实例配置时调用。

输入包括：

- 新的已解析配置

如果 worker 实现了此方法，则无需重启即可应用新配置。如果 worker 未实现此方法，主机将以新配置重启 worker 进程（优雅关闭后重启）。

### 13.5 `onEvent`

接收一个类型化的 Paperclip 领域事件。

投递语义：

- 至少一次
- 插件必须保持幂等性
- 跨所有事件类型无全局排序保证
- 按实体排序是尽力而为，重试后不保证

### 13.6 `runJob`

运行一个已声明的计划作业。

主机提供：

- 作业键
- 触发来源
- 运行 ID
- 调度元数据

### 13.7 `handleWebhook`

接收由主机路由的入站 Webhook 载荷。

主机提供：

- 端点键
- 请求头
- 原始请求体
- 已解析的请求体（如适用）
- 请求 ID

### 13.8 `getData`

返回插件自身 UI 组件所请求的插件数据。

插件 UI 调用主机 bridge，bridge 将请求转发给 worker。worker 返回类型化 JSON，由插件自身的前端组件渲染。

输入包括：

- 数据键（插件定义，例如 `"sync-health"`、`"issue-detail"`）
- 上下文（公司 ID、项目 ID、实体 ID 等）
- 可选的查询参数

### 13.9 `performAction`

运行由看板 UI 发起的显式插件动作。

示例：

- "立即重新同步"
- "关联 GitHub Issue"
- "从 Issue 创建分支"
- "重启进程"

### 13.10 `executeTool`

在运行期间执行插件贡献的 Agent 工具。

主机提供：

- 工具名称（不含插件命名空间前缀）
- 与工具声明 schema 匹配的已解析参数
- 运行上下文：Agent ID、运行 ID、公司 ID、项目 ID

worker 执行工具并返回类型化结果（字符串内容、结构化数据或错误）。

## 14. SDK 界面

插件不直接与数据库通信。
插件不从持久化配置中读取原始密钥材料。

暴露给 worker 的 SDK 必须提供类型化的主机客户端。

必须提供的 SDK 客户端：

- `ctx.config`
- `ctx.events`
- `ctx.jobs`
- `ctx.http`
- `ctx.secrets`
- `ctx.assets`
- `ctx.activity`
- `ctx.state`
- `ctx.entities`
- `ctx.projects`
- `ctx.issues`
- `ctx.agents`
- `ctx.goals`
- `ctx.data`
- `ctx.actions`
- `ctx.tools`
- `ctx.logger`

`ctx.data` 和 `ctx.actions` 注册处理器，供插件自身的 UI 通过主机 bridge 调用。`ctx.data.register(key, handler)` 支持前端的 `usePluginData(key)`。`ctx.actions.register(key, handler)` 支持 `usePluginAction(key)`。

需要文件系统、git、终端或进程操作的插件使用标准 Node API 或库直接处理这些操作。主机通过 `ctx.projects` 提供项目工作区元数据，使插件可以解析工作区路径，但主机不代理底层 OS 操作。

## 14.1 示例 SDK 结构

```ts
/** Top-level helper for defining a plugin with type checking */
export function definePlugin(definition: PluginDefinition): PaperclipPlugin;

/** Re-exported from Zod for config schema definitions */
export { z } from "zod";

export interface PluginContext {
  manifest: PaperclipPluginManifestV1;
  config: {
    get(): Promise<Record<string, unknown>>;
  };
  events: {
    on(name: string, fn: (event: unknown) => Promise<void>): void;
    on(name: string, filter: EventFilter, fn: (event: unknown) => Promise<void>): void;
    emit(name: string, payload: unknown): Promise<void>;
  };
  jobs: {
    register(key: string, input: { cron: string }, fn: (job: PluginJobContext) => Promise<void>): void;
  };
  state: {
    get(input: ScopeKey): Promise<unknown | null>;
    set(input: ScopeKey, value: unknown): Promise<void>;
    delete(input: ScopeKey): Promise<void>;
  };
  entities: {
    upsert(input: PluginEntityUpsert): Promise<void>;
    list(input: PluginEntityQuery): Promise<PluginEntityRecord[]>;
  };
  data: {
    register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void;
  };
  actions: {
    register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void;
  };
  tools: {
    register(name: string, input: PluginToolDeclaration, fn: (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>): void;
  };
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface EventFilter {
  projectId?: string;
  companyId?: string;
  agentId?: string;
  [key: string]: unknown;
}
```

## 15. 能力模型

能力是强制性且静态的。
每个插件必须预先声明它们。

主机在 SDK 层执行能力管控，并拒绝超出授权集合的调用。

## 15.1 能力类别

### 数据读取

- `companies.read`
- `projects.read`
- `project.workspaces.read`
- `issues.read`
- `issue.comments.read`
- `agents.read`
- `goals.read`
- `activity.read`
- `costs.read`

### 数据写入

- `issues.create`
- `issues.update`
- `issue.comments.create`
- `assets.write`
- `assets.read`
- `activity.log.write`
- `metrics.write`

### 插件状态

- `plugin.state.read`
- `plugin.state.write`

### 运行时 / 集成

- `events.subscribe`
- `events.emit`
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`

### Agent 工具

- `agent.tools.register`

### UI

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register`
- `ui.dashboardWidget.register`
- `ui.action.register`

## 15.2 禁止的能力

主机不得暴露以下能力：

- 审批决策
- 预算覆盖
- 认证绕过
- 问题签出锁覆盖
- 直接数据库访问

## 15.3 升级规则

如果插件升级添加了能力：

1. 主机必须将插件标记为 `upgrade_pending`
2. 运营者必须明确批准新的能力集合
3. 在批准完成之前，新版本不会进入 `ready` 状态

## 16. Event System

The host must emit typed domain events that plugins may subscribe to.

Minimum event set:

- `company.created`
- `company.updated`
- `project.created`
- `project.updated`
- `project.workspace_created`
- `project.workspace_updated`
- `project.workspace_deleted`
- `issue.created`
- `issue.updated`
- `issue.comment.created`
- `agent.created`
- `agent.updated`
- `agent.status_changed`
- `agent.run.started`
- `agent.run.finished`
- `agent.run.failed`
- `agent.run.cancelled`
- `approval.created`
- `approval.decided`
- `cost_event.created`
- `activity.logged`

Each event must include:

- event id
- event type
- occurred at
- actor metadata when applicable
- primary entity metadata
- typed payload

### 16.1 Event Filtering

Plugins may provide an optional filter when subscribing to events. The filter is evaluated by the host before dispatching to the worker, so filtered-out events never cross the process boundary.

Supported filter fields:

- `projectId` — only receive events for a specific project
- `companyId` — only receive events for a specific company
- `agentId` — only receive events for a specific agent

Filters are optional. If omitted, the plugin receives all events of the subscribed type. Filters may be combined (e.g. filter by both company and project).

### 16.2 Plugin-to-Plugin Events

Plugins may emit custom events using `ctx.events.emit(name, payload)`. Plugin-emitted events use a namespaced event type: `plugin.<pluginId>.<eventName>`.

Other plugins may subscribe to these events using the same `ctx.events.on()` API:

```ts
ctx.events.on("plugin.@paperclip/plugin-git.push-detected", async (event) => {
  // react to the git plugin detecting a push
});
```

Rules:

- Plugin events require the `events.emit` capability.
- Plugin events are not core domain events — they do not appear in the core activity log unless the emitting plugin explicitly logs them.
- Plugin events follow the same at-least-once delivery semantics as core events.
- The host must not allow plugins to emit events in the core namespace (events without the `plugin.` prefix).

## 17. Scheduled Jobs

Plugins may declare scheduled jobs in their manifest.

Job rules:

1. Each job has a stable `job_key`.
2. The host is the scheduler of record.
3. The host prevents overlapping execution of the same plugin/job combination unless explicitly allowed later.
4. Every job run is recorded in Postgres.
5. Failed jobs are retryable.

## 18. Webhooks

Plugins may declare webhook endpoints in their manifest.

Webhook route shape:

- `POST /api/plugins/:pluginId/webhooks/:endpointKey`

Rules:

1. The host owns the public route.
2. The worker receives the request body through `handleWebhook`.
3. Signature verification happens in plugin code using secret refs resolved by the host.
4. Every delivery is recorded.
5. Webhook handling must be idempotent.

## 19. UI Extension Model

Plugins ship their own frontend UI as a bundled React module. The host loads plugin UI into designated extension slots and provides a bridge for the plugin frontend to communicate with its own worker backend and with host APIs.

### How Plugin UI Publishing Works In Practice

A plugin's `dist/ui/` directory contains a built React bundle. The host serves this bundle and loads it into the page when the user navigates to a plugin surface (a plugin page, a detail tab, a dashboard widget, etc.).

**The host provides, the plugin renders:**

1. The host defines **extension slots** — designated mount points in the UI where plugin components can appear (pages, tabs, widgets, sidebar entries, action bars).
2. The plugin's UI bundle exports named components for each slot it wants to fill.
3. The host mounts the plugin component into the slot, passing it a **host bridge** object.
4. The plugin component uses the bridge to fetch data from its own worker (via `getData`), call actions (via `performAction`), read host context (current company, project, entity), and use shared host UI primitives (design tokens, common components).

**Concrete example: a Linear plugin ships a dashboard widget.**

The plugin's UI bundle exports:

```tsx
// dist/ui/index.tsx
import { usePluginData, usePluginAction, MetricCard, StatusBadge } from "@paperclipai/plugin-sdk/ui";

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading } = usePluginData("sync-health", { companyId: context.companyId });
  const resync = usePluginAction("resync");

  if (loading) return <Spinner />;

  return (
    <div>
      <MetricCard label="Synced Issues" value={data.syncedCount} trend={data.trend} />
      {data.mappings.map(m => (
        <StatusBadge key={m.id} label={m.label} status={m.status} />
      ))}
      <button onClick={() => resync({ companyId: context.companyId })}>Resync Now</button>
    </div>
  );
}
```

**What happens at runtime:**

1. User opens the dashboard. The host sees that the Linear plugin registered a `DashboardWidget` export.
2. The host mounts the plugin's `DashboardWidget` component into the dashboard widget slot, passing `context` (current company, user, etc.) and the bridge.
3. `usePluginData("sync-health", ...)` calls through the bridge → host → plugin worker's `getData` RPC → returns JSON → the plugin component renders it however it wants.
4. When the user clicks "Resync Now", `usePluginAction("resync")` calls through the bridge → host → plugin worker's `performAction` RPC.

**What the host controls:**

- The host decides **where** plugin components appear (which slots exist and when they mount).
- The host provides the **bridge** — plugin UI cannot make arbitrary network requests or access host internals directly.
- The host enforces **capability gates** — if a plugin's worker does not have a capability, the bridge rejects the call even if the UI requests it.
- The host provides **design tokens and shared components** via `@paperclipai/plugin-sdk/ui` so plugins can match the host's visual language without being forced to.

**What the plugin controls:**

- The plugin decides **how** to render its data — it owns its React components, layout, interactions, and state management.
- The plugin decides **what data** to fetch and **what actions** to expose.
- The plugin can use any React patterns (hooks, context, third-party component libraries) inside its bundle.

### 19.0.1 Plugin UI SDK (`@paperclipai/plugin-sdk/ui`)

The SDK includes a `ui` subpath export that plugin frontends import. This subpath provides:

- **Bridge hooks**: `usePluginData(key, params)`, `usePluginAction(key)`, `useHostContext()`
- **Design tokens**: colors, spacing, typography, shadows matching the host theme
- **Shared components**: `MetricCard`, `StatusBadge`, `DataTable`, `LogView`, `ActionBar`, `Spinner`, etc.
- **Type definitions**: `PluginPageProps`, `PluginWidgetProps`, `PluginDetailTabProps`

Plugins are encouraged but not required to use the shared components. A plugin may render entirely custom UI as long as it communicates through the bridge.

### 19.0.2 Bundle Isolation

Plugin UI bundles are loaded as standard ES modules, not iframed. This gives plugins full rendering performance and access to the host's design tokens.

Isolation rules:

- Plugin bundles must not import from host internals. They may only import from `@paperclipai/plugin-sdk/ui` and their own dependencies.
- Plugin bundles must not access `window.fetch` or `XMLHttpRequest` directly for host API calls. All host communication goes through the bridge.
- The host may enforce Content Security Policy rules that restrict plugin network access to the bridge endpoint only.
- Plugin bundles must be statically analyzable — no dynamic `import()` of URLs outside the plugin's own bundle.

If stronger isolation is needed later, the host can move to iframe-based mounting for untrusted plugins without changing the plugin's source code (the bridge API stays the same).

### 19.0.3 Bundle Serving

Plugin UI bundles must be pre-built ESM. The host does not compile or transform plugin UI code at runtime.

The host serves the plugin's `dist/ui/` directory as static assets under a namespaced path:

- `/_plugins/:pluginId/ui/*`

When the host renders an extension slot, it dynamically imports the plugin's UI entry module from this path, resolves the named export declared in `ui.slots[].exportName`, and mounts it into the slot.

In development, the host may support a `devUiUrl` override in plugin config that points to a local dev server (e.g. Vite) so plugin authors can use hot-reload during development without rebuilding.

## 19.1 Global Operator Routes

- `/settings/plugins`
- `/settings/plugins/:pluginId`

These routes are instance-level.

## 19.2 Company-Context Routes

- `/:companyPrefix/plugins/:pluginId`

These routes exist because the board UI is organized around companies even though plugin installation is global.

## 19.3 Detail Tabs

Plugins may add tabs to:

- project detail
- issue detail
- agent detail
- goal detail
- run detail

Recommended route pattern:

- `/:companyPrefix/<entity>/:id?tab=<plugin-tab-id>`

## 19.4 Dashboard Widgets

Plugins may add cards or sections to the dashboard.

## 19.5 Sidebar Entries

Plugins may add sidebar links to:

- global plugin settings
- company-context plugin pages

## 19.6 Shared Components In `@paperclipai/plugin-sdk/ui`

The host SDK ships shared components that plugins can import to quickly build UIs that match the host's look and feel. These are convenience building blocks, not a requirement.

| Component | What it renders | Typical use |
|---|---|---|
| `MetricCard` | Single number with label, optional trend/sparkline | KPIs, counts, rates |
| `StatusBadge` | Inline status indicator (ok/warning/error/info) | Sync health, connection status |
| `DataTable` | Rows and columns with optional sorting and pagination | Issue lists, job history, process lists |
| `TimeseriesChart` | Line or bar chart with timestamped data points | Revenue trends, sync volume, error rates |
| `MarkdownBlock` | Rendered markdown text | Descriptions, help text, notes |
| `KeyValueList` | Label/value pairs in a definition-list layout | Entity metadata, config summary |
| `ActionBar` | Row of buttons wired to `usePluginAction` | Resync, create branch, restart process |
| `LogView` | Scrollable log output with timestamps | Webhook deliveries, job output, process logs |
| `JsonTree` | Collapsible JSON tree for debugging | Raw API responses, plugin state inspection |
| `Spinner` | Loading indicator | Data fetch states |

Plugins may also use entirely custom components. The shared components exist to reduce boilerplate and keep visual consistency, not to limit what plugins can render.

## 19.7 Error Propagation Through The Bridge

The bridge hooks must return structured errors so plugin UI can handle failures gracefully.

`usePluginData` returns:

```ts
{
  data: T | null;
  loading: boolean;
  error: PluginBridgeError | null;
}
```

`usePluginAction` returns an async function that either resolves with the result or throws a `PluginBridgeError`.

`PluginBridgeError` shape:

```ts
interface PluginBridgeError {
  code: "WORKER_UNAVAILABLE" | "CAPABILITY_DENIED" | "WORKER_ERROR" | "TIMEOUT" | "UNKNOWN";
  message: string;
  /** Original error details from the worker, if available */
  details?: unknown;
}
```

Error codes:

- `WORKER_UNAVAILABLE` — the plugin worker is not running (crashed, shutting down, not yet started)
- `CAPABILITY_DENIED` — the plugin does not have the required capability for this operation
- `WORKER_ERROR` — the worker returned an error from its `getData` or `performAction` handler
- `TIMEOUT` — the worker did not respond within the configured timeout
- `UNKNOWN` — unexpected bridge-level failure

The `@paperclipai/plugin-sdk/ui` subpath should also export an `ErrorBoundary` component that plugin authors can use to catch rendering errors without crashing the host page.

## 19.8 Plugin Settings UI

Each plugin that declares an `instanceConfigSchema` in its manifest gets an auto-generated settings form at `/settings/plugins/:pluginId`. The host renders the form from the JSON Schema.

The auto-generated form supports:

- text inputs, number inputs, toggles, select dropdowns derived from schema types and enums
- nested objects rendered as fieldsets
- arrays rendered as repeatable field groups with add/remove controls
- secret ref fields: any schema property annotated with `"format": "secret-ref"` renders as a secret picker that resolves through the Paperclip secret provider system rather than a plain text input
- validation messages derived from schema constraints (`required`, `minLength`, `pattern`, `minimum`, etc.)
- a "Test Connection" action if the plugin declares a `validateConfig` RPC method — the host calls it and displays the result inline

For plugins that need richer settings UX beyond what JSON Schema can express, the plugin may declare a `settingsPage` slot in `ui.slots`. When present, the host renders the plugin's own React component instead of the auto-generated form. The plugin component communicates with its worker through the standard bridge to read and write config.

Both approaches coexist: a plugin can use the auto-generated form for simple config and add a custom settings page slot for advanced configuration or operational dashboards.

## 20. Local Tooling

Plugins that need filesystem, git, terminal, or process operations implement those directly. The host does not wrap or proxy these operations.

The host provides workspace metadata through `ctx.projects` (list workspaces, get primary workspace, resolve workspace from issue or agent/run). Plugins use this metadata to resolve local paths and then operate on the filesystem, spawn processes, shell out to `git`, or open PTY sessions using standard Node APIs or any libraries they choose.

This keeps the host lean — it does not need to maintain a parallel API surface for every OS-level operation a plugin might need. Plugins own their own logic for file browsing, git workflows, terminal sessions, and process management.

## 21. Persistence And Postgres

## 21.1 Database Principles

1. Core Paperclip data stays in first-party tables.
2. Most plugin-owned data starts in generic extension tables.
3. Plugin data should scope to existing Paperclip objects before new tables are introduced.
4. Arbitrary third-party schema migrations are out of scope for the first plugin system.

## 21.2 Core Table Reuse

If data becomes part of the actual Paperclip product model, it should become a first-party table.

Examples:

- `project_workspaces` is already first-party
- if Paperclip later decides git state is core product data, it should become a first-party table too

## 21.3 Required Tables

### `plugins`

- `id` uuid pk
- `plugin_key` text unique not null
- `package_name` text not null
- `version` text not null
- `api_version` int not null
- `categories` text[] not null
- `manifest_json` jsonb not null
- `status` enum: `installed | ready | error | upgrade_pending`
- `install_order` int null
- `installed_at` timestamptz not null
- `updated_at` timestamptz not null
- `last_error` text null

Indexes:

- unique `plugin_key`
- `status`

### `plugin_config`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` unique not null
- `config_json` jsonb not null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null
- `last_error` text null

### `plugin_state`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `scope_kind` enum: `instance | company | project | project_workspace | agent | issue | goal | run`
- `scope_id` uuid/text null
- `namespace` text not null
- `state_key` text not null
- `value_json` jsonb not null
- `updated_at` timestamptz not null

Constraints:

- unique `(plugin_id, scope_kind, scope_id, namespace, state_key)`

Examples:

- Linear external IDs keyed by `issue`
- GitHub sync cursors keyed by `project`
- file browser preferences keyed by `project_workspace`
- git branch metadata keyed by `project_workspace`
- process metadata keyed by `project_workspace` or `run`

### `plugin_jobs`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `scope_kind` enum nullable
- `scope_id` uuid/text null
- `job_key` text not null
- `schedule` text null
- `status` enum: `idle | queued | running | error`
- `next_run_at` timestamptz null
- `last_started_at` timestamptz null
- `last_finished_at` timestamptz null
- `last_succeeded_at` timestamptz null
- `last_error` text null

Constraints:

- unique `(plugin_id, scope_kind, scope_id, job_key)`

### `plugin_job_runs`

- `id` uuid pk
- `plugin_job_id` uuid fk `plugin_jobs.id` not null
- `plugin_id` uuid fk `plugins.id` not null
- `status` enum: `queued | running | succeeded | failed | cancelled`
- `trigger` enum: `schedule | manual | retry`
- `started_at` timestamptz null
- `finished_at` timestamptz null
- `error` text null
- `details_json` jsonb null

Indexes:

- `(plugin_id, started_at desc)`
- `(plugin_job_id, started_at desc)`

### `plugin_webhook_deliveries`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `scope_kind` enum nullable
- `scope_id` uuid/text null
- `endpoint_key` text not null
- `status` enum: `received | processed | failed | ignored`
- `request_id` text null
- `headers_json` jsonb null
- `body_json` jsonb null
- `received_at` timestamptz not null
- `handled_at` timestamptz null
- `response_code` int null
- `error` text null

Indexes:

- `(plugin_id, received_at desc)`
- `(plugin_id, endpoint_key, received_at desc)`

### `plugin_entities` (optional but recommended)

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `entity_type` text not null
- `scope_kind` enum not null
- `scope_id` uuid/text null
- `external_id` text null
- `title` text null
- `status` text null
- `data_json` jsonb not null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Indexes:

- `(plugin_id, entity_type, external_id)` unique when `external_id` is not null
- `(plugin_id, scope_kind, scope_id, entity_type)`

Use cases:

- imported Linear issues
- imported GitHub issues
- plugin-owned process records
- plugin-owned external metric bindings

## 21.4 Activity Log Changes

The activity log should extend `actor_type` to include `plugin`.

New actor enum:

- `agent`
- `user`
- `system`
- `plugin`

Plugin-originated mutations should write:

- `actor_type = plugin`
- `actor_id = <plugin-id>`

## 21.5 Plugin Migrations

The first plugin system does not allow arbitrary third-party migrations.

Later, if custom tables become necessary, the system may add a trusted-module-only migration path.

## 22. Secrets

Plugin config must never persist raw secret values.

Rules:

1. Plugin config stores secret refs only.
2. Secret refs resolve through the existing Paperclip secret provider system.
3. Plugin workers receive resolved secrets only at execution time.
4. Secret values must never be written to:
   - plugin config JSON
   - activity logs
   - webhook delivery rows
   - error messages

## 23. Auditing

All plugin-originated mutating actions must be auditable.

Minimum requirements:

- activity log entry for every mutation
- job run history
- webhook delivery history
- plugin health page
- install/upgrade history in `plugins`

## 24. Operator UX

## 24.1 Global Settings

Global plugin settings page must show:

- installed plugins
- versions
- status
- requested capabilities
- current errors
- install/upgrade/remove actions

## 24.2 Plugin Settings Page

Each plugin may expose:

- config form derived from `instanceConfigSchema`
- health details
- recent job history
- recent webhook history
- capability list

Route:

- `/settings/plugins/:pluginId`

## 24.3 Company-Context Plugin Page

Each plugin may expose a company-context main page:

- `/:companyPrefix/plugins/:pluginId`

This page is where board users do most day-to-day work.

## 25. Uninstall And Data Lifecycle

When a plugin is uninstalled, the host must handle plugin-owned data explicitly.

### 25.1 Uninstall Process

1. The host sends `shutdown()` to the worker and follows the graceful shutdown policy.
2. The host marks the plugin status `uninstalled` in the `plugins` table (soft delete).
3. Plugin-owned data (`plugin_state`, `plugin_entities`, `plugin_jobs`, `plugin_job_runs`, `plugin_webhook_deliveries`, `plugin_config`) is retained for a configurable grace period (default: 30 days).
4. During the grace period, the operator can reinstall the same plugin and recover its state.
5. After the grace period, the host purges all plugin-owned data for the uninstalled plugin.
6. The operator may force-purge immediately via CLI: `pnpm paperclipai plugin purge <plugin-id>`.

### 25.2 Upgrade Data Considerations

Plugin upgrades do not automatically migrate plugin state. If a plugin's `value_json` shape changes between versions:

- The plugin worker is responsible for migrating its own state on first access after upgrade.
- The host does not run plugin-defined schema migrations.
- Plugins should version their state keys or use a schema version field inside `value_json` to detect and handle format changes.

### 25.3 Upgrade Lifecycle

When upgrading a plugin:

1. The host sends `shutdown()` to the old worker.
2. The host waits for the old worker to drain in-flight work (respecting the shutdown deadline).
3. Any in-flight jobs that do not complete within the deadline are marked `cancelled`.
4. The host installs the new version and starts the new worker.
5. If the new version adds capabilities, the plugin enters `upgrade_pending` and the operator must approve before the new worker becomes `ready`.

### 25.4 Hot Plugin Lifecycle

Plugin install, uninstall, upgrade, and config changes **must** take effect without restarting the Paperclip server. This is a normative requirement, not optional.

The architecture already supports this — plugins run as out-of-process workers with dynamic ESM imports, IPC bridges, and host-managed routing tables. This section makes the requirement explicit so implementations do not regress.

#### 25.4.1 Hot Install

When a plugin is installed at runtime:

1. The host resolves and validates the manifest without stopping existing services.
2. The host spawns a new worker process for the plugin.
3. The host registers the plugin's event subscriptions, job schedules, webhook endpoints, and agent tool declarations in the live routing tables.
4. The host loads the plugin's UI bundle path into the extension slot registry so the frontend can discover it on the next navigation or via a live notification.
5. The plugin enters `ready` status (or `upgrade_pending` if capability approval is required).

No other plugin or host service is interrupted.

#### 25.4.2 Hot Uninstall

When a plugin is uninstalled at runtime:

1. The host sends `shutdown()` and follows the graceful shutdown policy (Section 12.5).
2. The host removes the plugin's event subscriptions, job schedules, webhook endpoints, and agent tool declarations from the live routing tables.
3. The host removes the plugin's UI bundle from the extension slot registry. Any currently mounted plugin UI components are unmounted and replaced with a placeholder or removed entirely.
4. The host marks the plugin `uninstalled` and starts the data retention grace period (Section 25.1).

No server restart is needed.

#### 25.4.3 Hot Upgrade

When a plugin is upgraded at runtime:

1. The host follows the upgrade lifecycle (Section 25.3) — shut down old worker, start new worker.
2. If the new version changes event subscriptions, job schedules, webhook endpoints, or agent tools, the host atomically swaps the old registrations for the new ones.
3. If the new version ships an updated UI bundle, the host invalidates any cached bundle assets and notifies the frontend to reload plugin UI components. Active users see the updated UI on next navigation or via a live refresh notification.
4. If the manifest `apiVersion` is unchanged and no new capabilities are added, the upgrade completes without operator interaction.

#### 25.4.4 Hot Config Change

When an operator updates a plugin's instance config at runtime:

1. The host writes the new config to `plugin_config`.
2. The host sends a `configChanged` notification to the running worker via IPC.
3. The worker receives the new config through `ctx.config` and applies it without restarting. If the plugin needs to re-initialize connections (e.g. a new API token), it does so internally.
4. If the plugin does not handle `configChanged`, the host restarts the worker process with the new config (graceful shutdown then restart).

#### 25.4.5 Frontend Cache Invalidation

The host must version plugin UI bundle URLs (e.g. `/_plugins/:pluginId/ui/:version/*` or content-hash-based paths) so that browser caches do not serve stale bundles after upgrade or reinstall.

The host should emit a `plugin.ui.updated` event that the frontend listens for to trigger re-import of updated plugin modules without a full page reload.

#### 25.4.6 Worker Process Management

The host's plugin process manager must support:

- starting a worker for a newly installed plugin without affecting other workers
- stopping a worker for an uninstalled plugin without affecting other workers
- replacing a worker during upgrade (stop old, start new) atomically from the routing table's perspective
- restarting a worker after crash without operator intervention (with backoff)

Each worker process is independent. There is no shared process pool or batch restart mechanism.

## 26. Plugin Observability

### 26.1 Logging

Plugin workers use `ctx.logger` to emit structured logs. The host captures these logs and stores them in a queryable format.

Log storage rules:

- Plugin logs are stored in a `plugin_logs` table or appended to a log file under the plugin's data directory.
- Each log entry includes: plugin ID, timestamp, level, message, and optional structured metadata.
- Logs are queryable from the plugin settings page in the UI.
- Logs have a configurable retention period (default: 7 days).
- The host captures `stdout` and `stderr` from the worker process as fallback logs even if the worker does not use `ctx.logger`.

### 26.2 Health Dashboard

The plugin settings page must show:

- current worker status (running, error, stopped)
- uptime since last restart
- recent log entries
- job run history with success/failure rates
- webhook delivery history with success/failure rates
- last health check result and diagnostics
- resource usage if available (memory, CPU)

### 26.3 Alerting

The host should emit internal events when plugin health degrades. These use the `plugin.*` namespace (not core domain events) and do not appear in the core activity log:

- `plugin.health.degraded` — worker reporting errors or failing health checks
- `plugin.health.recovered` — worker recovered from error state
- `plugin.worker.crashed` — worker process exited unexpectedly
- `plugin.worker.restarted` — worker restarted after crash

These events can be consumed by other plugins (e.g. a notification plugin) or surfaced in the dashboard.

## 27. Plugin Development And Testing

### 27.1 `@paperclipai/plugin-test-harness`

The host should publish a test harness package that plugin authors use for local development and testing.

The test harness provides:

- a mock host that implements the full SDK interface (`ctx.config`, `ctx.events`, `ctx.state`, etc.)
- ability to send synthetic events and verify handler responses
- ability to trigger job runs and verify side effects
- ability to simulate `getData` and `performAction` calls as if coming from the UI bridge
- ability to simulate `executeTool` calls as if coming from an agent run
- in-memory state and entity stores for assertions
- configurable capability sets for testing capability denial paths

Example usage:

```ts
import { createTestHarness } from "@paperclipai/plugin-test-harness";
import manifest from "../dist/manifest.js";
import { register } from "../dist/worker.js";

const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
await register(harness.ctx);

// Simulate an event
await harness.emit("issue.created", { issueId: "iss-1", projectId: "proj-1" });

// Verify state was written
const state = await harness.state.get({ pluginId: manifest.id, scopeKind: "issue", scopeId: "iss-1", namespace: "sync", stateKey: "external-id" });
expect(state).toBeDefined();

// Simulate a UI data request
const data = await harness.getData("sync-health", { companyId: "comp-1" });
expect(data.syncedCount).toBeGreaterThan(0);
```

### 27.2 Local Plugin Development

For developing a plugin against a running Paperclip instance:

- The operator installs the plugin from a local path: `pnpm paperclipai plugin install ./path/to/plugin`
- The host watches the plugin directory for changes and restarts the worker on rebuild.
- `devUiUrl` in plugin config can point to a local Vite dev server for UI hot-reload.
- The plugin settings page shows real-time logs from the worker for debugging.

### 27.3 Plugin Starter Template

The host should publish a starter template (`create-paperclip-plugin`) that scaffolds:

- `package.json` with correct `paperclipPlugin` keys
- manifest with placeholder values
- worker entry with SDK type imports and example event handler
- UI entry with example `DashboardWidget` using bridge hooks
- test file using the test harness
- build configuration (esbuild or similar) for both worker and UI bundles
- `.gitignore` and `tsconfig.json`

## 28. Example Mappings

This spec directly supports the following plugin types:

- `@paperclip/plugin-workspace-files`
- `@paperclip/plugin-terminal`
- `@paperclip/plugin-git`
- `@paperclip/plugin-linear`
- `@paperclip/plugin-github-issues`
- `@paperclip/plugin-grafana`
- `@paperclip/plugin-runtime-processes`
- `@paperclip/plugin-stripe`

## 29. Compatibility And Versioning

### 29.1 API Version Rules

1. Host supports one or more explicit plugin API versions.
2. Plugin manifest declares exactly one `apiVersion`.
3. Host rejects unsupported versions at install time.
4. Plugin upgrades are explicit operator actions.
5. Capability expansion requires explicit operator approval.

### 29.2 SDK Versioning

The host publishes a single SDK package for plugin authors:

- `@paperclipai/plugin-sdk` — the complete plugin SDK

The package uses subpath exports to separate worker and UI concerns:

- `@paperclipai/plugin-sdk` — worker-side SDK (context, events, state, tools, logger, `definePlugin`, `z`)
- `@paperclipai/plugin-sdk/ui` — frontend SDK (bridge hooks, shared components, design tokens)

A single package simplifies dependency management for plugin authors — one dependency, one version, one changelog. The subpath exports keep bundle separation clean: worker code imports from the root, UI code imports from `/ui`. Build tools tree-shake accordingly so the worker bundle does not include React components and the UI bundle does not include worker-only code.

Versioning rules:

1. **Semver**: The SDK follows strict semantic versioning. Major version bumps indicate breaking changes to either the worker or UI surface; minor versions add new features backwards-compatibly; patch versions are bug fixes only.
2. **Tied to API version**: Each major SDK version corresponds to exactly one plugin `apiVersion`. When `@paperclipai/plugin-sdk@2.x` ships, it targets `apiVersion: 2`. Plugins built with SDK 1.x continue to declare `apiVersion: 1`.
3. **Host multi-version support**: The host must support at least the current and one previous `apiVersion` simultaneously. This means plugins built against the previous SDK major version continue to work without modification. The host maintains separate IPC protocol handlers for each supported API version.
4. **Minimum SDK version in manifest**: Plugins declare `sdkVersion` in the manifest as a semver range (e.g. `">=1.4.0 <2.0.0"`). The host validates this at install time and warns if the plugin's declared range is outside the host's supported SDK versions.
5. **Deprecation timeline**: When a new `apiVersion` ships, the previous version enters a deprecation period of at least 6 months. During this period:
   - The host continues to load plugins targeting the deprecated version.
   - The host logs a deprecation warning at plugin startup.
   - The plugin settings page shows a banner indicating the plugin should be upgraded.
   - After the deprecation period ends, the host may drop support for the old version in a future release.
6. **SDK changelog and migration guides**: Each major SDK release must include a migration guide documenting every breaking change, the new API surface, and a step-by-step upgrade path for plugin authors.
7. **UI surface stability**: Breaking changes to shared UI components (removing a component, changing required props) or design tokens require a major version bump just like worker API changes. The single-package model means both surfaces are versioned together, avoiding drift between worker and UI compatibility.

### 29.3 Version Compatibility Matrix

The host should publish a compatibility matrix:

| Host Version | Supported API Versions | SDK Range |
|---|---|---|
| 1.0 | 1 | 1.x |
| 2.0 | 1, 2 | 1.x, 2.x |
| 3.0 | 2, 3 | 2.x, 3.x |

This matrix is published in the host docs and queryable via `GET /api/plugins/compatibility`.

### 29.4 Plugin Author Workflow

When a new SDK version is released:

1. Plugin author updates `@paperclipai/plugin-sdk` dependency.
2. Plugin author follows the migration guide to update code.
3. Plugin author updates `apiVersion` and `sdkVersion` in the manifest.
4. Plugin author publishes a new plugin version.
5. Operators upgrade the plugin on their instances. The old version continues to work until explicitly upgraded.

## 30. Recommended Delivery Order

## Phase 1

- plugin manifest
- install/list/remove/upgrade CLI
- global settings UI
- plugin process manager
- capability enforcement
- `plugins`, `plugin_config`, `plugin_state`, `plugin_jobs`, `plugin_job_runs`, `plugin_webhook_deliveries`
- event bus
- jobs
- webhooks
- settings page
- plugin UI bundle loading, host bridge, and `@paperclipai/plugin-sdk/ui`
- extension slot mounting for pages, tabs, widgets, sidebar entries
- bridge error propagation (`PluginBridgeError`)
- auto-generated settings form from `instanceConfigSchema`
- plugin-contributed agent tools
- plugin-to-plugin events (`plugin.<pluginId>.*` namespace)
- event filtering
- graceful shutdown with configurable deadlines
- plugin logging and health dashboard
- `@paperclipai/plugin-test-harness`
- `create-paperclip-plugin` starter template
- uninstall with data retention grace period
- hot plugin lifecycle (install, uninstall, upgrade, config change without server restart)
- SDK versioning with multi-version host support and deprecation policy

This phase is enough for:

- Linear
- GitHub Issues
- Grafana
- Stripe
- file browser
- terminal
- git workflow
- process/server tracking

Workspace plugins (file browser, terminal, git, process tracking) do not require additional host APIs — they resolve workspace paths through `ctx.projects` and handle filesystem, git, PTY, and process operations directly.

## Phase 2

- optional `plugin_entities`
- richer action systems
- trusted-module migration path if truly needed
- iframe-based isolation for untrusted plugin UI bundles
- plugin ecosystem/distribution work

## 31. Final Design Decision

Paperclip should not implement a generic in-process hook bag modeled directly after local coding tools.

Paperclip should implement:

- trusted platform modules for low-level host integration
- globally installed out-of-process plugins for additive instance-wide capabilities
- plugin-contributed agent tools (namespaced, capability-gated)
- plugin-shipped UI bundles rendered in host extension slots via a typed bridge with structured error propagation
- auto-generated settings UI from config schema, with custom settings pages as an option
- plugin-to-plugin events for cross-plugin coordination
- server-side event filtering for efficient event routing
- plugins own their local tooling logic (filesystem, git, terminal, processes) directly
- generic extension tables for most plugin state
- graceful shutdown, uninstall data lifecycle, and plugin observability
- hot plugin lifecycle — install, uninstall, upgrade, and config changes without server restart
- SDK versioning with multi-version host support and a clear deprecation policy
- test harness and starter template for low authoring friction
- strict preservation of core governance and audit rules

That is the complete target design for the Paperclip plugin system.
