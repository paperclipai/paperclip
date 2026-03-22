# Paperclip 插件系统规范

状态：为 V1 后插件系统提议的完整规范

本文档是 Paperclip 插件和扩展架构的完整规范。
它扩展了 [doc/SPEC.md](../SPEC.md) 中关于插件的简要说明，应与 [doc/plugins/ideas-from-opencode.md](./ideas-from-opencode.md) 中的对比分析一起阅读。

本规范不属于 [doc/SPEC-implementation.md](../SPEC-implementation.md) 中的 V1 实现范围。
它是 V1 之后插件系统的完整目标架构。

## 当前实现的注意事项

本仓库中的代码现已包含早期插件运行时和管理界面，但尚未实现本规范中描述的完整部署模型。

目前实际的部署模型是：

- 单租户
- 自托管
- 单节点或其他文件系统持久化方式

需要注意的当前限制：

- 插件 UI 包目前作为同源 JavaScript 在 Paperclip 主应用内运行。请将插件 UI 视为受信任的代码，而非沙箱化的前端能力边界。
- 清单中的能力声明目前仅限制 worker 端的宿主 RPC 调用。它们无法阻止插件 UI 代码直接调用普通的 Paperclip HTTP API。
- 运行时安装假设存在可写的本地文件系统用于插件包目录和插件数据目录。
- 运行时 npm 安装假设运行环境中有可用的 `npm`，且宿主可以访问配置的包注册中心。
- 已发布的 npm 包是已部署插件的预期安装产物。
- 仓库中 `packages/plugins/examples/` 下的示例插件是开发便利工具。它们在源码检出时可用，不应假设在通用发布构建中存在，除非该构建明确包含了它们。
- 动态插件安装尚未为水平扩展或临时部署提供云端就绪支持。目前没有共享产物存储、安装协调或跨节点分发层。
- 当前运行时尚未提供真正的宿主端插件 UI 组件套件，也不支持插件资产上传/读取。请将本规范中的这些内容视为未来功能构想，而非当前实现承诺。

实际上，这意味着当前实现适合本地开发和自托管持久化部署，但尚不适合多实例云端插件分发。

## 1. 范围

本规范涵盖：

- 插件打包和安装
- 运行时模型
- 信任模型
- 能力系统
- UI 扩展界面
- 插件设置 UI
- 智能体工具贡献
- 事件、作业和 webhook 界面
- 插件间通信
- 工作区插件的本地工具方案
- Postgres 扩展持久化
- 卸载和数据生命周期
- 插件可观测性
- 插件开发和测试
- 操作员工作流
- 热插件生命周期（无需服务器重启）
- SDK 版本管理和兼容性规则

本规范不涵盖：

- 公共市场
- 云端/SaaS 多租户
- 第一版插件中的任意第三方 schema 迁移
- 第一版插件中的 iframe 沙箱化插件 UI（插件作为 ES 模块在宿主扩展槽中渲染）

## 2. 核心假设

Paperclip 插件设计基于以下假设：

1. Paperclip 是单租户、自托管的。
2. 插件安装对整个实例全局生效。
3. "公司"仍然是 Paperclip 的核心业务对象，但它们不是插件信任边界。
4. 董事会治理、审批门禁、预算硬限制和核心任务不变量仍由 Paperclip 核心拥有。
5. 项目已经通过 `project_workspaces` 拥有真实的工作区模型，本地/运行时插件应基于此构建，而不是发明单独的工作区抽象。

## 3. 目标

插件系统必须：

1. 允许操作员安装全局实例级插件。
2. 允许插件在不编辑 Paperclip 核心的情况下添加主要功能。
3. 保持核心治理和审计完整。
4. 同时支持本地/运行时插件和外部 SaaS 连接器。
5. 支持未来的插件类别，例如：
   - 新的智能体适配器
   - 收入跟踪
   - 知识库
   - 任务跟踪器同步
   - 指标/仪表盘
   - 文件/项目工具
6. 使用简单、明确、类型化的契约。
7. 保持故障隔离，使一个插件不会导致整个实例崩溃。

## 4. 非目标

第一版插件系统不得：

1. 允许任意插件覆盖核心路由或核心不变量。
2. 允许任意插件修改审批、认证、任务检出或预算执行逻辑。
3. 允许任意第三方插件运行自由形式的数据库迁移。
4. 依赖项目本地插件目录，如 `.paperclip/plugins`。
5. 依赖服务器启动时从任意配置文件自动安装并执行的行为。

## 5. 术语

### 5.1 实例

操作员安装和控制的单个 Paperclip 部署。

### 5.2 公司

实例中的一等 Paperclip 业务对象。

### 5.3 项目工作区

通过 `project_workspaces` 附加到项目的工作区。
插件通过此模型解析工作区路径，以定位用于文件、终端、git 和进程操作的本地目录。

### 5.4 平台模块

由 Paperclip 核心直接加载的受信任进程内扩展。

示例：

- 智能体适配器
- 存储提供者
- 密钥提供者
- 运行日志后端

### 5.5 插件

通过 Paperclip 插件运行时加载的可安装实例级扩展包。

示例：

- Linear 同步
- GitHub Issues 同步
- Grafana 小组件
- Stripe 收入同步
- 文件浏览器
- 终端
- git 工作流

### 5.6 插件 Worker

用于插件的运行时进程。
在本规范中，第三方插件默认在进程外运行。

### 5.7 能力

宿主授予插件的命名权限。
插件只能调用已授权能力覆盖的宿主 API。

## 6. 扩展类别

Paperclip 有两种扩展类别。

## 6.1 平台模块

平台模块的特点：

- 受信任
- 进程内运行
- 与宿主集成
- 底层

它们使用显式注册表，而不是通用插件 worker 协议。

平台模块接口：

- `registerAgentAdapter()`
- `registerStorageProvider()`
- `registerSecretProvider()`
- `registerRunLogStore()`

平台模块适用于：

- 新的智能体适配器包
- 新的存储后端
- 新的密钥后端
- 其他需要直接进程或数据库集成的宿主内部系统

## 6.2 插件

插件的特点：

- 每个实例全局安装
- 通过插件运行时加载
- 累加式
- 能力受限
- 通过稳定的 SDK 和宿主协议与核心隔离

插件类别：

- `connector`
- `workspace`
- `automation`
- `ui`

一个插件可以声明多个类别。

## 7. 项目工作区

Paperclip 已经拥有一个具体的工作区模型：

- 项目暴露 `workspaces`
- 项目暴露 `primaryWorkspace`
- 数据库包含 `project_workspaces`
- 项目路由已经管理工作区

需要本地工具（文件浏览、git、终端、进程跟踪）的插件可以通过项目工作区 API 解析工作区路径，然后直接操作文件系统、生成进程和运行 git 命令。宿主不包装这些操作——插件拥有自己的实现。

## 8. 安装模型

插件安装是全局的，由操作员驱动。

没有按公司的安装表，也没有按公司的启用/禁用开关。

如果插件需要业务对象级别的映射，这些映射作为插件配置或插件状态存储。

示例：

- 全局安装一个 Linear 插件
- 将公司 A 映射到 Linear 团队 X，将公司 B 映射到 Linear 团队 Y
- 全局安装一个 git 插件
- 按项目工作区状态存储在 `project_workspace` 下

## 8.1 磁盘布局

插件位于 Paperclip 实例目录下。

建议布局：

- `~/.paperclip/instances/default/plugins/package.json`
- `~/.paperclip/instances/default/plugins/node_modules/`
- `~/.paperclip/instances/default/plugins/.cache/`
- `~/.paperclip/instances/default/data/plugins/<plugin-id>/`

包安装目录和插件数据目录是分开的。

这个磁盘模型就是当前实现要求持久化可写宿主文件系统的原因。云端安全的产物复制是未来工作。

## 8.2 操作员命令

Paperclip 应添加 CLI 命令：

- `pnpm paperclipai plugin list`
- `pnpm paperclipai plugin install <package[@version]>`
- `pnpm paperclipai plugin uninstall <plugin-id>`
- `pnpm paperclipai plugin upgrade <plugin-id> [version]`
- `pnpm paperclipai plugin doctor <plugin-id>`

这些命令是实例级操作。

## 8.3 安装流程

安装流程是：

1. 解析 npm 包和版本。
2. 安装到实例插件目录。
3. 读取并验证插件清单。
4. 拒绝不兼容的插件 API 版本。
5. 向操作员显示请求的能力。
6. 将安装记录持久化到 Postgres。
7. 启动插件 worker 并运行健康/验证检查。
8. 将插件标记为 `ready` 或 `error`。

对于当前实现，此安装流程应视为单主机工作流。成功的安装将包写入本地主机，其他应用节点不会自动接收该插件，除非未来添加共享分发机制。

## 9. 加载顺序和优先级

加载顺序必须是确定性的。

1. 核心平台模块
2. 内置第一方插件
3. 已安装插件，排序依据：
   - 如果存在操作员配置的显式顺序
   - 否则按清单 `id`

规则：

- 插件贡献默认是累加式的
- 插件不得通过名称冲突覆盖核心路由或核心操作
- UI 槽位 ID 自动按插件 ID 命名空间化（例如 `@paperclip/plugin-linear:sync-health-widget`），因此跨插件冲突在结构上是不可能的
- 如果单个插件在自己的清单中声明了重复的槽位 ID，宿主必须在安装时拒绝

## 10. 包契约

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
      /** UI 包中提供此组件的导出名称 */
      exportName: string;
      /** 对于 detailTab：此标签页出现在哪些实体类型上 */
      entityTypes?: Array<"project" | "issue" | "agent" | "goal" | "run">;
    }>;
  };
}
```

规则：

- `id` 必须全局唯一
- `id` 通常应等于 npm 包名
- `apiVersion` 必须与宿主支持的插件 API 版本匹配
- `capabilities` 必须是静态的，且在安装时可见
- 配置 schema 必须兼容 JSON Schema
- `entrypoints.ui` 指向包含已构建 UI 包的目录
- `ui.slots` 声明插件填充哪些扩展槽位，以便宿主无需急切加载包即可知道挂载什么；每个槽位引用 UI 包中的一个 `exportName`

## 11. 智能体工具

插件可以贡献 Paperclip 智能体在运行期间可使用的工具。

### 11.1 工具声明

插件在清单中声明工具：

```ts
tools?: Array<{
  name: string;
  displayName: string;
  description: string;
  parametersSchema: JsonSchema;
}>;
```

工具名称在运行时自动按插件 ID 命名空间化（例如 `linear:search-issues`），因此插件无法遮蔽核心工具或其他插件的工具。

### 11.2 工具执行

当智能体在运行期间调用插件工具时，宿主通过 `executeTool` RPC 方法将调用路由到插件 worker：

- `executeTool(input)` — 接收工具名称、解析后的参数和运行上下文（智能体 ID、运行 ID、公司 ID、项目 ID）

worker 执行工具逻辑并返回类型化结果。宿主强制执行能力门禁——插件必须声明 `agent.tools.register` 才能贡献工具，单个工具可能需要额外的能力（例如调用外部 API 的工具需要 `http.outbound`）。

### 11.3 工具可用性

默认情况下，插件工具对所有智能体可用。操作员可以通过插件配置按智能体或按项目限制工具可用性。

插件工具与核心工具一起出现在智能体的工具列表中，但在 UI 中作为插件贡献的工具有视觉区分。

### 11.4 约束

- 插件工具不得按名称覆盖或遮蔽核心工具。
- 插件工具应尽可能保持幂等性。
- 工具执行受与其他插件 worker 调用相同的超时和资源限制约束。
- 工具结果包含在运行日志中。

## 12. 运行时模型

## 12.1 进程模型

第三方插件默认在进程外运行。

默认运行时：

- Paperclip 服务器为每个已安装的插件启动一个 worker 进程
- worker 进程是一个 Node 进程
- 宿主和 worker 通过 stdio 上的 JSON-RPC 通信

这种设计提供了：

- 故障隔离
- 更清晰的日志边界
- 更容易的资源限制
- 比任意进程内执行更清晰的信任边界

## 12.2 宿主职责

宿主负责：

- 包安装
- 清单验证
- 能力执行
- 进程监管
- 作业调度
- webhook 路由
- 活动日志写入
- 密钥解析
- UI 路由注册

## 12.3 Worker 职责

插件 worker 负责：

- 验证自身配置
- 处理域事件
- 处理定时作业
- 处理 webhook
- 通过 `getData` 和 `performAction` 为插件自身 UI 提供数据和处理操作
- 通过 SDK 调用宿主服务
- 报告健康信息

## 12.4 故障策略

如果 worker 失败：

- 将插件状态标记为 `error`
- 在插件健康 UI 中显示错误
- 保持实例其余部分正常运行
- 使用有界退避重试启动
- 不影响其他插件或核心服务

## 12.5 优雅关闭策略

当宿主需要停止插件 worker 时（用于升级、卸载或实例关闭）：

1. 宿主向 worker 发送 `shutdown()`。
2. worker 有 10 秒时间完成进行中的工作并正常退出。
3. 如果 worker 在截止时间内未退出，宿主发送 SIGTERM。
4. 如果 worker 在 SIGTERM 后 5 秒内未退出，宿主发送 SIGKILL。
5. 任何进行中的作业运行被标记为 `cancelled`，并附注说明是强制关闭。
6. 任何进行中的 `getData` 或 `performAction` 调用向桥接返回错误。

关闭截止时间应可在每个插件的配置中配置，以适应需要更长排空时间的插件。

## 13. 宿主-Worker 协议

宿主必须支持以下 worker RPC 方法。

必需方法：

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
- 宿主 API 版本

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

当操作员在运行时更新插件的实例配置时调用。

输入包括：

- 新的已解析配置

如果 worker 实现了此方法，它会在不重启的情况下应用新配置。如果 worker 未实现此方法，宿主将使用新配置重启 worker 进程（优雅关闭后重启）。

### 13.5 `onEvent`

接收一个类型化的 Paperclip 域事件。

投递语义：

- 至少一次
- 插件必须保持幂等性
- 不保证所有事件类型的全局排序
- 按实体排序尽力而为，但在重试后不保证

### 13.6 `runJob`

运行已声明的定时作业。

宿主提供：

- 作业键
- 触发来源
- 运行 ID
- 调度元数据

### 13.7 `handleWebhook`

接收由宿主路由的入站 webhook 载荷。

宿主提供：

- 端点键
- 头部
- 原始正文
- 解析后的正文（如适用）
- 请求 ID

### 13.8 `getData`

返回插件自身 UI 组件请求的插件数据。

插件 UI 调用宿主桥接，桥接将请求转发给 worker。worker 返回类型化的 JSON，由插件自身的前端组件渲染。

输入包括：

- 数据键（插件定义的，例如 `"sync-health"`、`"issue-detail"`）
- 上下文（公司 ID、项目 ID、实体 ID 等）
- 可选查询参数

### 13.9 `performAction`

运行由仪表盘 UI 发起的显式插件操作。

示例：

- "立即重新同步"
- "关联 GitHub 任务"
- "从任务创建分支"
- "重启进程"

### 13.10 `executeTool`

在运行期间运行插件贡献的智能体工具。

宿主提供：

- 工具名称（不含插件命名空间前缀）
- 匹配工具已声明 schema 的解析后参数
- 运行上下文：智能体 ID、运行 ID、公司 ID、项目 ID

worker 执行工具并返回类型化结果（字符串内容、结构化数据或错误）。

## 14. SDK 接口

插件不直接与数据库通信。
插件不从持久化配置中读取原始密钥材料。

暴露给 worker 的 SDK 必须提供类型化的宿主客户端。

必需的 SDK 客户端：

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

`ctx.data` 和 `ctx.actions` 注册处理程序，供插件自身 UI 通过宿主桥接调用。`ctx.data.register(key, handler)` 支撑前端的 `usePluginData(key)`。`ctx.actions.register(key, handler)` 支撑 `usePluginAction(key)`。

需要文件系统、git、终端或进程操作的插件使用标准 Node API 或库直接处理这些操作。宿主通过 `ctx.projects` 提供项目工作区元数据，以便插件可以解析工作区路径，但宿主不代理底层 OS 操作。

## 14.1 示例 SDK 结构

```ts
/** 用于定义插件并进行类型检查的顶层辅助函数 */
export function definePlugin(definition: PluginDefinition): PaperclipPlugin;

/** 从 Zod 重新导出，用于配置 schema 定义 */
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

能力是强制性的和静态的。
每个插件都预先声明它们。

宿主在 SDK 层强制执行能力，并拒绝已授权集合之外的调用。

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

### 智能体工具

- `agent.tools.register`

### UI

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register`
- `ui.dashboardWidget.register`
- `ui.action.register`

## 15.2 禁止的能力

宿主不得暴露以下能力：

- 审批决策
- 预算覆盖
- 认证绕过
- 任务检出锁覆盖
- 直接数据库访问

## 15.3 升级规则

如果插件升级添加了能力：

1. 宿主必须将插件标记为 `upgrade_pending`
2. 操作员必须明确批准新的能力集
3. 新版本在审批完成前不会变为 `ready`

## 16. 事件系统

宿主必须发出类型化的域事件供插件订阅。

最小事件集：

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

每个事件必须包含：

- 事件 ID
- 事件类型
- 发生时间
- 操作者元数据（如适用）
- 主要实体元数据
- 类型化载荷

### 16.1 事件过滤

插件在订阅事件时可以提供可选的过滤器。过滤器由宿主在分发给 worker 之前评估，因此被过滤掉的事件永远不会跨越进程边界。

支持的过滤字段：

- `projectId` — 仅接收特定项目的事件
- `companyId` — 仅接收特定公司的事件
- `agentId` — 仅接收特定智能体的事件

过滤器是可选的。如果省略，插件接收已订阅类型的所有事件。过滤器可以组合使用（例如同时按公司和项目过滤）。

### 16.2 插件间事件

插件可以使用 `ctx.events.emit(name, payload)` 发出自定义事件。插件发出的事件使用命名空间化的事件类型：`plugin.<pluginId>.<eventName>`。

其他插件可以使用相同的 `ctx.events.on()` API 订阅这些事件：

```ts
ctx.events.on("plugin.@paperclip/plugin-git.push-detected", async (event) => {
  // 响应 git 插件检测到的推送
});
```

规则：

- 插件事件需要 `events.emit` 能力。
- 插件事件不是核心域事件——除非发出插件明确记录它们，否则不会出现在核心活动日志中。
- 插件事件遵循与核心事件相同的至少一次投递语义。
- 宿主不得允许插件在核心命名空间（不带 `plugin.` 前缀的事件）中发出事件。

## 17. 定时作业

插件可以在清单中声明定时作业。

作业规则：

1. 每个作业有一个稳定的 `job_key`。
2. 宿主是记录调度器。
3. 除非后续明确允许，宿主阻止同一插件/作业组合的重叠执行。
4. 每次作业运行都记录在 Postgres 中。
5. 失败的作业可以重试。

## 18. Webhook

插件可以在清单中声明 webhook 端点。

Webhook 路由格式：

- `POST /api/plugins/:pluginId/webhooks/:endpointKey`

规则：

1. 宿主拥有公共路由。
2. worker 通过 `handleWebhook` 接收请求正文。
3. 签名验证在插件代码中使用宿主解析的密钥引用进行。
4. 每次投递都会被记录。
5. Webhook 处理必须是幂等的。

## 19. UI 扩展模型

插件以打包的 React 模块形式发布自己的前端 UI。宿主将插件 UI 加载到指定的扩展槽位中，并提供桥接供插件前端与其自身的 worker 后端和宿主 API 通信。

### 插件 UI 发布的实际工作方式

插件的 `dist/ui/` 目录包含已构建的 React 包。宿主提供此包的服务，并在用户导航到插件界面（插件页面、详情标签页、仪表盘小组件等）时将其加载到页面中。

**宿主提供，插件渲染：**

1. 宿主定义**扩展槽位**——UI 中插件组件可以出现的指定挂载点（页面、标签页、小组件、侧边栏入口、操作栏）。
2. 插件的 UI 包为其要填充的每个槽位导出命名组件。
3. 宿主将插件组件挂载到槽位中，传递一个**宿主桥接**对象。
4. 插件组件使用桥接从其自身 worker 获取数据（通过 `getData`）、调用操作（通过 `performAction`）、读取宿主上下文（当前公司、项目、实体），以及使用共享的宿主 UI 原语（设计令牌、通用组件）。

**具体示例：Linear 插件发布一个仪表盘小组件。**

插件的 UI 包导出：

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

**运行时发生的事情：**

1. 用户打开仪表盘。宿主看到 Linear 插件注册了一个 `DashboardWidget` 导出。
2. 宿主将插件的 `DashboardWidget` 组件挂载到仪表盘小组件槽位中，传递 `context`（当前公司、用户等）和桥接。
3. `usePluginData("sync-health", ...)` 通过桥接调用 → 宿主 → 插件 worker 的 `getData` RPC → 返回 JSON → 插件组件按其需要渲染。
4. 当用户点击"立即重新同步"时，`usePluginAction("resync")` 通过桥接调用 → 宿主 → 插件 worker 的 `performAction` RPC。

**宿主控制的内容：**

- 宿主决定插件组件**出现在哪里**（存在哪些槽位以及何时挂载）。
- 宿主提供**桥接**——插件 UI 不能直接发出任意网络请求或访问宿主内部。
- 宿主强制执行**能力门禁**——如果插件的 worker 没有某个能力，即使 UI 请求，桥接也会拒绝调用。
- 宿主通过 `@paperclipai/plugin-sdk/ui` 提供**设计令牌和共享组件**，以便插件可以匹配宿主的视觉语言而不被强制要求。

**插件控制的内容：**

- 插件决定**如何**渲染其数据——它拥有自己的 React 组件、布局、交互和状态管理。
- 插件决定**获取什么数据**和**暴露什么操作**。
- 插件可以在其包内使用任何 React 模式（hooks、context、第三方组件库）。

### 19.0.1 插件 UI SDK（`@paperclipai/plugin-sdk/ui`）

SDK 包含一个 `ui` 子路径导出，供插件前端导入。此子路径提供：

- **桥接 hooks**：`usePluginData(key, params)`、`usePluginAction(key)`、`useHostContext()`
- **设计令牌**：颜色、间距、排版、阴影，匹配宿主主题
- **共享组件**：`MetricCard`、`StatusBadge`、`DataTable`、`LogView`、`ActionBar`、`Spinner` 等
- **类型定义**：`PluginPageProps`、`PluginWidgetProps`、`PluginDetailTabProps`

鼓励但不强制插件使用共享组件。插件可以渲染完全自定义的 UI，只要通过桥接通信即可。

### 19.0.2 包隔离

插件 UI 包作为标准 ES 模块加载，不使用 iframe。这让插件拥有完整的渲染性能和对宿主设计令牌的访问权限。

隔离规则：

- 插件包不得从宿主内部导入。它们只能从 `@paperclipai/plugin-sdk/ui` 和其自身的依赖项导入。
- 插件包不得直接使用 `window.fetch` 或 `XMLHttpRequest` 进行宿主 API 调用。所有宿主通信都通过桥接进行。
- 宿主可以强制执行内容安全策略规则，将插件网络访问限制为仅桥接端点。
- 插件包必须是静态可分析的——不允许动态 `import()` 插件自身包之外的 URL。

如果以后需要更强的隔离，宿主可以为不受信任的插件切换到基于 iframe 的挂载，而无需更改插件的源代码（桥接 API 保持不变）。

### 19.0.3 包服务

插件 UI 包必须是预构建的 ESM。宿主不会在运行时编译或转换插件 UI 代码。

宿主在命名空间化的路径下将插件的 `dist/ui/` 目录作为静态资源提供服务：

- `/_plugins/:pluginId/ui/*`

当宿主渲染扩展槽位时，它从此路径动态导入插件的 UI 入口模块，解析 `ui.slots[].exportName` 中声明的命名导出，并将其挂载到槽位中。

在开发中，宿主可以支持插件配置中的 `devUiUrl` 覆盖，指向本地开发服务器（例如 Vite），以便插件作者可以在开发过程中使用热重载而无需重新构建。

## 19.1 全局操作员路由

- `/settings/plugins`
- `/settings/plugins/:pluginId`

这些路由是实例级的。

## 19.2 公司上下文路由

- `/:companyPrefix/plugins/:pluginId`

这些路由存在是因为仪表盘 UI 围绕公司组织，即使插件安装是全局的。

## 19.3 详情标签页

插件可以向以下页面添加标签页：

- 项目详情
- 任务详情
- 智能体详情
- 目标详情
- 运行详情

推荐的路由模式：

- `/:companyPrefix/<entity>/:id?tab=<plugin-tab-id>`

## 19.4 仪表盘小组件

插件可以向仪表盘添加卡片或区块。

## 19.5 侧边栏入口

插件可以添加侧边栏链接到：

- 全局插件设置
- 公司上下文插件页面

## 19.6 `@paperclipai/plugin-sdk/ui` 中的共享组件

宿主 SDK 提供共享组件，插件可以导入以快速构建匹配宿主外观的 UI。这些是便利的构建模块，不是强制要求。

| 组件 | 渲染内容 | 典型用途 |
|---|---|---|
| `MetricCard` | 带标签的单个数字，可选趋势/迷你图 | KPI、计数、比率 |
| `StatusBadge` | 内联状态指示器（ok/warning/error/info） | 同步健康状态、连接状态 |
| `DataTable` | 带可选排序和分页的行列表格 | 任务列表、作业历史、进程列表 |
| `TimeseriesChart` | 带时间戳数据点的折线图或柱状图 | 收入趋势、同步量、错误率 |
| `MarkdownBlock` | 渲染的 markdown 文本 | 描述、帮助文本、备注 |
| `KeyValueList` | 定义列表布局中的标签/值对 | 实体元数据、配置摘要 |
| `ActionBar` | 连接到 `usePluginAction` 的按钮行 | 重新同步、创建分支、重启进程 |
| `LogView` | 带时间戳的可滚动日志输出 | Webhook 投递、作业输出、进程日志 |
| `JsonTree` | 可折叠的 JSON 树，用于调试 | 原始 API 响应、插件状态检查 |
| `Spinner` | 加载指示器 | 数据获取状态 |

插件也可以使用完全自定义的组件。共享组件的存在是为了减少样板代码并保持视觉一致性，而不是限制插件可以渲染的内容。

## 19.7 通过桥接的错误传播

桥接 hooks 必须返回结构化错误，以便插件 UI 可以优雅地处理失败。

`usePluginData` 返回：

```ts
{
  data: T | null;
  loading: boolean;
  error: PluginBridgeError | null;
}
```

`usePluginAction` 返回一个异步函数，要么以结果解析，要么抛出 `PluginBridgeError`。

`PluginBridgeError` 结构：

```ts
interface PluginBridgeError {
  code: "WORKER_UNAVAILABLE" | "CAPABILITY_DENIED" | "WORKER_ERROR" | "TIMEOUT" | "UNKNOWN";
  message: string;
  /** 来自 worker 的原始错误详情（如可用） */
  details?: unknown;
}
```

错误码：

- `WORKER_UNAVAILABLE` — 插件 worker 未运行（崩溃、正在关闭、尚未启动）
- `CAPABILITY_DENIED` — 插件没有此操作所需的能力
- `WORKER_ERROR` — worker 从其 `getData` 或 `performAction` 处理程序返回了错误
- `TIMEOUT` — worker 在配置的超时时间内未响应
- `UNKNOWN` — 意外的桥接级故障

`@paperclipai/plugin-sdk/ui` 子路径还应导出一个 `ErrorBoundary` 组件，供插件作者用于捕获渲染错误而不会导致宿主页面崩溃。

## 19.8 插件设置 UI

每个在清单中声明了 `instanceConfigSchema` 的插件都会在 `/settings/plugins/:pluginId` 获得一个自动生成的设置表单。宿主根据 JSON Schema 渲染表单。

自动生成的表单支持：

- 从 schema 类型和枚举派生的文本输入、数字输入、开关、下拉选择
- 嵌套对象渲染为字段集
- 数组渲染为带添加/删除控件的可重复字段组
- 密钥引用字段：任何用 `"format": "secret-ref"` 注解的 schema 属性渲染为密钥选择器，通过 Paperclip 密钥提供者系统解析，而不是普通文本输入
- 从 schema 约束派生的验证消息（`required`、`minLength`、`pattern`、`minimum` 等）
- 如果插件声明了 `validateConfig` RPC 方法，则有"测试连接"操作——宿主调用它并内联显示结果

对于需要超出 JSON Schema 表达能力的更丰富设置 UX 的插件，插件可以在 `ui.slots` 中声明一个 `settingsPage` 槽位。存在时，宿主渲染插件自己的 React 组件而不是自动生成的表单。插件组件通过标准桥接与其 worker 通信以读写配置。

两种方式共存：插件可以使用自动生成的表单进行简单配置，并添加自定义设置页面槽位用于高级配置或运营仪表盘。

## 20. 本地工具

需要文件系统、git、终端或进程操作的插件直接实现这些操作。宿主不包装或代理这些操作。

宿主通过 `ctx.projects` 提供工作区元数据（列出工作区、获取主要工作区、从任务或智能体/运行解析工作区）。插件使用此元数据解析本地路径，然后使用标准 Node API 或其选择的任何库操作文件系统、生成进程、执行 `git` 命令或打开 PTY 会话。

这保持了宿主的精简——它不需要为插件可能需要的每个 OS 级操作维护并行 API 接口。插件拥有自己的文件浏览、git 工作流、终端会话和进程管理逻辑。

## 21. 持久化和 Postgres

## 21.1 数据库原则

1. 核心 Paperclip 数据保留在第一方表中。
2. 大多数插件拥有的数据从通用扩展表开始。
3. 插件数据在引入新表之前应先限定到现有 Paperclip 对象。
4. 任意第三方 schema 迁移不在第一版插件系统的范围内。

## 21.2 核心表复用

如果数据成为实际 Paperclip 产品模型的一部分，它应该成为第一方表。

示例：

- `project_workspaces` 已经是第一方表
- 如果 Paperclip 后来决定 git 状态是核心产品数据，它也应该成为第一方表

## 21.3 必需表

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

索引：

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

约束：

- unique `(plugin_id, scope_kind, scope_id, namespace, state_key)`

示例：

- 按 `issue` 键控的 Linear 外部 ID
- 按 `project` 键控的 GitHub 同步游标
- 按 `project_workspace` 键控的文件浏览器偏好
- 按 `project_workspace` 键控的 git 分支元数据
- 按 `project_workspace` 或 `run` 键控的进程元数据

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

约束：

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

索引：

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

索引：

- `(plugin_id, received_at desc)`
- `(plugin_id, endpoint_key, received_at desc)`

### `plugin_entities`（可选但推荐）

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

索引：

- `(plugin_id, entity_type, external_id)` 当 `external_id` 不为 null 时唯一
- `(plugin_id, scope_kind, scope_id, entity_type)`

用例：

- 导入的 Linear 任务
- 导入的 GitHub 任务
- 插件拥有的进程记录
- 插件拥有的外部指标绑定

## 21.4 活动日志变更

活动日志应扩展 `actor_type` 以包含 `plugin`。

新的操作者枚举：

- `agent`
- `user`
- `system`
- `plugin`

插件发起的变更操作应写入：

- `actor_type = plugin`
- `actor_id = <plugin-id>`

## 21.5 插件迁移

第一版插件系统不允许任意第三方迁移。

以后如果需要自定义表，系统可能会添加仅限受信任模块的迁移路径。

## 22. 密钥

插件配置绝不能持久化原始密钥值。

规则：

1. 插件配置仅存储密钥引用。
2. 密钥引用通过现有的 Paperclip 密钥提供者系统解析。
3. 插件 worker 仅在执行时接收已解析的密钥。
4. 密钥值绝不能写入：
   - 插件配置 JSON
   - 活动日志
   - webhook 投递行
   - 错误消息

## 23. 审计

所有插件发起的变更操作必须可审计。

最低要求：

- 每次变更操作的活动日志条目
- 作业运行历史
- webhook 投递历史
- 插件健康页面
- `plugins` 中的安装/升级历史

## 24. 操作员用户体验

## 24.1 全局设置

全局插件设置页面必须显示：

- 已安装的插件
- 版本
- 状态
- 请求的能力
- 当前错误
- 安装/升级/移除操作

## 24.2 插件设置页面

每个插件可以暴露：

- 从 `instanceConfigSchema` 派生的配置表单
- 健康详情
- 最近作业历史
- 最近 webhook 历史
- 能力列表

路由：

- `/settings/plugins/:pluginId`

## 24.3 公司上下文插件页面

每个插件可以暴露一个公司上下文主页面：

- `/:companyPrefix/plugins/:pluginId`

此页面是仪表盘用户执行大部分日常工作的地方。

## 25. 卸载和数据生命周期

当插件被卸载时，宿主必须显式处理插件拥有的数据。

### 25.1 卸载流程

1. 宿主向 worker 发送 `shutdown()` 并遵循优雅关闭策略。
2. 宿主在 `plugins` 表中将插件状态标记为 `uninstalled`（软删除）。
3. 插件拥有的数据（`plugin_state`、`plugin_entities`、`plugin_jobs`、`plugin_job_runs`、`plugin_webhook_deliveries`、`plugin_config`）在可配置的宽限期内保留（默认：30 天）。
4. 在宽限期内，操作员可以重新安装同一插件并恢复其状态。
5. 宽限期结束后，宿主清除已卸载插件的所有插件拥有数据。
6. 操作员可以通过 CLI 立即强制清除：`pnpm paperclipai plugin purge <plugin-id>`。

### 25.2 升级数据注意事项

插件升级不会自动迁移插件状态。如果插件的 `value_json` 结构在版本间发生变化：

- 插件 worker 负责在升级后首次访问时迁移自己的状态。
- 宿主不运行插件定义的 schema 迁移。
- 插件应对其状态键进行版本管理或在 `value_json` 内使用 schema 版本字段来检测和处理格式变更。

### 25.3 升级生命周期

升级插件时：

1. 宿主向旧 worker 发送 `shutdown()`。
2. 宿主等待旧 worker 排空进行中的工作（遵守关闭截止时间）。
3. 在截止时间内未完成的进行中作业被标记为 `cancelled`。
4. 宿主安装新版本并启动新 worker。
5. 如果新版本添加了能力，插件进入 `upgrade_pending`，操作员必须在新 worker 变为 `ready` 之前批准。

### 25.4 热插件生命周期

插件安装、卸载、升级和配置变更**必须**在不重启 Paperclip 服务器的情况下生效。这是规范性要求，不是可选的。

架构已经支持这一点——插件作为进程外 worker 运行，具有动态 ESM 导入、IPC 桥接和宿主管理的路由表。本节明确了这一要求，以便实现不会退化。

#### 25.4.1 热安装

当插件在运行时安装时：

1. 宿主在不停止现有服务的情况下解析和验证清单。
2. 宿主为插件生成一个新的 worker 进程。
3. 宿主在活跃路由表中注册插件的事件订阅、作业调度、webhook 端点和智能体工具声明。
4. 宿主将插件的 UI 包路径加载到扩展槽位注册表中，以便前端可以在下次导航时或通过实时通知发现它。
5. 插件进入 `ready` 状态（或如果需要能力审批则为 `upgrade_pending`）。

不影响任何其他插件或宿主服务。

#### 25.4.2 热卸载

当插件在运行时卸载时：

1. 宿主发送 `shutdown()` 并遵循优雅关闭策略（第 12.5 节）。
2. 宿主从活跃路由表中移除插件的事件订阅、作业调度、webhook 端点和智能体工具声明。
3. 宿主从扩展槽位注册表中移除插件的 UI 包。任何当前挂载的插件 UI 组件被卸载并替换为占位符或完全移除。
4. 宿主将插件标记为 `uninstalled` 并开始数据保留宽限期（第 25.1 节）。

无需服务器重启。

#### 25.4.3 热升级

当插件在运行时升级时：

1. 宿主遵循升级生命周期（第 25.3 节）——关闭旧 worker，启动新 worker。
2. 如果新版本更改了事件订阅、作业调度、webhook 端点或智能体工具，宿主原子性地将旧注册替换为新注册。
3. 如果新版本提供了更新的 UI 包，宿主使所有缓存的包资产失效，并通知前端重新加载插件 UI 组件。活跃用户在下次导航时或通过实时刷新通知看到更新的 UI。
4. 如果清单 `apiVersion` 未更改且未添加新能力，升级无需操作员交互即可完成。

#### 25.4.4 热配置变更

当操作员在运行时更新插件的实例配置时：

1. 宿主将新配置写入 `plugin_config`。
2. 宿主通过 IPC 向运行中的 worker 发送 `configChanged` 通知。
3. worker 通过 `ctx.config` 接收新配置并在不重启的情况下应用。如果插件需要重新初始化连接（例如新的 API 令牌），它在内部执行。
4. 如果插件不处理 `configChanged`，宿主使用新配置重启 worker 进程（优雅关闭后重启）。

#### 25.4.5 前端缓存失效

宿主必须对插件 UI 包 URL 进行版本化（例如 `/_plugins/:pluginId/ui/:version/*` 或基于内容哈希的路径），以便浏览器缓存在升级或重新安装后不会提供过时的包。

宿主应发出 `plugin.ui.updated` 事件，前端监听该事件以触发重新导入更新的插件模块，而无需完整页面重新加载。

#### 25.4.6 Worker 进程管理

宿主的插件进程管理器必须支持：

- 为新安装的插件启动 worker 而不影响其他 worker
- 为已卸载的插件停止 worker 而不影响其他 worker
- 在升级期间替换 worker（停止旧的，启动新的），从路由表的角度原子性地进行
- 崩溃后无需操作员干预重启 worker（带退避）

每个 worker 进程是独立的。没有共享进程池或批量重启机制。

## 26. 插件可观测性

### 26.1 日志

插件 worker 使用 `ctx.logger` 发出结构化日志。宿主捕获这些日志并以可查询的格式存储。

日志存储规则：

- 插件日志存储在 `plugin_logs` 表中或追加到插件数据目录下的日志文件中。
- 每个日志条目包含：插件 ID、时间戳、级别、消息和可选的结构化元数据。
- 日志可从 UI 中的插件设置页面查询。
- 日志有可配置的保留期限（默认：7 天）。
- 即使 worker 不使用 `ctx.logger`，宿主也会捕获 worker 进程的 `stdout` 和 `stderr` 作为后备日志。

### 26.2 健康仪表盘

插件设置页面必须显示：

- 当前 worker 状态（运行中、错误、已停止）
- 自上次重启以来的运行时间
- 最近日志条目
- 带成功/失败率的作业运行历史
- 带成功/失败率的 webhook 投递历史
- 最近健康检查结果和诊断
- 资源使用情况（如可用，包括内存、CPU）

### 26.3 告警

宿主应在插件健康状态恶化时发出内部事件。这些事件使用 `plugin.*` 命名空间（不是核心域事件），不会出现在核心活动日志中：

- `plugin.health.degraded` — worker 报告错误或健康检查失败
- `plugin.health.recovered` — worker 从错误状态恢复
- `plugin.worker.crashed` — worker 进程意外退出
- `plugin.worker.restarted` — worker 在崩溃后重启

这些事件可以被其他插件（例如通知插件）消费或在仪表盘中展示。

## 27. 插件开发和测试

### 27.1 `@paperclipai/plugin-test-harness`

宿主应发布一个测试工具包，供插件作者用于本地开发和测试。

测试工具包提供：

- 实现完整 SDK 接口的模拟宿主（`ctx.config`、`ctx.events`、`ctx.state` 等）
- 发送合成事件并验证处理程序响应的能力
- 触发作业运行并验证副作用的能力
- 模拟 `getData` 和 `performAction` 调用（如同来自 UI 桥接）的能力
- 模拟 `executeTool` 调用（如同来自智能体运行）的能力
- 用于断言的内存状态和实体存储
- 可配置的能力集，用于测试能力拒绝路径

示例用法：

```ts
import { createTestHarness } from "@paperclipai/plugin-test-harness";
import manifest from "../dist/manifest.js";
import { register } from "../dist/worker.js";

const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
await register(harness.ctx);

// 模拟事件
await harness.emit("issue.created", { issueId: "iss-1", projectId: "proj-1" });

// 验证状态已写入
const state = await harness.state.get({ pluginId: manifest.id, scopeKind: "issue", scopeId: "iss-1", namespace: "sync", stateKey: "external-id" });
expect(state).toBeDefined();

// 模拟 UI 数据请求
const data = await harness.getData("sync-health", { companyId: "comp-1" });
expect(data.syncedCount).toBeGreaterThan(0);
```

### 27.2 本地插件开发

针对运行中的 Paperclip 实例开发插件：

- 操作员从本地路径安装插件：`pnpm paperclipai plugin install ./path/to/plugin`
- 宿主监视插件目录的变更，并在重新构建时重启 worker。
- 插件配置中的 `devUiUrl` 可以指向本地 Vite 开发服务器以实现 UI 热重载。
- 插件设置页面显示来自 worker 的实时日志以用于调试。

### 27.3 插件入门模板

宿主应发布一个入门模板（`create-paperclip-plugin`），用于搭建：

- 包含正确 `paperclipPlugin` 键的 `package.json`
- 包含占位值的清单
- 包含 SDK 类型导入和示例事件处理程序的 worker 入口
- 包含使用桥接 hooks 的示例 `DashboardWidget` 的 UI 入口
- 使用测试工具包的测试文件
- 用于 worker 和 UI 包的构建配置（esbuild 或类似工具）
- `.gitignore` 和 `tsconfig.json`

## 28. 示例映射

本规范直接支持以下插件类型：

- `@paperclip/plugin-workspace-files`
- `@paperclip/plugin-terminal`
- `@paperclip/plugin-git`
- `@paperclip/plugin-linear`
- `@paperclip/plugin-github-issues`
- `@paperclip/plugin-grafana`
- `@paperclip/plugin-runtime-processes`
- `@paperclip/plugin-stripe`

## 29. 兼容性和版本管理

### 29.1 API 版本规则

1. 宿主支持一个或多个明确的插件 API 版本。
2. 插件清单声明恰好一个 `apiVersion`。
3. 宿主在安装时拒绝不支持的版本。
4. 插件升级是明确的操作员操作。
5. 能力扩展需要明确的操作员审批。

### 29.2 SDK 版本管理

宿主为插件作者发布单个 SDK 包：

- `@paperclipai/plugin-sdk` — 完整的插件 SDK

该包使用子路径导出来分离 worker 和 UI 关注点：

- `@paperclipai/plugin-sdk` — worker 端 SDK（context、events、state、tools、logger、`definePlugin`、`z`）
- `@paperclipai/plugin-sdk/ui` — 前端 SDK（桥接 hooks、共享组件、设计令牌）

单个包简化了插件作者的依赖管理——一个依赖、一个版本、一个更新日志。子路径导出保持包分离的清晰：worker 代码从根导入，UI 代码从 `/ui` 导入。构建工具相应地进行摇树优化，使 worker 包不包含 React 组件，UI 包不包含仅 worker 的代码。

版本管理规则：

1. **语义化版本**：SDK 遵循严格的语义化版本规范。主版本号升级表示 worker 或 UI 接口的破坏性变更；次版本号向后兼容地添加新功能；补丁版本仅修复错误。
2. **绑定 API 版本**：每个 SDK 主版本对应恰好一个插件 `apiVersion`。当 `@paperclipai/plugin-sdk@2.x` 发布时，它针对 `apiVersion: 2`。使用 SDK 1.x 构建的插件继续声明 `apiVersion: 1`。
3. **宿主多版本支持**：宿主必须同时支持至少当前和一个之前的 `apiVersion`。这意味着针对前一个 SDK 主版本构建的插件无需修改即可继续工作。宿主为每个支持的 API 版本维护单独的 IPC 协议处理程序。
4. **清单中的最低 SDK 版本**：插件在清单中将 `sdkVersion` 声明为 semver 范围（例如 `">=1.4.0 <2.0.0"`）。宿主在安装时验证此范围，如果插件声明的范围超出宿主支持的 SDK 版本则发出警告。
5. **弃用时间线**：当新 `apiVersion` 发布时，前一个版本进入至少 6 个月的弃用期。在此期间：
   - 宿主继续加载针对已弃用版本的插件。
   - 宿主在插件启动时记录弃用警告。
   - 插件设置页面显示一个横幅，表示插件应升级。
   - 弃用期结束后，宿主可以在未来版本中移除对旧版本的支持。
6. **SDK 更新日志和迁移指南**：每个 SDK 主版本发布必须包含迁移指南，记录每个破坏性变更、新的 API 接口和插件作者的逐步升级路径。
7. **UI 接口稳定性**：共享 UI 组件的破坏性变更（移除组件、更改必需属性）或设计令牌需要主版本号升级，就像 worker API 变更一样。单包模型意味着两个接口一起版本管理，避免 worker 和 UI 兼容性之间的偏差。

### 29.3 版本兼容性矩阵

宿主应发布兼容性矩阵：

| 宿主版本 | 支持的 API 版本 | SDK 范围 |
|---|---|---|
| 1.0 | 1 | 1.x |
| 2.0 | 1, 2 | 1.x, 2.x |
| 3.0 | 2, 3 | 2.x, 3.x |

此矩阵在宿主文档中发布，并可通过 `GET /api/plugins/compatibility` 查询。

### 29.4 插件作者工作流

当新 SDK 版本发布时：

1. 插件作者更新 `@paperclipai/plugin-sdk` 依赖。
2. 插件作者按照迁移指南更新代码。
3. 插件作者更新清单中的 `apiVersion` 和 `sdkVersion`。
4. 插件作者发布新的插件版本。
5. 操作员在其实例上升级插件。旧版本在明确升级之前继续工作。

## 30. 推荐交付顺序

## 第 1 阶段

- 插件清单
- 安装/列出/移除/升级 CLI
- 全局设置 UI
- 插件进程管理器
- 能力执行
- `plugins`、`plugin_config`、`plugin_state`、`plugin_jobs`、`plugin_job_runs`、`plugin_webhook_deliveries`
- 事件总线
- 作业
- webhook
- 设置页面
- 插件 UI 包加载、宿主桥接和 `@paperclipai/plugin-sdk/ui`
- 页面、标签页、小组件、侧边栏入口的扩展槽位挂载
- 桥接错误传播（`PluginBridgeError`）
- 从 `instanceConfigSchema` 自动生成设置表单
- 插件贡献的智能体工具
- 插件间事件（`plugin.<pluginId>.*` 命名空间）
- 事件过滤
- 带可配置截止时间的优雅关闭
- 插件日志和健康仪表盘
- `@paperclipai/plugin-test-harness`
- `create-paperclip-plugin` 入门模板
- 带数据保留宽限期的卸载
- 热插件生命周期（安装、卸载、升级、配置变更无需服务器重启）
- SDK 版本管理，支持多版本宿主和弃用策略

此阶段足以支持：

- Linear
- GitHub Issues
- Grafana
- Stripe
- 文件浏览器
- 终端
- git 工作流
- 进程/服务器跟踪

工作区插件（文件浏览器、终端、git、进程跟踪）不需要额外的宿主 API——它们通过 `ctx.projects` 解析工作区路径，并直接处理文件系统、git、PTY 和进程操作。

## 第 2 阶段

- 可选的 `plugin_entities`
- 更丰富的操作系统
- 受信任模块迁移路径（如确实需要）
- 不受信任插件 UI 包的 iframe 隔离
- 插件生态/分发工作

## 31. 最终设计决策

Paperclip 不应实现直接模仿本地编码工具的通用进程内 hook 包。

Paperclip 应实现：

- 用于底层宿主集成的受信任平台模块
- 用于累加式实例级功能的全局安装的进程外插件
- 插件贡献的智能体工具（命名空间化、能力受限）
- 通过类型化桥接在宿主扩展槽位中渲染的插件发布 UI 包，具有结构化错误传播
- 从配置 schema 自动生成设置 UI，并提供自定义设置页面选项
- 用于跨插件协调的插件间事件
- 用于高效事件路由的服务端事件过滤
- 插件直接拥有其本地工具逻辑（文件系统、git、终端、进程）
- 用于大多数插件状态的通用扩展表
- 优雅关闭、卸载数据生命周期和插件可观测性
- 热插件生命周期——安装、卸载、升级和配置变更无需服务器重启
- SDK 版本管理，支持多版本宿主和明确的弃用策略
- 测试工具包和入门模板，降低编写门槛
- 严格保护核心治理和审计规则

这就是 Paperclip 插件系统的完整目标设计。
