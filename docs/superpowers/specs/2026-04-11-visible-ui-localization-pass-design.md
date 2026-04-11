# Paperclip 可见 UI 中文收口设计

## 背景

当前 `zh-enterprise` 已经具备中文运行时基础，但最近一轮浏览器巡检表明，核心产品面仍有大量残留英文，主要集中在：

- 全局壳层与共享控件（跳转链接、命令面板、相对时间、列选择器、筛选项）
- 页面级设置与管理页（公司设置、技能、插件、适配器、心跳）
- 列表页与工作流页的共享标签（智能体、审批、活动、任务/收件箱）

问题不在“有没有中文能力”，而在**残留英文仍然散落在页面组件、共享组件、formatter 与 aria/title 提示里**。如果继续逐页硬改，后续跟随 `paperclipai/paperclip` 上游同步时，会不断重复处理同一类文案冲突。

## 目标

1. 清理当前本地核心产品面的可见残留英文，使主要工作流达到“第一眼基本全中文”。
2. 保持与上游页面结构尽量接近，优先收口文案出口，不重做页面骨架。
3. 统一关键术语，避免同一概念在不同页面出现不同中文。
4. 将本轮改动尽量压缩在共享 copy/helper/formatter 层，降低未来跟进 upstream 的冲突面。

## 非目标

1. 不把本轮扩大成全站完整 i18n 架构重构。
2. 不迁移全部剩余页面到全新的 key 体系。
3. 不翻译用户输入的数据、模型名、技能名、包名、插件技术标识、仓库名。
4. 不改动业务逻辑、权限逻辑、数据结构或路由结构。

## 方案选型

本轮采用 **方案 B：共享文案收口**。

### 为什么不用方案 A

方案 A 逐页硬改虽然快，但会继续让英文/中文散落在页面内部。后续只要上游改同一页面结构，就需要重新人工比对。

### 为什么暂时不用方案 C

方案 C（把这一批页面进一步统一进更完整的字典 key 体系）长期最整齐，但当前代码库已经同时存在：

- `LocaleContext + t(key)`
- `getXxxCopy(locale)` helper
- 页面内少量硬编码文案

如果本轮直接做 C，会把问题从“清掉可见英文”扩大为“统一三套文案组织方式”，diff 面和验证链路都会显著变大，不利于当前阶段与 upstream 保持低冲突同步。

### 选定策略

本轮使用共享收口策略：

- **可复用的共享词、状态词、相对时间、无障碍提示，优先进入 helper / formatter**
- **页面域文案，优先补到已有 page-level copy helper，必要时新增轻量 helper**
- **页面组件尽量消费 copy，而不是新增更多 `locale === "zh-CN"` 分支**

## 范围边界

### 纳入本轮

1. 全局壳层
   - 跳转链接（如 `Skip to Main Content`）
   - 命令面板相关文案
   - 全局导航与共享按钮
   - 相对时间文案（如 `2h ago`）
   - aria/title 等实际会暴露给用户的辅助提示

2. 共享组件与格式化层
   - 任务/收件箱列选择器
   - 活动流动作描述
   - 列表筛选标签
   - 空状态、计数文案、状态标签

3. 页面级核心路由
   - 公司设置
   - 技能
   - 智能体
   - 审批
   - 活动
   - 实例设置：通用、心跳、插件、适配器
   - 任务 / 收件箱 中共用的列与共享词

### 不纳入本轮

1. 用户自定义内容与业务数据
2. 模型名、技能名、插件包名、适配器技术标识
3. 示例代码、日志原文、诊断原文
4. 未被当前核心产品面覆盖的大范围 i18n 体系迁移

## 术语策略

本轮统一采用“以中文为主，只保留品牌名/模型名/技能名等专有名词”的策略。

关键术语：

- Agent → **智能体**
- Plugin → **插件**
- Adapter → **适配器**
- Approval → **审批**
- Heartbeat → **心跳**
- Columns → **列**
- Filters → **筛选**
- Archive → **归档**
- Group → **分组**

若某个术语已在既有 helper 中形成稳定表达，本轮以**现有中文表达统一收口**为先，不重新发明多套同义词。

## 实现设计

### 1. 全局壳层收口

处理所有跨页面重复出现的残留英文，优先修改共享出口：

- `App` 或路由壳层中的跳转辅助文案
- 命令面板占位文案与提示文案
- 导航、页签、全局按钮、共享空状态
- 相对时间显示函数与活动时间格式

原则：

- 不在每个页面单独翻译同一个词
- 共享词必须有单一出口

### 2. 页面域 copy/helper 收口

对英文残留最集中的页面，按“页面域 copy”做轻量集中：

- `CompanySettings`
- `CompanySkills`
- `InstanceSettings`（心跳）
- `PluginManager` / `PluginSettings`
- `AdapterManager`
- `Agents`
- `Approvals`

处理方式：

- 若页面已有 locale helper，继续补强该 helper
- 若页面尚未有 helper，但文案量较大，则新增轻量 `getXxxCopy(locale)` 或类似 formatter
- 页面组件内尽量只读取 copy，不新增大片 `isZh` 分支

### 3. 共享组件与 formatter 收口

以下内容进入共享组件或 formatter 层，避免页面重复定义：

- `IssueColumns` 中的列名、列描述、重置默认项
- 活动流动词、实体类型名、空状态
- 审批/智能体页的标签页、筛选项、计数文案
- 心跳页中的启停、状态、统计摘要、确认提示
- 插件/适配器页的设置、状态、说明块与运行时诊断标题

### 4. 边界控制

本轮禁止以下做法：

- 不为单个页面单独发明一套新的 locale 机制
- 不把简单文案问题升级成通用业务层改造
- 不对上游页面结构做无关重排
- 不因为汉化而修改接口、数据模型或状态流

## 受影响的主要文件面

本轮大概率会涉及以下文件或同类文件：

- `ui/src/App.tsx`
- `ui/src/lib/shell-copy.ts`
- `ui/src/lib/activity-format.ts`
- `ui/src/components/IssueColumns.tsx`
- `ui/src/pages/CompanySettings.tsx`
- `ui/src/pages/CompanySkills.tsx`
- `ui/src/pages/Agents.tsx`
- `ui/src/pages/Approvals.tsx`
- `ui/src/pages/InstanceGeneralSettings.tsx`
- `ui/src/pages/InstanceSettings.tsx`
- `ui/src/pages/PluginManager.tsx`
- `ui/src/pages/PluginSettings.tsx`
- `ui/src/pages/AdapterManager.tsx`

如果浏览器复查时发现共享词仍从别的 helper 泄漏，再补充到对应共享出口，而不是回到页面散改。

## 数据流与调用方式

1. 页面从 `LocaleContext` 取得 locale。
2. 页面或组件读取共享 copy/helper/formatter。
3. helper 根据 locale 返回统一中文或英文表达。
4. 页面只负责渲染，不承担术语翻译和句式拼接职责。

目标是让**页面从“文案生产者”退回“文案消费者”**。

## 错误处理与回退

1. 若某个页面已有明确的共享 copy 入口，优先复用，不新增第二出口。
2. 若某个字符串实际属于用户数据或插件原始元数据，则保留原文，不强翻。
3. 若某个诊断字段混合技术含义与用户提示，优先只翻用户可理解的标签，保留技术值。
4. 若相对时间或状态词已有现成 formatter，则统一修改 formatter，不在调用点拼接中文。

## 验收标准

### 浏览器结果

以下核心路由在复查时，不应再出现明显残留英文 UI：

- `/CMP/company/settings`
- `/CMP/skills`
- `/CMP/issues`
- `/CMP/inbox/mine`
- `/CMP/agents/all`
- `/CMP/approvals/pending`
- `/CMP/activity`
- `/instance/settings/general`
- `/instance/settings/heartbeats`
- `/instance/settings/plugins`
- `/instance/settings/adapters`

### 共享结果

以下共享残留应被收口：

- `Skip to Main Content`
- `Command Palette`
- `Search for a command to run...`
- `2h ago / 10m ago`
- `Columns / Filters / Group / Archive / Pending / All`

### 代码结果

1. 页面级硬编码英文显著减少。
2. 新增或补强的 helper / formatter 可以复用。
3. 不引入新的大面积页面级 `isZh` 分支。
4. 保持现有页面结构与 upstream 尽量接近。

## 验证方案

1. 运行仓库现有相关检查，至少覆盖本轮影响到的 UI 侧校验。
2. 重新做浏览器抽查，核对核心页面是否仍有明显英文漏网。
3. 若抽查发现共享词仍有残留，优先回溯到共享出口修复。

## 风险与控制

### 风险 1：同义词不统一

例如“Agent / 智能体 / Agent（智能体）”混用。

控制方式：

- 先锁定术语表
- 统一由 helper 输出，不在页面局部随意翻译

### 风险 2：误翻技术标识

例如技能名、插件包名、模型名被误当 UI 文案翻译。

控制方式：

- 严格区分“展示标签”与“技术值”
- 原始值保留，标签中文化

### 风险 3：为了汉化破坏 upstream 结构

控制方式：

- 优先改 helper / formatter
- 页面结构改动最小化
- 不把本轮升级成 i18n 架构重写

## 结论

本轮最合适的工程化路线是：

> **用共享文案收口的方式，彻底清理当前核心产品面的残留英文，同时把改动尽量压缩在 helper / formatter / 少量页面域 copy 层。**

这样既能满足“这轮看起来彻底”，又能尽量保持未来跟随上游主版本同步时的低冲突特性。
