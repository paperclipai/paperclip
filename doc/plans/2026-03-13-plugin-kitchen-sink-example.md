# 厨房水槽插件计划

## 目标

添加一个新的第一方示例插件 `Kitchen Sink (Example)`，在一个地方演示当前已实现的每个 Paperclip 插件 API 表面。

此插件旨在：

- 为贡献者提供活的参考实现
- 为插件运行时提供手动测试工具
- 可发现地展示插件今天实际能做什么

它不旨在成为打磨的最终用户产品插件。

## 为什么

当前插件系统有真实的 API 表面，但分散在：

- SDK 文档
- SDK 类型
- 插件规格散文
- 两个各自只展示窄范围切片的示例插件

这使得难以回答基本问题，如：

- 插件能渲染什么？
- 插件 worker 实际能做什么？
- 哪些界面是真实的，哪些是愿景性的？
- 在此仓库中新插件应如何结构化？

厨房水槽插件应通过示例回答这些问题。

## 成功标准

如果贡献者可以安装它并在不先阅读 SDK 的情况下，从 Paperclip 内部发现和体验当前插件运行时的表面区域，则该插件是成功的。

具体而言：

- 它从捆绑示例列表安装
- 它为每个已实现的 worker API 表面至少暴露一个演示
- 它为每个宿主挂载的 UI 表面至少暴露一个演示
- 它清楚标记仅本地 / 仅受信的演示
- 它对本地开发默认足够安全
- 它兼作插件运行时变更的回归工具

## 约束

- 保持为实例安装，而非公司安装。
- 视为受信/本地示例插件。
- 不依赖云安全运行时假设。
- 避免破坏性默认值。
- 避免不可逆变更，除非它们被清楚标记且易于撤销。

## 本计划的事实来源

本计划基于当前已实现的 SDK/类型/运行时，而不仅是长期规格。

主要引用：

- `packages/plugins/sdk/README.md`
- `packages/plugins/sdk/src/types.ts`
- `packages/plugins/sdk/src/ui/types.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/types/plugin.ts`

## 当前表面清单

### 需要演示的 Worker/运行时 API

这些是 SDK 当前暴露的具体 `ctx` 客户端：

- `ctx.config`
- `ctx.events`
- `ctx.jobs`
- `ctx.launchers`
- `ctx.http`
- `ctx.secrets`
- `ctx.assets`
- `ctx.activity`
- `ctx.state`
- `ctx.entities`
- `ctx.projects`
- `ctx.companies`
- `ctx.issues`
- `ctx.agents`
- `ctx.goals`
- `ctx.data`
- `ctx.actions`
- `ctx.streams`
- `ctx.tools`
- `ctx.metrics`
- `ctx.logger`

### 需要演示的 UI 表面

SDK 中定义的表面：

- `page`
- `settingsPage`
- `dashboardWidget`
- `sidebar`
- `sidebarPanel`
- `detailTab`
- `taskDetailView`
- `projectSidebarItem`
- `toolbarButton`
- `contextMenuItem`
- `commentAnnotation`
- `commentContextMenuItem`

### 当前宿主支持状况

已确认或强烈表明在当前应用中已挂载的：

- `page`
- `settingsPage`
- `dashboardWidget`
- `detailTab`
- `projectSidebarItem`
- 评论表面
- 启动器基础设施

在声称完整演示覆盖前需要显式验证的：

- `sidebar`
- `sidebarPanel`
- `taskDetailView`
- `toolbarButton` 作为直接插槽，区别于启动器放置
- `contextMenuItem` 作为直接插槽，区别于评论菜单和启动器放置

实现应在这些项上保留一个小的验证检查清单，然后才能称该插件为"完整"。

## 插件概念

插件应命名为：

- 显示名称：`Kitchen Sink (Example)`
- 包名：`@paperclipai/plugin-kitchen-sink-example`
- 插件 id：`paperclip.kitchen-sink-example` 或 `paperclip-kitchen-sink-example`

建议：使用 `paperclip-kitchen-sink-example` 以匹配当前仓库内示例的命名风格。

分类组合：

- `ui`
- `automation`
- `workspace`
- `connector`

这是有意宽泛的，因为目的是覆盖面。

## UX 形态

插件应有一个主要的全页面演示控制台加上其他表面上的小型卫星。

### 1. 插件页面

主要路由：插件 `page` 表面应是所有演示的中央仪表盘。

推荐的页面部分：

- `概览`
  - 此插件演示什么
  - 当前授予的能力
  - 当前宿主上下文
- `UI 表面`
  - 解释每个其他表面应出现在哪里的链接
- `数据 + 操作`
  - 用于桥接驱动的 worker 演示的按钮和表单
- `事件 + 流`
  - 发送事件
  - 观察事件日志
  - 流式演示输出
- `Paperclip 领域 API`
  - 公司
  - 项目/工作区
  - 任务
  - 目标
  - 智能体
- `本地工作区 + 进程`
  - 文件列表
  - 文件读/写暂存区
  - 子进程演示
- `任务 + Webhook + 工具`
  - 任务状态
  - webhook URL 和最近的投递
  - 声明的工具
- `状态 + 实体 + 资源`
  - 范围化状态编辑器
  - 插件实体检查器
  - 上传/生成的资源演示
- `可观测性`
  - 已写入的指标
  - 活动日志样本
  - 最新 worker 日志

### 2. 仪表盘小部件

主仪表盘上的紧凑小部件应显示：

- 插件健康状况
- 已体验的演示数量
- 最近的事件/流活动
- 到完整插件页面的快捷方式

### 3. 项目侧边栏项

在每个项目下添加一个 `Kitchen Sink` 链接，深层链接到项目范围的插件标签页。

### 4. 详情标签页

使用详情标签页在以下实体上下文中演示渲染：

- `project`
- `issue`
- `agent`
- `goal`

每个标签页应显示：

- 它接收到的宿主上下文
- 通过 worker 桥接获取的相关实体
- 一个范围限定于该实体的小操作

### 5. 评论表面

使用任务评论演示来证明评论特定的扩展点：

- `commentAnnotation`
  - 在每条评论下渲染解析的元数据
  - 显示评论 id、任务 id 和一个小的衍生状态
- `commentContextMenuItem`
  - 添加一个菜单操作如 `复制上下文到 Kitchen Sink`
  - 操作写入一个插件实体或状态记录供后续检查

### 6. 设置页面

自定义 `settingsPage` 应有意保持简单和操作性：

- `关于`
- `危险 / 信任模型`
- 演示开关
- 本地进程默认值
- 工作区暂存路径行为
- 密钥引用输入
- 事件/任务/webhook 示例配置

此插件还应通过写入健康、日志和指标来保持通用插件设置 `Status` 标签页的有用性。

## 功能矩阵

每个已实现的 worker API 应有一个可见的演示。

### `ctx.config`

演示：

- 读取实时配置
- 显示配置 JSON
- 在可能的情况下不重启即响应配置变更

### `ctx.events`

演示：

- 发送一个插件事件
- 订阅插件事件
- 订阅一个核心 Paperclip 事件如 `issue.created`
- 在时间线中显示最近接收的事件

### `ctx.jobs`

演示：

- 一个调度的心跳式演示任务
- 如果宿主支持手动任务触发，从 UI 提供一个手动运行按钮
- 显示上次运行结果和时间戳

### `ctx.launchers`

演示：

- 在清单中声明启动器
- 可选地从 worker 注册一个运行时启动器
- 在插件页面显示启动器元数据

### `ctx.http`

演示：

- 向一个安全端点发起简单的出站 GET 请求
- 显示状态码、延迟和 JSON 结果

建议：默认使用 Paperclip 本地端点或稳定的公共回显端点以避免不稳定的文档。

### `ctx.secrets`

演示：

- 操作者在配置中输入密钥引用
- 插件按需解析
- UI 仅显示掩码后的结果长度/成功状态，永不显示原始密钥

### `ctx.assets`

演示：

- 从 UI 生成文本资源
- 可选上传一个小 JSON blob 或截图式文本文件
- 显示返回的资源 URL

### `ctx.activity`

演示：

- 按钮写入一条针对当前公司/实体的插件活动日志条目

### `ctx.state`

演示：

- 实例范围状态
- 公司范围状态
- 项目范围状态
- 任务范围状态
- 删除/重置控制

在插件页面使用小型状态检查器/编辑器。

### `ctx.entities`

演示：

- 创建插件拥有的示例记录
- 列出/过滤它们
- 展示一个现实用例如"已复制的评论"或"演示同步记录"

### `ctx.projects`

演示：

- 列出项目
- 列出项目工作区
- 解析主工作区
- 解析任务的工作区

### `ctx.companies`

演示：

- 列出公司并显示当前选择的公司

### `ctx.issues`

演示：

- 列出当前公司的任务
- 创建任务
- 更新任务状态/标题
- 列出评论
- 创建评论

### `ctx.agents`

演示：

- 列出智能体
- 用测试 prompt 调用一个智能体
- 在安全的情况下暂停/恢复

智能体变更控制应在显式警告后面。

### `ctx.agents.sessions`

演示：

- 创建智能体聊天会话
- 发送消息
- 将事件流式传输回 UI
- 关闭会话

这是插件页面上最佳"哇"演示的有力候选。

### `ctx.goals`

演示：

- 列出目标
- 创建目标
- 更新状态/标题

### `ctx.data`

在整个插件中用于所有读取侧桥接演示。

### `ctx.actions`

在整个插件中用于所有变更侧桥接演示。

### `ctx.streams`

演示：

- 实时事件日志流
- 来自智能体会话中继的 token 式流
- 长时运行操作的伪进度流

### `ctx.tools`

演示：

- 声明 2-3 个简单的智能体工具
- 工具 1：回显/诊断
- 工具 2：项目/工作区摘要
- 工具 3：创建任务或写入插件状态

插件页面应列出声明的工具并显示示例输入负载。

### `ctx.metrics`

演示：

- 在每个主要演示操作上写入一个样本指标
- 在插件页面展示一个小的最近指标表

### `ctx.logger`

演示：

- 每个操作记录结构化条目
- 插件设置 `Status` 页面随后兼作日志查看器

## 本地工作区和进程演示

插件 SDK 有意将文件/进程操作留给插件本身，一旦它有了工作区元数据。

厨房水槽插件应明确演示这一点。

### 工作区演示

- 列出所选工作区的文件
- 读取一个文件
- 写入一个插件拥有的暂存文件
- 如果可用，可选使用 `rg` 搜索文件

### 进程演示

- 运行一个短命命令如 `pwd`、`ls` 或 `git status`
- 将 stdout/stderr 流式传输回 UI
- 显示退出码和时间

重要安全措施：

- 默认命令必须是只读的
- v1 中不从任意自由形式输入进行 shell 插值
- 提供一个精选命令列表或一个强验证的命令表单
- 清楚标记此区域为仅本地和仅受信

## 提议的清单覆盖

插件应旨在声明：

- `page`
- `settingsPage`
- `dashboardWidget`
- `detailTab` 用于 `project`、`issue`、`agent`、`goal`
- `projectSidebarItem`
- `commentAnnotation`
- `commentContextMenuItem`

然后，在宿主验证后，如果支持则添加：

- `sidebar`
- `sidebarPanel`
- `taskDetailView`
- `toolbarButton`
- `contextMenuItem`

它还应声明一个或多个 `ui.launchers` 条目以独立于插槽渲染来体验启动器行为。

## 提议的包布局

新包：

- `packages/plugins/examples/plugin-kitchen-sink-example/`

预期文件：

- `package.json`
- `README.md`
- `tsconfig.json`
- `src/index.ts`
- `src/manifest.ts`
- `src/worker.ts`
- `src/ui/index.tsx`
- `src/ui/components/...`
- `src/ui/hooks/...`
- `src/lib/...`
- 可选的 `scripts/build-ui.mjs`（如果 UI 打包需要 esbuild）

## 提议的内部架构

### Worker 模块

推荐拆分：

- `src/worker.ts`
  - 插件定义和连接
- `src/worker/data.ts`
  - `ctx.data.register(...)`
- `src/worker/actions.ts`
  - `ctx.actions.register(...)`
- `src/worker/events.ts`
  - 事件订阅和事件日志缓冲区
- `src/worker/jobs.ts`
  - 调度任务处理器
- `src/worker/tools.ts`
  - 工具声明和处理器
- `src/worker/local-runtime.ts`
  - 文件/进程演示
- `src/worker/demo-store.ts`
  - 状态/实体/资源/指标的辅助工具

### UI 模块

推荐拆分：

- `src/ui/index.tsx`
  - 导出的插槽组件
- `src/ui/page/KitchenSinkPage.tsx`
- `src/ui/settings/KitchenSinkSettingsPage.tsx`
- `src/ui/widgets/KitchenSinkDashboardWidget.tsx`
- `src/ui/tabs/ProjectKitchenSinkTab.tsx`
- `src/ui/tabs/IssueKitchenSinkTab.tsx`
- `src/ui/tabs/AgentKitchenSinkTab.tsx`
- `src/ui/tabs/GoalKitchenSinkTab.tsx`
- `src/ui/comments/KitchenSinkCommentAnnotation.tsx`
- `src/ui/comments/KitchenSinkCommentMenuItem.tsx`
- `src/ui/shared/...`

## 配置架构

插件应有一个实质性但可理解的 `instanceConfigSchema`。

推荐的配置字段：

- `enableDangerousDemos`
- `enableWorkspaceDemos`
- `enableProcessDemos`
- `showSidebarEntry`
- `showSidebarPanel`
- `showProjectSidebarItem`
- `showCommentAnnotation`
- `showCommentContextMenuItem`
- `showToolbarLauncher`
- `defaultDemoCompanyId` 可选
- `secretRefExample`
- `httpDemoUrl`
- `processAllowedCommands`
- `workspaceScratchSubdir`

默认值应保持高风险行为关闭。

## 安全默认值

默认姿态：

- UI 和只读演示开启
- 变更领域演示开启但明确标记
- 进程演示默认关闭
- 默认无任意 shell 输入
- 永不渲染原始密钥

## 分阶段构建计划

### 第一阶段：核心插件骨架

- 脚手架包
- 添加清单、worker、UI 入口点
- 添加 README
- 使其出现在捆绑示例列表中

### 第二阶段：核心已确认 UI 表面

- 插件页面
- 设置页面
- 仪表盘小部件
- 项目侧边栏项
- 详情标签页

### 第三阶段：核心 worker API

- config
- state
- entities
- companies/projects/issues/goals
- data/actions
- metrics/logger/activity

### 第四阶段：实时和自动化 API

- streams
- events
- jobs
- webhooks
- 智能体会话
- tools

### 第五阶段：本地受信运行时演示

- 工作区文件演示
- 子进程演示
- 由配置保护

### 第六阶段：次要 UI 表面

- 评论注解
- 评论上下文菜单项
- 启动器

### 第七阶段：仅验证的表面

验证当前宿主是否真正挂载了：

- `sidebar`
- `sidebarPanel`
- `taskDetailView`
- 直接插槽 `toolbarButton`
- 直接插槽 `contextMenuItem`

如果已挂载，添加演示。
如果未挂载，将其记录为 SDK 定义但宿主待实现。

## 文档交付物

插件应附带一个 README，包含：

- 它演示了什么
- 哪些表面是仅本地的
- 如何安装
- 每个 UI 表面应出现在哪里
- 从演示卡片到 SDK API 的映射

它还应从插件文档中被引用为"全面参考插件"。

## 测试与验证

最低验证：

- 包类型检查/构建
- 从捆绑示例列表安装
- 页面加载
- 小部件显示
- 项目标签页显示
- 评论表面渲染
- 设置页面加载
- 关键操作成功

推荐的手动检查清单：

- 从插件创建任务
- 从插件创建目标
- 发送并接收插件事件
- 流式操作输出
- 打开智能体会话并接收流式回复
- 上传一个资源
- 写入插件活动日志
- 运行一个安全的本地进程演示

## 开放问题

1. 进程演示在第一轮中是否应保持仅精选命令？
   建议：是的。

2. 插件是否应自动创建临时的"厨房水槽演示"任务/目标？
   建议：不。使创建显式化。

3. 我们是否应在 UI 中暴露不受支持但已定义类型的表面，即使宿主挂载未连接？
   建议：是的，但标记为 `SDK 已定义 / 宿主验证待完成`。

4. 智能体变更演示是否应默认包含暂停/恢复？
   建议：可能是的，但要在警告块后面。

5. 此插件是否应在后续被视为 CI 中支持的回归工具？
   建议：是的。长期来看，这应该是插件运行时的烟雾测试包。

## 推荐的下一步

如果此计划看起来正确，下一个实现轮次应仅从以下开始构建：

- 包骨架
- 页面
- 设置页面
- 仪表盘小部件
- 一个项目详情标签页
- 一个任务详情标签页
- 基本的 worker/action/data/state/event 脚手架

这足以在填充每个演示表面之前锁定架构。
