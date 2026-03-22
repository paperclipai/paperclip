# 从 OpenCode 获得的插件思路

状态：设计报告，非 V1 承诺

Paperclip V1 在 [doc/SPEC-implementation.md](../SPEC-implementation.md) 中明确排除了插件框架，但长期规范表示架构应为扩展留有空间。本报告研究了 `opencode` 的插件系统，并将有用的模式转化为适合 Paperclip 的设计。

本文档的假设：Paperclip 是一个单租户、操作员控制的实例。因此，插件安装应在整个实例范围内全局生效。"公司"仍然是 Paperclip 的一等对象，但它们是组织记录，而非插件信任或安装的租户隔离边界。

## 执行摘要

`opencode` 已经有一个真正的插件系统。它有意设计为低摩擦：

- 插件是普通的 JS/TS 模块
- 它们从本地目录和 npm 包加载
- 它们可以挂钩许多运行时事件
- 它们可以添加自定义工具
- 它们可以扩展提供者认证流程
- 它们在进程内运行，可以直接修改运行时行为

该模型对本地编码工具来说效果很好。但不应照搬到 Paperclip 中。

主要结论是：

- Paperclip 应借鉴 `opencode` 的类型化 SDK、确定性加载、低编写摩擦和清晰的扩展面。
- Paperclip 不应借鉴 `opencode` 的信任模型、项目本地插件加载、"名称冲突覆盖"行为或核心业务逻辑的任意进程内修改 hook。
- Paperclip 应使用多种扩展类别，而非一个通用的插件包：
  - 用于智能体适配器、存储提供者、密钥提供者和可能的运行日志后端等底层平台关注点的受信任进程内模块
  - 用于大多数第三方集成（如 Linear、GitHub Issues、Grafana、Stripe 和调度器）的进程外插件
  - 插件贡献的智能体工具（命名空间化，非冲突覆盖）
  - 通过类型化桥接加载到宿主扩展槽位的插件发布 React UI
  - 具有服务端过滤和插件间事件的类型化事件总线，加上用于自动化的定时作业

如果 Paperclip 做好这些，你列出的示例就变得很直接：

- 文件浏览器 / 终端 / git 工作流 / 子进程跟踪成为从宿主解析路径并直接处理 OS 操作的工作区插件
- Linear / GitHub / Grafana / Stripe 成为连接器插件
- 未来的知识库和会计功能也可以适配同一模型

## 审查的来源

我克隆了 `anomalyco/opencode` 并审查了提交：

- `a965a062595403a8e0083e85770315d5dc9628ab`

审查的主要文件：

- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/plugin/src/index.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/plugin/src/tool.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/opencode/src/plugin/index.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/opencode/src/config/config.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/opencode/src/tool/registry.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/opencode/src/provider/auth.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/web/src/content/docs/plugins.mdx`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/web/src/content/docs/custom-tools.mdx`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/web/src/content/docs/ecosystem.mdx`

审查的相关 Paperclip 文件（当前扩展接缝）：

- [server/src/adapters/registry.ts](../../server/src/adapters/registry.ts)
- [ui/src/adapters/registry.ts](../../ui/src/adapters/registry.ts)
- [server/src/storage/provider-registry.ts](../../server/src/storage/provider-registry.ts)
- [server/src/secrets/provider-registry.ts](../../server/src/secrets/provider-registry.ts)
- [server/src/services/run-log-store.ts](../../server/src/services/run-log-store.ts)
- [server/src/services/activity-log.ts](../../server/src/services/activity-log.ts)
- [doc/SPEC.md](../SPEC.md)
- [doc/SPEC-implementation.md](../SPEC-implementation.md)

## OpenCode 实际实现了什么

## 1. 插件编写 API

`opencode` 暴露了一个小型包 `@opencode-ai/plugin`，包含类型化的 `Plugin` 函数和类型化的 `tool()` 辅助函数。

核心结构：

- 插件是一个接收上下文对象的异步函数
- 插件返回一个 `Hooks` 对象
- hooks 是可选的
- 插件还可以贡献工具和认证提供者

插件初始化上下文包括：

- SDK 客户端
- 当前项目信息
- 当前目录
- 当前 git worktree
- 服务器 URL
- Bun shell 访问

这很重要：`opencode` 立即给予插件丰富的运行时能力，而不是狭窄的能力 API。

## 2. Hook 模型

hook 集合很广泛。它包括：

- 事件订阅
- 配置时 hook
- 消息 hook
- 模型参数/头部 hook
- 权限决策 hook
- shell 环境注入
- 工具执行前/后 hook
- 工具定义修改
- 压缩提示自定义
- 文本补全转换

实现模式非常简单：

- 核心代码构造一个 `output` 对象
- 每个匹配的插件 hook 顺序运行
- hook 修改 `output`
- 最终修改后的输出被核心使用

这很优雅且易于扩展。

但也极其强大。一个插件可以更改认证头、模型参数、权限答案、工具输入、工具描述和 shell 环境。

## 3. 插件发现和加载顺序

`opencode` 支持两种插件来源：

- 本地文件
- npm 包

本地目录：

- `~/.config/opencode/plugins/`
- `.opencode/plugins/`

Npm 插件：

- 在配置的 `plugin: []` 下列出

加载顺序是确定性的且有文档说明：

1. 全局配置
2. 项目配置
3. 全局插件目录
4. 项目插件目录

重要细节：

- 配置数组是连接的而非替换的
- 重复的插件名称会去重，高优先级的条目胜出
- 内部第一方插件和默认插件也通过插件管道加载

这给了 `opencode` 一个真正的优先级模型，而不是"最后偶然加载的东西获胜"。

## 4. 依赖处理

对于本地配置/插件目录，`opencode` 会：

- 确保存在 `package.json`
- 注入 `@opencode-ai/plugin`
- 运行 `bun install`

这让本地插件和本地自定义工具可以导入依赖。

这对本地开发者的人体工程学非常好。

但对于操作员控制的控制平面服务器来说，这不是一个安全的默认设置。

## 5. 错误处理

插件加载失败默认不会硬崩溃运行时。

相反，`opencode`：

- 记录错误
- 发布会话错误事件
- 继续加载其他插件

这是一个好的运营模式。一个坏的插件不应该导致整个产品无法使用，除非操作员明确将其配置为必需的。

## 6. 工具是一等扩展点

`opencode` 有两种添加工具的方式：

- 通过 `hook.tool` 直接从插件导出工具
- 在 `.opencode/tools/` 或全局工具目录中定义本地文件

工具 API 很强大：

- 工具有描述
- 工具有 Zod schema
- 工具执行获得上下文，如会话 ID、消息 ID、目录和 worktree
- 工具被合并到与内置工具相同的注册表中
- 工具定义本身可以被 `tool.definition` hook 修改

设计中最激进的部分：

- 自定义工具可以通过名称覆盖内置工具

这对本地编码助手来说非常强大。
但对 Paperclip 的核心操作来说太危险了。

然而，插件贡献智能体可用工具的概念对 Paperclip 非常有价值——只要插件工具是命名空间化的（不能遮蔽核心工具）且受能力门禁限制。

## 7. 认证也是插件接口

`opencode` 允许插件为提供者注册认证方法。

插件可以贡献：

- 认证方法元数据
- 提示流程
- OAuth 流程
- API 密钥流程
- 认证成功后适配提供者行为的请求加载器

这是一个值得借鉴的强大模式。集成通常需要自定义认证 UX 和令牌处理。

## 8. 生态系统证据

生态系统页面是该模型在实践中有效的最佳证明。
社区插件已经覆盖：

- 沙箱/工作区系统
- 认证提供者
- 会话头部 / 遥测
- 记忆/上下文功能
- 调度
- 通知
- worktree 辅助工具
- 后台智能体
- 监控

这验证了主要论点：简单的类型化插件 API 可以创造真正的生态系统速度。

## OpenCode 做对了什么

## 1. 将插件 SDK 与宿主运行时分离

这是设计中最好的部分之一。

- 插件作者针对一个干净的公共包编码
- 宿主内部可以在加载器后面演进
- 运行时代码和插件代码有清晰的契约边界

Paperclip 绝对应该这样做。

## 2. 确定性加载和优先级

`opencode` 明确了：

- 插件来自哪里
- 配置如何合并
- 什么顺序胜出

Paperclip 应借鉴这种纪律性。

## 3. 低仪式感编写

插件作者不必学习一个庞大的框架。

- 导出异步函数
- 返回 hooks
- 可选地导出工具

这种简洁性很重要。

## 4. 类型化工具定义

`tool()` 辅助函数非常出色：

- 类型化
- 基于 schema
- 易于文档化
- 易于运行时验证

Paperclip 应为插件操作、自动化和 UI schema 采用这种风格。

## 5. 内置功能和插件使用相似的形状

`opencode` 在多个地方对内部和外部类插件行为使用相同的 hook 系统。
这减少了特殊情况。

Paperclip 可以在适配器、密钥后端、存储提供者和连接器模块中从中受益。

## 6. 增量扩展，而非前期巨大抽象

`opencode` 没有先设计一个巨大的市场平台。
它添加了真实功能需要的具体扩展点。

对 Paperclip 来说这也是正确的思维方式。

## Paperclip 不应直接照搬的内容

## 1. 进程内任意插件代码作为默认

`opencode` 基本上是一个本地智能体运行时，所以非沙箱化的插件执行对其受众来说是可以接受的。

Paperclip 是一个操作员管理的实例控制平面，包含公司对象。
风险特征不同：

- 密钥很重要
- 审批门禁很重要
- 预算很重要
- 变更操作需要可审计性

默认的第三方插件不应以对服务器内存、数据库句柄和密钥的无限制进程内访问权限运行。

## 2. 项目本地插件加载

`opencode` 有项目本地插件目录，因为该工具以代码库为中心。

Paperclip 不是项目范围的。它是实例范围的。
可比较的单元是：

- 实例安装的插件包

Paperclip 不应从工作区仓库（如 `.paperclip/plugins` 或项目目录）自动加载任意代码。

## 3. 核心业务决策上的任意修改 hook

如下 hook：

- `permission.ask`
- `tool.execute.before`
- `chat.headers`
- `shell.env`

在 `opencode` 中是合理的。

对于 Paperclip，等价的 hook 用于：

- 审批决策
- 任务检出语义
- 活动日志行为
- 预算执行

将是一个错误。

核心不变量应留在核心代码中，而不应变成 hook 可重写的。

## 4. 名称冲突覆盖

允许插件通过名称替换内置工具在本地智能体产品中是有用的。

Paperclip 不应允许插件静默替换：

- 核心路由
- 核心变更操作
- 认证行为
- 权限评估器
- 预算逻辑
- 审计逻辑

扩展应该是累加式或明确委托的，而非意外遮蔽。

## 5. 从用户配置自动安装和执行

`opencode` 的"启动时安装依赖"流程很符合人体工程学。
对 Paperclip 来说这会有风险，因为它结合了：

- 包安装
- 代码加载
- 执行

在控制平面服务器的启动路径中。

Paperclip 应要求明确的操作员安装步骤。

## 为什么 Paperclip 需要不同的形态

这两个产品解决的问题不同。

| 主题 | OpenCode | Paperclip |
|---|---|---|
| 主要单元 | 本地项目/worktree | 包含公司对象的单租户操作员实例 |
| 信任假设 | 在自己机器上的本地高级用户 | 操作员管理一个受信任的 Paperclip 实例 |
| 故障爆炸半径 | 本地会话/运行时 | 整个公司控制平面 |
| 扩展风格 | 自由修改运行时行为 | 保持治理和可审计性 |
| UI 模型 | 本地应用可以加载本地行为 | 仪表盘 UI 必须保持连贯和安全 |
| 安全模型 | 宿主信任的本地插件 | 需要能力边界和可审计性 |

这意味着 Paperclip 应该借鉴 `opencode` 的好想法但使用更严格的架构。

## Paperclip 已有的有用的预插件接缝

Paperclip 已经有几个类扩展的接缝：

- 服务器适配器注册表：[server/src/adapters/registry.ts](../../server/src/adapters/registry.ts)
- UI 适配器注册表：[ui/src/adapters/registry.ts](../../ui/src/adapters/registry.ts)
- 存储提供者注册表：[server/src/storage/provider-registry.ts](../../server/src/storage/provider-registry.ts)
- 密钥提供者注册表：[server/src/secrets/provider-registry.ts](../../server/src/secrets/provider-registry.ts)
- 可插拔运行日志存储接缝：[server/src/services/run-log-store.ts](../../server/src/services/run-log-store.ts)
- 活动日志和实时事件发射：[server/src/services/activity-log.ts](../../server/src/services/activity-log.ts)

这是好消息。
Paperclip 不需要从头发明可扩展性。
它需要统一和加固现有的接缝。

## 推荐的 Paperclip 插件模型

## 1. 使用多种扩展类别

不要为所有东西创建一个巨大的 `hooks` 对象。
使用具有不同信任模型的不同插件类别。

| 扩展类别 | 示例 | 运行时模型 | 信任级别 | 原因 |
|---|---|---|---|---|
| 平台模块 | 智能体适配器、存储提供者、密钥提供者、运行日志后端 | 进程内 | 高度受信任 | 紧密集成、性能、底层 API |
| 连接器插件 | Linear、GitHub Issues、Grafana、Stripe | 进程外 worker 或 sidecar | 中等 | 外部同步、更安全的隔离、更清晰的故障边界 |
| 工作区插件 | 文件浏览器、终端、git 工作流、子进程/服务器跟踪 | 进程外，直接 OS 访问 | 中等 | 从宿主解析工作区路径，直接拥有文件系统/git/PTY/进程逻辑 |
| UI 贡献 | 仪表盘小组件、设置表单、公司面板 | 通过桥接在宿主扩展槽位中的插件发布 React 包 | 中等 | 插件拥有其渲染；宿主控制槽位放置和桥接访问 |
| 自动化插件 | 告警、调度器、同步作业、webhook 处理器 | 进程外 | 中等 | 事件驱动的自动化天然适合插件 |

这种拆分是本报告中最重要的设计建议。

## 2. 将底层模块与第三方插件分开

Paperclip 已经隐式地有这种模式：

- 适配器是一回事
- 存储提供者是另一回事
- 密钥提供者又是另一回事

保持这种分离。

我会这样形式化：

- `module` 意味着宿主为底层运行时服务加载的受信任代码
- `plugin` 意味着通过类型化插件协议和能力模型与 Paperclip 通信的集成代码

这避免了试图将 Stripe、PTY 终端和新的智能体适配器强行放入同一抽象中。

## 3. 优先使用事件驱动扩展而非核心逻辑修改

对于第三方插件，主要 API 应该是：

- 订阅类型化域事件（带可选的服务端过滤）
- 发出插件命名空间化的事件用于跨插件通信
- 读取实例状态，包括相关的公司绑定业务记录
- 注册 webhook
- 运行定时作业
- 贡献智能体在运行期间可以使用的工具
- 写入插件拥有的状态
- 添加累加式 UI 界面
- 通过 API 调用显式的 Paperclip 操作

不要让第三方插件负责：

- 决定审批是否通过
- 拦截任务检出语义
- 重写活动日志行为
- 覆盖预算硬限制

这些是核心不变量。

## 4. 插件发布自己的 UI

插件将自己的 React UI 作为打包模块发布在 `dist/ui/` 中。宿主将插件组件加载到指定的**扩展槽位**（页面、标签页、小组件、侧边栏入口）中，并提供**桥接**供插件前端与其自身的 worker 后端通信以及访问宿主上下文。

**工作方式：**

1. 插件的 UI 为其填充的每个槽位导出命名组件（例如 `DashboardWidget`、`IssueDetailTab`、`SettingsPage`）。
2. 宿主将插件组件挂载到正确的槽位中，传递包含 `usePluginData(key, params)` 和 `usePluginAction(key)` 等 hook 的桥接对象。
3. 插件组件通过桥接从其自身 worker 获取数据并按其需要渲染。
4. 宿主通过桥接强制执行能力门禁——如果 worker 没有某个能力，即使 UI 请求，桥接也会拒绝调用。

**宿主控制的内容：** 插件组件出现在哪里、桥接 API、能力执行以及通过 `@paperclipai/plugin-sdk/ui` 提供的共享 UI 原语（设计令牌和通用组件）。

**插件控制的内容：** 如何渲染其数据、获取什么数据、暴露什么操作，以及是否使用宿主的共享组件或构建完全自定义的 UI。

第一版扩展槽位：

- 仪表盘小组件
- 设置页面
- 详情页标签页（项目、任务、智能体、目标、运行）
- 侧边栏入口
- 公司上下文插件页面

宿主 SDK 提供共享组件（MetricCard、DataTable、StatusBadge、LogView 等）以保持视觉一致性，但这些是可选的。

以后，如果不受信任的第三方插件变得常见，宿主可以切换到基于 iframe 的隔离而无需更改插件的源代码（桥接 API 保持不变）。

## 5. 使安装全局化，将映射/配置分开

`opencode` 主要是用户级本地配置。
Paperclip 应将插件安装视为全局实例级操作。

示例：

- 安装 `@paperclip/plugin-linear` 一次
- 立即在所有地方可用
- 可选地在 Paperclip 对象上存储映射，如果一个公司映射到与另一个公司不同的 Linear 团队

## 6. 使用项目工作区作为本地工具的主要锚点

Paperclip 已经有一个具体的项目工作区模型：

- 项目暴露 `workspaces` 和 `primaryWorkspace`
- 数据库已有 `project_workspaces`
- 项目路由已支持创建、更新和删除工作区
- 心跳解析优先使用项目工作区，然后才回退到任务会话或智能体主目录工作区

这意味着本地/运行时插件通常应首先锚定到项目，而不是发明平行的工作区模型。

实用指导：

- 文件浏览器应首先浏览项目工作区
- 终端会话应可从项目工作区启动
- git 应将项目工作区视为仓库根锚点
- 开发服务器和子进程跟踪应附加到项目工作区
- 任务和智能体视图仍可深度链接到相关的项目工作区上下文

换句话说：

- `project` 是业务对象
- `project_workspace` 是本地运行时锚点
- 插件应基于此构建，而不是先创建一个不相关的工作区模型

## 7. 让插件贡献智能体工具

`opencode` 将工具作为一等扩展点。这对 Paperclip 来说也是最高价值的接口之一。

Linear 插件应该能够贡献一个 `search-linear-issues` 工具供智能体在运行期间使用。git 插件应贡献 `create-branch` 和 `get-diff`。文件浏览器插件应贡献 `read-file` 和 `list-directory`。

关键约束：

- 插件工具按插件 ID 命名空间化（例如 `linear:search-issues`），因此不能遮蔽核心工具
- 插件工具需要 `agent.tools.register` 能力
- 工具执行通过与其他所有东西相同的 worker RPC 边界
- 工具结果出现在运行日志中

这是天然适合的——插件已经有 SDK 上下文、外部 API 凭据和域逻辑。将其包装在工具定义中对插件作者来说是最小的额外工作。

## 8. 支持插件间事件

插件应该能够发出其他插件可以订阅的自定义事件。例如，git 插件检测到推送并发出 `plugin.@paperclip/plugin-git.push-detected`。GitHub Issues 插件订阅该事件并更新 PR 链接。

这避免了插件需要通过共享状态或外部通道进行协调。宿主通过相同的事件总线路由插件事件，具有与核心事件相同的投递语义。

插件事件使用 `plugin.<pluginId>.*` 命名空间，因此不会与核心事件冲突。

## 9. 从配置 schema 自动生成设置 UI

声明了 `instanceConfigSchema` 的插件应该免费获得自动生成的设置表单。宿主直接从 JSON Schema 渲染文本输入、下拉菜单、开关、数组和密钥引用选择器。

对于需要更丰富设置 UX 的插件，它们可以声明一个 `settingsPage` 扩展槽位并发布自定义 React 组件。两种方式共存。

这很重要，因为设置表单是每个插件都需要的样板代码。从已有的 schema 自动生成它们消除了编写摩擦的重要部分。

## 10. 为优雅关闭和升级而设计

规范应明确说明当插件 worker 停止时会发生什么——在升级、卸载或实例重启期间。

推荐策略：

- 发送 `shutdown()` 并带有可配置的截止时间（默认 10 秒）
- 截止时间后 SIGTERM，再 5 秒后 SIGKILL
- 进行中的作业标记为 `cancelled`
- 进行中的桥接调用向 UI 返回结构化错误

对于升级特别是：旧 worker 排空，新 worker 启动。如果新版本添加了能力，它进入 `upgrade_pending` 直到操作员批准。

## 11. 定义卸载数据生命周期

当插件被卸载时，其数据（`plugin_state`、`plugin_entities`、`plugin_jobs` 等）应保留一个宽限期（默认 30 天），而不是立即删除。操作员可以在宽限期内重新安装并恢复状态，或通过 CLI 强制清除。

这很重要，因为意外卸载不应导致不可逆的数据丢失。

## 12. 投资插件可观测性

通过 `ctx.logger` 的插件日志应存储并可从插件设置页面查询。宿主还应捕获 worker 进程的原始 `stdout`/`stderr` 作为后备。

插件健康仪表盘应显示：worker 状态、运行时间、最近日志、作业成功/失败率、webhook 投递率和资源使用情况。宿主应发出内部事件（`plugin.health.degraded`、`plugin.worker.crashed`），其他插件或仪表盘可以消费。

这对操作员来说至关重要。没有可观测性，调试插件问题需要 SSH 访问和手动日志查看。

## 13. 提供测试工具包和入门模板

`@paperclipai/plugin-test-harness` 包应提供具有内存存储、合成事件发射和 `getData`/`performAction`/`executeTool` 模拟的模拟宿主。插件作者应该能够在没有运行中的 Paperclip 实例的情况下编写单元测试。

`create-paperclip-plugin` CLI 应搭建一个可工作的插件，包含清单、worker、UI 包、测试文件和构建配置。

低编写摩擦被指出是 `opencode` 最好的品质之一。测试工具包和入门模板是 Paperclip 实现同样效果的方式。

## 14. 支持热插件生命周期

插件安装、卸载、升级和配置变更应在不重启 Paperclip 服务器的情况下生效。这对开发者工作流和操作员体验至关重要。

进程外 worker 架构使这变得自然：

- **热安装**：生成新 worker，在活跃路由表中注册其事件订阅、作业调度、webhook 端点和智能体工具，将其 UI 包加载到扩展槽位注册表中。
- **热卸载**：优雅关闭 worker，从路由表中移除所有注册，卸载 UI 组件，开始数据保留宽限期。
- **热升级**：关闭旧 worker，启动新 worker，原子性地交换路由表条目，使 UI 包缓存失效以便前端加载更新的包。
- **热配置变更**：将新配置写入 `plugin_config`，通过 IPC 通知运行中的 worker（`configChanged`）。worker 在不重启的情况下应用变更。如果它不处理 `configChanged`，宿主仅重启该 worker。

前端缓存失效使用版本化或内容哈希的包 URL 和 `plugin.ui.updated` 事件，触发重新导入而无需完整页面重新加载。

每个 worker 进程是独立的——启动、停止或替换一个 worker 永远不会影响任何其他插件或宿主本身。

## 15. 定义 SDK 版本管理和兼容性

`opencode` 没有正式的 SDK 版本管理方案，因为插件在进程内运行并且实际上被固定到当前运行时。Paperclip 的进程外模型意味着插件可能针对一个 SDK 版本构建但运行在已经前进的宿主上。这需要明确的规则。

推荐方案：

- **单一 SDK 包**：`@paperclipai/plugin-sdk` 带子路径导出——根用于 worker 代码，`/ui` 用于前端代码。一个依赖、一个版本、一个更新日志。
- **SDK 主版本 = API 版本**：`@paperclipai/plugin-sdk@2.x` 针对 `apiVersion: 2`。使用 SDK 1.x 构建的插件声明 `apiVersion: 1` 并继续工作。
- **宿主多版本支持**：宿主同时支持至少当前和一个之前的 `apiVersion`，每个版本有单独的 IPC 协议处理程序。
- **清单中的 `sdkVersion`**：插件声明 semver 范围（例如 `">=1.4.0 <2.0.0"`）。宿主在安装时验证。
- **弃用时间线**：前一个 API 版本在新版本发布后至少有 6 个月的继续支持。宿主记录弃用警告并在插件设置页面显示横幅。
- **迁移指南**：每个 SDK 主版本发布附带逐步迁移指南，涵盖每个破坏性变更。
- **UI 接口与 worker 一起版本管理**：worker 和 UI 接口都在同一个包中，因此一起版本管理。共享 UI 组件的破坏性变更与 worker API 变更一样需要主版本号升级。
- **发布的兼容性矩阵**：宿主发布支持的 API 版本和 SDK 范围的矩阵，可通过 API 查询。

## 具体的 Paperclip SDK 形态

一个有意狭窄的第一版可能看起来像这样：

```ts
import { definePlugin, z } from "@paperclipai/plugin-sdk";

export default definePlugin({
  id: "@paperclip/plugin-linear",
  version: "0.1.0",
  categories: ["connector", "ui"],
  capabilities: [
    "events.subscribe",
    "jobs.schedule",
    "http.outbound",
    "instance.settings.register",
    "ui.dashboardWidget.register",
    "secrets.read-ref",
  ],
  instanceConfigSchema: z.object({
    linearBaseUrl: z.string().url().optional(),
    companyMappings: z.array(
      z.object({
        companyId: z.string(),
        teamId: z.string(),
        apiTokenSecretRef: z.string(),
      }),
    ).default([]),
  }),
  async register(ctx) {
    ctx.jobs.register("linear-pull", { cron: "*/5 * * * *" }, async (job) => {
      // 将 Linear 任务同步到插件拥有的状态或显式的 Paperclip 实体中
    });

    // 带可选服务端过滤器的订阅
    ctx.events.on("issue.created", { projectId: "proj-1" }, async (event) => {
      // 仅接收项目 proj-1 的 issue.created 事件
    });

    // 订阅来自另一个插件的事件
    ctx.events.on("plugin.@paperclip/plugin-git.push-detected", async (event) => {
      // 响应 git 插件检测到的推送
    });

    // 贡献智能体在运行期间可以使用的工具
    ctx.tools.register("search-linear-issues", {
      displayName: "Search Linear Issues",
      description: "Search for Linear issues by query",
      parametersSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }, async (params, runCtx) => {
      // 搜索 Linear API 并返回结果
      return { content: JSON.stringify(results) };
    });

    // getData 由插件自身的 UI 组件通过宿主桥接调用
    ctx.data.register("sync-health", async ({ companyId }) => {
      // 返回插件的 DashboardWidget 组件渲染的类型化 JSON
      return { syncedCount: 142, trend: "+12 today", mappings: [...] };
    });

    ctx.actions.register("resync", async ({ companyId }) => {
      // 运行同步逻辑
    });
  },
});
```

插件的 UI 包（与 worker 分开）可能看起来像：

```tsx
// dist/ui/index.tsx
import { usePluginData, usePluginAction, MetricCard, ErrorBoundary } from "@paperclipai/plugin-sdk/ui";

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData("sync-health", { companyId: context.companyId });
  const resync = usePluginAction("resync");

  if (loading) return <Spinner />;
  if (error) return <div>Plugin error: {error.message} ({error.code})</div>;

  return (
    <ErrorBoundary fallback={<div>Widget failed to render</div>}>
      <MetricCard label="Synced Issues" value={data.syncedCount} trend={data.trend} />
      <button onClick={() => resync({ companyId: context.companyId })}>Resync Now</button>
    </ErrorBoundary>
  );
}
```

重要的不是确切的语法。
重要的是契约形态：

- 类型化清单
- 显式能力
- 显式全局配置，带可选公司映射
- 带可选服务端过滤的事件订阅
- 通过命名空间化事件类型的插件间事件
- 智能体工具贡献
- 作业
- 通过宿主桥接与其 worker 通信的插件发布 UI
- 从 worker 到 UI 的结构化错误传播

## 推荐的核心扩展面

## 1. 平台模块接口

这些应保持接近当前注册表风格。

候选：

- `registerAgentAdapter()`
- `registerStorageProvider()`
- `registerSecretProvider()`
- `registerRunLogStore()`

这些是受信任的平台模块，不是普通插件。

## 2. 连接器插件接口

这些是最佳的近期插件候选。

能力：

- 订阅域事件
- 定义定时同步作业
- 在 `/api/plugins/:pluginId/...` 下暴露插件特定的 API 路由
- 使用公司密钥引用
- 写入插件状态
- 发布仪表盘数据
- 通过核心 API 记录活动

示例：

- Linear 任务同步
- GitHub 任务同步
- Grafana 仪表盘卡片
- Stripe MRR / 订阅汇总

## 3. 工作区运行时接口

工作区插件直接处理本地工具：

- 文件浏览器
- 终端
- git 工作流
- 子进程跟踪
- 本地开发服务器跟踪

插件通过宿主 API 解析工作区路径（`ctx.projects` 提供工作区元数据，包括 `cwd`、`repoUrl` 等），然后使用标准 Node API 或其选择的任何库操作文件系统、生成进程、执行 `git` 命令或打开 PTY 会话。

宿主不包装或代理这些操作。这保持了核心的精简——不需要为插件可能需要的每个 OS 级操作维护并行 API 接口。插件拥有自己的实现。

## 治理和安全要求

任何 Paperclip 插件系统都必须保持仓库文档中的核心控制平面不变量。

这意味着：

- 插件安装对实例全局生效
- "公司"仍然是 API 和数据模型中的业务对象，不是租户边界
- 审批门禁仍由核心拥有
- 预算硬限制仍由核心拥有
- 变更操作会被活动日志记录
- 密钥保持基于引用且在日志中脱敏

我会要求每个插件满足以下条件：

## 1. 能力声明

每个插件声明一个静态能力集，例如：

- `companies.read`
- `issues.read`
- `issues.write`
- `events.subscribe`
- `events.emit`
- `jobs.schedule`
- `http.outbound`
- `webhooks.receive`
- `assets.read`
- `assets.write`
- `secrets.read-ref`
- `agent.tools.register`
- `plugin.state.read`
- `plugin.state.write`

仪表盘/操作员在安装前看到这些。

## 2. 全局安装

插件安装一次即在整个实例可用。
如果需要特定 Paperclip 对象上的映射，这些是插件数据，不是启用/禁用边界。

## 3. 活动日志

插件发起的变更操作应通过相同的活动日志机制流转，使用专门的 `plugin` 操作者类型：

- `actor_type = plugin`
- `actor_id = <plugin-id>`（例如 `@paperclip/plugin-linear`）

## 4. 健康和故障报告

每个插件应暴露：

- 启用/禁用状态
- 上次成功运行
- 上次错误
- 最近的 webhook/作业历史

一个损坏的插件不得影响公司的其余部分。

## 5. 密钥处理

插件应接收密钥引用，而不是配置持久化中的原始密钥值。
解析应通过现有的密钥提供者抽象进行。

## 6. 资源限制

插件应有：

- 超时限制
- 并发限制
- 重试策略
- 可选的按插件预算

这对同步连接器和工作区插件尤其重要。

## 需要考虑的数据模型新增

我会避免在第一版中使用"任意第三方插件定义的 SQL 迁移"。
这在早期给予了太多权力。

正确的心智模型是：

- 当数据明确是 Paperclip 本身的一部分时复用核心表
- 对大多数插件拥有的状态使用通用扩展表
- 仅在以后才允许插件特定表，并且仅限于受信任的平台模块或严格控制的迁移工作流

## 推荐的 Postgres 扩展策略

### 1. 核心表保持核心

如果一个概念正在成为 Paperclip 实际产品模型的一部分，它应该获得一个正常的第一方表。

示例：

- `project_workspaces` 已经是核心表，因为项目工作区现在是 Paperclip 本身的一部分
- 如果未来的"项目 git 状态"成为核心功能而非插件拥有的元数据，那也应该是第一方表

### 2. 大多数插件应从通用扩展表开始

对于大多数插件，宿主应提供几个通用持久化表，插件在其中存储命名空间化的记录。

这保持了系统的可管理性：

- 更简单的迁移
- 更简单的备份/恢复
- 更简单的可移植性方案
- 更容易的操作员审查
- 插件 schema 漂移破坏实例的机会更少

### 3. 在添加自定义 schema 之前将插件数据限定到 Paperclip 对象

很多插件数据自然挂在现有的 Paperclip 对象上：

- 项目工作区插件状态通常应限定到 `project` 或 `project_workspace`
- 任务同步状态应限定到 `issue`
- 指标小组件可能限定到 `company`、`project` 或 `goal`
- 进程跟踪可能限定到 `project_workspace`、`agent` 或 `run`

这在引入自定义表之前提供了一个好的默认键控模型。

### 4. 以后添加受信任模块迁移，而非现在添加任意插件迁移

如果 Paperclip 最终需要扩展拥有的表，我只会允许：

- 受信任的第一方包
- 受信任的平台模块
- 可能是明确安装的管理员审查过的插件，带有固定版本

我不会让随机的第三方插件在启动时运行自由形式的 schema 迁移。

而是在以后需要时添加受控机制。

## 建议的基础扩展表

## 1. `plugins`

实例级安装记录。

建议字段：

- `id`
- `package_name`
- `version`
- `categories`
- `manifest_json`
- `installed_at`
- `status`

## 2. `plugin_config`

实例级插件配置。

建议字段：

- `id`
- `plugin_id`
- `config_json`
- `created_at`
- `updated_at`
- `last_error`

## 3. `plugin_state`

插件的通用键/值状态。

建议字段：

- `id`
- `plugin_id`
- `scope_kind`（`instance | company | project | project_workspace | agent | issue | goal | run`）
- `scope_id` 可空
- `namespace`
- `state_key`
- `value_json`
- `updated_at`

这在允许自定义表之前足以满足许多连接器。

示例：

- 按 `issue` 键控的 Linear 外部 ID
- 按 `project` 键控的 GitHub 同步游标
- 按 `project_workspace` 键控的文件浏览器偏好
- 按 `project_workspace` 键控的 git 分支元数据
- 按 `project_workspace` 或 `run` 键控的进程元数据

## 4. `plugin_jobs`

定时作业和运行跟踪。

建议字段：

- `id`
- `plugin_id`
- `scope_kind` 可空
- `scope_id` 可空
- `job_key`
- `status`
- `last_started_at`
- `last_finished_at`
- `last_error`

## 5. `plugin_webhook_deliveries`

如果插件暴露 webhook，投递历史值得存储。

建议字段：

- `id`
- `plugin_id`
- `scope_kind` 可空
- `scope_id` 可空
- `endpoint_key`
- `status`
- `received_at`
- `response_code`
- `error`

## 6. 也许以后：`plugin_entities`

如果通用插件状态变得太局限，在允许任意插件迁移之前为连接器记录添加一个结构化、可查询的实体表。

建议字段：

- `id`
- `plugin_id`
- `entity_type`
- `scope_kind`
- `scope_id`
- `external_id`
- `title`
- `status`
- `data_json`
- `updated_at`

这是一个有用的折中方案：

- 比不透明的键/值状态更易于查询
- 仍然避免让每个插件立即创建自己的关系 schema

## 请求的示例如何映射到此模型

| 用例 | 最佳适配 | 所需宿主原语 | 备注 |
|---|---|---|---|
| 文件浏览器 | 工作区插件 | 项目工作区元数据 | 插件直接拥有文件系统操作 |
| 终端 | 工作区插件 | 项目工作区元数据 | 插件直接生成 PTY 会话 |
| Git 工作流 | 工作区插件 | 项目工作区元数据 | 插件直接执行 git 命令 |
| Linear 任务跟踪 | 连接器插件 | 作业、webhook、密钥引用、任务同步 API | 非常强的插件候选 |
| GitHub 任务跟踪 | 连接器插件 | 作业、webhook、密钥引用 | 非常强的插件候选 |
| Grafana 指标 | 连接器插件 + 仪表盘小组件 | 出站 HTTP | 可能首先只读 |
| 子进程/服务器跟踪 | 工作区插件 | 项目工作区元数据 | 插件直接管理进程 |
| Stripe 收入跟踪 | 连接器插件 | 密钥引用、定时同步、公司指标 API | 强插件候选 |

# 插件示例

## 工作区文件浏览器

包构想：`@paperclip/plugin-workspace-files`

此插件让仪表盘检查项目工作区、智能体工作区、生成的产物和任务相关文件，而无需进入 shell。它适用于：

- 浏览项目工作区内的文件
- 调试智能体更改了什么
- 在审批前审查生成的输出
- 将工作区文件附加到任务
- 了解公司的仓库布局
- 在本地受信任模式下检查智能体主目录工作区

### 用户体验

- 设置页面：`/settings/plugins/workspace-files`
- 主页面：`/:companyPrefix/plugins/workspace-files`
- 项目标签页：`/:companyPrefix/projects/:projectId?tab=files`
- 可选任务标签页：`/:companyPrefix/issues/:issueId?tab=files`
- 可选智能体标签页：`/:companyPrefix/agents/:agentId?tab=workspace`

主要界面和交互：

- 插件设置：
  - 选择插件是否默认使用 `project.primaryWorkspace`
  - 选择哪些项目工作区可见
  - 选择是否允许文件写入或仅只读
  - 选择是否显示隐藏文件
- 主浏览器页面：
  - 顶部的项目选择器
  - 限定到所选项目 `workspaces` 的工作区选择器
  - 左侧树形视图
  - 右侧文件预览面板
  - 文件名/路径搜索框
  - 操作：复制路径、下载文件、附加到任务、打开差异
- 项目标签页：
  - 直接打开项目的主要工作区
  - 让仪表盘在所有项目工作区间切换
  - 显示工作区元数据如 `cwd`、`repoUrl` 和 `repoRef`
- 任务标签页：
  - 解析任务的项目并打开该项目的工作区上下文
  - 显示链接到任务的文件
  - 让仪表盘从项目工作区拉取文件到任务附件中
  - 显示每个链接文件的路径和最后修改信息
- 智能体标签页：
  - 显示智能体当前解析的工作区
  - 如果运行附加到项目，链接回项目工作区视图
  - 让仪表盘检查智能体当前正在操作的文件

核心工作流：

- 仪表盘打开项目并浏览其主要工作区文件。
- 当项目有多个检出或仓库引用时，仪表盘从一个项目工作区切换到另一个。
- 仪表盘打开任务，从文件浏览器附加生成的产物，并留下审查评论。
- 仪表盘打开智能体详情页以检查失败运行背后的确切文件。

### 所需 Hook

推荐的能力和扩展点：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register` 用于 `project`、`issue` 和 `agent`
- `projects.read`
- `project.workspaces.read`
- 可选 `assets.write`
- `activity.log.write`

插件通过 `ctx.projects` 解析工作区路径，并直接使用 Node API 处理所有文件系统操作（读取、写入、stat、搜索、列出目录）。

可选事件订阅：

- `events.subscribe(agent.run.started)`
- `events.subscribe(agent.run.finished)`
- `events.subscribe(issue.attachment.created)`

## 工作区终端

包构想：`@paperclip/plugin-terminal`

此插件为项目工作区和智能体工作区提供受控的终端 UI。它适用于：

- 调试卡住的运行
- 验证环境状态
- 运行有针对性的手动命令
- 监视长时间运行的命令
- 将人类操作员与智能体工作流配对

### 用户体验

- 设置页面：`/settings/plugins/terminal`
- 主页面：`/:companyPrefix/plugins/terminal`
- 项目标签页：`/:companyPrefix/projects/:projectId?tab=terminal`
- 可选智能体标签页：`/:companyPrefix/agents/:agentId?tab=terminal`
- 可选运行标签页：`/:companyPrefix/agents/:agentId/runs/:runId?tab=terminal`

主要界面和交互：

- 插件设置：
  - 允许的 shell 和 shell 策略
  - 命令是只读、自由形式还是允许列表
  - 终端启动前是否需要明确的操作员确认
  - 新终端会话是否默认使用项目的主要工作区
- 终端主页：
  - 活跃终端会话列表
  - 打开新会话的按钮
  - 项目选择器，然后从该项目的工作区中选择工作区
  - 可选的智能体关联
  - 带输入、调整大小和重连支持的终端面板
  - 控件：中断、终止、清除、保存记录
- 项目终端标签页：
  - 打开已限定到项目主要工作区的会话
  - 让仪表盘在项目配置的工作区间切换
  - 显示该项目最近的命令和相关进程/服务器状态
- 智能体终端标签页：
  - 打开已限定到智能体工作区的会话
  - 显示最近相关的运行和命令
- 运行终端标签页：
  - 让仪表盘检查特定失败运行周围的环境

核心工作流：

- 仪表盘针对智能体工作区打开终端以重现失败的命令。
- 仪表盘打开项目页面并直接在该项目的主要工作区启动终端。
- 仪表盘从终端页面监视长时间运行的开发服务器或测试命令。
- 仪表盘从同一 UI 终止或中断失控的进程。

### 所需 Hook

推荐的能力和扩展点：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register` 用于 `project`、`agent` 和 `run`
- `projects.read`
- `project.workspaces.read`
- `activity.log.write`

插件通过 `ctx.projects` 解析工作区路径，并直接使用 Node PTY 库处理 PTY 会话管理（打开、输入、调整大小、终止、订阅）。

可选事件订阅：

- `events.subscribe(agent.run.started)`
- `events.subscribe(agent.run.failed)`
- `events.subscribe(agent.run.cancelled)`

## Git 工作流

包构想：`@paperclip/plugin-git`

此插件围绕任务和工作区添加仓库感知的工作流工具。它适用于：

- 与任务绑定的分支创建
- 快速差异审查
- 提交和 worktree 可见性
- PR 准备
- 将项目的主要工作区视为规范的仓库锚点
- 查看智能体的工作区是干净还是脏的

### 用户体验

- 设置页面：`/settings/plugins/git`
- 主页面：`/:companyPrefix/plugins/git`
- 项目标签页：`/:companyPrefix/projects/:projectId?tab=git`
- 可选任务标签页：`/:companyPrefix/issues/:issueId?tab=git`
- 可选智能体标签页：`/:companyPrefix/agents/:agentId?tab=git`

主要界面和交互：

- 插件设置：
  - 分支命名模板
  - 可选的远程提供者令牌密钥引用
  - 写入操作是否启用或仅只读
  - 插件是否始终使用 `project.primaryWorkspace`，除非选择了不同的项目工作区
- Git 概览页面：
  - 项目选择器和工作区选择器
  - 当前分支
  - 领先/落后状态
  - 脏文件摘要
  - 最近提交
  - 活跃的 worktree
  - 操作：刷新、创建分支、创建 worktree、暂存全部、提交、打开差异
- 项目标签页：
  - 在项目的主要工作区中打开
  - 显示工作区元数据和仓库绑定（`cwd`、`repoUrl`、`repoRef`）
  - 显示该项目工作区的分支、差异和提交历史
- 任务标签页：
  - 解析任务的项目并使用该项目的工作区上下文
  - "从任务创建分支"操作
  - 限定到项目所选工作区的差异视图
  - 将分支/worktree 元数据链接到任务
- 智能体标签页：
  - 显示智能体的分支、worktree 和脏状态
  - 显示该智能体最近的提交
  - 如果智能体在项目工作区内工作，链接回项目 git 标签页

核心工作流：

- 仪表盘从任务创建分支并将其绑定到项目的主要工作区。
- 仪表盘打开项目页面并在不离开 Paperclip 的情况下审查该项目工作区的差异。
- 仪表盘在运行后不离开 Paperclip 即可审查差异。
- 仪表盘打开 worktree 列表以了解跨智能体的并行分支。

### 所需 Hook

推荐的能力和扩展点：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register` 用于 `project`、`issue` 和 `agent`
- `ui.action.register`
- `projects.read`
- `project.workspaces.read`
- 可选 `agent.tools.register`（例如 `create-branch`、`get-diff`、`get-status`）
- 可选 `events.emit`（例如 `plugin.@paperclip/plugin-git.push-detected`）
- `activity.log.write`

插件通过 `ctx.projects` 解析工作区路径，并直接使用 git CLI 或 git 库处理所有 git 操作（status、diff、log、branch create、commit、worktree create、push）。

可选事件订阅：

- `events.subscribe(issue.created)`
- `events.subscribe(issue.updated)`
- `events.subscribe(agent.run.finished)`

git 插件可以发出 `plugin.@paperclip/plugin-git.push-detected` 事件，其他插件（例如 GitHub Issues）订阅以实现跨插件协调。

注意：GitHub/GitLab PR 创建可能应该放在单独的连接器插件中，而不是让本地 git 插件承担过多功能。

## Linear 任务跟踪

包构想：`@paperclip/plugin-linear`

此插件将 Paperclip 工作与 Linear 同步。它适用于：

- 从 Linear 导入积压工作
- 将 Paperclip 任务链接到 Linear 任务
- 同步状态、评论和指派人
- 将公司目标/项目映射到外部产品规划
- 让仪表盘操作员在一个地方查看同步健康状态

### 用户体验

- 设置页面：`/settings/plugins/linear`
- 主页面：`/:companyPrefix/plugins/linear`
- 仪表盘小组件：`/:companyPrefix/dashboard`
- 可选任务标签页：`/:companyPrefix/issues/:issueId?tab=linear`
- 可选项目标签页：`/:companyPrefix/projects/:projectId?tab=linear`

主要界面和交互：

- 插件设置：
  - Linear API 令牌密钥引用
  - 工作区/团队/项目映射
  - Paperclip 和 Linear 之间的状态映射
  - 同步方向：仅导入、仅导出、双向
  - 评论同步开关
- Linear 概览页面：
  - 同步健康卡片
  - 最近同步作业
  - 已映射的项目和团队
  - 未解决的冲突队列
  - 团队、项目和任务的导入操作
- 任务标签页：
  - 关联的 Linear 任务键和 URL
  - 同步状态和上次同步时间
  - 操作：关联现有、在 Linear 中创建、立即重新同步、取消关联
  - 已同步评论/状态变更的时间线
- 仪表盘小组件：
  - 开放的同步错误
  - 导入 vs 关联的任务数
  - 最近的 webhook/作业失败

核心工作流：

- 仪表盘启用插件，映射 Linear 团队，并将积压工作导入 Paperclip。
- Paperclip 任务状态变更推送到 Linear，Linear 评论通过 webhook 返回。
- 仪表盘从插件页面解决映射冲突，而不是静默的状态漂移。

### 所需 Hook

推荐的能力和扩展点：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.dashboardWidget.register`
- `ui.detailTab.register` 用于 `issue` 和 `project`
- `events.subscribe(issue.created)`
- `events.subscribe(issue.updated)`
- `events.subscribe(issue.comment.created)`
- `events.subscribe(project.updated)`
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- 可选 `issues.create`
- 可选 `issues.update`
- 可选 `issue.comments.create`
- 可选 `agent.tools.register`（例如 `search-linear-issues`、`get-linear-issue`）
- `activity.log.write`

重要约束：

- webhook 处理应该是幂等的且具有冲突感知能力
- 外部 ID 和同步游标属于插件拥有的状态，在第一版中不应内联在核心任务行上

## GitHub 任务跟踪

包构想：`@paperclip/plugin-github-issues`

此插件将 Paperclip 任务与 GitHub Issues 同步，并可选地链接 PR。它适用于：

- 导入仓库积压工作
- 镜像任务状态和评论
- 将 PR 链接到 Paperclip 任务
- 从一个公司视图内跟踪跨仓库工作
- 将工程工作流与 Paperclip 任务治理连接

### 用户体验

- 设置页面：`/settings/plugins/github-issues`
- 主页面：`/:companyPrefix/plugins/github-issues`
- 仪表盘小组件：`/:companyPrefix/dashboard`
- 可选任务标签页：`/:companyPrefix/issues/:issueId?tab=github`
- 可选项目标签页：`/:companyPrefix/projects/:projectId?tab=github`

主要界面和交互：

- 插件设置：
  - GitHub App 或 PAT 密钥引用
  - 组织/仓库映射
  - 标签/状态映射
  - 是否启用 PR 链接
  - 新 Paperclip 任务是否应自动创建 GitHub 任务
- GitHub 概览页面：
  - 仓库映射列表
  - 同步健康和最近 webhook 事件
  - 导入积压工作操作
  - 未关联 GitHub 任务的队列
- 任务标签页：
  - 关联的 GitHub 任务和可选的关联 PR
  - 操作：创建 GitHub 任务、关联现有任务、取消关联、重新同步
  - 评论/状态同步时间线
- 仪表盘小组件：
  - 关联到活跃 Paperclip 任务的开放 PR
  - webhook 失败
  - 同步延迟指标

核心工作流：

- 仪表盘将仓库的 GitHub Issues 导入 Paperclip。
- GitHub webhook 更新 Paperclip 中的状态/评论状态。
- PR 被链接回 Paperclip 任务，以便仪表盘可以跟踪交付状态。

### 所需 Hook

推荐的能力和扩展点：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.dashboardWidget.register`
- `ui.detailTab.register` 用于 `issue` 和 `project`
- `events.subscribe(issue.created)`
- `events.subscribe(issue.updated)`
- `events.subscribe(issue.comment.created)`
- `events.subscribe(plugin.@paperclip/plugin-git.push-detected)`（跨插件协调）
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- 可选 `issues.create`
- 可选 `issues.update`
- 可选 `issue.comments.create`
- `activity.log.write`

重要约束：

- 即使"本地 git 状态"和"远程 GitHub 任务状态"协同工作，也应保持在单独的插件中——跨插件事件处理协调

## Grafana 指标

包构想：`@paperclip/plugin-grafana`

此插件在 Paperclip 内展示外部指标和仪表盘。它适用于：

- 公司 KPI 可见性
- 基础设施/事件监控
- 在工作旁边显示部署、流量、延迟或收入图表
- 从异常指标创建 Paperclip 任务

### 用户体验

- 设置页面：`/settings/plugins/grafana`
- 主页面：`/:companyPrefix/plugins/grafana`
- 仪表盘小组件：`/:companyPrefix/dashboard`
- 可选目标标签页：`/:companyPrefix/goals/:goalId?tab=metrics`

主要界面和交互：

- 插件设置：
  - Grafana 基础 URL
  - 服务账户令牌密钥引用
  - 仪表盘和面板映射
  - 刷新间隔
  - 可选的告警阈值规则
- 仪表盘小组件：
  - 主仪表盘上的一个或多个指标卡片
  - 快速趋势视图和上次刷新时间
  - 链接到 Grafana 和链接到完整的 Paperclip 插件页面
- 完整指标页面：
  - 嵌入或代理的选定仪表盘面板
  - 指标选择器
  - 时间范围选择器
  - "从异常创建任务"操作
- 目标标签页：
  - 与特定目标或项目相关的指标卡片

核心工作流：

- 仪表盘直接在 Paperclip 仪表盘上看到服务退化或业务 KPI 变化。
- 仪表盘点击进入完整指标页面以检查相关的 Grafana 面板。
- 仪表盘从阈值突破创建 Paperclip 任务，并附加指标快照。

### 所需 Hook

推荐的能力和扩展点：

- `instance.settings.register`
- `ui.dashboardWidget.register`
- `ui.page.register`
- `ui.detailTab.register` 用于 `goal` 或 `project`
- `jobs.schedule`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- 可选 `issues.create`
- 可选 `assets.write`
- `activity.log.write`

可选事件订阅：

- `events.subscribe(goal.created)`
- `events.subscribe(project.updated)`

重要约束：

- 首先从只读开始
- 不要让 Grafana 告警逻辑成为 Paperclip 核心的一部分；将其保持为累加式信号和任务创建

## 子进程 / 服务器跟踪

包构想：`@paperclip/plugin-runtime-processes`

此插件跟踪在项目工作区中启动的长期运行的本地进程和开发服务器。它适用于：

- 查看哪个智能体启动了哪个本地服务
- 跟踪端口、健康状态和运行时间
- 重启失败的开发服务器
- 在任务和运行状态旁边暴露进程状态
- 使本地开发工作流对仪表盘可见

### 用户体验

- 设置页面：`/settings/plugins/runtime-processes`
- 主页面：`/:companyPrefix/plugins/runtime-processes`
- 仪表盘小组件：`/:companyPrefix/dashboard`
- 进程详情页：`/:companyPrefix/plugins/runtime-processes/:processId`
- 项目标签页：`/:companyPrefix/projects/:projectId?tab=processes`
- 可选智能体标签页：`/:companyPrefix/agents/:agentId?tab=processes`

主要界面和交互：

- 插件设置：
  - 是否允许手动进程注册
  - 健康检查行为
  - 操作员是否可以停止/重启进程
  - 日志保留偏好
- 进程列表页面：
  - 包含名称、命令、cwd、所属智能体、端口、运行时间和健康状态的状态表
  - 运行中/已退出/已崩溃进程的过滤器
  - 操作：检查、停止、重启、查看日志
- 项目标签页：
  - 将进程列表过滤到项目的工作区
  - 显示每个进程属于哪个工作区
  - 按项目工作区分组进程
- 进程详情页：
  - 进程元数据
  - 实时日志跟踪
  - 健康检查历史
  - 到关联任务或运行的链接
- 智能体标签页：
  - 显示由该智能体启动或分配给该智能体的进程

核心工作流：

- 智能体启动开发服务器；插件检测并跟踪它。
- 仪表盘打开项目并立即看到附加到该项目工作区的进程。
- 仪表盘在仪表盘上看到崩溃的进程并从插件页面重启它。
- 仪表盘在调试故障时将进程日志附加到任务。

### 所需 Hook

推荐的能力和扩展点：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.dashboardWidget.register`
- `ui.detailTab.register` 用于 `project` 和 `agent`
- `projects.read`
- `project.workspaces.read`
- `plugin.state.read`
- `plugin.state.write`
- `activity.log.write`

插件通过 `ctx.projects` 解析工作区路径，并直接使用 Node API 处理进程管理（注册、列出、终止、重启、读取日志、健康探测）。

可选事件订阅：

- `events.subscribe(agent.run.started)`
- `events.subscribe(agent.run.finished)`

## Stripe 收入跟踪

包构想：`@paperclip/plugin-stripe`

此插件将 Stripe 收入和订阅数据拉入 Paperclip。它适用于：

- 在公司目标旁边显示 MRR 和流失率
- 跟踪试用、转化和失败支付
- 让仪表盘将收入变化与正在进行的工作联系起来
- 启用超越令牌成本的未来财务仪表盘

### 用户体验

- 设置页面：`/settings/plugins/stripe`
- 主页面：`/:companyPrefix/plugins/stripe`
- 仪表盘小组件：`/:companyPrefix/dashboard`
- 如果这些界面以后存在，可选的公司/目标指标标签页

主要界面和交互：

- 插件设置：
  - Stripe 密钥密钥引用
  - 账户选择（如需要）
  - 指标定义，如 MRR 处理和试用处理
  - 同步间隔
  - webhook 签名密钥引用
- 仪表盘小组件：
  - MRR 卡片
  - 活跃订阅
  - 试用到付费转化
  - 失败支付告警
- Stripe 概览页面：
  - 时间序列图表
  - 最近的客户/订阅事件
  - webhook 健康
  - 同步历史
  - 操作：从账单异常创建任务

核心工作流：

- 仪表盘启用插件并连接 Stripe 账户。
- Webhook 和定时对账保持插件状态最新。
- 收入小组件出现在主仪表盘上，可以链接到公司目标。
- 失败支付激增或流失事件可以生成 Paperclip 任务以进行跟进。

### 所需 Hook

推荐的能力和扩展点：

- `instance.settings.register`
- `ui.dashboardWidget.register`
- `ui.page.register`
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- `metrics.write`
- 可选 `issues.create`
- `activity.log.write`

重要约束：

- Stripe 数据应保持为 Paperclip 核心的累加式补充
- 它不应渗入核心预算逻辑，在 V1 中预算逻辑专门关于模型/令牌消费

## 值得采纳的 OpenCode 具体模式

## 采纳

- 将 SDK 包与运行时加载器分离
- 确定性加载顺序和优先级
- 非常小的编写 API
- 插件输入/配置/工具的类型化 schema
- 工具作为一等插件扩展点（命名空间化，非冲突覆盖）
- 内部扩展在合理时使用与外部扩展相同的注册形状
- 插件加载错误在可能时与宿主启动隔离
- 面向社区的显式插件文档和示例模板
- 测试工具包和入门模板以降低编写摩擦
- 无需服务器重启的热插件生命周期（由进程外 worker 支持）
- 正式的 SDK 版本管理，支持多版本宿主

## 适配，而非照搬

- 本地路径加载
- 依赖自动安装
- hook 修改模型
- 内置覆盖行为
- 广泛的运行时上下文对象

## 避免

- 项目本地任意代码加载
- 启动时隐式信任 npm 包
- 插件覆盖核心不变量
- 非沙箱化进程内执行作为默认扩展模型

## 建议的推出计划

## 第 0 阶段：加固已存在的接缝

- 将适配器/存储/密钥/运行日志注册表形式化为"平台模块"
- 尽可能移除临时回退行为
- 记录稳定的注册契约

## 第 1 阶段：首先添加连接器插件

这是最高价值、最低风险的插件类别。

构建：

- 插件清单
- 全局安装/更新生命周期
- 全局插件配置和可选的公司映射存储
- 密钥引用访问
- 类型化域事件订阅
- 定时作业
- webhook 端点
- 活动日志辅助工具
- 插件 UI 包加载、宿主桥接、`@paperclipai/plugin-sdk/ui`
- 页面、标签页、小组件、侧边栏入口的扩展槽位挂载
- 从 `instanceConfigSchema` 自动生成设置表单
- 桥接错误传播（`PluginBridgeError`）
- 插件贡献的智能体工具
- 插件间事件（`plugin.<pluginId>.*` 命名空间）
- 事件过滤（服务端，按订阅）
- 带可配置截止时间的优雅关闭
- 插件日志和健康仪表盘
- 带数据保留宽限期的卸载
- `@paperclipai/plugin-test-harness` 和 `create-paperclip-plugin` 入门模板
- 热插件生命周期（安装、卸载、升级、配置变更无需服务器重启）
- SDK 版本管理，支持多版本宿主和弃用策略

此阶段将立即覆盖：

- Linear
- GitHub
- Grafana
- Stripe
- 文件浏览器
- 终端
- git 工作流
- 子进程/服务器跟踪

工作区插件不需要额外的宿主 API——它们通过 `ctx.projects` 解析工作区路径，并直接处理文件系统、git、PTY 和进程操作。

## 第 2 阶段：考虑更丰富的 UI 和插件打包

仅在第 1 阶段稳定后：

- 不受信任第三方插件 UI 包的 iframe 隔离
- 签名/验证的插件包
- 插件市场
- 可选的自定义插件存储后端或迁移

## 推荐的架构决策

如果我必须将此报告浓缩为一个架构决策，那就是：

Paperclip 不应实现"OpenCode 风格的通用进程内 hook 系统"。
Paperclip 应实现"一个具有多层信任级别的插件平台"：

- 用于底层运行时集成的受信任平台模块
- 用于实例级集成和自动化的类型化进程外插件
- 插件贡献的智能体工具（命名空间化、能力受限）
- 通过类型化桥接在宿主扩展槽位中渲染的插件发布 UI 包，具有结构化错误传播
- 用于跨插件协调的插件间事件
- 从配置 schema 自动生成设置 UI
- 插件可以观察和围绕其行动但不能替换的核心拥有不变量
- 插件可观测性、优雅生命周期管理和降低编写摩擦的测试工具包
- 热插件生命周期——安装、卸载、升级或配置变更无需服务器重启
- SDK 版本管理，支持多版本宿主和明确的弃用策略

这获得了 `opencode` 可扩展性的好处，而不引入错误的威胁模型。

## 我会在 Paperclip 中采取的具体下一步

1. 编写一个简短的扩展架构 RFC，形式化 `platform modules` 和 `plugins` 之间的区别。
2. 在 `packages/shared` 中引入一个小型插件清单类型，在实例配置中添加 `plugins` 安装/配置部分。
3. 围绕现有的活动/实时事件模式构建类型化域事件总线，带有服务端事件过滤和用于跨插件事件的 `plugin.*` 命名空间。保持核心不变量不可挂钩。
4. 实现插件 MVP：全局安装/配置、密钥引用、作业、webhook、插件 UI 包、扩展槽位、自动生成设置表单、桥接错误传播。
5. 添加智能体工具贡献——插件注册智能体在运行期间可以调用的命名空间化工具。
6. 添加插件可观测性：通过 `ctx.logger` 的结构化日志、健康仪表盘、内部健康事件。
7. 添加优雅关闭策略和带保留宽限期的卸载数据生命周期。
8. 发布 `@paperclipai/plugin-test-harness` 和 `create-paperclip-plugin` 入门模板。
9. 实现热插件生命周期——安装、卸载、升级和配置变更无需服务器重启。
10. 定义 SDK 版本管理策略——语义化版本、多版本宿主支持、弃用时间线、迁移指南、发布的兼容性矩阵。
11. 构建工作区插件（文件浏览器、终端、git、进程跟踪），从宿主解析工作区路径并直接处理 OS 级操作。
