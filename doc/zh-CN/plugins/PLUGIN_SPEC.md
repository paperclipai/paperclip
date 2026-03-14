# Paperclip 插件系统规范

状态：V1 后插件系统的完整规范建议

本文档是Paperclip插件和扩展架构的完整规范。
它扩展了 [doc/SPEC.md](../SPEC.md) 中的简短插件注释，并且应该与 [doc/plugins/ideas-from-opencode.md](ideas-from-opencode.md) 中的比较分析一起阅读。

这不是 [doc/SPEC-implementation.md](../SPEC-implementation.md) 中 V1 实现合同的一部分。
这是应该遵循 V1 的插件系统的完整目标架构。

## 1.范围

该规范涵盖：

- 插件打包和安装
- 运行时模型
- 信任模型
- 能力系统
- UI 扩展界面
- 插件设置用户界面
- 智能体工具贡献
- 事件、作业和 Webhook 界面
- 插件到插件的通信
- 工作区插件的本地工具方法
- 用于扩展的 Postgres 持久性
- 卸载和数据生命周期
- 插件可观察性
- 插件开发和测试
- 操作员工作流程
- 热插件生命周期（无需重启服务器）
- SDK版本控制和兼容性规则

本规范不涵盖：

- 公共市场
- 云/SaaS 多租户
- 第一个插件版本中的任意第三方架构迁移
- 第一个插件版本中的 iframe-sandboxed 插件 UI（插件在主机扩展插槽中呈现为 ES 模块）

## 2. 核心假设

Paperclip插件设计基于以下假设：

1. Paperclip是单租户、自托管的。
2. 插件安装对于实例是全局的。
3. “公司”仍然是核心Paperclip业务对象，但它们不是插件信任边界。
4. 董事会治理、审批门、预算硬停止和核心任务不变性仍然由 Paperclip 核心拥有。
5. 项目已经通过 `project_workspaces` 拥有一个真实的工作区模型，本地/运行时插件应该在此基础上构建，而不是发明一个单独的工作区抽象。

## 3. 目标

插件系统必须：

1. 让运营商安装全局实例范围的插件。
2. 让插件添加主要功能而无需编辑Paperclip核心。
3. 保持核心治理和审计完好无损。
4. 支持本地/运行时插件和外部 SaaS 连接器。
5. 支持未来的插件类别，例如：
   - 新的智能体适配器
   - 收入跟踪
   - 知识库
   - 问题跟踪器同步
   - 指标/控制台
   - 文件/项目工具
6. 使用简单、明确、类型化的合同。
7. 保持故障隔离，这样一个插件就不会导致整个实例崩溃。

## 4. 非目标

第一个插件系统不得：1. 允许任意插件覆盖核心路由或核心不变量。
2. 允许任意插件改变批准、授权、问题结帐或预算执行逻辑。
3. 允许任意第三方插件运行自由格式的数据库迁移。
4. 依赖项目本地插件文件夹，例如`.paperclip/plugins`。
5. 依赖于服务器启动时从任意配置文件自动安装和执行的行为。

## 5. 术语

### 5.1 实例

操作员安装和控制的单个 Paperclip 部署。

### 5.2 公司

实例内有一个一流的 Paperclip 业务对象。

### 5.3 项目工作区

通过 `project_workspaces` 附加到项目的工作区。
插件从此模型解析工作空间路径，以查找文件、终端、git 和流程操作的本地目录。

### 5.4 平台模块

由 Paperclip 核心直接加载的可信进程内扩展。

示例：

- 智能体适配器
- 存储提供商
- 秘密提供者
- 运行日志后端

### 5.5 插件

通过 Paperclip 插件运行时加载的可安装实例范围扩展包。

示例：

- 线性同步
- GitHub 问题同步
- Grafana 小部件
- Stripe收入同步
- 文件浏览器
- 终端
- git工作流程

### 5.6 插件工作者

用于插件的运行时进程。
在此规范中，第三方插件默认在进程外运行。

### 5.7 能力

主机授予插件的命名权限。
插件只能调用授予功能所涵盖的主机 API。

## 6. 扩展类

Paperclip 有两个扩展类。

## 6.1 平台模块

平台模块有：

- 值得信赖
- 处理中
- 主机集成
- 低级

他们使用显式注册表，而不是一般的插件工作协议。

平台模块表面：

- `registerAgentAdapter()`
- `registerStorageProvider()`
- `registerSecretProvider()`
- `registerRunLogStore()`

平台模块适合：

- 新的智能体适配器包
- 新的存储后端
- 新的秘密后端
- 其他需要直接进程或数据库集成的主机内部系统

## 6.2 插件

插件有：

- 每个实例全局安装
- 通过插件运行时加载
- 添加剂
- 能力门控
- 通过稳定的 SDK 和主机协议与核心隔离

插件类别：

- `connector`
- `workspace`
- `automation`
- `ui`

一个插件可以声明多个类别。

## 7. 项目工作区

Paperclip 已经有一个具体的工作空间模型：

- 项目暴露`workspaces`
- 项目暴露`primaryWorkspace`
- 数据库包含`project_workspaces`
- 项目路线已经管理工作区需要本地工具（文件浏览、git、终端、进程跟踪）的插件可以通过项目工作区 APIs 解析工作区路径，然后对文件系统进行操作、生成进程并直接运行 git 命令。主机不包装这些操作——插件拥有自己的实现。

## 8. 安装模型

插件安装是全局的且由操作员驱动。

没有每个公司的安装表，也没有每个公司的启用/禁用开关。

如果插件需要特定于业务对象的映射，则这些映射将存储为插件配置或插件状态。

示例：

- 安装一个全局线性插件
- 从 A 公司到 Linear 团队 X 以及从 B 公司到 Linear 团队 Y 的映射
- 安装一个全局 git 插件
- 每个项目的工作空间状态存储在 `project_workspace` 下

## 8.1 磁盘布局

插件位于 Paperclip 实例目录下。

建议布局：

- `~/.paperclip/instances/default/plugins/package.json`
- `~/.paperclip/instances/default/plugins/node_modules/`
- `~/.paperclip/instances/default/plugins/.cache/`
- `~/.paperclip/instances/default/data/plugins/<plugin-id>/`

包安装目录和插件数据目录是分开的。

## 8.2 操作员命令

Paperclip 应添加 CLI 命令：

- `pnpm paperclipai plugin list`
- `pnpm paperclipai plugin install <package[@version]>`
- `pnpm paperclipai plugin uninstall <plugin-id>`
- `pnpm paperclipai plugin upgrade <plugin-id> [version]`
- `pnpm paperclipai plugin doctor <plugin-id>`

这些命令是实例级操作。

## 8.3 安装过程

安装过程是：

1. 解决npm包和版本。
2. 安装到实例插件目录中。
3. 阅读并验证插件清单。
4. 拒绝不兼容的插件API版本。
5. 向操作员显示请求的功能。
6. 在 Postgres 中保留安装记录。
7. 启动插件工作程序并运行运行状况/验证。
8. 标记插件`ready`或`error`。

## 9. 加载顺序和优先级

加载顺序必须是确定性的。

1. 核心平台模块
2. 内置第一方插件
3. 安装的插件排序方式：
   - 明确的操作员配置的顺序（如果存在）
   - 否则显示 `id`

规则：

- 插件贡献默认是累加的
- 插件不得通过名称冲突覆盖核心路由或核心操作
- UI 插槽 ID 自动按插件 ID 命名（例如 `@paperclip/plugin-linear:sync-health-widget`），因此跨插件冲突在结构上是不可能的
- 如果单个插件在其自己的清单中声明重复的插槽 ID，则主机必须在安装时拒绝

## 10. 打包合同

每个插件包必须导出一个清单、一个工作入口点和一个可选的 UI 包。

建议的封装布局：

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

## 10.1 清单形状

规范的明显形状：

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

规则：- `id` 必须是全局唯一的
- `id` 通常应等于 npm 包名称
- `apiVersion` 必须与主机支持的插件 API 版本匹配
- `capabilities` 必须是静态的并且安装时可见
- 配置模式必须与 JSON 模式兼容
- `entrypoints.ui` 指向包含构建的 UI 包的目录
- `ui.slots` 声明插件填充哪些扩展槽，因此主机知道要安装什么，而无需急切地加载捆绑包；每个插槽引用 UI 包中的 `exportName`

## 11. 智能体工具

插件可能会提供 Paperclip 智能体在运行期间可以使用的工具。

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

工具名称在运行时自动按插件 ID 命名（例如 `linear:search-issues`），因此插件无法隐藏核心工具或彼此的工具。

### 11.2 工具执行

当智能体在运行期间调用插件工具时，主机通过 `executeTool` RPC 方法将调用路由到插件工作器：

- `executeTool(input)` — 接收工具名称、解析的参数和运行上下文（智能体 ID、运行 ID、公司 ID、项目 ID）

工作人员执行工具逻辑并返回类型化结果。主机强制执行功能门 - 插件必须声明 `agent.tools.register` 才能贡献工具，并且各个工具可能需要额外的功能（例如，调用外部 API 的工具需要 `http.outbound`）。

### 11.3 工具可用性

默认情况下，插件工具可供所有智能体使用。操作员可以通过插件配置限制每个智能体或每个项目的工具可用性。

插件工具与核心工具一起出现在智能体的工具列表中，但在 UI 中以视觉方式区分为插件提供的工具。

### 11.4 约束

- 插件工具不得按名称覆盖或隐藏核心工具。
- 插件工具必须尽可能是幂等的。
- 工具执行与其他插件工作程序调用一样受到相同的超时和资源限制。
- 工具结果包含在运行日志中。

## 12. 运行时模型

## 12.1 过程模型

第三方插件默认在进程外运行。

默认运行时间：

- Paperclip 服务器为每个安装的插件启动一个工作进程
-工作进程是一个Node进程
- 主机和工作人员通过 stdio 上的 JSON-RPC 进行通信

该设计提供：

- 故障隔离
- 更清晰的记录边界
- 更简单的资源限制
- 比任意进程内执行更清晰的信任边界

## 12.2 主持人职责

主办方负责：

- 包安装
- 清单验证
- 能力执行
- 过程监督
- 作业调度
- 网络钩子路由
- 活动日志写入
- 秘密决议
- UI路由注册

## 12.3 工人的责任

插件工作者负责：- 验证自己的配置
- 处理领域事件
- 处理预定的作业
- 处理网络钩子
- 通过 `getData` 和 `performAction` 为插件自己的 UI 提供数据和处理操作
- 通过SDK调用主机服务
- 报告健康信息

## 12.4 失败策略

如果工人失败：

- 标记插件状态 `error`
- 插件运行状况 UI 中出现表面错误
- 保持实例的其余部分运行
- 以有界退避重试开始
- 不要删除其他插件或核心服务

## 12.5 优雅关闭策略

当主机需要停止插件工作程序时（用于升级、卸载或实例关闭）：

1. Host发送`shutdown()`给Worker。
2. 工作人员有 10 秒的时间完成飞行中的工作并干净利落地退出。
3. 如果worker没有在期限内退出，则主机发送SIGTERM。
4. 如果worker在SIGTERM后5秒内没有退出，则主机发送SIGKILL。
5. 任何正在进行的作业运行都标记为 `cancelled`，并附有指示强制关闭的注释。
6. 任何正在进行的 `getData` 或 `performAction` 调用都会向桥接器返回错误。

对于需要更长耗尽时间的插件，关闭截止时间应该可以在插件配置中针对每个插件进行配置。

## 13. 主机-工作协议

主机必须支持以下工作 RPC 方法。

所需方法：

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

在工作进程启动时调用一次。

输入包括：

- 插件清单
- 解决了插件配置
- 实例信息
- 主机API版本

### 13.2 `health`

返回：

- 状态
- 当前错误（如果有）
- 可选插件报告的诊断

### 13.3 `validateConfig`

在配置更改和启动后运行。

返回：

- `ok`
- 警告
- 错误

### 13.4 `configChanged`

当操作员在运行时更新插件的实例配置时调用。

输入包括：

- 新解决的配置

如果工作人员实现此方法，它将应用新配置而无需重新启动。如果工作进程没有实现此方法，主机将使用新配置重新启动工作进程（正常关闭然后重新启动）。

### 13.5 `onEvent`

接收一个类型为 Paperclip 的域事件。

传递语义：

- 至少一次
- 插件必须是幂等的
- 不保证所有活动类型的全局排序
- 每个实体的排序是尽力而为，但重试后不能保证

### 13.6 `runJob`

运行已声明的预定作业。

楼主提供：

- 工作钥匙
- 触发源
- 运行ID
- 安排元数据

### 13.7 `handleWebhook`

接收主机路由的入站 Webhook 负载。

楼主提供：- 端点密钥
- 标题
- 原始身体
- 解析正文（如果适用）
- 请求ID

### 13.8 `getData`

返回插件自己的 UI 组件请求的插件数据。

插件 UI 调用主机桥，主机桥将请求转发给工作线程。工作程序返回插件自己的前端组件渲染的类型为 JSON 的值。

输入包括：

- 数据密钥（插件定义，例如`"sync-health"`、`"issue-detail"`）
- 上下文（公司 ID、项目 ID、实体 ID 等）
- 可选的查询参数

### 13.9 `performAction`

运行由板 UI 发起的显式插件操作。

示例：

- “立即重新同步”
-“链接GitHub问题”
- “从问题创建分支”
- “重新启动进程”

### 13.10 `executeTool`

在运行期间运行插件提供的智能体工具。

楼主提供：

- 工具名称（不带插件名称空间前缀）
- 与工具声明的模式匹配的解析参数
- 运行上下文：智能体 ID、运行 ID、公司 ID、项目 ID

工作人员执行该工具并返回类型化结果（字符串内容、结构化数据或错误）。

## 14. SDK 表面

插件不直接与数据库对话。
插件不会从持久配置中读取原始秘密材料。

向工作人员公开的 SDK 必须提供类型化的主机客户端。

所需的 SDK 客户端：

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

`ctx.data` 和 `ctx.actions` 注册插件自己的 UI 通过主机桥调用的处理程序。 `ctx.data.register(key, handler)` 在前端支持 `usePluginData(key)`。 `ctx.actions.register(key, handler)`支持`usePluginAction(key)`。

需要文件系统、git、终端或进程操作的插件直接使用标准 Node API 或库来处理这些操作。主机通过 `ctx.projects` 提供项目工作区元数据，以便插件可以解析工作区路径，但主机不智能体低级操作系统操作。

## 14.1 SDK 形状示例

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

能力是强制性的和静态的。
每个插件都会预先声明它们。

主机强制执行 SDK 层中的功能，并拒绝授权集之外的调用。

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

### 运行时/集成

- `events.subscribe`
- `events.emit`
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`

### 智能体工具

- `agent.tools.register`

### 用户界面- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register`
- `ui.dashboardWidget.register`
- `ui.action.register`

## 15.2 禁止的能力

主机不得公开以下功能：

- 批准决定
- 预算超控
- 验证绕过
- 问题结账锁定覆盖
- 直接数据库访问

## 15.3 升级规则

如果插件升级添加了功能：

1. 宿主必须标记插件`upgrade_pending`
2. 运营商必须明确批准新的能力集
3. 审批完成后新版本不会变成`ready`

## 16. 事件系统

主机必须发出插件可以订阅的类型化域事件。

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

每个事件必须包括：

- 事件ID
- 事件类型
- 发生于
- 适用时演员元数据
- 主要实体元数据
- 输入有效负载

### 16.1 事件过滤

插件可以在订阅事件时提供可选的过滤器。过滤器在分派给工作线程之前由主机进行评估，因此过滤掉的事件永远不会跨越进程边界。

支持的过滤字段：

- `projectId` — 仅接收特定项目的事件
- `companyId` — 仅接收特定公司的事件
- `agentId` — 仅接收特定智能体的事件

过滤器是可选的。如果省略，插件将接收订阅类型的所有事件。过滤器可以组合（例如按公司和项目过滤）。

### 16.2 插件到插件事件

插件可以使用 `ctx.events.emit(name, payload)` 发出自定义事件。插件发出的事件使用命名空间事件类型：`plugin.<pluginId>.<eventName>`。

其他插件可以使用相同的 `ctx.events.on()` API 订阅这些事件：

```ts
ctx.events.on("plugin.@paperclip/plugin-git.push-detected", async (event) => {
  // react to the git plugin detecting a push
});
```

规则：

- 插件事件需要 `events.emit` 功能。
- 插件事件不是核心域事件 - 它们不会出现在核心活动日志中，除非发出插件明确记录它们。
- 插件事件遵循与核心事件相同的至少一次传递语义。
- 主机不得允许插件在核心命名空间中发出事件（没有 `plugin.` 前缀的事件）。

## 17. 预定作业

插件可以在其清单中声明预定的作业。

岗位规则：

1、每个职业都有一个稳定的`job_key`。
2. 主机是记录的调度者。
3. 主机防止同一插件/作业组合的重叠执行，除非稍后明确允许。
4. 每个作业运行都记录在 Postgres 中。
5. 失败的作业可以重试。

## 18. Webhooks

插件可以在其清单中声明 webhook 端点。Webhook 路由形状：

- `POST /api/plugins/:pluginId/webhooks/:endpointKey`

规则：

1. 主机拥有公共路由。
2. Worker通过`handleWebhook`接收请求体。
3. 使用主机解析的秘密引用在插件代码中进行签名验证。
4. 每次交货都有记录。
5. Webhook 处理必须是幂等的。

## 19. UI 扩展模型

插件将自己的前端 UI 作为捆绑的 React 模块提供。主机将插件 UI 加载到指定的扩展插槽中，并为插件前端提供与其自己的工作后端和主机 API 通信的桥梁。

### 插件 UI 发布的实际工作原理

插件的 `dist/ui/` 目录包含构建的 React 包。当用户导航到插件界面（插件页面、详细信息选项卡、控制台小部件等）时，主机提供该捆绑包并将其加载到页面中。

**主机提供，插件渲染：**

1. 主机定义**扩展槽** - UI 中可以出现插件组件（页面、选项卡、小部件、侧边栏条目、操作栏）的指定安装点。
2. 插件的 UI 包为其想要填充的每个插槽导出命名组件。
3. 主机将插件组件安装到插槽中，并向其传递一个**主机桥**对象。
4. 插件组件使用桥从自己的worker获取数据（通过`getData`），调用操作（通过`performAction`），读取主机上下文（当前公司，项目，实体），并使用共享主机UI原语（设计令牌，公共组件）。

**具体示例：线性插件附带控制台小部件。**

该插件的 UI 包导出：

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

**运行时会发生什么：**

1. 用户打开控制台。主机看到 Linear 插件注册了 `DashboardWidget` 导出。
2. 主机将插件的`DashboardWidget`组件挂载到控制台小部件槽中，传递`context`（当前公司、用户等）和桥接器。
3. `usePluginData("sync-health", ...)` 通过桥接 → 主机 → 插件工作者的 `getData` RPC → 返回 JSON → 插件组件根据需要渲染它。
4. 当用户点击“立即重新同步”时，`usePluginAction("resync")` 通过网桥 → 主机 → 插件工作者的 `performAction` RPC 进行调用。

**主机控制什么：**

- 主机决定插件组件出现的**位置**（存在哪些插槽以及何时安装）。
- 主机提供 **bridge** — 插件 UI 无法发出任意网络请求或直接访问主机内部。
- 主机强制执行 **能力门** - 如果插件的工作人员不具备能力，则即使 UI 请求，桥也会拒绝调用。
- 主机通过 `@paperclipai/plugin-sdk/ui` 提供**设计令牌和共享组件**，因此插件可以匹配主机的视觉语言而无需被迫。

**插件控制什么：**- 插件决定**如何**呈现其数据 - 它拥有其 React 组件、布局、交互和状态管理。
- 插件决定**哪些数据**要获取以及**哪些操作**要公开。
- 该插件可以在其捆绑包内使用任何 React 模式（挂钩、上下文、第三方组件库）。

### 19.0.1 插件UI SDK (`@paperclipai/plugin-sdk/ui`)

SDK 包含插件前端导入的 `ui` 子路径导出。该子路径提供：

- **桥钩**：`usePluginData(key, params)`、`usePluginAction(key)`、`useHostContext()`
- **设计标记**：与主机主题匹配的颜色、间距、排版、阴影
- **共享组件**：`MetricCard`、`StatusBadge`、`DataTable`、`LogView`、`ActionBar`、`Spinner` 等。
- **类型定义**：`PluginPageProps`、`PluginWidgetProps`、`PluginDetailTabProps`

鼓励但不强制使用插件来使用共享组件。只要插件通过桥进行通信，就可以呈现完全自定义的 UI。

### 19.0.2 捆绑包隔离

插件 UI 包作为标准 ES 模块加载，而不是 iframe。这为插件提供了完整的渲染性能并可以访问主机的设计令牌。

隔离规则：

- 插件包不得从主机内部导入。它们只能从 `@paperclipai/plugin-sdk/ui` 及其自己的依赖项导入。
- 插件包不得直接访问 `window.fetch` 或 `XMLHttpRequest` 来进行主机 API 调用。所有主机通信都通过网桥。
- 主机可以强制执行内容安全策略规则，仅限制插件网络访问桥接端点。
- 插件包必须是可静态分析的——插件自己的包之外没有动态 `import()` 的 URL。

如果以后需要更强的隔离，主机可以将不受信任的插件转移到基于 iframe 的安装，而无需更改插件的源代码（桥 API 保持不变）。

### 19.0.3 捆绑服务

插件 UI 捆绑包必须预先构建 ESM。主机不会在运行时编译或转换插件 UI 代码。

主机将插件的 `dist/ui/` 目录作为命名空间路径下的静态资产提供服务：

- `/_plugins/:pluginId/ui/*`

当主机渲染扩展槽时，它会从此路径动态导入插件的UI入口模块，解析`ui.slots[].exportName`中声明的命名导出，并将其挂载到槽中。

在开发过程中，主机可能会在插件配置中支持 `devUiUrl` 覆盖，该配置指向本地开发服务器（例如 Vite），因此插件作者可以在开发过程中使用热重载而无需重建。

## 19.1 全球运营商路线

- `/settings/plugins`
- `/settings/plugins/:pluginId`

这些路由是实例级的。

## 19.2 公司上下文路由

- `/:companyPrefix/plugins/:pluginId`

这些路线的存在是因为董事会 UI 是围绕公司组织的，即使插件安装是全局的。

## 19.3 详细信息选项卡插件可以将选项卡添加到：

- 项目细节
- 问题详细信息
- 智能体详细信息
- 目标细节
- 运行细节

推荐路线模式：

- `/:companyPrefix/<entity>/:id?tab=<plugin-tab-id>`

## 19.4 控制台小部件

插件可以将卡片或部分添加到控制台。

## 19.5 侧边栏条目

插件可以将侧边栏链接添加到：

- 全局插件设置
- 公司上下文插件页面

## 19.6 `@paperclipai/plugin-sdk/ui` 中的共享组件

主机 SDK 提供了共享组件，插件可以导入这些组件来快速构建与主机外观相匹配的 UI。这些是方便的构建块，而不是必需的。

|组件|它呈现什么 |典型用途|
|---|---|---|
| `MetricCard` |带标签的单个数字，可选趋势/迷你图 | KPI、计数、比率 |
| `StatusBadge` |内联状态指示器（正常/警告/错误/信息）|同步健康状况、连接状态 |
| `DataTable` |具有可选排序和分页功能的行和列 |问题列表、作业历史记录、流程列表 |
| `TimeseriesChart` |带有时间戳数据点的折线图或条形图 |收入趋势、同步量、错误率 |
| `MarkdownBlock` |渲染的 Markdown 文本 |描述、帮助文本、注释 |
| `KeyValueList` |定义列表布局中的标签/值对 |实体元数据、配置摘要 |
| `ActionBar` |连接到 `usePluginAction` 的一排按钮 |重新同步、创建分支、重新启动进程 |
| `LogView` |带时间戳的可滚动日志输出 | Webhook 交付、作业输出、流程日志 |
| `JsonTree` |用于调试的可折叠 JSON 树 |原始 API 响应，插件状态检查 |
| `Spinner` |加载指示器 |数据获取状态 |

插件也可以使用完全自定义的组件。共享组件的存在是为了减少样板文件并保持视觉一致性，而不是限制插件可以渲染的内容。

## 19.7 通过桥的误差传播

桥接钩子必须返回结构化错误，以便插件 UI 可以优雅地处理故障。

`usePluginData` 返回：

```ts
{
  data: T | null;
  loading: boolean;
  error: PluginBridgeError | null;
}
```

`usePluginAction` 返回一个异步函数，该函数要么解析结果，要么抛出 `PluginBridgeError`。

`PluginBridgeError` 形状：

```ts
interface PluginBridgeError {
  code: "WORKER_UNAVAILABLE" | "CAPABILITY_DENIED" | "WORKER_ERROR" | "TIMEOUT" | "UNKNOWN";
  message: string;
  /** Original error details from the worker, if available */
  details?: unknown;
}
```

错误代码：

- `WORKER_UNAVAILABLE` — 插件工作程序未运行（崩溃、关闭、尚未启动）
- `CAPABILITY_DENIED` — 该插件不具备此操作所需的功能
- `WORKER_ERROR` — 工作线程从其 `getData` 或 `performAction` 处理程序返回错误
- `TIMEOUT` — 工作线程在配置的超时时间内没有响应
- `UNKNOWN` — 意外的桥接级故障

`@paperclipai/plugin-sdk/ui` 子路径还应该导出 `ErrorBoundary` 组件，插件作者可以使用该组件来捕获渲染错误，而不会导致主机页面崩溃。

## 19.8 插件设置用户界面每个在其清单中声明 `instanceConfigSchema` 的插件都会在 `/settings/plugins/:pluginId` 处获得自动生成的设置表单。主机根据 JSON 架构呈现表单。

自动生成的表单支持：

- 文本输入、数字输入、切换、从模式类型和枚举派生的选择下拉列表
- 呈现为字段集的嵌套对象
- 数组呈现为可重复的字段组，并带有添加/删除控件
- 秘密引用字段：用 `"format": "secret-ref"` 注释的任何模式属性都会呈现为秘密选择器，通过 Paperclip 秘密提供程序系统而不是纯文本输入进行解析
- 从模式约束派生的验证消息（`required`、`minLength`、`pattern`、`minimum` 等）
- 如果插件声明 `validateConfig` RPC 方法，则“测试连接”操作 - 主机调用它并内联显示结果

对于需要超出 JSON Schema 所能表达的更丰富设置 UX 的插件，该插件可以在 `ui.slots` 中声明一个 `settingsPage` 插槽。当存在时，主机呈现插件自己的 React 组件，而不是自动生成的表单。插件组件通过标准桥与其工作人员通信以读取和写入配置。

两种方法共存：插件可以使用自动生成的表单进行简单配置，并添加自定义设置页面槽以进行高级配置或操作控制台。

## 20. 本地工具

需要文件系统、git、终端或进程操作的插件直接实现这些操作。主机不包装或智能体这些操作。

主机通过 `ctx.projects` 提供工作区元数据（列出工作区、获取主工作区、解决问题或智能体/运行中的工作区）。插件使用此元数据来解析本地路径，然后对文件系统进行操作，生成进程，shell 到 `git`，或使用标准 Node API 或他们选择的任何库打开 PTY 会话。

这使主机保持精简——它不需要为插件可能需要的每个操作系统级操作维护并行的 API 表面。插件拥有自己的文件浏览、git 工作流程、终端会话和流程管理逻辑。

## 21. 持久化和 Postgres

## 21.1 数据库原理

1. 核心Paperclip数据保留在第一方表中。
2. 大多数插件拥有的数据都从通用扩展表开始。
3. 在引入新表之前，插件数据的范围应限于现有的 Paperclip 对象。
4. 任意第三方模式迁移超出了第一个插件系统的范围。

## 21.2 核心表重用

如果数据成为实际Paperclip产品模型的一部分，它应该成为第一方表。

示例：- `project_workspaces` 已经是第一方
- 如果Paperclip后来决定git state是核心产品数据，它也应该成为第一方表

## 21.3 所需表格

### `plugins`

- `id` uuid pk
- `plugin_key` 文本唯一不为空
- `package_name` 文本不为空
- `version` 文本不为空
- `api_version` int 不为空
- `categories` 文本[]不为空
- `manifest_json` jsonb 不为空
- `status` 枚举：`installed | ready | error | upgrade_pending`
- `install_order` int null
- `installed_at` 时间戳不为空
- `updated_at` 时间戳不为空
- `last_error` 文字为空

索引：

- 独特的`plugin_key`
- `status`

### `plugin_config`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` 唯一不为空
- `config_json` jsonb 不为空
- `created_at` 时间戳不为空
- `updated_at` 时间戳不为空
- `last_error` 文字为空

### `plugin_state`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` 不为空
- `scope_kind` 枚举：`instance | company | project | project_workspace | agent | issue | goal | run`
- `scope_id` uuid/文本为空
- `namespace` 文本不为空
- `state_key` 文本不为空
- `value_json` jsonb 不为空
- `updated_at` 时间戳不为空

限制条件：

- 独特的`(plugin_id, scope_kind, scope_id, namespace, state_key)`

示例：

- 由 `issue` 键入的线性外部 ID
- GitHub 同步光标由 `project` 键入
- 由 `project_workspace` 键控的文件浏览器首选项
- git 分支元数据由 `project_workspace` 键入
- 处理由`project_workspace`或`run`键入的元数据

### `plugin_jobs`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` 不为空
- `scope_kind` 枚举可为空
- `scope_id` uuid/文本为空
- `job_key` 文本不为空
- `schedule` 文字为空
- `status` 枚举：`idle | queued | running | error`
- `next_run_at` 时间戳空
- `last_started_at` 时间戳空
- `last_finished_at` 时间戳空
- `last_succeeded_at` 时间戳空
- `last_error` 文字为空

限制条件：

- 独特的`(plugin_id, scope_kind, scope_id, job_key)`

### `plugin_job_runs`

- `id` uuid pk
- `plugin_job_id` uuid fk `plugin_jobs.id` 不为空
- `plugin_id` uuid fk `plugins.id` 不为空
- `status` 枚举：`queued | running | succeeded | failed | cancelled`
- `trigger` 枚举：`schedule | manual | retry`
- `started_at` 时间戳为空
- `finished_at` 时间戳空
- `error` 文字为空
- `details_json` jsonb 空

索引：

- `(plugin_id, started_at desc)`
- `(plugin_job_id, started_at desc)`

### `plugin_webhook_deliveries`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` 不为空
- `scope_kind` 枚举可为空
- `scope_id` uuid/文本为空
- `endpoint_key` 文本不为空
- `status` 枚举：`received | processed | failed | ignored`
- `request_id` 文字为空
- `headers_json` jsonb 空
- `body_json` jsonb 空
- `received_at`时间戳不为空
- `handled_at` 时间戳空
- `response_code` int null
- `error` 文字为空

索引：

- `(plugin_id, received_at desc)`
- `(plugin_id, endpoint_key, received_at desc)`

### `plugin_entities`（可选但推荐）- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` 不为空
- `entity_type` 文本不为空
- `scope_kind` 枚举不为空
- `scope_id` uuid/文本为空
- `external_id` 文字为空
- `title` 文字为空
- `status` 文字为空
- `data_json` jsonb 不为空
- `created_at` 时间戳不为空
- `updated_at` 时间戳不为空

索引：

- 当 `external_id` 不为空时，`(plugin_id, entity_type, external_id)` 唯一
- `(plugin_id, scope_kind, scope_id, entity_type)`

使用案例：

- 导入线性问题
- 导入GitHub问题
- 插件拥有的进程记录
- 插件拥有的外部指标绑定

## 21.4 活动日志更改

活动日志应扩展 `actor_type` 以包含 `plugin`。

新演员枚举：

- `agent`
- `user`
- `system`
- `plugin`

插件引发的突变应该这样写：

- `actor_type = plugin`
- `actor_id = <plugin-id>`

## 21.5 插件迁移

第一个插件系统不允许任意第三方迁移。

稍后，如果需要自定义表，系统可能会添加仅受信任模块的迁移路径。

## 22. 秘密

插件配置绝不能保留原始秘密值。

规则：

1. 插件配置仅存储秘密引用。
2. 通过现有的Paperclip秘密提供者系统进行秘密引用解析。
3. 插件工作人员仅在执行时接收已解析的机密。
4. 秘密值绝不能写入：
   - 插件配置 JSON
   - 活动日志
   - webhook 传递行
   - 错误消息

## 23. 审计

所有插件发起的变异操作都必须是可审核的。

最低要求：

- 每个突变的活动日志条目
- 作业运行历史记录
- webhook 传递历史记录
- 插件健康页面
- 安装/升级历史记录在`plugins`

## 24. 操作员用户体验

## 24.1 全局设置

全局插件设置页面必须显示：

- 安装的插件
- 版本
- 状态
- 要求的能力
- 当前错误
- 安装/升级/删除操作

## 24.2 插件设置页面

每个插件可能会暴露：

- 配置表单源自`instanceConfigSchema`
- 健康详情
- 最近的工作经历
- 最近的 webhook 历史记录
- 能力列表

路线：

- `/settings/plugins/:pluginId`

## 24.3 公司上下文插件页面

每个插件可能会公开一个公司上下文主页：

- `/:companyPrefix/plugins/:pluginId`

此页面是董事会用户进行大部分日常工作的地方。

## 25. 卸载和数据生命周期

当插件被卸载时，主机必须显式处理插件拥有的数据。

### 25.1 卸载过程1. Host发送`shutdown()`给worker，遵循优雅关闭策略。
2、主机在`plugins`表中标记插件状态`uninstalled`（软删除）。
3. 插件拥有的数据（`plugin_state`、`plugin_entities`、`plugin_jobs`、`plugin_job_runs`、`plugin_webhook_deliveries`、`plugin_config`）保留可配置的宽限期（默认：30 天）。
4. 在宽限期内，操作员可以重新安装相同的插件并恢复其状态。
5. 宽限期过后，主机将清除已卸载插件的所有插件拥有的数据。
6、操作者可通过CLI立即强制清除：`pnpm paperclipai plugin purge <plugin-id>`。

### 25.2 升级数据注意事项

插件升级不会自动迁移插件状态。如果插件的 `value_json` 形状在版本之间发生变化：

- 插件工作人员负责在升级后首次访问时迁移其自己的状态。
- 主机不运行插件定义的架构迁移。
- 插件应该对其状态键进行版本控制或使用 `value_json` 内的架构版本字段来检测和处理格式更改。

### 25.3 升级生命周期

升级插件时：

1、主机发送`shutdown()`给老worker。
2. 主机等待旧工作进程耗尽运行中的工作（遵守关闭期限）。
3. 任何未在截止日期内完成的正在进行的作业均标记为 `cancelled`。
4. 主机安装新版本并启动新worker。
5、如果新版本增加了能力，插件进入`upgrade_pending`，必须经过运营商批准后，新的worker才会变成`ready`。

### 25.4 热插件生命周期

插件安装、卸载、升级和配置更改**必须**生效，而无需重新启动 Paperclip 服务器。这是规范性要求，不是可选的。

该架构已经支持这一点——插件作为进程外工作人员运行，具有动态 ESM 导入、IPC 桥接和主机管理的路由表。本节明确了要求，因此实现不会倒退。

#### 25.4.1 热安装

当插件在运行时安装时：

1. 主机在不停止现有服务的情况下解析并验证清单。
2. 主机为插件生成一个新的工作进程。
3. 主机在实时路由表中注册插件的事件订阅、作业计划、webhook 端点和智能体工具声明。
4. 主机将插件的 UI 包路径加载到扩展槽注册表中，以便前端可以在下次导航时或通过实时通知发现它。
5. 插件进入`ready`状态（如果需要能力审批则进入`upgrade_pending`状态）。

没有其他插件或主机服务被中断。

#### 25.4.2 热卸载

当插件在运行时被卸载时：1.主机发送`shutdown()`并遵循优雅关闭策略（第12.5节）。
2. 主机从实时路由表中删除插件的事件订阅、作业计划、Webhook 端点和智能体工具声明。
3. 主机从扩展槽注册表中删除插件的 UI 包。任何当前安装的插件 UI 组件都将被卸载并替换为占位符或完全删除。
4. 主机标记插件 `uninstalled` 并启动数据保留宽限期（第 25.1 节）。

无需重新启动服务器。

#### 25.4.3 热升级

当插件在运行时升级时：

1. 主机遵循升级生命周期（第25.3节）——关闭旧的worker，启动新的worker。
2. 如果新版本更改了事件订阅、作业计划、Webhook 端点或智能体工具，主机会自动将旧注册替换为新注册。
3. 如果新版本发布了更新的 UI 包，则主机将使所有缓存的包资源失效，并通知前端重新加载插件 UI 组件。活跃用户会在下次导航时或通过实时刷新通知看到更新的 UI。
4. 如果清单 `apiVersion` 未更改且未添加新功能，则升级无需操作员交互即可完成。

#### 25.4.4 热配置更改

当操作员在运行时更新插件的实例配置时：

1. 主机将新配置写入`plugin_config`。
2. 主机通过IPC向正在运行的worker发送`configChanged`通知。
3. worker通过`ctx.config`接收新配置并应用它而无需重新启动。如果插件需要重新初始化连接（例如新的 API 令牌），它会在内部执行此操作。
4. 如果插件不处理 `configChanged`，主机将使用新配置重新启动工作进程（正常关闭然后重新启动）。

#### 25.4.5 前端缓存失效

主机必须对插件 UI 捆绑包 URL（例如 `/_plugins/:pluginId/ui/:version/*` 或基于内容哈希的路径）进行版本控制，以便浏览器缓存在升级或重新安装后不会提供过时的捆绑包。

主机应发出 `plugin.ui.updated` 事件，前端侦听该事件以触发重新导入更新的插件模块，而无需重新加载整个页面。

#### 25.4.6 工作进程管理

主机的插件进程管理器必须支持：

- 为新安装的插件启动一个worker，而不影响其他worker
- 停止已卸载插件的工作人员，而不影响其他工作人员
- 从路由表的角度来看，在升级期间自动替换工作人员（停止旧的，开始新的）
- 崩溃后重新启动工作程序，无需操作员干预（带退避）

每个工作进程都是独立的。没有共享进程池或批量重启机制。

## 26. 插件可观察性

### 26.1 日志记录插件工作人员使用 `ctx.logger` 发出结构化日志。主机捕获这些日志并以可查询的格式存储它们。

日志存储规则：

- 插件日志存储在 `plugin_logs` 表中或附加到插件数据目录下的日志文件中。
- 每个日志条目包括：插件 ID、时间戳、级别、消息和可选的结构化元数据。
- 日志可从 UI 中的插件设置页面查询。
- 日志具有可配置的保留期限（默认值：7 天）。
- 即使工作进程不使用 `ctx.logger`，主机也会从工作进程捕获 `stdout` 和 `stderr` 作为后备日志。

### 26.2 健康控制台

插件设置页面必须显示：

- 当前工作状态（运行、错误、停止）
- 自上次重启以来的正常运行时间
- 最近的日志条目
- 作业运行历史记录以及成功/失败率
- webhook 传送历史记录以及成功/失败率
- 最后的健康检查结果和诊断
- 资源使用情况（如果可用）（内存、CPU）

### 26.3 警报

当插件运行状况恶化时，主机应发出内部事件。这些使用 `plugin.*` 命名空间（不是核心域事件）并且不会出现在核心活动日志中：

- `plugin.health.degraded` — 工人报告错误或健康检查失败
- `plugin.health.recovered` — 工作线程从错误状态中恢复
- `plugin.worker.crashed` — 工作进程意外退出
- `plugin.worker.restarted` — 工作进程在崩溃后重新启动

这些事件可以由其他插件（例如通知插件）使用或显示在控制台中。

## 27. 插件开发和测试

### 27.1 `@paperclipai/plugin-test-harness`

主机应发布一个测试工具包，供插件作者用于本地开发和测试。

测试工具提供：

- 实现完整SDK接口的模拟主机（`ctx.config`、`ctx.events`、`ctx.state`等）
- 能够发送合成事件并验证处理程序响应
- 能够触发作业运行并验证副作用
- 能够模拟 `getData` 和 `performAction` 调用，就像来自 UI 桥一样
- 能够模拟 `executeTool` 调用，就像来自智能体运行一样
- 用于断言的内存状态和实体存储
- 用于测试能力拒绝路径的可配置能力集

用法示例：

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

### 27.2 本地插件开发

针对正在运行的 Paperclip 实例开发插件：

- 操作员从本地路径安装插件：`pnpm paperclipai plugin install ./path/to/plugin`
- 主机监视插件目录的更改并在重建时重新启动工作程序。
- 插件配置中的`devUiUrl`可以指向本地Vite开发服务器以进行UI热重载。
- 插件设置页面显示来自工作人员的实时日志以进行调试。

### 27.3 插件入门模板

主办方应发布一个入门模板（`create-paperclip-plugin`），该模板搭建：- `package.json` 具有正确的 `paperclipPlugin` 密钥
- 带有占位符值的清单
- 具有 SDK 类型导入和示例事件处理程序的工作条目
- 使用桥接钩子的 UI 条目，示例为 `DashboardWidget`
- 使用测试工具测试文件
- Worker 和 UI 包的构建配置（esbuild 或类似）
- `.gitignore` 和 `tsconfig.json`

## 28. 示例映射

该规范直接支持以下插件类型：

- `@paperclip/plugin-workspace-files`
- `@paperclip/plugin-terminal`
- `@paperclip/plugin-git`
- `@paperclip/plugin-linear`
- `@paperclip/plugin-github-issues`
- `@paperclip/plugin-grafana`
- `@paperclip/plugin-runtime-processes`
- `@paperclip/plugin-stripe`

## 29. 兼容性和版本控制

### 29.1 API 版本规则

1. 主机支持一个或多个显式插件API版本。
2. 插件清单恰好声明了一个 `apiVersion`。
3. 主机在安装时拒绝不支持的版本。
4. 插件升级是明确的操作员操作。
5. 能力扩展需要运营商的明确批准。

### 29.2 SDK 版本控制

主办方为插件作者发布了单个 SDK 包：

- `@paperclipai/plugin-sdk` — 完整的插件 SDK

该包使用子路径导出来分离工作线程和 UI 问题：

- `@paperclipai/plugin-sdk` — 工作端 SDK（上下文、事件、状态、工具、记录器、`definePlugin`、`z`）
- `@paperclipai/plugin-sdk/ui` — 前端 SDK（桥接钩子、共享组件、设计令牌）

单个包简化了插件作者的依赖管理——一个依赖、一个版本、一个变更日志。子路径导出保持包分离干净：工作代码从根导入，UI 代码从 `/ui` 导入。相应地构建工具 tree-shake，以便工作程序包不包含 React 组件，并且 UI 包不包含仅工作程序代码。

版本控制规则：1. **Semver**：SDK 遵循严格的语义版本控制。主要版本的变化表明工作人员或 UI 界面发生了重大变化；次要版本添加向后兼容的新功能；补丁版本仅修复错误。
2. **与API版本绑定**：每个主要SDK版本都对应一个插件`apiVersion`。当 `@paperclipai/plugin-sdk@2.x` 发布时，它的目标是 `apiVersion: 2`。使用 SDK 1.x 构建的插件继续声明 `apiVersion: 1`。
3. **主机多版本支持**：主机必须至少同时支持当前和以前的一个`apiVersion`。这意味着针对以前的 SDK 主要版本构建的插件无需修改即可继续工作。主机为每个受支持的 API 版本维护单独的 IPC 协议处理程序。
4. **清单中的最低 SDK 版本**：插件在清单中将 `sdkVersion` 声明为 semver 范围（例如 `">=1.4.0 <2.0.0"`）。主机在安装时验证这一点，并在插件声明的范围超出主机支持的 ​​SDK 版本时发出警告。
5. **弃用时间表**：当新的 `apiVersion` 发布时，之前的版本进入至少 6 个月的弃用期。在此期间：
   - 主机继续加载针对已弃用版本的插件。
   - 主机在插件启动时记录弃用警告。
   - 插件设置页面显示一个横幅，指示插件应该升级。
   - 弃用期结束后，主机可能会在未来版本中放弃对旧版本的支持。
6. **SD​​K 变更日志和迁移指南**：每个主要 SDK 版本都必须包含记录每个重大变更的迁移指南、新的 API 界面以及插件作者的逐步升级路径。
7. **UI 表面稳定性**：对共享 UI 组件的重大更改（删除组件、更改所需的 props）或设计令牌需要主要版本更新，就像工作人员 API 更改一样。单包模型意味着两个表面都一起进行版本控制，避免了工作程序和 UI 兼容性之间的偏差。

### 29.3 版本兼容性矩阵

主机应发布兼容性矩阵：

|主机版本 |支持的 API 版本 | SDK范围|
|---|---|---|
| 1.0 | 1 | 1.x |
| 2.0 | 1, 2 | 1.x、2.x |
| 3.0 | 2, 3 | 2.x、3.x |

该矩阵发布在主机文档中，可通过 `GET /api/plugins/compatibility` 查询。

### 29.4 插件作者工作流程

当新的SDK版本发布时：

1. 插件作者更新了`@paperclipai/plugin-sdk`依赖。
2. 插件作者按照迁移指南更新代码。
3. 插件作者更新了清单中的`apiVersion`和`sdkVersion`。
4. 插件作者发布新的插件版本。
5. 运营商升级其实例上的插件。旧版本将继续工作，直到明确升级为止。## 30. 推荐交货单

## 第一阶段

- 插件清单
- 安装/列出/删除/升级CLI
- 全局设置用户界面
- 插件进程管理器
- 能力执行
- `plugins`、`plugin_config`、`plugin_state`、`plugin_jobs`、`plugin_job_runs`、`plugin_webhook_deliveries`
- 活动巴士
- 职位
- 网络钩子
- 设置页面
- 插件 UI 包加载、主机桥和 `@paperclipai/plugin-sdk/ui`
- 用于页面、选项卡、小部件、侧边栏条目的扩展槽安装
- 桥接错误传播 (`PluginBridgeError`)
- 从 `instanceConfigSchema` 自动生成的设置表单
- 插件提供的智能体工具
- 插件到插件事件（`plugin.<pluginId>.*` 命名空间）
- 事件过滤
- 优雅地关闭并可配置截止日期
- 插件日志记录和健康控制台
- `@paperclipai/plugin-test-harness`
- `create-paperclip-plugin` 入门模板
- 卸载并保留数据宽限期
- 热插件生命周期（安装、卸载、升级、配置更改，无需重新启动服务器）
- SDK 版本控制，具有多版本主机支持和弃用政策

此阶段足以：

- 线性
- GitHub 问题
- 格拉法纳
- 条纹
- 文件浏览器
- 终端
- git工作流程
- 进程/服务器跟踪

工作区插件（文件浏览器、终端、git、进程跟踪）不需要额外的主机 API - 它们通过 `ctx.projects` 解析工作区路径并直接处理文件系统、git、PTY 和进程操作。

## 第二阶段

- 可选`plugin_entities`
- 更丰富的动作系统
- 如果确实需要的话，可信模块迁移路径
- 针对不受信任的插件 UI 包的基于 iframe 的隔离
- 插件生态系统/分发工作

## 31. 最终设计决策

Paperclip 不应实现直接仿照本地编码工具的通用进程内钩包。

Paperclip 应实现：

- 用于低级主机集成的可信平台模块
- 全局安装的进程外插件，用于附加实例范围的功能
- 插件贡献的智能体工具（命名空间、功能门控）
- 插件交付的 UI 包通过具有结构化错误传播的类型化桥在主机扩展插槽中呈现
- 从配置模式自动生成设置 UI，并可选择自定义设置页面
- 用于跨插件协调的插件到插件事件
- 服务器端事件过滤以实现高效的事件路由
- 插件直接拥有其本地工具逻辑（文件系统、git、终端、进程）
- 大多数插件状态的通用扩展表
- 正常关闭、卸载数据生命周期和插件可观察性
- 热插件生命周期 — 安装、卸载、升级和配置更改，无需重新启动服务器
- SDK 版本控制，具有多版本主机支持和明确的弃用政策
- 测试工具和入门模板可降低创作难度
- 严格保留核心治理和审计规则这就是Paperclip插件系统的完整目标设计。