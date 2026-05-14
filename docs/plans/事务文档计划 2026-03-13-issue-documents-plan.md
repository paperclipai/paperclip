# 问题文档计划

状态：草稿  
所有者：后端 + UI + 代理协议  
日期：2026-03-13  
主要问题：`PAP-448`

## 摘要

向 Paperclip 添加一流的**文档**作为可编辑、带版本、公司范围的文本工件，可以链接到问题。

第一个必需的约定是键为 `plan` 的文档。

这解决了 `PAP-448` 中的即时工作流问题：

- 计划应该停止作为 `<plan>` 块存在于问题描述中
- 代理和董事会用户应该能够直接创建/更新问题文档
- `GET /api/issues/:id` 应该包括完整的 `plan` 文档并公开其他可用文档
- 问题详细信息应在描述下呈现文档

这应该构建为更广泛的工件系统的**文本文档切片**，而不是附件/工件的替代品。

## 推荐的产品形态

### 文档 vs 附件 vs 工件

- **文档**：具有稳定键和修订历史的可编辑文本内容。
- **附件**：上传/生成的不透明文件，由存储支持（`assets` + `issue_attachments`）。
- **工件**：后来的伞形/读取模型，可以统一文档、附件、预览和工作区文件。

建议：

- 立即实现**问题文档**
- 保持现有附件不变
- 直到有第二个真正的消费者（除了问题文档 + 附件）再推迟完整的工件统一

这使 `PAP-448` 保持专注，同时仍然符合更大的工件方向。

## 目标

1. 给问题一流的键控文档，从 `plan` 开始。
2. 使文档可由董事会用户和具有问题访问权限的同一公司代理编辑。
3. 通过仅追加修订保留更改历史。
4. 使 `plan` 文档在代理/心跳使用的正常问题获取中自动可用。
5. 替换技能/文档中当前在描述中的 `<plan>` 约定。
6. 保持设计与未来的工件/可交付成果层兼容。

## 非目标

- 完整的协作文档编辑
- 二进制文件版本历史
- 浏览器 IDE 或工作区编辑器
- 在同一更改中实现完整的工件系统
- 从第一天开始为每个实体类型进行广义多态关系

## 产品决策

### 1. 键控问题文档

每个问题可以有多个文档。每个文档关系都有一个稳定的键：

- `plan`
- `design`
- `notes`
- `report`
- 自定义键稍后

键规则：

- 每个问题唯一，不区分大小写
- 规范化为小写 slug 形式
- 面向机器且稳定
- 标题是单独的，面向用户

`plan` 键是约定的，由 Paperclip 工作流/文档保留。

### 2. 文本优先 v1

V1 文档应该是文本优先，而不是任意二进制块。

推荐的支持格式：

- `markdown`
- `plain_text`
- `json`
- `html`

建议：

- 为 `markdown` 优化 UI
- 允许其他格式的原始编辑
- 将 PDF/图像/CSV 等保留为附件/工件，而不是可编辑文档

### 3. 修订模型

每个文档更新都会创建一个新的不可变修订。

当前文档行存储最新快照以供快速读取。

### 4. 并发模型

不要使用静默的最后写入获胜。

更新应包含 `baseRevisionId`：

- 创建：不需要基础修订
- 更新：`baseRevisionId` 必须匹配当前最新修订
- 不匹配：返回 `409 冲突`

这很重要，因为董事会用户和代理都可能编辑同一文档。

### 5. 问题获取行为

`GET /api/issues/:id` 应该包括：

- 当存在 `plan` 文档时，完整的 `planDocument`
- 所有链接文档的 `documentSummaries`

它默认不应内联每个文档正文。

这保持问题获取对代理有用，而不会使每个问题负载无界。

### 6. 传统 `<plan>` 兼容性

如果问题没有 `plan` 文档但其描述包含传统的 `<plan>` 块：

- 在 API/UI 中将其作为传统只读后备公开
- 将其标记为传统/合成
- 当两者都存在时，优先使用真正的 `plan` 文档

建议：

- 在第一次推出中不要自动重写旧的问题描述
- 以后提供显式的导入/迁移路径

## 建议的数据模型

建议：使文档成为一等公民，但通过连接表保持问题链接显式。

这保留了当今的外键，并为未来的 `project_documents` 或 `company_documents` 表提供了干净的路径。

## 表

### `documents`

规范的文本文档记录。

建议列：

- `id`
- `company_id`
- `title`
- `format`
- `latest_body`
- `latest_revision_id`
- `latest_revision_number`
- `created_by_agent_id`
- `created_by_user_id`
- `updated_by_agent_id`
- `updated_by_user_id`
- `created_at`
- `updated_at`

### `document_revisions`

仅追加历史。

建议列：

- `id`
- `company_id`
- `document_id`
- `revision_number`
- `body`
- `change_summary`
- `created_by_agent_id`
- `created_by_user_id`
- `created_at`

约束：

- 唯一 `(document_id, revision_number)`

### `issue_documents`

问题关系 + 工作流键。

建议列：

- `id`
- `company_id`
- `issue_id`
- `document_id`
- `key`
- `created_at`
- `updated_at`

约束：

- 唯一 `(company_id, issue_id, key)`
- 唯一 `(document_id)` 以在 v1 中保持每个文档一个问题关系

## 为什么不使用 `assets`

因为 `assets` 解决的是二进制存储，而不是：

- 像 `plan` 这样的稳定键控语义
- 内联文本编辑
- 修订历史
- 乐观并发
- 在 `GET /issues/:id` 中廉价包含

文档和附件应该保持为独立的基元，然后在可交付成果/工件读取模型中相遇。

## 共享类型和 API 合同

## 新的共享类型

添加：

- `DocumentFormat`
- `IssueDocument`
- `IssueDocumentSummary`
- `DocumentRevision`

推荐的 `IssueDocument` 形状：

```ts
type DocumentFormat = "markdown" | "plain_text" | "json" | "html";

interface IssueDocument {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  body: string;
  latestRevisionId: string;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

推荐的 `IssueDocumentSummary` 形状：

```ts
interface IssueDocumentSummary {
  id: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string;
  latestRevisionNumber: number;
  updatedAt: Date;
}
```

## 问题类型丰富

使用以下内容扩展 `Issue`：

```ts
interface Issue {
  ...
  planDocument?: IssueDocument | null;
  documentSummaries?: IssueDocumentSummary[];
  legacyPlanDocument?: {
    key: "plan";
    body: string;
    source: "issue_description";
  } | null;
}
```

这直接满足了 `PAP-448` 对心跳/API 问题获取的要求。

## API 端点

推荐端点：

- `GET /api/issues/:issueId/documents`
- `GET /api/issues/:issueId/documents/:key`
- `PUT /api/issues/:issueId/documents/:key`
- `GET /api/issues/:issueId/documents/:key/revisions`
- `DELETE /api/issues/:issueId/documents/:key` 在 v1 中可选为仅限董事会

推荐的 `PUT` 正文：

```ts
{
  title?: string | null;
  format: "markdown" | "plain_text" | "json" | "html";
  body: string;
  changeSummary?: string | null;
  baseRevisionId?: string | null;
}
```

行为：

- 缺失文档 + 无 `baseRevisionId`：创建
- 现有文档 + 匹配 `baseRevisionId`：更新
- 现有文档 + 陈旧 `baseRevisionId`：`409`

## 授权和不变量

- 所有文档记录都是公司范围的
- 问题关系必须属于同一公司
- 董事会访问遵循现有的问题访问规则
- 代理访问遵循现有的同一公司问题访问规则
- 每个变更写入活动日志条目

v1 的推荐删除规则：

- 董事会可以删除文档
- 代理可以创建/更新，但不能删除

这可以防止自动化系统太容易地删除规范文档。

## UI 计划

## 问题详细信息

在问题描述下添加一个新的**文档**部分。

推荐行为：

- 当存在时首先显示 `plan`
- 在其下方显示其他文档
- 渲染类似要点的标题：
  - 键
  - 标题
  - 最后更新的元数据
  - 修订号
- 支持内联编辑
- 支持按键创建新文档
- 支持修订历史抽屉或工作表

推荐的呈现顺序：

1. 描述
2. 文档
3. 附件
4. 评论 / 活动 / 子问题

这与文档位于描述之下的请求相匹配，同时仍然使附件可用。

## 编辑用户体验

建议：

- 对于 markdown 文档，使用 markdown 预览 + 原始编辑切换
- 对于非 markdown 文档，在 v1 中使用原始 textarea 编辑器
- 在 `409` 上显示明确的保存冲突
- 显示清晰的空状态："尚无文档"

## 传统计划渲染

如果没有存储的 `plan` 文档但存在传统的 `<plan>`：

- 在文档部分显示它
- 将其标记为 `来自描述的传统计划`
- 在以后的传递中提供创建/导入

## 代理协议和技能

更新 Paperclip 代理工作流，以便规划不再编辑问题描述。

必需的更改：

- 更新 `skills/paperclip/SKILL.md`
- 用文档创建/更新指令替换 `<plan>` 指令
- 在 `docs/API接口/05 事务 issues.md` 中记录新端点
- 更新任何仍然教授内联 `<plan>` 块的内部规划文档

新规则：

- 当要求为问题制定计划时，创建或更新键为 `plan` 的问题文档
- 留下评论说明计划文档已创建/更新
- 不要将问题标记为完成

## 与工件计划的关系

这项工作应该明确地为更广泛的工件/可交付成果方向提供信息。

建议：

- 在此更改中将文档保留为其自己的基元
- 将 `document` 添加到任何未来的 `ArtifactKind`
- 以后构建一个聚合以下内容的可交付成果读取模型：
  - 问题文档
  - 问题附件
  - 预览 URL
  - 工作区文件引用

工件提案目前没有明确的 `document` 类型。它应该有。

推荐的未来形状：

```ts
type ArtifactKind =
  | "document"
  | "attachment"
  | "workspace_file"
  | "preview"
  | "report_link";
```

## 实施阶段

## 阶段 1：共享合同和模式

文件：

- `packages/db/src/schema/documents.ts`
- `packages/db/src/schema/document_revisions.ts`
- `packages/db/src/schema/issue_documents.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/migrations/*`
- `packages/shared/src/types/issue.ts`
- `packages/shared/src/validators/issue.ts` 或新的文档验证器文件
- `packages/shared/src/index.ts`

验收：

- 模式强制每个问题一个键
- 修订是仅追加的
- 共享类型在问题获取时暴露计划/文档字段

## 阶段 2：服务器服务和路由

文件：

- `server/src/services/issues.ts` 或 `server/src/services/documents.ts`
- `server/src/routes/issues.ts`
- `server/src/services/activity.ts` 调用点

行为：

- 列出/获取/更新/删除文档
- 修订列表
- `GET /issues/:id` 返回 `planDocument` + `documentSummaries`
- 公司边界检查与问题路由匹配

验收：

- 代理和董事会可以获取/更新同一公司的问题文档
- 陈旧的编辑返回 `409`
- 活动时间线显示文档更改

## 阶段 3：UI 问题文档界面

文件：

- `ui/src/api/issues.ts`
- `ui/src/lib/queryKeys.ts`
- `ui/src/pages/IssueDetail.tsx`
- 新的可重用文档 UI 组件（如果需要）

行为：

- 在描述下呈现计划 + 文档
- 按键创建/更新
- 打开修订历史
- 清晰显示冲突/错误

验收：

- 董事会可以从问题详细信息创建 `plan` 文档
- 更新的计划立即出现
- 问题详细信息不再依赖描述嵌入的 `<plan>`

## 阶段 4：技能/文档迁移

文件：

- `skills/paperclip/SKILL.md`
- `docs/API接口/05 事务 issues.md`
- `doc/SPEC-implementation.md`
- 提及 `<plan>` 的相关计划/文档

验收：

- 规划指南引用问题文档，而不是内联问题描述标签
- API 文档描述新的文档端点和问题负载添加

## 阶段 5：传统兼容性和后续

行为：

- 读取传统的 `<plan>` 块作为后备
- 以后可选择添加显式的导入/迁移命令

后续，首次合并不需要：

- 可交付成果/工件读取模型
- 项目/公司文档
- 评论链接的文档
- 修订之间的差异视图

## 测试计划

### 服务器

- 文档创建/读取/更新/删除生命周期
- 修订编号
- `baseRevisionId` 冲突处理
- 公司边界强制执行
- 代理 vs 董事会授权
- 问题获取包括 `planDocument` 和文档摘要
- 传统 `<plan>` 后备行为
- 活动日志变更覆盖

### UI

- 问题详细信息显示计划文档
- 创建/更新流正确地使查询失效
- 冲突和验证错误被公开
- 传统计划后备正确呈现

### 验证

在实施宣布完成之前运行：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

## 开放性问题

1. v1 文档是否应该仅限于 markdown，将 `json/html/plain_text` 推迟？
   建议：在 API 中允许所有四种，仅针对 markdown 优化 UI。

2. 是否应该允许代理创建任意键，还是只允许约定的键？
   建议：允许带有规范化验证的任意键；仅将 `plan` 保留为特殊行为。

3. v1 中是否应该存在删除？
   建议：是的，但仅限董事会。

4. 传统的 `<plan>` 块是否应该自动迁移？
   建议：在第一次推出中不要自动更改。

5. 文档是否应该出现在未来的可交付成果部分中，还是保持为顶级问题部分？
   建议：现在保留专用的文档部分；如果以后添加了聚合的工件视图，也将在可交付成果中公开它们。

## 最终建议

现在将**问题文档**作为专注的、文本优先的基元发布。

不要尝试在同一实现中解决完整的工件统一。

使用：

- 一流的文档表
- 问题级别的键控链接
- 仅追加修订
- 嵌入在正常问题获取中的 `planDocument`
- 传统 `<plan>` 后备
- 从描述嵌入计划迁移技能/文档

这立即解决了真实的规划工作流问题，并为工件系统留下了干净增长的空间。