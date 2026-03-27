# 记忆系统全景

日期：2026-03-17

本文档总结了任务 `PAP-530` 中引用的记忆系统，并提取了对 Paperclip 重要的设计模式。

## Paperclip 需要从这项调研中获得什么

Paperclip 并非试图成为一个单一的、有主见的记忆引擎。更有用的目标是一个控制平面记忆层，它：

- 保持公司范围
- 让每家公司选择默认的记忆提供者
- 让特定代理覆盖该默认值
- 保持对 Paperclip 运行、议题、评论和文档的来源追溯
- 像控制平面记录工作的其他部分一样记录记忆相关的成本和延迟
- 与插件提供的提供者配合工作，而不仅是内置的

问题不是"哪个记忆项目胜出？"而是"Paperclip 的最小契约是什么，能够位于几个非常不同的记忆系统之上，而不会抹平有用的差异？"

## 快速分类

### 托管记忆 API

- `mem0`
- `supermemory`
- `Memori`

这些优化了简单的应用集成方式：发送对话/内容加上身份标识，然后稍后查询相关记忆或用户上下文。

### 以代理为中心的记忆框架/记忆操作系统

- `MemOS`
- `memU`
- `EverMemOS`
- `OpenViking`

这些将记忆视为代理运行时子系统，而不仅仅是搜索索引。它们通常添加任务记忆、用户画像、文件系统风格的组织、异步摄入或技能/资源管理。

### 本地优先的记忆存储/索引

- `nuggets`
- `memsearch`

这些强调本地持久化、可检查性和低运维开销。它们很有用，因为 Paperclip 目前是本地优先的，需要至少一条零配置路径。

## 各项目笔记

| 项目 | 形态 | 主要 API / 模型 | 与 Paperclip 的契合度 | 主要不匹配 |
|---|---|---|---|---|
| [nuggets](https://github.com/NeoVertex1/nuggets) | 本地记忆引擎 + 消息网关 | 基于主题的 HRR 记忆，具有 `remember`、`recall`、`forget`，事实提升至 `MEMORY.md` | 轻量级本地记忆和自动提升的好例子 | 架构非常特定；不是通用的多租户服务 |
| [mem0](https://github.com/mem0ai/mem0) | 托管 + 开源 SDK | `add`、`search`、`getAll`、`get`、`update`、`delete`、`deleteAll`；通过 `user_id`、`agent_id`、`run_id`、`app_id` 进行实体分区 | 最接近带身份标识和元数据过滤的干净提供者 API | 提供者大量控制提取；Paperclip 不应假设每个后端都像 mem0 一样运作 |
| [MemOS](https://github.com/MemTensor/MemOS) | 记忆操作系统/框架 | 统一的增删改查、记忆立方体、多模态记忆、工具记忆、异步调度器、反馈/纠正 | 超越简单搜索的可选能力的有力来源 | 比 Paperclip 应该首先标准化的最小契约广泛得多 |
| [supermemory](https://github.com/supermemoryai/supermemory) | 托管记忆 + 上下文 API | `add`、`profile`、`search.memories`、`search.documents`、文档上传、设置；自动构建用户画像和遗忘 | "上下文包"而非原始搜索结果的好例子 | 高度围绕自身本体论和托管流程产品化 |
| [memU](https://github.com/NevaMind-AI/memU) | 主动式代理记忆框架 | 文件系统隐喻、主动循环、意图预测、始终在线的伴随模型 | 记忆应触发代理行为而非仅检索的好来源 | 主动助手框架比 Paperclip 以任务为中心的控制平面更广泛 |
| [Memori](https://github.com/MemoriLabs/Memori) | 托管记忆网络 + SDK 封装 | 针对 LLM SDK 注册，通过 `entity_id` + `process_id` 归因，会话，云 + BYODB | 围绕模型客户端自动捕获的好例子 | 封装为中心的设计不能 1:1 映射到 Paperclip 的运行/议题/评论生命周期 |
| [EverMemOS](https://github.com/EverMind-AI/EverMemOS) | 对话式长期记忆系统 | MemCell 提取、结构化叙事、用户画像、混合检索/重排序 | 来源丰富的结构化记忆和不断演进的用户画像的有用模型 | 专注于对话记忆而非通用控制平面事件 |
| [memsearch](https://github.com/zilliztech/memsearch) | 以 markdown 为核心的本地记忆索引 | markdown 作为真实来源，`index`、`search`、`watch`、转录解析、插件钩子 | 本地内置提供者和可检查来源的极佳基线 | 有意简单；没有托管服务语义或丰富的纠正工作流 |
| [OpenViking](https://github.com/volcengine/OpenViking) | 上下文数据库 | 记忆/资源/技能的文件系统风格组织、分层加载、可视化检索轨迹 | 浏览/检查 UX 和上下文来源的有力参考 | 将"上下文数据库"视为比 Paperclip 应该拥有的更大的产品面 |

## 跨系统的共同原语

尽管这些系统在架构上不一致，但它们在几个原语上趋于一致：

- `ingest`：从文本、消息、文档或转录中添加记忆
- `query`：根据任务、问题或范围搜索或检索记忆
- `scope`：按用户、代理、项目、流程或会话对记忆进行分区
- `provenance`：携带足够的元数据来解释记忆来自何处
- `maintenance`：随时间更新、遗忘、去重、压缩或纠正记忆
- `context assembly`：将原始记忆转化为代理可用的提示包

如果 Paperclip 不暴露这些，它将无法很好地适配上述系统。

## 系统差异之处

这些差异正是 Paperclip 需要分层契约而非单一硬编码引擎的原因。

### 1. 谁拥有提取权？

- `mem0`、`supermemory` 和 `Memori` 期望提供者从对话中推断记忆。
- `memsearch` 期望宿主决定写什么 markdown，然后对其建立索引。
- `MemOS`、`memU`、`EverMemOS` 和 `OpenViking` 介于两者之间，通常暴露更丰富的记忆构建管道。

Paperclip 应该支持两者：

- 提供者管理的提取
- Paperclip 管理的提取 + 提供者管理的存储/检索

### 2. 什么是真实来源？

- `memsearch` 和 `nuggets` 使来源在磁盘上可检查。
- 托管 API 通常使提供者存储为规范。
- 文件系统风格的系统如 `OpenViking` 和 `memU` 将层级本身视为记忆模型的一部分。

Paperclip 不应要求单一的存储形状。它应该要求归一化的引用回到 Paperclip 实体。

### 3. 记忆仅仅是搜索，还是也包括画像和计划状态？

- `mem0` 和 `memsearch` 以搜索和 CRUD 为中心。
- `supermemory` 将用户画像添加为一等输出。
- `MemOS`、`memU`、`EverMemOS` 和 `OpenViking` 扩展到工具轨迹、任务记忆、资源和技能。

Paperclip 应该将简单搜索作为最低契约，将更丰富的输出作为可选能力。

### 4. 记忆是同步的还是异步的？

- 本地工具通常在进程内同步工作。
- 更大的系统添加调度器、后台索引、压缩或同步作业。

Paperclip 需要直接的请求/响应操作和后台维护钩子。

## Paperclip 特定的结论

### Paperclip 应该拥有这些关注点

- 将提供者绑定到公司，并可选地按代理覆盖
- 将 Paperclip 实体映射到提供者范围
- 对议题评论、文档、运行和活动的来源追溯
- 记忆工作的成本/token/延迟报告
- Paperclip UI 中的浏览和检查界面
- 破坏性操作的治理

### 提供者应该拥有这些关注点

- 提取启发式算法
- 嵌入/索引策略
- 排名和重排序
- 用户画像合成
- 矛盾解决和遗忘逻辑
- 存储引擎细节

### 控制平面契约应该保持精简

Paperclip 不需要标准化每个提供者的每个功能。它需要：

- 一个必须的可移植核心
- 为更丰富的提供者提供的可选能力标志
- 一种记录提供者原生 ID 和元数据的方式，而不假装所有提供者在内部是等价的

## 推荐方向

Paperclip 应该采用两层记忆模型：

1. `记忆绑定 + 控制平面层`
   Paperclip 决定哪个提供者密钥对公司、代理或项目有效，并记录每个记忆操作的来源和使用情况。

2. `提供者适配器层`
   内置或插件提供的适配器将 Paperclip 记忆请求转换为提供者特定的调用。

可移植核心应该覆盖：

- 摄入/写入
- 搜索/回忆
- 浏览/检查
- 按提供者记录句柄获取
- 遗忘/纠正
- 使用量报告

可选能力可以覆盖：

- 用户画像合成
- 异步摄入
- 多模态内容
- 工具/资源/技能记忆
- 提供者原生图浏览

这足以支持：

- 类似 `memsearch` 的本地 markdown 优先基线
- 类似 `mem0`、`supermemory` 或 `Memori` 的托管服务
- 类似 `MemOS` 或 `OpenViking` 的更丰富的代理记忆系统

而不会迫使 Paperclip 本身成为一个单体记忆引擎。
