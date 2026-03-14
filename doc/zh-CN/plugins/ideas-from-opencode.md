# 来自 OpenCode 的插件创意

状态：设计报告，不是 V1 承诺

Paperclip V1 在 [doc/SPEC-implementation.md](../SPEC-implementation.md) 中明确排除了插件框架，但长期规范表示该架构应该为扩展留出空间。本报告研究了 `opencode` 插件系统，并将有用的模式转化为 Paperclip 形状的设计。

本文档的假设：Paperclip 是单租户操作员控制的实例。因此，插件安装应该是跨实例的全局安装。 “公司”仍然是一流的 Paperclip 对象，但它们是组织记录，而不是插件信任或安装的租户隔离边界。

## 执行摘要

`opencode`已经有了一个真正的插件系统。它是故意低摩擦的：

- 插件是普通的 JS/TS 模块
- 它们从本地目录和 npm 包加载
- 他们可以挂钩许多运行时事件
- 他们可以添加自定义工具
- 他们可以扩展提供商身份验证流程
- 它们在进程内运行并且可以直接改变运行时行为

该模型非常适合本地编码工具。不应将其逐字复制到 Paperclip 中。

主要结论是：

- Paperclip 应复制 `opencode` 的类型化 SDK、确定性加载、低创作摩擦和清晰的扩展表面。
- Paperclip 不应复制 `opencode` 的信任模型、项目本地插件加载、“按名称冲突覆盖”行为或核心业务逻辑的任意进程内突变挂钩。
- Paperclip 应该使用多个扩展类而不是一个通用插件包：
  - 用于低级平台问题的可信进程内模块，例如智能体适配器、存储提供程序、秘密提供程序以及可能的运行日志后端
  - 适用于大多数第三方集成的进程外插件，例如 Linear、GitHub Issues、Grafana、Stripe 和调度程序
  - 插件提供的智能体工具（命名空间，不是碰撞覆盖）
  - 插件提供的 React UI 通过类型化桥加载到主机扩展插槽中
  - 具有服务器端过滤和插件到插件事件的类型化事件总线，以及用于自动化的预定作业

如果 Paperclip 做得很好，那么您列出的示例就会变得简单：

- 文件浏览器/终端/git工作流程/子进程跟踪成为工作区插件，可以解析来自主机的路径并直接处理操作系统操作
- Linear / GitHub / Grafana / Stripe 成为连接器插件
- 未来的知识库和会计功能也可以适合同一模型

## 来源审查

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
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/web/src/content/docs/ecosystem.mdx`针对当前扩展接缝审核的相关 Paperclip 文件：

- [服务器/src/适配器/registry.ts](../../server/src/adapters/registry.ts)
- [ui/src/adapters/registry.ts](../../ui/src/adapters/registry.ts)
- [服务器/src/存储/provider-registry.ts](../../server/src/storage/provider-registry.ts)
- [服务器/src/secrets/provider-registry.ts](../../server/src/secrets/provider-registry.ts)
- [服务器/src/services/run-log-store.ts](../../server/src/services/run-log-store.ts)
- [服务器/src/services/activity-log.ts](../../server/src/services/activity-log.ts)
- [doc/SPEC.md](../SPEC.md)
- [doc/SPEC-implementation.md](../SPEC-implementation.md)

## OpenCode 实际实现了什么

## 1. 插件编写 API

`opencode` 公开了一个小包 `@opencode-ai/plugin`，带有类型化的 `Plugin` 函数和类型化的 `tool()` 帮助程序。

核心形状：

- 插件是一个接收上下文对象的异步函数
- 插件返回一个 `Hooks` 对象
- 挂钩是可选的
- 插件还可以贡献工具和身份验证提供者

插件初始化上下文包括：

- SDK客户端
- 当前项目信息
- 当前目录
- 当前的 git 工作树
- 服务器网址
- 包子壳访问

这很重要：`opencode` 立即为插件提供丰富的运行时功能，而不是狭窄的功能 API。

## 2. 钩子模型

钩组很宽。它包括：

- 事件订阅
- 配置时间挂钩
- 消息挂钩
- 模型参数/标题挂钩
- 权限决策挂钩
- shell 环境注入
- 钩子变更前/后的工具执行
- 工具定义突变
- 压缩提示定制
- 文本完成变换

实现模式非常简单：

- 核心代码构造一个`output`对象
- 每个匹配的插件挂钩按顺序运行
- 钩子使 `output` 发生变异
- 最终变异输出由核心使用

这是优雅且易于扩展的。

它的威力也是极其强大的。插件可以更改身份验证标头、模型参数、权限答案、工具输入、工具描述和 shell 环境。

## 3. 插件发现和加载顺序

`opencode` 支持两种插件源：

- 本地文件
- npm 包

本地目录：

- `~/.config/opencode/plugins/`
- `.opencode/plugins/`

Npm 插件：

- 在 `plugin: []` 下的配置中列出

加载顺序是确定性的并记录在案：

1. 全局配置
2. 项目配置
3. 全局插件目录
4. 项目插件目录

重要细节：

- 配置数组是连接而不是替换
- 重复的插件名称将被删除，优先级较高的条目获胜
- 内部第一方插件和默认插件也通过插件管道加载

这为 `opencode` 提供了真正的优先级模型，而不是“偶然最后加载的内容”。

## 4. 依赖关系处理

对于本地配置/插件目录，`opencode` 将：

- 确保 `package.json` 存在
-注入`@opencode-ai/plugin`
- 运行`bun install`

这允许本地插件和本地自定义工具导入依赖项。这对于本地开发人员的人体工程学来说非常有用。

对于操作员控制的控制平面服务器来说，这不是安全的默认设置。

## 5. 错误处理

默认情况下，插件加载失败不会导致运行时硬崩溃。

相反，`opencode`：

- 记录错误
- 发布会话错误事件
- 继续加载其他插件

这是一个很好的运营模式。一个糟糕的插件不应该破坏整个产品，除非操作员已根据需要明确配置它。

## 6. 工具是一流的扩展点

`opencode`有两种添加工具的方式：

- 通过 `hook.tool` 直接从插件导出工具
- 在`.opencode/tools/`或全局工具目录中定义本地文件

API这个工具很强大：

- 工具有描述
- 工具具有 Zod 模式
- 工具执行获取上下文，如会话 ID、消息 ID、目录和工作树
- 工具被合并到与内置工具相同的注册表中
- 工具定义本身可以通过 `tool.definition` 挂钩进行变异

设计中最激进的部分：

- 自定义工具可以按名称覆盖内置工具

这对于本地编码助手来说非常强大。
对于Paperclip的核心动作来说太危险了。

然而，插件贡献智能体可用工具的概念对于 Paperclip 来说非常有价值——只要插件工具是命名空间的（不能影子核心工具）和能力门控的。

## 7. Auth 也是一个插件表面

`opencode` 允许插件为提供者注册身份验证方法。

插件可以贡献：

- 验证方法元数据
- 提示流程
- OAuth 流程
- API 关键流程
- 请求加载器在身份验证成功后调整提供者的行为

这是一个值得效仿的强大模式。集成通常需要自定义身份验证用户体验和令牌处理。

## 8. 生态系统证据

生态系统页面是该模型在实践中发挥作用的最好证明。
社区插件已经涵盖：

- 沙箱/工作空间系统
- 授权提供商
- 会话标头/遥测
- 记忆/上下文特征
- 日程安排
- 通知
- 工作树助手
- 后台特工
- 监控

这验证了主要论点：一个简单的类型插件 API 可以创造真正的生态系统速度。

## OpenCode 的正确之处

## 1. 将插件 SDK 与主机运行时分开

这是设计中最好的部分之一。

- 插件作者针对干净的公共包编写代码
- 主机内部结构可以在加载程序后面进化
- 运行时代码和插件代码有一个干净的契约边界

Paperclip 绝对应该这样做。

## 2. 确定性加载和优先级

`opencode` 明确表示：

- 插件从哪里来
- 配置如何合并
- 什么顺序获胜

Paperclip 应该复制这个纪律。

## 3. 低调的创作

插件作者不必学习庞大的框架。- 导出异步函数
- 返回挂钩
- 可选择导出工具

这种简单性很重要。

## 4. 类型化工具定义

`tool()` 助手非常出色：

- 键入
- 基于模式
- 易于记录
- 易于运行时验证

Paperclip 应该对插件操作、自动化和 UI 模式采用这种风格。

## 5.内置功能和插件使用相似的形状

`opencode` 在多个地方对内部和外部插件式行为使用相同的钩子系统。
这减少了特殊情况。

Paperclip 可以从适配器、秘密后端、存储提供程序和连接器模块中受益。

## 6. 增量扩展，而不是预先进行巨大的抽象

`opencode` 最初并没有设计一个巨大的市场平台。
它添加了实际功能所需的具体扩展点。

这也是Paperclip的正确心态。

## Paperclip 不应该直接复制的内容

## 1.默认进程内任意插件代码

`opencode` 基本上是本地智能体运行时，因此非沙盒插件执行对其受众来说是可以接受的。

Paperclip 是具有公司对象的操作员管理实例的控制平面。
风险状况不同：

- 秘密很重要
- 审批关口很重要
- 预算很重要
- 变异操作需要可审计性

默认第三方插件不应在对服务器内存、数据库句柄和机密进行不受限制的进程内访问的情况下运行。

## 2.项目本地插件加载

`opencode` 具有项目本地插件文件夹，因为该工具以代码库为中心。

Paperclip 不是项目范围。它是实例范围的。
可比单位是：

- 实例安装的插件包

Paperclip 不应从工作区存储库（如 `.paperclip/plugins` 或项目目录）自动加载任意代码。

## 3. 任意突变会影响核心业务决策

钩子如：

- `permission.ask`
- `tool.execute.before`
- `chat.headers`
- `shell.env`

在 `opencode` 中有意义。

对于 Paperclip，等效挂钩到：

- 批准决定
- 问题结帐语义
- 活动日志行为
- 预算执行

将是一个错误。

核心不变量应该保留在核心代码中，而不是可钩重写的。

## 4. 按名称覆盖冲突

允许插件按名称替换内置工具在本地智能体产品中非常有用。

Paperclip 不应允许插件静默替换：

- 核心路线
- 核心变异动作
- 授权行为
- 权限评估器
- 预算逻辑
- 审计逻辑

扩展应该是附加的或显式委托的，而不是意外的遮蔽。

## 5. 从用户配置自动安装并执行

`opencode` 的“启动时安装依赖项”流程符合人体工程学。
对于 Paperclip 来说，这是有风险的，因为它结合了：

- 包安装
- 代码加载
- 执行在控制平面服务器启动路径内。

Paperclip 应该需要显式的操作员安装步骤。

## 为什么 Paperclip 需要不同的形状

产品正在解决不同的问题。

|主题 |开放代码 | Paperclip |
|---|---|---|
|主要单位|本地项目/工作树 |具有公司对象的单租户操作员实例 |
|信任假设|自己机器上的本地高级用户|操作员管理一个受信任的Paperclip 实例|
|失效爆炸半径|本地会话/运行时 |整个公司的控制平面|
|扩展样式|自由改变运行时行为 |保持治理和可审计性|
|用户界面模型 |本地应用程序可以加载本地行为|主板 UI 必须保持连贯且安全 |
|安全模型 |主机信任的本地插件 |需求能力边界和可审计性|

这意味着Paperclip应该借鉴`opencode`的好想法，但使用更严格的架构。

## Paperclip 已经有有用的预插件接缝

Paperclip 已经有几个类似扩展的接缝：

- 服务器适配器注册表：[server/src/adapters/registry.ts](../../server/src/adapters/registry.ts)
- UI适配器注册表：[ui/src/adapters/registry.ts](../../ui/src/adapters/registry.ts)
- 存储提供商注册表：[server/src/storage/provider-registry.ts](../../server/src/storage/provider-registry.ts)
- 秘密提供商注册表：[server/src/secrets/provider-registry.ts](../../server/src/secrets/provider-registry.ts)
- 可插入运行日志存储接缝：[server/src/services/run-log-store.ts](../../server/src/services/run-log-store.ts)
- 活动日志和实时事件发射：[server/src/services/activity-log.ts](../../server/src/services/activity-log.ts)

这是个好消息。
Paperclip 不需要从头开始发明可扩展性。
它需要统一并加固现有的接缝。

## 推荐 Paperclip 插件型号

## 1.使用多个扩展类

不要为所有内容创建一个巨大的 `hooks` 对象。

使用具有不同信任模型的不同插件类。|延伸类|示例 |运行时模型 |信任级别 |为什么 |
|---|---|---|---|---|
|平台模块|智能体适配器、存储提供程序、秘密提供程序、运行日志后端 |进行中|高度信赖|紧密集成、性能、低级 APIs |
|连接器插件 |线性、GitHub 问题、Grafana、条纹 |进程外工作者或 sidecar |中等|外部同步，隔离更安全，故障边界更清晰 |
|工作区插件 |文件浏览器、终端、git 工作流程、子进程/服务器跟踪 |进程外、直接操作系统访问中等|解析主机的工作空间路径，直接拥有文件系统/git/PTY/进程逻辑 |
| UI 贡献 |控制台小部件、设置表单、公司面板 |通过桥接在主机扩展插槽中提供插件 React 捆绑包 |中等|插件拥有自己的渲染；主机控制插槽放置和桥接访问
|自动化插件 |警报、调度程序、同步作业、webhook 处理器 |进程外|中等|事件驱动的自动化是一个自然的插件配合|

这种分割是本报告中最重要的设计建议。

## 2. 将低级模块与第三方插件分开

Paperclip 已经隐式具有此模式：

- 适配器是一回事
- 存储提供商是另一个
- 秘密供应商是另一个

保持这种分离。

我会这样正式化它：

- `module` 表示主机为低级运行时服务加载的可信代码
- `plugin` 表示通过类型化插件协议和功能模型与 Paperclip 对话的集成代码

这避免了尝试强制 Stripe、PTY 终端和新智能体适配器进入相同的抽象。

## 3. 优先选择事件驱动的扩展而不是核心逻辑突变

对于第三方插件，主要的 API 应该是：

- 订阅类型化域事件（带有可选的服务器端过滤）
- 发出插件命名空间事件以进行跨插件通信
- 读取实例状态，包括相关的公司业务记录
- 注册网络钩子
- 运行预定的作业
- 提供智能体在运行期间可以使用的工具
- 写入插件拥有的状态
- 添加附加 UI 表面
- 通过 API 调用显式 Paperclip 操作

不要让第三方插件负责：

- 决定是否批准通过
- 拦截问题结账语义
- 重写活动日志行为
- 压倒性的预算硬停止

这些是核心不变量。

## 4. 插件提供自己的 UI

插件将自己的 React UI 作为 `dist/ui/` 内的捆绑模块提供。主机将插件组件加载到指定的**扩展槽**（页面、选项卡、小部件、侧边栏条目）中，并为插件前端提供一个**桥**，以与其自己的工作后端通信并访问主机上下文。**它是如何工作的：**

1. 插件的 UI 为其填充的每个槽导出命名组件（例如 `DashboardWidget`、`IssueDetailTab`、`SettingsPage`）。
2. 主机将插件组件安装到正确的插槽中，并传递带有 `usePluginData(key, params)` 和 `usePluginAction(key)` 等钩子的桥接对象。
3. 插件组件通过桥接器从其自己的工作线程获取数据，并根据需要进行渲染。
4. 主机通过网桥强制执行能力门 - 如果工作人员没有能力，网桥将拒绝调用。

**主机控制的内容：** 插件组件出现的位置、桥 API、功能实施以及具有设计令牌和通用组件的共享 UI 基元 (`@paperclipai/plugin-sdk/ui`)。

**插件控制什么：**如何呈现其数据、获取哪些数据、公开哪些操作以及是否使用主机的共享组件或构建完全自定义的 UI。

第一个版本扩展槽：

- 控制台小部件
- 设置页面
- 详细信息页面选项卡（项目、问题、智能体、目标、运行）
- 侧边栏条目
- 公司上下文插件页面

主机 SDK 附带共享组件（MetricCard、DataTable、StatusBadge、LogView 等）以实现视觉一致性，但这些是可选的。

稍后，如果不受信任的第三方插件变得普遍，主机可以转移到基于 iframe 的隔离，而无需更改插件的源代码（桥 API 保持不变）。

## 5. 使安装全局化并保持映射/配置独立

`opencode` 主要是用户级本地配置。
Paperclip 应该将插件安装视为全局实例级操作。

示例：

- 安装一次 `@paperclip/plugin-linear`
- 立即使其随处可用
- 如果一家公司映射到与另一家公司不同的 Linear 团队，则可选择存储 Paperclip 对象上的映射

## 6. 使用项目工作区作为本地工具的主要锚点

Paperclip 已经有了一个具体的项目工作空间模型：

- 项目公开 `workspaces` 和 `primaryWorkspace`
- 数据库已有`project_workspaces`
- 项目路由已经支持创建、更新和删除工作区
- 在回退到任务会话或智能体主工作区之前，心跳解析已经优先选择项目工作区

这意味着本地/运行时插件通常应该首先将自己锚定到项目，而不是发明并行工作空间模型。

实用指导：

- 文件浏览器应首先浏览项目工作区
- 终端会话应该可以从项目工作区启动
- git 应该将项目工作区视为存储库根锚点
- 开发服务器和子进程跟踪应附加到项目工作区
- 问题和智能体视图仍然可以深入链接到相关的项目工作空间上下文

换句话说：- `project` 是业务对象
- `project_workspace` 是本地运行时锚点
- 插件应该在此基础上构建，而不是首先创建不相关的工作区模型

## 7. 让插件贡献智能体工具

`opencode` 使工具成为一流的扩展点。这也是 Paperclip 价值最高的表面之一。

线性插件应该能够提供智能体在运行期间使用的 `search-linear-issues` 工具。 git 插件应该贡献 `create-branch` 和 `get-diff`。文件浏览器插件应提供 `read-file` 和 `list-directory`。

关键限制：

- 插件工具按插件 ID 命名（例如 `linear:search-issues`），因此它们无法隐藏核心工具
- 插件工具需要 `agent.tools.register` 功能
- 工具执行与其他所有内容一样通过相同的工作 RPC 边界
- 工具结果显示在运行日志中

这是一个自然的配合 - 该插件已经具有 SDK 上下文、外部 API 凭证和域逻辑。对于插件作者来说，将其包装在工具定义中是最少的额外工作。

## 8. 支持插件到插件事件

插件应该能够发出其他插件可以订阅的自定义事件。例如，git 插件检测到推送并发出 `plugin.@paperclip/plugin-git.push-detected`。 GitHub Issues 插件订阅该事件并更新 PR 链接。

这避免了插件需要通过共享状态或外部通道进行协调。主机通过相同的事件总线路由插件事件，并具有与核心事件相同的传递语义。

插件事件使用 `plugin.<pluginId>.*` 命名空间，因此它们不会与核心事件发生冲突。

## 9. 从配置模式自动生成设置 UI

声明 `instanceConfigSchema` 的插件应该免费获得自动生成的设置表单。主机直接从 JSON 模式呈现文本输入、下拉菜单、切换、数组和秘密引用选择器。

对于需要更丰富的设置 UX 的插件，他们可以声明 `settingsPage` 扩展槽并提供自定义 React 组件。两种方法并存。

这很重要，因为设置表单是每个插件都需要的样板。从已经存在的模式自动生成它们可以消除大量的创作摩擦。

## 10. 优雅关闭和升级的设计

规范应该明确说明插件工作程序在升级、卸载或实例重新启动期间停止时会发生什么。

推荐政策：

- 发送 `shutdown()` 并设置可配置的截止时间（默认 10 秒）
- 截止时间后 SIGTERM，再过 5 秒后 SIGKILL
- 标记为 `cancelled` 的飞行中作业
- 进行中的桥接调用将结构化错误返回给 UI特别是对于升级：旧工作人员耗尽，新工作人员启动。如果新版本增加了功能，则输入`upgrade_pending`，直到运营商批准。

## 11.定义卸载数据生命周期

卸载插件时，其数据（`plugin_state`、`plugin_entities`、`plugin_jobs` 等）应保留一段宽限期（默认 30 天），而不是立即删除。操作员可以在宽限期内重新安装并恢复状态，或通过CLI强制清除。

这很重要，因为意外卸载不应导致不可逆转的数据丢失。

## 12. 投资插件可观察性

通过 `ctx.logger` 的插件日志应该被存储并可以从插件设置页面查询。主机还应该从工作进程捕获原始 `stdout`/`stderr` 作为后备。

插件运行状况控制台应显示：工作人员状态、正常运行时间、最近日志、作业成功/失败率、Webhook 交付率和资源使用情况。主机应发出其他插件或控制台可以使用的内部事件（`plugin.health.degraded`、`plugin.worker.crashed`）。

这对于运营商来说至关重要。如果没有可观察性，调试插件问题需要 SSH 访问和手动日志跟踪。

## 13. 发送测试工具和入门模板

`@paperclipai/plugin-test-harness` 包应为模拟主机提供内存存储、合成事件发射和 `getData`/`performAction`/`executeTool` 模拟。插件作者应该能够在没有运行的 Paperclip 实例的情况下编写单元测试。

`create-paperclip-plugin` CLI 应该构建一个包含清单、worker、UI 包、测试文件和构建配置的工作插件。

低创作摩擦被认为是 `opencode` 的最佳品质之一。测试工具和入门模板是 Paperclip 实现相同功能的方式。

## 14.支持热插件生命周期

插件安装、卸载、升级和配置更改应在不重新启动 Paperclip 服务器的情况下生效。这对于开发人员工作流程和操作员体验至关重要。

进程外工作架构使这变得很自然：- **热安装**：生成一个新的工作线程，在实时路由表中注册其事件订阅、作业计划、Webhook 端点和智能体工具，将其 UI 包加载到扩展槽注册表中。
- **热卸载**：正常关闭工作线程，从路由表中删除所有注册，卸载 UI 组件，启动数据保留宽限期。
- **热升级**：关闭旧的worker，启动新的worker，自动交换路由表条目，使UI包缓存无效，以便前端加载更新的包。
- **热配置更改**：将新配置写入`plugin_config`，通过IPC（`configChanged`）通知正在运行的worker。工作人员无需重新启动即可应用更改。如果它不处理 `configChanged`，则主机仅重新启动该工作线程。

前端缓存失效使用版本化或内容散列的捆绑包 URL 和 `plugin.ui.updated` 事件，该事件会触发重新导入，而无需重新加载整个页面。

每个工作进程都是独立的——启动、停止或替换一个工作进程不会影响任何其他插件或主机本身。

## 15. 定义 SDK 版本控制和兼容性

`opencode` 没有正式的 SDK 版本控制故事，因为插件在进程内运行并有效地固定到当前运行时。 Paperclip 的进程外模型意味着插件可以针对一个 SDK 版本构建并在已更新的主机上运行。这需要明确的规则。

推荐方法：

- **单个 SDK 包**：带有子路径导出的 `@paperclipai/plugin-sdk` — 用于工作代码的 root，用于前端代码的 `/ui`。一种依赖、一种版本、一份变更日志。
- **SD​​K主要版本= API版本**：`@paperclipai/plugin-sdk@2.x`目标为`apiVersion: 2`。使用 SDK 1.x 构建的插件声明 `apiVersion: 1` 并继续工作。
- **主机多版本支持**：主机至少同时支持当前和一个以前的 `apiVersion`，每个版本都有单独的 IPC 协议处理程序。
- **清单中的 `sdkVersion`**：插件声明 semver 范围（例如 `">=1.4.0 <2.0.0"`）。主机在安装时验证这一点。
- **弃用时间表**：以前的 API 版本在新版本发布后获得至少 6 个月的持续支持。主机记录弃用警告并在插件设置页面上显示横幅。
- **迁移指南**：每个主要 SDK 版本都附带涵盖每项重大更改的分步迁移指南。
- **UI 表面与工作人员版本化**：工作人员和 UI 表面都在同一个包中，因此它们一起版本化。对共享 UI 组件的重大更改需要主要版本更新，就像工作人员 API 更改一样。
- **发布的兼容性矩阵**：主机发布了支持的API版本和SDK范围的矩阵，可通过API查询。

## Paperclip 的具体 SDK 形状故意缩小的第一遍可能如下所示：

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
      // sync Linear issues into plugin-owned state or explicit Paperclip entities
    });

    // subscribe with optional server-side filter
    ctx.events.on("issue.created", { projectId: "proj-1" }, async (event) => {
      // only receives issue.created events for project proj-1
    });

    // subscribe to events from another plugin
    ctx.events.on("plugin.@paperclip/plugin-git.push-detected", async (event) => {
      // react to the git plugin detecting a push
    });

    // contribute a tool that agents can use during runs
    ctx.tools.register("search-linear-issues", {
      displayName: "Search Linear Issues",
      description: "Search for Linear issues by query",
      parametersSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }, async (params, runCtx) => {
      // search Linear API and return results
      return { content: JSON.stringify(results) };
    });

    // getData is called by the plugin's own UI components via the host bridge
    ctx.data.register("sync-health", async ({ companyId }) => {
      // return typed JSON that the plugin's DashboardWidget component renders
      return { syncedCount: 142, trend: "+12 today", mappings: [...] };
    });

    ctx.actions.register("resync", async ({ companyId }) => {
      // run sync logic
    });
  },
});
```

插件的 UI 包（与工作线程分开）可能如下所示：

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

重要的一点不是确切的语法。
重要的一点是合约的形状：

- 输入清单
- 明确的能力
- 具有可选公司映射的显式全局配置
- 具有可选服务器端过滤的事件订阅
- 通过命名空间事件类型的插件到插件事件
- 智能体工具贡献
- 职位
- 插件提供的 UI，通过主机桥与其工作人员通信
- 从worker到UI的结构化错误传播

## 推荐的核心扩展表面

## 1. 平台模块表面

这些应该与当前的注册表风格保持接近。

候选人：

- `registerAgentAdapter()`
- `registerStorageProvider()`
- `registerSecretProvider()`
- `registerRunLogStore()`

这些是值得信赖的平台模块，而不是随意的插件。

## 2. 连接器插件表面

这些是近期最好的候选插件。

能力：

- 订阅领域事件
- 定义预定的同步作业
- 在 `/api/plugins/:pluginId/...` 下公开插件特定的 API 路由
- 使用公司秘密参考
- 写入插件状态
- 发布控制台数据
- 通过核心 APIs 记录活动

示例：

- 线性问题同步
- GitHub 问题同步
- Grafana 控制台卡
- Stripe MRR/订阅汇总

## 3. 工作空间-运行时表面

工作区插件直接处理本地工具：

- 文件浏览器
- 终端
- git工作流程
- 子进程跟踪
- 本地开发服务器跟踪

插件通过主机 API 解析工作区路径（`ctx.projects` 提供工作区元数据，包括 `cwd`、`repoUrl` 等），然后对文件系统进行操作、生成进程、shell 到 `git`，或使用标准节点 API 或他们选择的任何库打开 PTY 会话。

主机不包装或智能体这些操作。这使核心保持精简——无需为插件可能需要的每个操作系统级操作维护并行的 API 表面。插件拥有自己的实现。

## 治理和安全要求

任何 Paperclip 插件系统都必须保留存储库文档中的核心控制平面不变量。

这意味着：

- 插件安装对于实例是全局的
- “公司”仍然是 API 和数据模型中的业务对象，而不是租户边界
- 审批门仍然由核心拥有
- 预算硬停仍然由核心拥有
- 变异动作被活动记录
- 秘密仍然基于参考并在日志中进行编辑

我对每个插件都需要以下内容：

## 1. 能力声明

每个插件都声明一个静态功能集，例如：- `companies.read`
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

董事会/操作员在安装之前会看到这一点。

## 2.全局安装

插件安装一次后即可在整个实例中使用。
如果它需要特定 Paperclip 对象的映射，那么这些是插件数据，而不是启用/禁用边界。

## 3. 活动记录

插件发起的突变应通过相同的活动日志机制，并具有专用的 `plugin` 参与者类型：

- `actor_type = plugin`
- `actor_id = <plugin-id>`（例如`@paperclip/plugin-linear`）

## 4. 健康和故障报告

每个插件应该公开：

- 启用/禁用状态
- 上次成功运行
- 最后一个错误
- 最近的网络钩子/工作历史记录

一个损坏的插件不能破坏公司的其他部分。

## 5. 秘密处理

插件应该接收秘密引用，而不是配置持久性中的原始秘密值。
解决方案应该经过现有的秘密提供者抽象。

## 6. 资源限制

插件应该有：

- 超时限制
- 并发限制
- 重试政策
- 可选的每个插件预算

这对于同步连接器和工作区插件尤其重要。

## 需要考虑的数据模型添加

我会在第一个版本中避免“任意第三方插件定义的 SQL 迁移”。
这太早了，力量太大了。

正确的心智模型是：

- 当数据明显是 Paperclip 本身的一部分时，重用核心表
- 对大多数插件拥有的状态使用通用扩展表
- 稍后仅允许特定于插件的表，并且仅适用于受信任的平台模块或严格控制的迁移工作流程

## 推荐的 Postgres 扩展策略

### 1.核心表保持核心

如果一个概念成为 Paperclip 实际产品模型的一部分，它应该得到一个正常的第一方表。

示例：

- `project_workspaces` 已经是核心表，因为项目工作区现在是 Paperclip 本身的一部分
- 如果未来的“项目 git state”成为核心功能而不是插件拥有的元数据，那么它也应该是第一方表

### 2. 大多数插件应该从通用扩展表开始

对于大多数插件，主机应该提供一些通用的持久性表，并且插件在那里存储命名空间记录。

这使系统易于管理：

- 更简单的迁移
- 更简单的备份/恢复
- 更简单的便携性故事
- 更轻松的操作员审查
- 插件模式漂移破坏实例的机会更少

### 3. 在添加自定义模式之前将插件数据范围限定为 Paperclip 对象

许多插件数据自然地挂在现有的 Paperclip 对象上：- 项目工作区插件状态通常应范围为 `project` 或 `project_workspace`
- 问题同步状态范围应为 `issue`
- 指标小部件的范围可能为 `company`、`project` 或 `goal`
- 进程跟踪范围可能为 `project_workspace`、`agent` 或 `run`

在引入自定义表之前，这提供了一个良好的默认键控模型。

### 4.稍后添加可信模块迁移，而不是现在添加任意插件迁移

如果 Paperclip 最终需要扩展拥有的表，我只会允许：

- 值得信赖的第一方软件包
- 可信平台模块
- 可能明确安装了具有固定版本的管理员审查插件

我不会让随机的第三方插件在启动时运行自由格式的架构迁移。

相反，如果有必要，可以稍后添加受控机制。

## 建议的基线扩展表

## 1.`plugins`

实例级安装记录。

建议字段：

- `id`
- `package_name`
- `version`
- `categories`
- `manifest_json`
- `installed_at`
- `status`

## 2.`plugin_config`

实例级插件配置。

建议字段：

- `id`
- `plugin_id`
- `config_json`
- `created_at`
- `updated_at`
- `last_error`

## 3.`plugin_state`

插件的通用键/值状态。

建议字段：

- `id`
- `plugin_id`
- `scope_kind` (`instance | company | project | project_workspace | agent | issue | goal | run`)
- `scope_id` 可为空
- `namespace`
- `state_key`
- `value_json`
- `updated_at`

在允许自定义表之前，这对于许多连接器来说已经足够了。

示例：

- 由 `issue` 键入的线性外部 ID
- GitHub 同步光标由 `project` 键入
- 由 `project_workspace` 键控的文件浏览器首选项
- git 分支元数据由 `project_workspace` 键入
- 处理由`project_workspace`或`run`键入的元数据

## 4.`plugin_jobs`

计划作业和运行跟踪。

建议字段：

- `id`
- `plugin_id`
- `scope_kind` 可为空
- `scope_id` 可为空
- `job_key`
- `status`
- `last_started_at`
- `last_finished_at`
- `last_error`

## 5.`plugin_webhook_deliveries`

如果插件公开网络钩子，则值得存储传递历史记录。

建议字段：

- `id`
- `plugin_id`
- `scope_kind` 可为空
- `scope_id` 可为空
- `endpoint_key`
- `status`
- `received_at`
- `response_code`
- `error`

## 6.也许稍后：`plugin_entities`

如果通用插件状态变得过于有限，请在允许任意插件迁移之前为连接器记录添加结构化、可查询的实体表。

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

这是一个有用的中间立场：- 比不透明的键/值状态更可查询
- 仍然避免让每个插件立即创建自己的关系模式

## 请求的示例如何映射到该模型

|使用案例 |最适合|所需的主机原语 |笔记|
|---|---|---|---|
|文件浏览器|工作区插件 |项目工作区元数据|插件直接拥有文件系统操作|
|终端|工作区插件 |项目工作区元数据|插件直接生成 PTY 会话 |
| Git 工作流程 |工作区插件 |项目工作区元数据|插件直接 shell 到 git |
|线性问题跟踪 |连接器插件 |作业、webhooks、秘密参考、问题同步 API |非常强大的候选插件|
| GitHub 问题追踪 |连接器插件 |工作、webhooks、秘密参考 |非常强大的候选插件|
| Grafana 指标 |连接器插件+控制台小部件|出站 HTTP |可能首先是只读的 |
|子进程/服务器跟踪 |工作区插件 |项目工作区元数据|插件直接管理进程 |
| Stripe 收入追踪 |连接器插件 |秘密参考、预定同步、公司指标 API |强大的候选插件|

# 插件示例

## 工作区文件浏览器

封装理念：`@paperclip/plugin-workspace-files`

该插件允许董事会检查项目工作区、智能体工作区、生成的工件以及与问题相关的文件，而无需放入 shell。它适用于：

- 浏览项目工作空间内的文件
- 调试智能体更改的内容
- 在批准之前审查生成的输出
- 将工作区中的文件附加到问题
- 了解公司的回购布局
- 以本地信任模式检查智能体主工作区

### 用户体验

- 设置页面：`/settings/plugins/workspace-files`
- 主页：`/:companyPrefix/plugins/workspace-files`
- 项目选项卡：`/:companyPrefix/projects/:projectId?tab=files`
- 可选问题选项卡：`/:companyPrefix/issues/:issueId?tab=files`
- 可选智能体选项卡：`/:companyPrefix/agents/:agentId?tab=workspace`

主屏幕和交互：- 插件设置：
  - 选择插件是否默认为`project.primaryWorkspace`
  - 选择哪些项目工作区可见
  - 选择文件写入是允许还是只读
  - 选择隐藏文件是否可见
- 主浏览器页面：
  - 顶部的项目选择器
  - 工作区选择器范围为所选项目的 `workspaces`
  - 左侧的树视图
  - 右侧的文件预览窗格
  - 文件名/路径搜索的搜索框
  - 操作：复制路径、下载文件、附加到问题、打开差异
- 项目选项卡：
  - 直接打开到项目的主工作区
  - 让董事会在所有项目工作区之间切换
  - 显示工作区元数据，例如 `cwd`、`repoUrl` 和 `repoRef`
- 问题选项卡：
  - 解决问题的项目并打开该项目的工作区上下文
  - 显示与问题相关的文件
  - 让董事会将文件从项目工作区提取到问题附件中
  - 显示每个链接文件的路径和上次修改信息
- 智能体选项卡：
  - 显示智能体当前解析的工作空间
  - 如果运行附加到项目，则链接回项目工作区视图
  - 让董事会检查特工当前正在接触的文件

核心工作流程：

- Board 打开一个项目并浏览其主要工作区文件。
- 当项目有多个签出或存储库引用时，板从一个项目工作区切换到另一个项目工作区。
- 委员会打开一个问题，附加从文件浏览器生成的工件，并留下评论。
- Board 打开智能体详细信息页面以检查失败运行背后的确切文件。

### 需要挂钩

推荐的功能和扩展点：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register` 适用于 `project`、`issue` 和 `agent`
- `projects.read`
- `project.workspaces.read`
- 可选`assets.write`
- `activity.log.write`

该插件通过 `ctx.projects` 解析工作空间路径，并直接使用 Node APIs 处理所有文件系统操作（读、写、统计、搜索、列出目录）。

可选事件订阅：

- `events.subscribe(agent.run.started)`
- `events.subscribe(agent.run.finished)`
- `events.subscribe(issue.attachment.created)`

## 工作区终端

封装理念：`@paperclip/plugin-terminal`

该插件为开发板提供了用于项目工作区和智能体工作区的受控终端 UI。它适用于：

- 调试卡住的运行
- 验证环境状态
- 运行有针对性的手动命令
- 观看长时间运行的命令
- 将人工操作员与智能体工作流程配对

### 用户体验

- 设置页面：`/settings/plugins/terminal`
- 主页：`/:companyPrefix/plugins/terminal`
- 项目选项卡：`/:companyPrefix/projects/:projectId?tab=terminal`
- 可选智能体选项卡：`/:companyPrefix/agents/:agentId?tab=terminal`
- 可选运行选项卡：`/:companyPrefix/agents/:agentId/runs/:runId?tab=terminal`

主屏幕和交互：- 插件设置：
  - 允许的 shell 和 shell 策略
  - 命令是只读、自由格式还是列入允许列表
  - 终端在启动前是否需要运营商明确确认
  - 新的终端会话是否默认为项目的主工作区
- 终端主页：
  - 活动终端会话列表
  - 打开新会话的按钮
  - 项目选择器，然后是该项目工作区中的工作区选择器
  - 可选智能体协会
  - 支持输入、调整大小和重新连接的终端面板
  - 控制：中断、终止、清除、保存记录
- 项目终端选项卡：
  - 打开范围已确定为项目主工作区的会话
  - 让开发板在项目配置的工作区之间切换
  - 显示该项目的最新命令和相关进程/服务器状态
- 智能体终端选项卡：
  - 打开一个已经限定在智能体工作区范围内的会话
  - 显示最近的相关运行和命令
- 运行终端选项卡：
  - 让董事会检查特定失败运行周围的环境

核心工作流程：

- Board 针对智能体工作区打开一个终端以重现失败的命令。
- Board 打开项目页面并直接在该项目的主工作区中启动终端。
- 板从终端页面监视长时间运行的开发服务器或测试命令。
- 主板从同一用户界面杀死或中断失控的进程。

### 需要挂钩

推荐的功能和扩展点：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register` 适用于 `project`、`agent` 和 `run`
- `projects.read`
- `project.workspaces.read`
- `activity.log.write`

该插件通过 `ctx.projects` 解析工作区路径，并直接使用 Node PTY 库处理 PTY 会话管理（打开、输入、调整大小、终止、订阅）。

可选事件订阅：

- `events.subscribe(agent.run.started)`
- `events.subscribe(agent.run.failed)`
- `events.subscribe(agent.run.cancelled)`

## Git 工作流程

封装理念：`@paperclip/plugin-git`

该插件围绕问题和工作区添加了存储库感知工作流程工具。它适用于：

- 与问题相关的分支创建
- 快速差异审查
- 提交和工作树可见性
- PR准备
- 将项目的主要工作空间视为规范的回购锚点
- 查看客服人员的工作空间是否干净或肮脏

### 用户体验

- 设置页面：`/settings/plugins/git`
- 主页：`/:companyPrefix/plugins/git`
- 项目选项卡：`/:companyPrefix/projects/:projectId?tab=git`
- 可选问题选项卡：`/:companyPrefix/issues/:issueId?tab=git`
- 可选智能体选项卡：`/:companyPrefix/agents/:agentId?tab=git`

主屏幕和交互：- 插件设置：
  - 分支命名模板
  - 可选的远程提供商令牌秘密参考
  - 写入操作是启用还是只读
  - 插件是否始终使用 `project.primaryWorkspace` 除非选择了不同的项目工作区
- Git 概述页面：
  - 项目选择器和工作区选择器
  - 当前分支
  - 领先/落后状态
  - 脏文件摘要
  - 最近的提交
  - 活动工作树
  - 操作：刷新、创建分支、创建工作树、暂存所有、提交、打开差异
- 项目选项卡：
  - 在项目的主工作区中打开
  - 显示工作区元数据和存储库绑定（`cwd`、`repoUrl`、`repoRef`）
  - 显示该项目工作区的分支、差异和提交历史记录
- 问题选项卡：
  - 解决问题的项目并使用该项目的工作区上下文
  - “从问题创建分支”操作
  - 差异视图范围仅限于项目的选定工作空间
  - 将分支/工作树元数据链接到问题
- 智能体选项卡：
  - 显示智能体的分支、工作树和脏状态
  - 显示该智能体最近生成的提交
  - 如果智能体在项目工作区中工作，则链接回项目 git 选项卡

核心工作流程：

- 董事会根据问题创建一个分支并将其与项目的主要工作区联系起来。
- Board 打开项目页面并查看该项目工作区的差异，而无需离开 Paperclip。
- 董事会在运行后检查差异，无需离开 Paperclip。
- Board 打开工作树列表以了解跨智能体的并行分支。

### 需要挂钩

推荐的功能和扩展点：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register` 适用于 `project`、`issue` 和 `agent`
- `ui.action.register`
- `projects.read`
- `project.workspaces.read`
- 可选`agent.tools.register`（例如`create-branch`、`get-diff`、`get-status`）
- 可选 `events.emit`（例如 `plugin.@paperclip/plugin-git.push-detected`）
- `activity.log.write`

该插件通过 `ctx.projects` 解析工作空间路径，并直接使用 git CLI 或 git 库处理所有 git 操作（状态、差异、日志、分支创建、提交、工作树创建、推送）。

可选事件订阅：

- `events.subscribe(issue.created)`
- `events.subscribe(issue.updated)`
- `events.subscribe(agent.run.finished)`

git 插件可以发出其他插件（例如 GitHub Issues）订阅的 `plugin.@paperclip/plugin-git.push-detected` 事件以进行跨插件协调。

注意：GitHub/GitLab PR 创建可能应该存在于单独的连接器插件中，而不是重载本地 git 插件。

## 线性问题跟踪

包装理念：`@paperclip/plugin-linear`

该插件将 Paperclip 与 Linear 同步工作。它适用于：- 从 Linear 导入积压订单
- 将 Paperclip 问题链接到线性问题
- 同步状态、评论和受让人
- 将公司目标/项目映射到外部产品规划
- 为董事会操作员提供一个查看同步运行状况的单一位置

### 用户体验

- 设置页面：`/settings/plugins/linear`
- 主页：`/:companyPrefix/plugins/linear`
- 控制台小部件：`/:companyPrefix/dashboard`
- 可选问题选项卡：`/:companyPrefix/issues/:issueId?tab=linear`
- 可选项目选项卡：`/:companyPrefix/projects/:projectId?tab=linear`

主屏幕和交互：

- 插件设置：
  - 线性 API 代币秘密参考
  - 工作空间/团队/项目映射
  - Paperclip 和 Linear 之间的状态映射
  - 同步方向：仅导入、仅导出、双向
  - 评论同步切换
- 线性概述页面：
  - 同步健康卡
  - 最近的同步作业
  - 映射项目和团队
  - 未解决的冲突队列
  - 导入团队、项目和问题的操作
- 问题选项卡：
  - 链接的线性问题密钥和 URL
  - 同步状态和上次同步时间
  - 操作：链接现有、在 Linear 中创建、立即重新同步、取消链接
  - 同步评论/状态更改的时间表
- 控制台小部件：
  - 打开同步错误
  - 导入问题与链接问题计数
  - 最近的网络钩子/作业失败

核心工作流程：

- Board 启用该插件，映射 Linear 团队，并将待办事项导入 Paperclip。
- Paperclip 问题状态更改推送至线性，线性评论通过 webhooks 返回。
- 板从插件页面解决映射冲突，而不是默默地漂移状态。

### 需要挂钩

推荐的功能和扩展点：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.dashboardWidget.register`
- `ui.detailTab.register` 为 `issue` 和 `project`
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
- 可选`issues.create`
- 可选`issues.update`
- 可选`issue.comments.create`
- 可选`agent.tools.register`（例如`search-linear-issues`、`get-linear-issue`）
- `activity.log.write`

重要约束：

- webhook 处理应该是幂等的并且具有冲突意识
- 外部 ID 和同步游标属于插件拥有的状态，而不是内联在第一个版本中的核心问题行上

## GitHub 问题跟踪

封装理念：`@paperclip/plugin-github-issues`

该插件将 Paperclip 问题与 GitHub 问题同步，并可选择链接 PR。它适用于：

- 导入回购积压
- 镜像问题状态和评论
- 将 PR 链接到 Paperclip 问题
- 从一个公司内部的角度跟踪跨回购工作
- 通过 Paperclip 任务治理桥接工程工作流程

### 用户体验

- 设置页面：`/settings/plugins/github-issues`
- 主页：`/:companyPrefix/plugins/github-issues`
- 控制台小部件：`/:companyPrefix/dashboard`
- 可选问题选项卡：`/:companyPrefix/issues/:issueId?tab=github`
- 可选项目选项卡：`/:companyPrefix/projects/:projectId?tab=github`

主屏幕和交互：- 插件设置：
  - GitHub App 或 PAT 秘密参考
  - 组织/回购映射
  - 标签/状态映射
  - 是否启用 PR 链接
  - 新的 Paperclip 问题是否应自动创建 GitHub 问题
- GitHub 概述页面：
  - 回购映射列表
  - 同步运行状况和最近的 webhook 事件
  - 导入积压操作
  - 未链接的 GitHub 问题队列
- 问题选项卡：
  - 链接的 GitHub 问题和可选的链接 PR
  - 操作：创建 GitHub 问题、链接现有问题、取消链接、重新同步
  - 评论/状态同步时间线
- 控制台小部件：
  - 与活跃的 Paperclip 问题相关的公开 PR
  - 网络钩子失败
  - 同步延迟指标

核心工作流程：

- 董事会将存储库的 GitHub 问题导入到 Paperclip 中。
- GitHub webhook 更新 Paperclip 中的状态/评论状态。
- PR 链接回 Paperclip 问题，以便董事会可以跟踪交付状态。

### 需要挂钩

推荐的功能和扩展点：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.dashboardWidget.register`
- `ui.detailTab.register` 为 `issue` 和 `project`
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
- 可选`issues.update`
- 可选 `issue.comments.create`
- `activity.log.write`

重要约束：

- 将“本地 git 状态”和“远程 GitHub 问题状态”保留在单独的插件中，即使它们一起工作 - 跨插件事件处理协调

## Grafana 指标

封装理念：`@paperclip/plugin-grafana`

该插件在 Paperclip 内显示外部指标和控制台。它适用于：

- 公司KPI可见性
- 基础设施/事件监控
- 显示工作旁边的部署、流量、延迟或收入图表
- 根据异常指标创建 Paperclip 问题

### 用户体验

- 设置页面：`/settings/plugins/grafana`
- 主页：`/:companyPrefix/plugins/grafana`
- 控制台小部件：`/:companyPrefix/dashboard`
- 可选目标选项卡：`/:companyPrefix/goals/:goalId?tab=metrics`

主屏幕和交互：

- 插件设置：
  - Grafana 基本 URL
  - 服务帐户令牌秘密参考
  - 控制台和面板映射
  - 刷新间隔
  - 可选的警报阈值规则
- 控制台小部件：
  - 主控制台上的一张或多张指标卡
  - 快速趋势视图和上次刷新时间
  - 链接到 Grafana 并链接到完整的 Paperclip 插件页面
- 完整指标页面：
  - 嵌入或智能体的选定控制台面板
  - 公制选择器
  - 时间范围选择器
  - “从异常中创建问题”行动
- 目标选项卡：
  - 与特定目标或项目相关的度量卡

核心工作流程：- 董事会直接在 Paperclip 控制台上看到服务降级或业务 KPI 变动。
- 董事会点击进入完整指标页面以检查相关 Grafana 面板。
- 董事会因违反阈值而创建 Paperclip 问题，并附有指标快照。

### 需要挂钩

推荐的功能和扩展点：

- `instance.settings.register`
- `ui.dashboardWidget.register`
- `ui.page.register`
- `ui.detailTab.register` 为 `goal` 或 `project`
- `jobs.schedule`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- 可选`issues.create`
- 可选`assets.write`
- `activity.log.write`

可选事件订阅：

- `events.subscribe(goal.created)`
- `events.subscribe(project.updated)`

重要约束：

- 首先以只读方式启动
- 不要使 Grafana 警报逻辑成为 Paperclip 核心的一部分；将其保留为附加信号和问题创建

## 子进程/服务器跟踪

封装理念：`@paperclip/plugin-runtime-processes`

该插件跟踪在项目工作区中启动的长期本地进程和开发服务器。它适用于：

- 查看哪个智能体启动了哪个本地服务
- 跟踪端口、运行状况和正常运行时间
- 重新启动失败的开发服务器
- 公开进程状态以及问题和运行状态
- 使本地开发工作流程对董事会可见

### 用户体验

- 设置页面：`/settings/plugins/runtime-processes`
- 主页：`/:companyPrefix/plugins/runtime-processes`
- 控制台小部件：`/:companyPrefix/dashboard`
- 流程详情页：`/:companyPrefix/plugins/runtime-processes/:processId`
- 项目选项卡：`/:companyPrefix/projects/:projectId?tab=processes`
- 可选智能体选项卡：`/:companyPrefix/agents/:agentId?tab=processes`

主屏幕和交互：

- 插件设置：
  - 是否允许手动流程注册
  - 健康检查行为
  - 操作员是否可以停止/重新启动流程
  - 日志保留偏好
- 进程列表页面：
  - 状态表，包含名称、命令、cwd、所有者智能体、端口、正常运行时间和运行状况
  - 运行/退出/崩溃进程的过滤器
  - 操作：检查、停止、重新启动、尾部日志
- 项目选项卡：
  - 将进程列表过滤到项目的工作区
  - 显示每个进程属于哪个工作区
  - 按项目工作空间对流程进行分组
- 流程详情页面：
  - 处理元数据
  - 实时日志尾部
  - 健康检查历史记录
  - 相关问题或运行的链接
- 智能体选项卡：
  - 显示由该智能体启动或分配给该智能体的进程

核心工作流程：

- 智能体启动开发服务器；该插件会检测并跟踪它。
- Board 打开一个项目并立即看到附加到该项目工作区的流程。
- Board 在控制台上看到崩溃的进程，并从插件页面重新启动它。
- 董事会在调试故障时将进程日志附加到问题上。

### 需要挂钩

推荐的功能和扩展点：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.dashboardWidget.register`
- `ui.detailTab.register` 为 `project` 和 `agent`
- `projects.read`
- `project.workspaces.read`
- `plugin.state.read`
- `plugin.state.write`
- `activity.log.write`该插件通过 `ctx.projects` 解析工作空间路径，并直接使用 Node API 处理进程管理（注册、列出、终止、重新启动、读取日志、运行状况探测）。

可选事件订阅：

- `events.subscribe(agent.run.started)`
- `events.subscribe(agent.run.finished)`

## Stripe 收入跟踪

包装理念：`@paperclip/plugin-stripe`

该插件将 Stripe 收入和订阅数据拉入 Paperclip。它适用于：

- 在公司目标旁边显示 MRR 和流失率
- 跟踪试用、转化和失败的付款
- 让董事会将收入变动与正在进行的工作联系起来
- 使未来的财务控制台超越代币成本

### 用户体验

- 设置页面：`/settings/plugins/stripe`
- 主页：`/:companyPrefix/plugins/stripe`
- 控制台小部件：`/:companyPrefix/dashboard`
- 可选的公司/目标指标选项卡（如果这些表面稍后存在）

主屏幕和交互：

- 插件设置：
  - 条纹秘密密钥秘密参考
  - 如果需要的话选择账户
  - 度量定义，例如 MRR 治疗和试验处理
  - 同步间隔
  - webhook 签名秘密参考
- 控制台小部件：
  - MRR卡
  - 活跃订阅
  - 试用到付费的转化
  - 付款失败提醒
- 条纹概述页面：
  - 时间序列图表
  - 最近的客户/订阅活动
  - 网络挂钩健康状况
  - 同步历史记录
  - 操作：从计费异常中创建问题

核心工作流程：

- Board 启用插件并连接 Stripe 帐户。
- Webhooks 和计划协调使插件状态保持最新。
- 收入小部件出现在主控制台上，可以链接到公司目标。
- 失败的付款高峰或流失事件可能会产生 Paperclip 问题以供后续处理。

### 需要挂钩

推荐的功能和扩展点：

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
- 可选`issues.create`
- `activity.log.write`

重要约束：

- 条带数据应保留在 Paperclip 核心中
- 它不应该泄漏到核心预算逻辑中，该逻辑专门针对 V1 中的模型/代币支出

## OpenCode 中值得采用的特定模式

## 采用

- 将 SDK 包与运行时加载器分开
- 确定性的加载顺序和优先级
- 非常小的创作API
- 插件输入/配置/工具的类型化模式
- 作为一流插件扩展点的工具（命名空间，而不是碰撞覆盖）
- 在合理的情况下，内部扩展使用与外部相同的注册形状
- 尽可能将插件加载错误与主机启动隔离
- 明确的面向社区的插件文档和示例模板
- 测试工具和入门模板可降低创作难度
- 热插件生命周期无需重新启动服务器（由进程外工作人员启用）
- 具有多版本主机支持的正式 SDK 版本控制## 适应，而不是复制

- 本地路径加载
- 依赖项自动安装
- 钩突变模型
- 内置覆盖行为
- 广泛的运行时上下文对象

## 避免

- 项目本地任意代码加载
- 启动时对 npm 包的隐式信任
- 插件覆盖核心不变量
- 非沙盒进程内执行作为默认扩展模型

## 建议的推出计划

## 第 0 阶段：加固已经存在的接缝

- 将适配器/存储/秘密/运行日志注册表正式化为“平台模块”
- 尽可能删除临时后备行为
- 记录稳定的注册合同

## 第 1 阶段：首先添加连接器插件

这是价值最高、风险最低的插件类别。

构建：

- 插件清单
- 全局安装/更新生命周期
- 全局插件配置和可选的公司映射存储
- 秘密参考访问
- 类型化域事件订阅
- 预定的工作
- webhook端点
- 活动记录助手
- 插件 UI 包加载、主机桥、`@paperclipai/plugin-sdk/ui`
- 用于页面、选项卡、小部件、侧边栏条目的扩展槽安装
- 从 `instanceConfigSchema` 自动生成的设置表单
- 桥接错误传播 (`PluginBridgeError`)
- 插件提供的智能体工具
- 插件到插件事件（`plugin.<pluginId>.*` 命名空间）
- 事件过滤（服务器端，每个订阅）
- 优雅地关闭并可配置截止日期
- 插件日志记录和健康控制台
- 卸载并保留数据宽限期
- `@paperclipai/plugin-test-harness` 和 `create-paperclip-plugin` 入门模板
- 热插件生命周期（安装、卸载、升级、配置更改，无需重新启动服务器）
- SDK 版本控制，具有多版本主机支持和弃用政策

此阶段将立即涵盖：

- 线性
- GitHub
- 格拉法纳
- 条纹
- 文件浏览器
- 终端
- git工作流程
- 子进程/服务器跟踪

工作区插件不需要额外的主机 API - 它们通过 `ctx.projects` 解析工作区路径并直接处理文件系统、git、PTY 和进程操作。

## 第 2 阶段：考虑更丰富的 UI 和插件打包

仅当第一阶段稳定后：

- 针对不受信任的第三方插件 UI 包的基于 iframe 的隔离
- 签名/验证的插件包
- 插件市场
- 可选的自定义插件存储后端或迁移

## 推荐的架构决策

如果我必须将这份报告分解为一项架构决策，那么它将是：

Paperclip 不应实现“OpenCode 风格的通用进程内挂钩系统”。
Paperclip 应该实现“具有多个信任层的插件平台”：- 用于低级运行时集成的可信平台模块
- 用于实例范围集成和自动化的类型化进程外插件
- 插件贡献的智能体工具（命名空间、功能门控）
- 插件交付的 UI 包通过具有结构化错误传播的类型化桥在主机扩展插槽中呈现
- 用于跨插件协调的插件到插件事件
- 从配置模式自动生成设置 UI
- 核心拥有的不变量，插件可以观察和操作，但不能替换
- 插件可观察性、优雅的生命周期管理和低创作摩擦的测试工具
- 热插件生命周期 — 安装、卸载、升级或配置更改时无需重新启动服务器
- SDK 版本控制，具有多版本主机支持和明确的弃用政策

这样就可以发挥 `opencode` 的可扩展性的优势，而无需导入错误的威胁模型。

## 我将在 Paperclip 中采取的具体后续步骤

1. 编写一个简短的扩展架构 RFC，形式化 `platform modules` 和 `plugins` 之间的区别。
2. 在 `packages/shared` 中引入一个小插件清单类型，并在实例配置中引入一个 `plugins` install/config 部分。
3. 围绕现有活动/实时事件模式构建类型化域事件总线，并具有服务器端事件过滤和用于跨插件事件的 `plugin.*` 命名空间。保持核心不变量不可挂钩。
4. 实现插件 MVP：全局安装/配置、秘密引用、作业、webhooks、插件 UI 包、扩展槽、自动生成的设置表单、桥接错误传播。
5. 添加智能体工具贡献 - 插件注册智能体可以在运行期间调用的命名空间工具。
6. 添加插件可观察性：通过 `ctx.logger` 进行结构化日志记录、健康控制台、内部健康事件。
7. 添加优雅关闭策略和具有保留宽限期的卸载数据生命周期。
8. 发送 `@paperclipai/plugin-test-harness` 和 `create-paperclip-plugin` 入门模板。
9. 实现热插件生命周期 — 安装、卸载、升级和配置更改，无需重新启动服务器。
10. 定义 SDK 版本控制策略 — semver、多版本主机支持、弃用时间表、迁移指南、发布的兼容性矩阵。
11. 构建工作区插件（文件浏览器、终端、git、进程跟踪），用于解析主机的工作区路径并直接处理操作系统级操作。