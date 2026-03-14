# Agent管理后续计划（CEO补丁+配置回滚+Issue↔审批链接）

状态： 拟定
日期：2026-02-19
上下文：运行 `faeab00e-7857-4acc-b2b2-86f6d078adb4` 的后续操作

## 1. 调查结果

## 1.1 为什么CEO PATCH失败

根本原因是显式路由逻辑：

- `server/src/routes/agents.ts` 目前阻止任何智能体修补另一个智能体：
  - `if (req.actor.type === "agent" && req.actor.agentId !== id) { ... "Agent can only modify itself" }`

因此，即使首席执行官拥有雇佣许可，该路线仍然强制执行旧的仅自我补丁行为。

## 1.2 为什么评论质量感觉不对

- `skills/paperclip/SKILL.md` 和 `skills/paperclip/references/api-reference.md` 目前不要求状态评论（链接、结构、可读更新）的 Markdown 格式质量。
- 因此，智能体会使用原始 ID 生成简单的散文评论，而不是链接的实体。

## 1.3 问题↔审批联动差距

- 目前，发布和批准之间没有直接的数据库关系。
- 批准有效负载可能包括上下文 ID，但这不是规范链接。
- 如果没有手动复制粘贴 ID，UI 页面无法可靠地交叉链接问题/批准。

## 1.4 配置回滚间隙

- 智能体配置更新当前覆盖状态，没有专用的修订历史记录表。
- 有活动日志记录，但没有一流的配置版本分类帐或回滚端点。

## 2. 产品/行为变更

## 2.1 允许CEO给其他同公司智能体打补丁

目标行为：

- 董事会：完整的补丁权。
- CEO：可以修补同一公司的智能体。
- 其他智能体：除非明确授予未来许可，否则只能自行修补。

注意：

- 严格公司边界检查。
- 单独管理特权领域。

## 2.2 添加一级智能体配置修改日志+回滚

每个影响配置的突变都必须创建一个修订记录：

- 快照之前
- 快照后
- 演员信息（用户/智能体）
- 可选原因/评论
- 源运行 ID（如果可用）

回滚必须是一个 API 调用，以原子方式恢复先前的修订。

## 2.3 在技能中强制执行 markdown 和问题评论链接

技能指导应要求：

- 短降价结构（`Summary`、`Actions`、`Next`）
- 相关时创建/更新实体的链接
- 避免没有链接的原始 ID

## 2.4 添加明确的Issue↔Approval联动（多对多）

实施规范连接模型，以便一个问题可以链接多个批准，一个批准可以链接多个问题。

## 3. 数据模型规划

## 3.1 新表：`agent_config_revisions`

栏目：

- `id` uuid pk
- `company_id` uuid fk
- `agent_id` uuid fk
- `revision_number` int（每个智能体单调）
- `reason` 文字为空
- `changed_by_agent_id` uuid 空
- `changed_by_user_id` 文字为空
- `run_id` uuid 空
- `before_snapshot` jsonb 不为空
- `after_snapshot` jsonb 不为空
- 时间戳

索引：

- `(company_id, agent_id, revision_number desc)`
- `(agent_id, created_at desc)`

## 3.2 新表：`issue_approvals`

栏目：- `id` uuid pk
- `company_id` uuid fk
- `issue_id` uuid fk
- `approval_id` uuid fk
- `relationship` 文字默认`context`
- `linked_by_agent_id` uuid 空
- `linked_by_user_id` 文字为空
- 时间戳

限制条件：

- 独特的`(company_id, issue_id, approval_id)`

索引：

- `(company_id, issue_id)`
- `(company_id, approval_id)`

## 4. API 计划

## 4.1 智能体补丁授权修复

更新 `PATCH /api/agents/:id` 授权矩阵：

- 董事会：允许
- 同一公司中的智能体角色 `ceo`：允许
- 否则：仅限自己

## 4.2 单独的特权补丁字段

由非董事会/非首席执行官保护这些免受通用补丁的影响：

- `permissions`
- `status` 转换超出允许范围

（继续使用专用权限路径进行权限编辑。）

## 4.3 配置修改 APIs

添加：

- `GET /api/agents/:id/config-revisions`
- `GET /api/agents/:id/config-revisions/:revisionId`
- `POST /api/agents/:id/config-revisions/:revisionId/rollback`

行为：

- 回滚写入新的修订条目（不会改变历史记录）
- 回滚响应包括生成的活动配置

## 4.4 发布↔审批链接 APIs

添加：

- `GET /api/issues/:id/approvals`
- `POST /api/issues/:id/approvals`（链接现有批准）
- `DELETE /api/issues/:id/approvals/:approvalId`
- `GET /api/approvals/:id/issues`

## 4.5 创建批准时自动链接

扩展创建有效负载以选择性地包含问题上下文：

- `POST /api/companies/:companyId/approvals` 支持 `issueId` 或 `issueIds`
- `POST /api/companies/:companyId/agent-hires` 支持 `sourceIssueId` 或 `sourceIssueIds`

服务器行为：

- 首先创建批准
- 在 `issue_approvals` 中插入链接行

## 5. UI 计划

## 5.1 智能体页面

在`AgentDetail`上添加配置历史面板：

- 修订清单
- 差异预览
- 带确认的回滚按钮

## 5.2 审批页面和问题页面交叉链接

- 关于批准详细信息：显示带有链接的链接问题
- 关于问题详细信息：显示带有链接的链接批准
- 董事会上下文中的链接/取消链接操作

## 5.3 更好的评论用户体验提示

最初没有硬编辑强制执行；更新帮助文本和模板以鼓励链接的 Markdown 更新。

## 6.技能更新

## 6.1 `skills/paperclip/SKILL.md`

添加评论标准：

- 使用降价部分
- 包括相关实体的链接：
  - 批准：`/approvals/{id}`
  - 智能体人：`/agents/{id}`
  - 问题：`/issues/{id}`

## 6.2 `skills/paperclip-create-agent/SKILL.md`

要求：

- 当根据问题创建雇用时，包括 `sourceIssueId`
- 使用 Markdown 评论回问题 + 批准和待处理智能体的链接

## 7. 实施阶段

## A阶段：Authz+安全加固

- 修复智能体路由中的 CEO 补丁授权
- 限制特权通用补丁字段
- 添加对 authz 矩阵的测试

## B 阶段：配置修订账本

- 添加`agent_config_revisions`
- 所有相关智能体突变的更改写入
- 回滚端点+测试

## C 阶段：Issue↔Approval 链接

- 添加`issue_approvals`
- 添加链接 APIs + 自动链接行为
- 更新批准/问题 UI 交叉链接

## D阶段：技能指导

- 更新降价/链接期望和源问题链接的技能

## 8. 验收标准- CEO 可以成功修补 CTO（同一家公司）。
- 每个配置更改都会创建一个可检索的修订版本。
- 回滚可一次性恢复之前的配置并创建新的修订记录。
- 发布和批准页面显示来自规范数据库关系的稳定双向链接。
- 招聘工作流程中的智能体评论使用 Markdown 并包含实体链接。

## 9. 风险和缓解措施

- 风险：通过通用补丁进行权限升级。
  - 缓解措施：隔离特权字段并验证参与者范围。
- 风险：回滚损坏。
  - 缓解措施：之前快照/之后快照 + 事务 + 测试。
- 风险：链接语义不明确。
  - 缓解措施：显式连接表+唯一约束+类型化关系字段。