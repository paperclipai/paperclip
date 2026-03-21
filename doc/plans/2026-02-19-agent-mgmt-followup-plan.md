# 智能体管理后续计划（CEO 补丁 + 配置回滚 + 任务-审批关联）

状态：提议
日期：2026-02-19
背景：运行 `faeab00e-7857-4acc-b2b2-86f6d078adb4` 的后续

## 1. 调查发现

## 1.1 为什么 CEO PATCH 失败

根本原因是显式路由逻辑：

- `server/src/routes/agents.ts` 当前阻止任何智能体修改另一个智能体：
  - `if (req.actor.type === "agent" && req.actor.agentId !== id) { ... "Agent can only modify itself" }`

所以即使 CEO 有招聘权限，路由仍然强制执行旧的仅自身修改行为。

## 1.2 为什么评论质量感觉不对

- `skills/paperclip/SKILL.md` 和 `skills/paperclip/references/api-reference.md` 当前不要求状态评论的 markdown 格式质量（链接、结构、可读更新）。
- 因此智能体产生带有原始 ID 的纯文本评论，而不是关联实体。

## 1.3 任务-审批关联差距

- 目前任务和审批之间没有直接的数据库关系。
- 审批负载可能包含上下文 ID，但这不是规范关联。
- UI 页面无法可靠地交叉链接任务/审批，只能手动复制粘贴 ID。

## 1.4 配置回滚差距

- 智能体配置更新目前覆盖状态，没有专用的修订历史表。
- 有活动日志记录，但没有一等的配置版本账本或回滚端点。

## 2. 产品/行为变更

## 2.1 允许 CEO 修改同公司的其他智能体

目标行为：

- 董事会：完全修改权限。
- CEO：可以修改同公司的智能体。
- 其他智能体：仅自身修改，除非未来明确授权。

说明：

- 保持公司边界检查严格。
- 特权字段单独治理。

## 2.2 添加一等智能体配置修订日志 + 回滚

每次影响配置的变更必须创建修订记录，包含：

- 变更前快照
- 变更后快照
- 操作者信息（用户/智能体）
- 可选原因/评论
- 源运行 ID（如果可用）

回滚必须是一次 API 调用即可原子恢复先前修订。

## 2.3 在技能中强制要求 markdown 和链接的任务评论

技能指导应要求：

- 短 markdown 结构（`Summary`、`Actions`、`Next`）
- 相关时链接到创建/更新的实体
- 避免没有链接的原始 ID

## 2.4 添加显式任务-审批关联（多对多）

实现规范连接模型，使一个任务可以关联多个审批，一个审批可以关联多个任务。

## 3. 数据模型计划

## 3.1 新表：`agent_config_revisions`

列：

- `id` uuid pk
- `company_id` uuid fk
- `agent_id` uuid fk
- `revision_number` int（每智能体单调递增）
- `reason` text null
- `changed_by_agent_id` uuid null
- `changed_by_user_id` text null
- `run_id` uuid null
- `before_snapshot` jsonb not null
- `after_snapshot` jsonb not null
- 时间戳

索引：

- `(company_id, agent_id, revision_number desc)`
- `(agent_id, created_at desc)`

## 3.2 新表：`issue_approvals`

列：

- `id` uuid pk
- `company_id` uuid fk
- `issue_id` uuid fk
- `approval_id` uuid fk
- `relationship` text default `context`
- `linked_by_agent_id` uuid null
- `linked_by_user_id` text null
- 时间戳

约束：

- 唯一 `(company_id, issue_id, approval_id)`

索引：

- `(company_id, issue_id)`
- `(company_id, approval_id)`

## 4. API 计划

## 4.1 智能体 PATCH 授权修复

更新 `PATCH /api/agents/:id` 授权矩阵：

- 董事会：允许
- 同公司角色为 `ceo` 的智能体：允许
- 其他：仅自身

## 4.2 分离特权修改字段

保护这些字段不被非董事会/非 CEO 的通用 PATCH 修改：

- `permissions`
- 超出允许范围的 `status` 转换

（继续使用专用权限路由进行权限编辑。）

## 4.3 配置修订 API

添加：

- `GET /api/agents/:id/config-revisions`
- `GET /api/agents/:id/config-revisions/:revisionId`
- `POST /api/agents/:id/config-revisions/:revisionId/rollback`

行为：

- 回滚写入新的修订条目（不修改历史）
- 回滚响应包含结果活跃配置

## 4.4 任务-审批关联 API

添加：

- `GET /api/issues/:id/approvals`
- `POST /api/issues/:id/approvals`（关联现有审批）
- `DELETE /api/issues/:id/approvals/:approvalId`
- `GET /api/approvals/:id/issues`

## 4.5 审批创建时自动关联

扩展创建负载以可选包含任务上下文：

- `POST /api/companies/:companyId/approvals` 支持 `issueId` 或 `issueIds`
- `POST /api/companies/:companyId/agent-hires` 支持 `sourceIssueId` 或 `sourceIssueIds`

服务器行为：

- 先创建审批
- 在 `issue_approvals` 中插入关联行

## 5. UI 计划

## 5.1 智能体页面

在 `AgentDetail` 上添加配置历史面板：

- 修订列表
- 差异预览
- 带确认的回滚按钮

## 5.2 审批页面和任务页面交叉链接

- 审批详情上：显示关联任务及链接
- 任务详情上：显示关联审批及链接
- 董事会上下文中的关联/取消关联操作

## 5.3 更好的评论 UX 提示

初始不做硬编辑器强制；更新帮助文本和模板以鼓励关联 markdown 更新。

## 6. 技能更新

## 6.1 `skills/paperclip/SKILL.md`

添加评论标准：

- 使用 markdown 部分
- 包含相关实体的链接：
  - 审批：`/approvals/{id}`
  - 智能体：`/agents/{id}`
  - 任务：`/issues/{id}`

## 6.2 `skills/paperclip-create-agent/SKILL.md`

要求：

- 从任务创建招聘时包含 `sourceIssueId`
- 回复到任务时使用 markdown + 链接到审批和待处理智能体

## 7. 实现阶段

## 阶段 A：授权 + 安全加固

- 修复智能体路由中的 CEO 修改授权
- 限制特权通用修改字段
- 为授权矩阵添加测试

## 阶段 B：配置修订账本

- 添加 `agent_config_revisions`
- 所有相关智能体变更的写入时记录
- 回滚端点 + 测试

## 阶段 C：任务-审批关联

- 添加 `issue_approvals`
- 添加关联 API + 自动关联行为
- 更新审批/任务 UI 交叉链接

## 阶段 D：技能指导

- 更新技能以符合 markdown/链接预期和 sourceIssue 关联

## 8. 验收标准

- CEO 可以成功修改 CTO（同公司）。
- 每次配置变更创建可检索的修订。
- 回滚在一次操作中恢复先前配置并创建新修订记录。
- 任务和审批页面显示来自规范数据库关系的稳定双向链接。
- 招聘工作流中的智能体评论使用 markdown 并包含实体链接。

## 9. 风险和缓解

- 风险：通过通用 PATCH 的权限升级。
  - 缓解：隔离特权字段并验证操作者范围。
- 风险：回滚损坏。
  - 缓解：变更前快照/变更后快照 + 事务 + 测试。
- 风险：关联语义不明确。
  - 缓解：显式连接表 + 唯一约束 + 类型化关系字段。
