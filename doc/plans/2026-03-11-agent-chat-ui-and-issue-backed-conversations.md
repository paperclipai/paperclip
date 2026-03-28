# 智能体聊天界面与基于 Issue 的对话

## 背景

`PAP-475` 提出了两个相关问题：

1. 如果 Paperclip 要添加与智能体的聊天界面，应该使用什么 UI 工具包？
2. 聊天功能应如何融入产品，同时不破坏当前以 issue 为中心的模型？

这不仅仅是一个组件库的选择问题。在当前的 Paperclip 中：

- V1 明确指出通信方式仅限于 `tasks + comments only`，没有单独的聊天系统。
- Issue 已经承载了指派、审计追踪、计费代码、项目关联、目标关联和活跃运行关联。
- Issue 详情页面已经支持实时运行流式输出。
- 智能体会话已经通过 `taskKey` 持久化，目前 `taskKey` 会回退到 `issueId`。
- OpenClaw 网关适配器已经支持基于 issue 范围的会话密钥策略。

这意味着最经济实用的路径不是"在 Paperclip 内部添加第二个消息产品"，而是"在我们已有的 issue 和运行原语之上添加更好的对话界面"。

## 代码库中的当前约束

### 持久化工作对象

Paperclip 中的持久化对象是 issue，而不是聊天线程。

- `IssueDetail` 已经将评论、关联运行、实时运行和活动整合到一个时间线中。
- `CommentThread` 已经渲染 markdown 评论并支持回复/重新指派流程。
- `LiveRunWidget` 已经为活跃运行渲染流式的助手/工具/系统输出。

### 会话行为

会话连续性已经是以任务为形态的。

- `heartbeat.ts` 从 `taskKey` 派生 `taskKey`，然后是 `taskId`，最后是 `issueId`。
- `agent_task_sessions` 按公司 + 智能体 + 适配器 + 任务密钥存储会话状态。
- OpenClaw 网关支持 `sessionKeyStrategy=issue|fixed|run`，其中 `issue` 已经很好地匹配了 Paperclip 的心智模型。

这意味着"就这个 issue 与 CEO 聊天"在当前无需发明第二套会话系统，就能自然映射到每个 issue 一个持久会话。

### 计费行为

计费已经具有 issue 感知能力。

- `cost_events` 可以关联到 `issueId`、`projectId`、`goalId` 和 `billingCode`。
- 心跳上下文已经将 issue 关联传播到运行和成本汇总中。

如果聊天脱离 issue 模型，Paperclip 将需要第二套计费方案。这是可以避免的。

## UI 工具包推荐

## 推荐：`assistant-ui`

使用 `assistant-ui` 作为聊天展示层。

为什么它适合 Paperclip：

- 它是一个真正的聊天 UI 工具包，不仅仅是一个 hook。
- 它是可组合的，与 shadcn 风格的原语对齐，这与当前的 UI 技术栈很好地匹配。
- 它明确支持自定义后端，这很重要，因为 Paperclip 通过 issue 评论、心跳和运行流与智能体通信，而不是直接的提供商调用。
- 它能快速提供完善的聊天交互能力：消息列表、编辑器、流式文本、附件、线程功能和面向 markdown 的渲染。

为什么不将"Vercel 的方案"作为首选：

- Vercel AI SDK 目前比早期"仅仅是在 `/api/chat` 上使用 `useChat`"的定位要强大得多。它的传输层很灵活，可以支持自定义协议。
- 但 AI SDK 在这里仍然更适合被理解为传输/运行时协议层，而不是 Paperclip 最佳的终端用户聊天界面。
- Paperclip 不需要 Vercel 来拥有消息状态、持久化或后端契约。Paperclip 已经有自己的 issue、运行和会话模型。

因此，清晰的分工是：

- `assistant-ui` 用于 UI 原语
- Paperclip 自有的运行时/存储用于状态、持久化和传输
- 仅在后续需要其流协议或客户端传输抽象时才可选使用 AI SDK

## 产品方案

### 方案 A：独立聊天对象

创建一个与 issue 无关的新顶级聊天/线程模型。

优点：

- 如果用户需要自由形式的对话，心智模型很清晰
- 容易从 issue 看板中隐藏

缺点：

- 打破了当前 V1 中通信以 issue 为中心的产品决策
- 需要新的持久化、计费、会话、权限、活动和唤醒规则
- 在 issue 旁边创建了第二个"为什么要有这个？"的对象
- 使"找回旧对话"成为一个独立的检索问题

结论：V1 不推荐。

### 方案 B：每次聊天都是一个 issue

将聊天视为 issue 之上的一种 UI 模式。Issue 仍然是持久记录。

优点：

- 符合当前产品规格
- 计费、运行、评论、审批和活动已经可以正常工作
- 会话已经基于 issue 身份恢复
- 适用于所有适配器，包括 OpenClaw，无需新的智能体认证或第二个 API 接口

缺点：

- 某些聊天在看板意义上并不真正是"任务"
- 入职引导和评审对话可能会使正常的 issue 列表变得杂乱

结论：最佳的 V1 基础。

### 方案 C：带隐藏对话 issue 的混合方案

每个对话都由一个 issue 支撑，但允许一种对话风格的 issue 模式，默认从执行看板中隐藏，除非被提升。

优点：

- 保留了以 issue 为中心的后端
- 为入职引导/评审聊天提供了更简洁的用户体验
- 保留了计费和会话的连续性

缺点：

- 需要额外的 UI 规则，可能还需要少量的 schema 或过滤增补
- 如果不加以限制，可能会变成伪装的第二套系统

结论：在基本的基于 issue 的 MVP 之后，很可能是正确的产品形态。

## 推荐的产品模型

### 第一阶段产品决策

在首次实现中，聊天应当基于 issue。

更具体地说：

- 看板为一个 issue 打开聊天界面
- 发送消息就是对该 issue 的评论变更
- 通过现有的 issue 评论流程唤醒已指派的智能体
- 流式输出来自该 issue 现有的实时运行流
- 持久化的助手输出保留为评论和运行历史，而不是额外的对话记录存储

这使 Paperclip 保持了自身的定位：

- 控制平面保持以 issue 为中心
- 聊天是与 issue 工作交互的更好方式，而不是一个新的协作产品

### 入职引导和 CEO 对话

对于入职引导、周回顾和"与 CEO 聊天"，使用对话 issue 而不是全局聊天标签。

建议的形态：

- 创建一个由看板发起的、指派给 CEO 的 issue
- 在 UI 中将其标记为对话风格
- 后续可选择默认从普通 issue 看板中隐藏
- 保持该 issue 上的所有成本/运行/会话关联

这同时解决了几个问题：

- 不需要单独的 API 密钥或直接的提供商接入
- 使用相同的 CEO 适配器
- 通过正常的 issue 历史恢复旧对话
- CEO 仍然可以从对话中创建或更新真正的子 issue

## 会话模型

### V1

每个 issue 使用一个持久对话会话。

这已经匹配了当前行为：

- 适配器任务会话基于 `taskKey` 持久化
- `taskKey` 已经回退到 `issueId`
- OpenClaw 已经支持基于 issue 范围的会话密钥

这意味着"稍后恢复 CEO 对话"只需重新打开同一个 issue 并在同一个 issue 上唤醒同一个智能体即可工作。

### 暂时不要添加的功能

在第一阶段不要添加每个 issue 多线程聊天。

如果 Paperclip 后续需要在一个 issue 上进行多个并行线程，那时再添加显式的对话身份并派生：

- `taskKey = issue:<issueId>:conversation:<conversationId>`
- OpenClaw `sessionKey = paperclip:conversation:<conversationId>`

在该需求真正出现之前，一个 issue == 一个持久对话是更简单更好的规则。

## 计费模型

聊天不应发明独立的计费流水线。

所有聊天成本应继续通过 issue 汇总：

- `cost_events.issueId`
- 通过现有关系进行项目和目标汇总
- 存在 `billingCode` 时使用 issue 的 `billingCode`

如果一个对话重要到需要存在，那它就重要到应该有持久的、基于 issue 的审计和成本追踪。

这是临时性自由形式聊天不应成为默认方式的另一个原因。

## UI 架构

### 推荐的技术栈

1. 保持 Paperclip 作为消息历史和运行状态的唯一真实来源。
2. 添加 `assistant-ui` 作为渲染/编辑器层。
3. 构建一个 Paperclip 运行时适配器来映射：
   - issue 评论 -> 用户/助手消息
   - 实时运行增量 -> 流式助手消息
   - issue 附件 -> 聊天附件
4. 尽可能保留当前的 markdown 渲染和代码块支持。

### 交互流程

1. 看板以"聊天"模式打开 issue 详情。
2. 现有评论历史被映射为聊天消息。
3. 当看板发送消息时：
   - `POST /api/issues/{id}/comments`
   - 如果用户体验需要"发送并替换当前响应"，可选择中断当前活跃运行
4. 现有的 issue 评论唤醒逻辑唤醒被指派者。
5. 现有的 `/issues/{id}/live-runs` 和 `/issues/{id}/active-run` 数据源驱动流式输出。
6. 当运行完成时，持久状态像现在一样保留在评论/运行/活动中。

### 为什么这适合当前代码

Paperclip 已经拥有大部分后端组件：

- issue 评论
- 运行时间线
- 运行日志和事件流
- markdown 渲染
- 附件支持
- 评论时唤醒被指派者

缺少的部分主要是展示层和映射层，而不是新的后端领域。

## 智能体范围

不要以"与每个智能体聊天"的形式发布此功能。

从更窄的范围开始：

- 与 CEO 的入职引导聊天
- 与 CEO 的工作流/评审聊天
- 后续可能扩展到选定的高管角色

原因：

- 防止该功能变成第二个收件箱/聊天产品
- 在早期限制权限和用户体验问题
- 符合已表述的产品需求

如果后续与其他智能体的直接聊天变得有用，同样基于 issue 的模式可以干净地扩展。

## 推荐的交付阶段

### 第一阶段：在现有 issue 上添加聊天 UI

- 在 issue 详情页添加聊天展示模式
- 使用 `assistant-ui`
- 将评论 + 实时运行映射到聊天界面
- 无 schema 变更
- 无新 API 接口

这是杠杆效率最高的步骤，因为它在产品模型扩展之前测试用户体验是否真正有用。

### 第二阶段：为 CEO 聊天创建对话风格的 issue

- 添加轻量级的对话分类
- 支持从入职引导和工作流入口创建 CEO 对话 issue
- 可选择默认从普通积压/看板视图中隐藏这些 issue

最小化实现可以是一个标签或 issue 元数据标志。如果后续变得足够重要，再将其提升为一等 issue 子类型。

### 第三阶段：仅在需要时进行提升和线程拆分

仅在确实有需求时：

- 允许将对话提升为正式的任务 issue
- 允许每个 issue 有多个线程，带有显式的对话身份

这应该由需求驱动，而不是预先设计。

## 明确的推荐

如果问题是"我们应该用什么？"，答案是：

- 使用 `assistant-ui` 作为聊天 UI
- 不要将原始的 Vercel AI SDK UI hooks 作为主要的产品方案
- 在 V1 中保持聊天基于 issue
- 使用当前的 issue 评论 + 运行 + 会话 + 计费模型，而不是发明一个并行的聊天子系统

如果问题是"我们应该如何看待 Paperclip 中的聊天？"，答案是：

- 聊天是与基于 issue 的智能体工作交互的一种模式
- 不是一个独立的产品竖井
- 不是停止将工作、成本和会话历史追溯到 issue 的借口

## 实施说明

### 直接实施目标

最具防御性的首次构建是：

- 在 issue 详情页添加聊天标签或以聊天为中心的布局
- 以该 issue 当前指派的智能体作为后端
- 在现有评论和实时运行事件之上使用 `assistant-ui` 原语

### 推迟到确有必要时再做

- 独立的全局聊天对象
- 单个 issue 内的多线程聊天
- 与组织中每个智能体聊天
- 消息历史的第二持久化层
- 聊天的单独成本追踪

## 参考资料

- V1 通信模型：`doc/SPEC-implementation.md`
- 当前 issue/评论/运行 UI：`ui/src/pages/IssueDetail.tsx`、`ui/src/components/CommentThread.tsx`、`ui/src/components/LiveRunWidget.tsx`
- 会话持久化和任务密钥派生：`server/src/services/heartbeat.ts`、`packages/db/src/schema/agent_task_sessions.ts`
- OpenClaw 会话路由：`packages/adapters/openclaw-gateway/README.md`
- assistant-ui 文档：<https://www.assistant-ui.com/docs>
- assistant-ui 代码库：<https://github.com/assistant-ui/assistant-ui>
- AI SDK 传输文档：<https://ai-sdk.dev/docs/ai-sdk-ui/transport>
