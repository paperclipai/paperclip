# Paperclip 记忆服务计划

## 目标

定义一个 Paperclip 记忆服务和表面 API，可以位于多个记忆后端之上，同时保留 Paperclip 的控制面要求：

- 公司范围
- 可审计性
- 追溯到 Paperclip 工作对象的出处
- 预算/成本可见性
- 插件优先的可扩展性

本计划基于 `doc/memory-landscape.md` 中总结的外部格局以及当前 Paperclip 架构：

- `doc/SPEC-implementation.md`
- `doc/plugins/PLUGIN_SPEC.md`
- `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`
- `packages/plugins/sdk/src/types.ts`

## 一句话建议

Paperclip 不应将一个固执己见的记忆引擎嵌入核心。它应添加一个公司范围的记忆控制面，带有一个小型规范化的适配器契约，然后让内置组件和插件实现提供商特定的行为。

## 产品决策

### 1. 记忆默认按公司范围

每个记忆绑定恰好属于一个公司。

该绑定然后可以是：

- 公司默认值
- 智能体覆盖
- 后续如需要可作为项目覆盖

初始设计中不支持跨公司记忆共享。

### 2. 提供商通过键选择

每个配置的记忆提供商在公司内获得一个稳定的键，例如：

- `default`
- `mem0-prod`
- `local-markdown`
- `research-kb`

智能体和服务通过键解析活跃的提供商，而非通过硬编码的供应商逻辑。

### 3. 插件是主要的提供商路径

内置组件对零配置本地路径有用，但大多数提供商应通过现有的 Paperclip 插件运行时到达。

这使核心保持小巧，并与当前方向一致——可选的知识类系统位于边缘。

### 4. Paperclip 拥有路由、出处和核算

提供商不应决定 Paperclip 实体如何映射到治理。

Paperclip 核心应拥有：

- 谁被允许调用记忆操作
- 哪个公司/智能体/项目范围是活跃的
- 操作属于哪个任务/运行/评论/文档
- 如何记录用量

### 5. 自动记忆应首先是狭窄的

自动捕获有用，但广泛的静默捕获是危险的。

初始自动钩子应为：

- 智能体运行后捕获
- 当绑定启用时的任务评论/文档捕获
- 智能体上下文注入的运行前召回

其他一切应从显式开始。

## 建议的概念

### 记忆提供商

内置或插件提供的实现，存储和检索记忆。

示例：

- 本地 markdown + 向量索引
- mem0 适配器
- supermemory 适配器
- MemOS 适配器

### 记忆绑定

公司范围的配置记录，指向提供商并携带提供商特定的配置。

这是通过键选择的对象。

### 记忆范围

传入提供商请求的规范化 Paperclip 范围。

至少包含：

- `companyId`
- 可选 `agentId`
- 可选 `projectId`
- 可选 `issueId`
- 可选 `runId`
- 可选 `subjectId` 用于外部/用户身份

### 记忆来源引用

解释记忆来源的出处句柄。

支持的来源类型应包含：

- `issue_comment`
- `issue_document`
- `issue`
- `run`
- `activity`
- `manual_note`
- `external_document`

### 记忆操作

通过 Paperclip 执行的规范化写入、查询、浏览或删除操作。

无论提供商是本地还是外部，Paperclip 都应记录每个操作。

## 必需的适配器契约

必需的核心应足够小以适配 `memsearch`、`mem0`、`Memori`、`MemOS` 或 `OpenViking`。

```ts
export interface MemoryAdapterCapabilities {
  profile?: boolean;
  browse?: boolean;
  correction?: boolean;
  asyncIngestion?: boolean;
  multimodal?: boolean;
  providerManagedExtraction?: boolean;
}

export interface MemoryScope {
  companyId: string;
  agentId?: string;
  projectId?: string;
  issueId?: string;
  runId?: string;
  subjectId?: string;
}

export interface MemorySourceRef {
  kind:
    | "issue_comment"
    | "issue_document"
    | "issue"
    | "run"
    | "activity"
    | "manual_note"
    | "external_document";
  companyId: string;
  issueId?: string;
  commentId?: string;
  documentKey?: string;
  runId?: string;
  activityId?: string;
  externalRef?: string;
}

export interface MemoryUsage {
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  costCents?: number;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface MemoryWriteRequest {
  bindingKey: string;
  scope: MemoryScope;
  source: MemorySourceRef;
  content: string;
  metadata?: Record<string, unknown>;
  mode?: "append" | "upsert" | "summarize";
}

export interface MemoryRecordHandle {
  providerKey: string;
  providerRecordId: string;
}

export interface MemoryQueryRequest {
  bindingKey: string;
  scope: MemoryScope;
  query: string;
  topK?: number;
  intent?: "agent_preamble" | "answer" | "browse";
  metadataFilter?: Record<string, unknown>;
}

export interface MemorySnippet {
  handle: MemoryRecordHandle;
  text: string;
  score?: number;
  summary?: string;
  source?: MemorySourceRef;
  metadata?: Record<string, unknown>;
}

export interface MemoryContextBundle {
  snippets: MemorySnippet[];
  profileSummary?: string;
  usage?: MemoryUsage[];
}

export interface MemoryAdapter {
  key: string;
  capabilities: MemoryAdapterCapabilities;
  write(req: MemoryWriteRequest): Promise<{
    records?: MemoryRecordHandle[];
    usage?: MemoryUsage[];
  }>;
  query(req: MemoryQueryRequest): Promise<MemoryContextBundle>;
  get(handle: MemoryRecordHandle, scope: MemoryScope): Promise<MemorySnippet | null>;
  forget(handles: MemoryRecordHandle[], scope: MemoryScope): Promise<{ usage?: MemoryUsage[] }>;
}
```

此契约有意不强制提供商公开其内部图、文件系统或本体。

## 可选的适配器界面

这些应由能力门控，非必需：

- `browse(scope, filters)` 用于文件系统/图/时间线检查
- `correct(handle, patch)` 用于自然语言纠正流程
- `profile(scope)` 当提供商可以合成稳定的偏好或摘要时
- `sync(source)` 用于连接器或后台摄入
- `explain(queryResult)` 用于可以公开检索轨迹的提供商

## Paperclip 应持久化的内容

Paperclip 不应将完整的提供商记忆语料库镜像到 PostgreSQL，除非提供商是 Paperclip 管理的本地提供商。

Paperclip 核心应持久化：

- 记忆绑定和覆盖
- 提供商键和能力元数据
- 规范化的记忆操作日志
- 操作返回的提供商记录句柄（如可用）
- 回溯到任务评论、文档、运行和活动的来源引用
- 用量和成本数据

对于外部提供商，记忆载荷本身可以留在提供商处。

## 钩子模型

### 自动钩子

这些应是低风险且易于推理的：

1. `pre-run hydrate`
   在智能体运行开始前，Paperclip 可以使用活跃绑定调用 `query(... intent = "agent_preamble")`。

2. `post-run capture`
   运行完成后，Paperclip 可以写入与运行关联的摘要或转录衍生笔记。

3. `issue comment / document capture`
   当在绑定上启用时，Paperclip 可以将选定的任务评论或任务文档作为记忆来源捕获。

### 显式钩子

这些应首先由工具或 UI 驱动：

- `memory.search`
- `memory.note`
- `memory.forget`
- `memory.correct`
- `memory.browse`

### 第一个版本中不自动化的

- 广泛的网页爬取
- 静默导入任意仓库文件
- 跨公司记忆共享
- 自动破坏性删除
- 绑定之间的提供商迁移

## 智能体用户体验规则

Paperclip 应给智能体提供自动召回和显式工具，附带简单指引：

- 当任务依赖先前的决策、人员、项目或不在当前任务线程中的长期上下文时使用 `memory.search`
- 当持久事实、偏好或决策应在本次运行中存留时使用 `memory.note`
- 当用户明确说先前上下文有误时使用 `memory.correct`
- 依赖运行后自动捕获来处理普通会话残留，这样智能体不必为每次琐碎交换都写记忆笔记

这使记忆可用，而不强制每个智能体提示词都变成记忆管理协议。

## 浏览和检查界面

Paperclip 需要一等的记忆 UI，否则提供商会变成黑盒。

初始浏览界面应支持：

- 按公司和智能体的活跃绑定
- 最近的记忆操作
- 最近的写入来源
- 带来源回链的查询结果
- 按智能体、任务、运行、来源类型和日期过滤
- 提供商用量/成本/延迟摘要

当提供商支持更丰富的浏览时，插件可以通过现有的插件 UI 界面添加更深层的视图。

## 成本与评估

每个适配器响应都应能返回用量记录。

Paperclip 应汇总：

- 记忆推理 token
- 嵌入 token
- 外部提供商成本
- 延迟
- 查询次数
- 写入次数

还应尽可能记录面向评估的指标：

- 召回命中率
- 空查询率
- 手动纠正次数
- 按绑定的成功/失败计数

这很重要，因为一个"能用"但静默消耗预算的记忆系统在 Paperclip 中是不可接受的。

## 建议的数据模型补充

在控制面层面，可能需要的新核心表有：

- `memory_bindings`
  - 公司范围的键
  - 提供商 ID / 插件 ID
  - 配置 blob
  - 启用状态

- `memory_binding_targets`
  - 目标类型（`company`、`agent`，后续 `project`）
  - 目标 ID
  - 绑定 ID

- `memory_operations`
  - 公司 ID
  - 绑定 ID
  - 操作类型（`write`、`query`、`forget`、`browse`、`correct`）
  - 范围字段
  - 来源引用
  - 用量/延迟/成本
  - 成功/错误

提供商特定的长格式状态应留在插件状态或提供商本身中，除非内置本地提供商需要自己的数据库。

## 推荐的首个内置

最佳的零配置内置是一个本地 markdown 优先的提供商，带可选语义索引。

原因：

- 与 Paperclip 的本地优先姿态匹配
- 可检查
- 易于备份和调试
- 即使没有外部 API 密钥也能给系统提供基线

设计仍应将该内置视为同一控制面契约背后的又一个提供商。

## 上线阶段

### 阶段 1：控制面契约

- 添加记忆绑定模型和 API 类型
- 添加记忆提供商的插件能力/注册界面
- 添加操作日志和用量报告

### 阶段 2：一个内置 + 一个插件示例

- 交付一个本地 markdown 优先的提供商
- 交付一个托管适配器示例来验证外部提供商路径

### 阶段 3：UI 检查

- 添加公司/智能体记忆设置
- 添加记忆操作浏览器
- 添加到任务和运行的来源回链

### 阶段 4：自动钩子

- 运行前注入
- 运行后捕获
- 选定的任务评论/文档捕获

### 阶段 5：丰富能力

- 纠正流程
- 提供商原生浏览/图视图
- 如需要的项目级覆盖
- 评估仪表盘

## 开放问题

- 项目覆盖是否应在记忆服务的 V1 中存在，还是应先强制使用公司默认 + 智能体覆盖？
- 我们是否想要 Paperclip 管理的提取管道，还是内置组件应是 Paperclip 拥有提取的唯一地方？
- 记忆用量应直接扩展当前的 `cost_events` 模型，还是记忆操作应保持并行的用量日志然后二次汇总到 `cost_events`？
- 我们是否希望提供商安装/绑定更改在某些公司需要审批？

## 底线

正确的抽象是：

- Paperclip 拥有记忆绑定、范围、出处、治理和用量报告。
- 提供商拥有提取、排序、存储和提供商原生的记忆语义。

这给 Paperclip 一个稳定的"记忆服务"，而不会将产品锁定在一种记忆哲学或一个供应商上。
