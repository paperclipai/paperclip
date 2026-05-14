# 记忆系统全景（Memory Landscape）

日期：2026-03-17

本文档汇总了任务 `PAP-530` 中引用的记忆系统，并提炼出对 Paperclip 有价值的设计模式。

## Paperclip 需要从本次调研中获取什么

Paperclip 并不打算成为一个单一的、强约定的记忆引擎（Memory Engine）。更有价值的目标是构建一个控制面记忆层（Control-plane Memory Surface），它应该：

- 作用域限定在公司级别
- 允许每家公司选择默认的记忆提供者（Memory Provider）
- 允许特定的 Agent 覆盖该默认值
- 保留对 Paperclip 运行记录（Run）、议题（Issue）、评论（Comment）和文档（Document）的溯源能力
- 以与控制面其他工作相同的方式，记录与记忆相关的成本和延迟
- 支持由插件（Plugin）提供的提供者，而不仅仅是内置的

问题不在于"哪个记忆项目会胜出？"，而在于"Paperclip 需要的最小契约是什么，才能同时适配多个差异巨大的记忆系统，同时不抹平它们各自有用的区别？"

## 快速分类

### 托管记忆 API（Hosted Memory APIs）

- `mem0`
- `AWS Bedrock AgentCore Memory`
- `supermemory`
- `Memori`

这些系统优化的是简单的应用集成体验：发送对话/内容加上一个身份标识（Identity），之后查询相关的记忆或用户上下文（User Context）。

### 以 Agent 为中心的记忆框架 / 记忆操作系统

- `MemOS`
- `memU`
- `EverMemOS`
- `OpenViking`

这些系统将记忆视为 Agent 的运行时子系统（Runtime Subsystem），而非仅仅是搜索索引。它们通常会增加任务记忆（Task Memory）、用户画像（Profile）、文件系统式组织、异步摄取（Async Ingestion）或技能/资源管理。

### 本地优先的记忆存储 / 索引

- `nuggets`
- `memsearch`

这些系统强调本地持久化（Local Persistence）、可检查性和低运维开销。它们的价值在于——Paperclip 目前是本地优先的（Local-first），并且至少需要一条零配置路径。

## 各项目详情

| 项目 | 形态 | 关键 API / 模型 | 与 Paperclip 的契合点 | 主要不匹配之处 |
|---|---|---|---|---|
| [nuggets](https://github.com/NeoVertex1/nuggets) | 本地记忆引擎 + 消息网关 | 基于主题的 HRR 记忆，提供 `remember`、`recall`、`forget`，事实（Fact）可提升到 `MEMORY.md` | 轻量本地记忆与自动提升（Promotion）的良好示例 | 架构非常特定，并非通用的多租户服务 |
| [mem0](https://github.com/mem0ai/mem0) | 托管 + 开源 SDK | `add`、`search`、`getAll`、`get`、`update`、`delete`、`deleteAll`；通过 `user_id`、`agent_id`、`run_id`、`app_id` 进行实体分区（Entity Partitioning） | 最接近一个具有身份标识和元数据过滤的、干净的提供者 API | 提供者深度控制提取（Extraction）；Paperclip 不应假设每个后端都像 mem0 一样运作 |
| [AWS Bedrock AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html) | AWS 托管记忆服务 | 显式的短期和长期记忆、Actor/Session/Event API、记忆策略（Memory Strategy）、命名空间模板（Namespace Template）、可选的自管理提取管线 | 提供者管理记忆的强示例，具有清晰的作用域 ID、保留策略（Retention Control）和独立于单一 Agent 框架的独立 API 访问 | AWS 托管且以 IAM 为中心；Paperclip 仍需自行管理公司/运行/评论的溯源、成本汇总，且更适合作为插件封装而非将 AWS 语义内建到核心 |
| [MemOS](https://github.com/MemTensor/MemOS) | 记忆操作系统 / 框架 | 统一的增删改查、记忆立方体（Memory Cube）、多模态记忆（Multimodal Memory）、工具记忆（Tool Memory）、异步调度器、反馈/纠正 | 超越简单搜索的可选能力的良好来源 | 范围远大于 Paperclip 应首先标准化的最小契约 |
| [supermemory](https://github.com/supermemoryai/supermemory) | 托管记忆 + 上下文 API | `add`、`profile`、`search.memories`、`search.documents`、文档上传、设置；自动构建用户画像和遗忘机制 | "上下文包（Context Bundle）"而非原始搜索结果的强示例 | 围绕其自身本体论（Ontology）和托管流程进行了重度产品化 |
| [memU](https://github.com/NevaMind-AI/memU) | 主动式 Agent 记忆框架 | 文件系统隐喻（File-system Metaphor）、主动循环（Proactive Loop）、意图预测、常驻伴侣模型 | 记忆应触发 Agent 行为（而非仅检索）时的良好参考 | 主动式助手的定位比 Paperclip 以任务为中心的控制面更宽泛 |
| [Memori](https://github.com/MemoriLabs/Memori) | 托管记忆结构 + SDK 封装 | 通过 `entity_id` + `process_id` 注册到 LLM SDK、会话（Session）、云端 + BYODB | 围绕模型客户端自动捕获的强示例 | 以封装为中心的设计无法 1:1 映射到 Paperclip 的 Run/Issue/Comment 生命周期 |
| [EverMemOS](https://github.com/EverMind-AI/EverMemOS) | 对话式长期记忆系统 | MemCell 提取、结构化叙事（Structured Narrative）、用户画像、混合检索/重排序 | 溯源丰富的结构化记忆和动态画像的有用模型 | 专注于对话式记忆，而非通用的控制面事件 |
| [memsearch](https://github.com/zilliztech/memsearch) | Markdown 优先的本地记忆索引 | Markdown 作为事实来源（Source of Truth）、`index`、`search`、`watch`、转录解析、插件钩子 | 作为本地内置提供者和可检查溯源的优秀基线 | 刻意保持简单；没有托管服务语义或丰富的纠正工作流 |
| [OpenViking](https://github.com/volcengine/OpenViking) | 上下文数据库（Context Database） | 文件系统式的记忆/资源/技能组织、分层加载（Tiered Loading）、可视化的检索轨迹 | 浏览/检查型 UX 和上下文溯源的良好来源 | 将"上下文数据库"视为比 Paperclip 应承载的更大的产品面 |

## 跨系统的通用原语

尽管这些系统在架构上各不相同，但它们收敛于以下几个通用原语（Common Primitives）：

- `ingest`（摄取）：从文本、消息、文档或转录内容中添加记忆
- `query`（查询）：根据任务、问题或作用域搜索或检索记忆
- `scope`（作用域）：按用户、Agent、项目、进程或会话对记忆进行分区
- `provenance`（溯源）：携带足够的元数据以解释记忆的来源
- `maintenance`（维护）：随时间更新、遗忘、去重、压缩或纠正记忆
- `context assembly`（上下文组装）：将原始记忆转换为可供 Agent 使用的 Prompt-ready 包

如果 Paperclip 不暴露这些原语，将无法良好适配上述系统。

## 系统间的差异

以下差异正是 Paperclip 需要分层契约（Layered Contract）而非单一硬编码引擎的原因。

### 1. 谁拥有提取（Extraction）？

- `mem0`、`supermemory` 和 `Memori` 期望提供者从对话中推断记忆。
- `AWS Bedrock AgentCore Memory` 同时支持提供者管理的提取和自管理管线——由宿主写入精选的长期记忆记录。
- `memsearch` 期望宿主决定写入什么 Markdown，然后对其进行索引。
- `MemOS`、`memU`、`EverMemOS` 和 `OpenViking` 处于两者之间，通常暴露更丰富的记忆构建管线。

Paperclip 应同时支持：

- 提供者管理的提取
- Paperclip 管理的提取 + 提供者管理的存储/检索

### 2. 什么是事实来源（Source of Truth）？

- `memsearch` 和 `nuggets` 使事实来源在磁盘上可检查。
- 托管 API 通常以提供者存储为权威来源。
- 文件系统式系统（如 `OpenViking` 和 `memU`）将层级结构本身视为记忆模型的一部分。

Paperclip 不应要求单一的存储形态。它应要求对 Paperclip 实体的规范化引用（Normalized Reference）。

### 3. 记忆仅仅是搜索，还是也包含画像和规划状态？

- `mem0` 和 `memsearch` 以搜索和 CRUD 为核心。
- `supermemory` 将用户画像（User Profile）作为一等输出。
- `MemOS`、`memU`、`EverMemOS` 和 `OpenViking` 扩展到工具轨迹（Tool Trace）、任务记忆、资源和技能。

Paperclip 应将简单搜索作为最小契约，将更丰富的输出作为可选能力。

### 4. 记忆是同步的还是异步的？

- 本地工具通常在进程内同步工作。
- `AWS Bedrock AgentCore Memory` 在 API 边缘是同步的，但其长期记忆路径包含由提供者管理的后台提取/索引行为和保留策略。
- 更大型的系统会添加调度器、后台索引、压缩或同步任务。

Paperclip 既需要直接的请求/响应操作，也需要后台维护钩子（Background Maintenance Hook）。

## Paperclip 特定要点

### Paperclip 应管理的事项

- 将提供者绑定到公司，并可选地按 Agent 覆盖
- 将 Paperclip 实体映射到提供者的作用域
- 对议题评论、文档、运行记录和活动的溯源
- 记忆工作的成本 / Token / 延迟报告
- Paperclip UI 中的浏览和检查界面
- 对破坏性操作的治理

### 提供者应管理的事项

- 提取启发式规则
- 向量化 / 索引策略
- 排序与重排序（Ranking & Reranking）
- 画像合成（Profile Synthesis）
- 矛盾解决（Contradiction Resolution）与遗忘逻辑
- 存储引擎细节

### 控制面契约应保持精简

Paperclip 无需标准化每个提供者的每个功能。它需要：

- 一个必需的可移植核心（Portable Core）
- 用于更丰富提供者的可选能力标志（Capability Flag）
- 一种记录提供者原生 ID 和元数据的方式，而非假装所有提供者在内部是等价的

## 推荐方向

Paperclip 应采用两层记忆模型：

1. `记忆绑定 + 控制面层（Memory Binding + Control Plane Layer）`
   Paperclip 决定哪家提供者的密钥对公司、Agent 或项目生效，并以溯源和用量记录每一次记忆操作。

2. `提供者适配器层（Provider Adapter Layer）`
   内置或插件提供的适配器将 Paperclip 的记忆请求转换为提供者特定的调用。

可移植核心应覆盖：

- ingest / write（摄取 / 写入）
- search / recall（搜索 / 召回）
- browse / inspect（浏览 / 检查）
- get by provider record handle（通过提供者记录句柄获取）
- forget / correction（遗忘 / 纠正）
- usage reporting（用量报告）

可选能力可覆盖：

- profile synthesis（画像合成）
- async ingestion（异步摄取）
- multimodal content（多模态内容）
- tool / resource / skill memory（工具 / 资源 / 技能记忆）
- provider-native graph browsing（提供者原生图谱浏览）

这足以支持：

- 类似 `memsearch` 的本地 Markdown 优先基线
- 类似 `mem0`、`supermemory` 或 `Memori` 的托管服务
- 类似 `MemOS` 或 `OpenViking` 的更丰富的 Agent 记忆系统

而无需迫使 Paperclip 自身成为一个单体记忆引擎（Monolithic Memory Engine）。
