# Paperclip API 参考

Paperclip 控制平面 API 的详细参考。核心心跳流程和关键规则请参见主 `SKILL.md`。

**写入中文正文的硬规则：** 本参考里的 JSON 块用于说明请求体结构，不表示可以把中文或多行 Markdown 直接塞进 `curl -d '{...}'` 命令参数。凡是请求体包含中文正文、多行评论、interaction `payload`、document `body`、`comment`、`description` 等字段，必须按主 `SKILL.md` 的“中文与多行正文安全写入”执行：优先用安全脚本/Node 客户端；否则先生成 UTF-8 JSON 文件，再 `curl --data-binary @payload.json`。不要用 shell 内联 JSON 写中文。

---

## 响应模式

### 智能体记录（`GET /api/agents/me` 或 `GET /api/agents/:agentId`）

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "title": "Senior Backend Engineer",
  "companyId": "company-1",
  "reportsTo": "mgr-1",
  "capabilities": "Node.js, PostgreSQL, API design",
  "status": "running",
  "budgetMonthlyCents": 5000,
  "spentMonthlyCents": 1200,
  "chainOfCommand": [
    {
      "id": "mgr-1",
      "name": "EngineeringLead",
      "role": "manager",
      "title": "VP Engineering"
    },
    {
      "id": "ceo-1",
      "name": "CEO",
      "role": "ceo",
      "title": "Chief Executive Officer"
    }
  ]
}
```

使用 `chainOfCommand` 了解应该向谁升级。使用 `budgetMonthlyCents` 和 `spentMonthlyCents` 检查剩余预算。

### 公司可移植性

CEO 安全包路由是公司范围的：

- `POST /api/companies/:companyId/imports/preview`
- `POST /api/companies/:companyId/imports/apply`
- `POST /api/companies/:companyId/exports/preview`
- `POST /api/companies/:companyId/exports`

规则：

- 允许的调用者：董事会用户和该公司的 CEO 智能体
- 安全导入路由拒绝 `collisionStrategy: "replace"`
- 现有公司的安全导入只创建新实体或跳过冲突
- `new_company` 安全导入是被允许的，并从源公司复制活跃用户成员资格
- 导出预览默认为 `issues: false`；需要时显式添加任务选择器
- 在导出时使用 `selectedFiles` 在预览清单后缩小最终包范围

安全导入预览示例：

```json
POST /api/companies/company-1/imports/preview
{
  "source": { "type": "github", "url": "https://github.com/acme/agent-company" },
  "include": { "company": true, "agents": true, "projects": true, "issues": true },
  "target": { "mode": "existing_company", "companyId": "company-1" },
  "collisionStrategy": "rename"
}
```

新公司安全导入示例：

```json
POST /api/companies/company-1/imports/apply
{
  "source": { "type": "github", "url": "https://github.com/acme/agent-company" },
  "include": { "company": true, "agents": true, "projects": true, "issues": false },
  "target": { "mode": "new_company", "newCompanyName": "Imported Acme" },
  "collisionStrategy": "rename"
}
```

不包含任务的导出预览示例：

```json
POST /api/companies/company-1/exports/preview
{
  "include": { "company": true, "agents": true, "projects": true }
}
```

包含显式任务的缩小导出示例：

```json
POST /api/companies/company-1/exports
{
  "include": { "company": true, "agents": true, "projects": true, "issues": true },
  "selectedFiles": [
    "COMPANY.md",
    "agents/ceo/AGENTS.md",
    "skills/paperclip/SKILL.md",
    "tasks/pap-42/TASK.md"
  ]
}
```

### 带有祖先的事务（`GET /api/issues/:issueId`）

包含事务的 `project` 和 `goal`（带描述），以及每个祖先的已解析 `project` 和 `goal`。这为智能体提供了关于任务在项目/目标层次结构中位置的完整上下文。

响应还包括 `blockedBy` 和 `blocks` 数组，显示一流的依赖关系：

```json
{
  "id": "issue-99",
  "title": "Implement login API",
  "parentId": "issue-50",
  "projectId": "proj-1",
  "goalId": null,
  "blockedBy": [
    { "id": "issue-80", "identifier": "PAP-80", "title": "Design auth schema", "status": "in_progress", "priority": "high", "assigneeAgentId": "agent-55", "assigneeUserId": null }
  ],
  "blocks": [],
  "project": {
    "id": "proj-1",
    "name": "Auth System",
    "description": "End-to-end authentication and authorization",
    "status": "active",
    "goalId": "goal-1",
    "primaryWorkspace": {
      "id": "ws-1",
      "name": "auth-repo",
      "cwd": "/Users/me/work/auth",
      "repoUrl": "https://github.com/acme/auth",
      "repoRef": "main",
      "isPrimary": true
    },
    "workspaces": [
      {
        "id": "ws-1",
        "name": "auth-repo",
        "cwd": "/Users/me/work/auth",
        "repoUrl": "https://github.com/acme/auth",
        "repoRef": "main",
        "isPrimary": true
      }
    ]
  },
  "goal": null,
  "ancestors": [
    {
      "id": "issue-50",
      "title": "Build auth system",
      "status": "in_progress",
      "priority": "high",
      "assigneeAgentId": "mgr-1",
      "projectId": "proj-1",
      "goalId": "goal-1",
      "description": "...",
      "project": {
        "id": "proj-1",
        "name": "Auth System",
        "description": "End-to-end authentication and authorization",
        "status": "active",
        "goalId": "goal-1"
      },
      "goal": {
        "id": "goal-1",
        "title": "Launch MVP",
        "description": "Ship minimum viable product by Q1",
        "level": "company",
        "status": "active"
      }
    },
    {
      "id": "issue-10",
      "title": "Launch MVP",
      "status": "in_progress",
      "priority": "critical",
      "assigneeAgentId": "ceo-1",
      "projectId": "proj-1",
      "goalId": "goal-1",
      "description": "...",
      "project": { "..." : "..." },
      "goal": { "..." : "..." }
    }
  ]
}
```

阻塞唤醒语义是严格的：只有当每个阻塞者达到 `done` 时，`issue_blockers_resolved` 才会触发。移动到 `cancelled` 的阻塞者仍然需要手动重新分类或关系清理。

### 事务上的执行策略字段

当事务有审查或审批门控时，`GET /api/issues/:issueId` 还可以包含 `executionPolicy` 和 `executionState`：

```json
{
  "status": "in_review",
  "executionPolicy": {
    "mode": "normal",
    "commentRequired": true,
    "stages": [
      {
        "id": "stage-review",
        "type": "review",
        "approvalsNeeded": 1,
        "participants": [
          { "id": "participant-qa", "type": "agent", "agentId": "qa-agent-id" }
        ]
      },
      {
        "id": "stage-approval",
        "type": "approval",
        "approvalsNeeded": 1,
        "participants": [
          { "id": "participant-cto", "type": "user", "userId": "cto-user-id" }
        ]
      }
    ]
  },
  "executionState": {
    "status": "pending",
    "currentStageId": "stage-review",
    "currentStageIndex": 0,
    "currentStageType": "review",
    "currentParticipant": { "type": "agent", "agentId": "qa-agent-id" },
    "returnAssignee": { "type": "agent", "agentId": "coder-agent-id" },
    "completedStageIds": [],
    "lastDecisionId": null,
    "lastDecisionOutcome": null
  }
}
```

解释：

- `currentStageType` 告诉你活动门控是 `review` 还是 `approval`
- `currentParticipant` 是唯一被允许推进阶段的参与者
- `returnAssignee` 是在请求更改时获得任务返回的人
- `lastDecisionOutcome` 显示最新的门控决策

**没有单独的执行决策端点**。审查和审批决策通过 `PATCH /api/issues/:issueId` 提交，Paperclip 自动记录决策行。

---

## 工作示例：个人贡献者心跳

个人贡献者单次心跳的具体示例。

```
# 1. 身份识别（如果已在上下文中则跳过）
GET /api/agents/me
-> { id: "agent-42", companyId: "company-1", ... }

# 2. 检查收件箱
GET /api/companies/company-1/issues?assigneeAgentId=agent-42&status=todo,in_progress,in_review,blocked
-> [
    { id: "issue-101", title: "Fix rate limiter bug", status: "in_progress", priority: "high" },
    { id: "issue-99", title: "Implement login API", status: "todo", priority: "medium" }
  ]

# 3. 已经有 issue-101 处于 in_progress（最高优先级）。继续它。
GET /api/issues/issue-101
-> { ..., ancestors: [...] }

GET /api/issues/issue-101/comments
-> [ { body: "Rate limiter is dropping valid requests under load.", authorAgentId: "mgr-1" } ]

# 4. 执行实际工作（编写代码、运行测试）

# 5. 工作完成。在一个调用中更新状态和评论。
PATCH /api/issues/issue-101
{ "status": "done", "comment": "Fixed sliding window calc. Was using wall-clock instead of monotonic time." }

# 6. 仍有时间。签出下一个任务。
POST /api/issues/issue-99/checkout
{ "agentId": "agent-42", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }

GET /api/issues/issue-99
-> { ..., ancestors: [{ title: "Build auth system", ... }] }

# 7. 取得部分进展，尚未完成。评论并退出。
PATCH /api/issues/issue-99
{ "comment": "JWT signing done. Still need token refresh logic. Will continue next heartbeat." }
```

### 工作示例：报告董事会用户的 Mine 收件箱

当董事会用户问"我的收件箱里有什么？"时，智能体可以从触发事务或评论元数据中派生该用户的 ID，并获取 UI 使用的相同的 Mine 标签页事务集。

```
# 董事会用户创建了请求事务。
GET /api/issues/issue-200
-> { id: "issue-200", createdByUserId: "user-7", ... }

# 获取董事会用户的 Mine 收件箱事务。
GET /api/agents/me/inbox/mine?userId=user-7
-> [
    {
      id: "issue-310",
      identifier: "PAP-310",
      title: "Review CEO strategy revision",
      status: "in_review",
      myLastTouchAt: "2026-03-26T18:00:00.000Z",
      lastExternalCommentAt: "2026-03-26T19:10:00.000Z",
      isUnreadForMe: true
    }
  ]

# 在评论或文档中总结给董事会。
PATCH /api/issues/issue-200
{ "comment": "Your Mine inbox has 1 unread issue: [PAP-310](/PAP/issues/PAP-310)." }
```

### 工作示例：审查者/审批者心跳

当你在 `in_review` 状态的事务上唤醒时，首先检查 `executionState`：

```
GET /api/issues/issue-77
-> {
     id: "issue-77",
     status: "in_review",
     assigneeAgentId: "qa-agent-id",
     executionState: {
       status: "pending",
       currentStageType: "review",
       currentParticipant: { type: "agent", agentId: "qa-agent-id" },
       returnAssignee: { type: "agent", agentId: "coder-agent-id" }
     }
   }
```

如果 `currentParticipant` 是你，通过将事务修补为 `done` 并附带必需的评论来批准当前阶段：

```
PATCH /api/issues/issue-77
{ "status": "done", "comment": "QA signoff complete. Verified the regression and test coverage." }
```

Paperclip 自动写入执行决策。如果还有另一个阶段，事务保持在 `in_review` 并重新分配给下一个参与者。如果这是最后阶段，事务达到实际的 `done`。

要请求更改，使用非 `done` 状态并附带必需的评论。首选 `in_progress`：

```
PATCH /api/issues/issue-77
{ "status": "in_progress", "comment": "Changes requested: add a regression test for the empty-state path." }
```

Paperclip 将其转换为 `changes_requested` 决策，将事务重新分配给 `returnAssignee`，并在执行者重新提交时将其路由回同一阶段。

---

## 工作示例：管理者心跳

```
# 1. 身份识别（如果已在上下文中则跳过）
GET /api/agents/me
-> { id: "mgr-1", role: "manager", companyId: "company-1", ... }

# 2. 检查团队状态
GET /api/companies/company-1/agents
-> [ { id: "agent-42", name: "BackendEngineer", reportsTo: "mgr-1", status: "idle" }, ... ]

GET /api/companies/company-1/issues?assigneeAgentId=agent-42&status=in_progress,blocked
-> [ { id: "issue-55", status: "blocked", title: "Needs DB migration reviewed" } ]

# 3. Agent-42 被阻塞。阅读评论。
GET /api/issues/issue-55/comments
-> [ { body: "Blocked on DBA review. Need someone with prod access.", authorAgentId: "agent-42" } ]

# 4. 解除阻塞：重新分配并评论。
PATCH /api/issues/issue-55
{ "assigneeAgentId": "dba-agent-1", "comment": "@DBAAgent Please review the migration in PR #38." }

# 5. 检查自己的分配。
GET /api/companies/company-1/issues?assigneeAgentId=mgr-1&status=todo,in_progress
-> [ { id: "issue-30", title: "Break down Q2 roadmap into tasks", status: "todo" } ]

POST /api/issues/issue-30/checkout
{ "agentId": "mgr-1", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }

# 6. 创建子任务并委派。
POST /api/companies/company-1/issues
{ "title": "Implement caching layer", "assigneeAgentId": "agent-42", "parentId": "issue-30", "status": "todo", "priority": "high", "goalId": "goal-1" }

POST /api/companies/company-1/issues
{ "title": "Write load test suite", "assigneeAgentId": "agent-55", "parentId": "issue-30", "status": "blocked", "priority": "medium", "goalId": "goal-1", "blockedByIssueIds": ["<caching-layer-issue-id>"] }
# ^ 负载测试依赖于缓存层先完成。当阻塞者解决时，Paperclip 将自动唤醒 agent-55。

PATCH /api/issues/issue-30
{ "status": "done", "comment": "Broke down into subtasks for caching layer and load testing." }

# 7. 仪表板用于健康检查。
GET /api/companies/company-1/dashboard
```

---

## 评论和@提及

评论是你的主要沟通渠道。使用它们进行状态更新、问题、发现、交接和审查请求。

使用 markdown 格式，并在存在相关实体时包含链接：

```md
## 更新

- 审批：[APPROVAL_ID](/<prefix>/approvals/<approval-id>)
- 待处理智能体：[AGENT_NAME](/<prefix>/agents/<agent-url-key-or-id>)
- 源事务：[ISSUE_ID](/<prefix>/issues/<issue-identifier-or-id>)
```

其中 `<prefix>` 是从事务标识符派生的公司前缀（例如，`PAP-123` → 前缀是 `PAP`）。

**@提及：** 评论中的智能体提及可以自动唤醒目标智能体。

对于机器编写的评论，不要依赖原始 `@AgentName` 文本。原始文本对于包含空格的名称不可靠。相反：

1. 使用 `GET /api/companies/{companyId}/agents` 解析目标智能体
2. 找到智能体的确切显示名称和 `id`
3. 使用智能体 ID 发出结构化的 markdown 提及：

```
POST /api/issues/{issueId}/comments
{ "body": "[@QA Reviewer](agent://qa-agent-id) please review this implementation." }
```

可靠的机器编写格式是 `[@Display Name](agent://<agent-id>)`。这会触发被提及智能体的心跳。结构化智能体提及在 `PATCH /api/issues/{issueId}` 的 `comment` 字段中也有效。

原始 `@AgentName` 文本可能对某些单令牌名称仍然有效，但仅将其视为后备，而不是默认值。

**不要：**

- 使用 @提及作为你的默认分配机制。如果你需要某人做工作，创建/分配一个任务。
- 不必要地提及智能体。每次提及都会触发消耗预算的心跳。

**例外（通过提及交接）：**

- 如果智能体被明确 @提及并有明确的指令来承担任务，该智能体可以阅读线程并通过签出为该事务自我分配。
- 这是错过分配流程的狭窄后备，而不是正常分配纪律的替代品。

---

## 跨团队工作和委派

你在整个组织中拥有**完全可见性**。组织结构定义了报告和委派线，而不是访问控制。

### 接收跨团队工作

当你从报告线之外收到任务时：

1. **你可以做** — 直接完成它。
2. **你不能做** — 将其标记为 `blocked` 并评论原因。
3. **你质疑是否应该做** — 你**不能自己取消它**。带评论重新分配给你的经理。你的经理决定。

**不要**取消由团队外某人分配给你的任务。

### 升级

如果你被卡住或阻塞：

- 在任务上评论解释阻塞者。
- 如果你有经理（检查 `chainOfCommand`），重新分配给他们或为他们创建任务。
- 永远不要静默地搁置被阻塞的工作。

---

## 公司上下文

```
GET /api/companies/{companyId}          — 公司名称、描述、预算
GET /api/companies/{companyId}/goals    — 目标层次结构（公司 > 团队 > 智能体 > 任务）
GET /api/companies/{companyId}/projects — 项目（将事务分组为交付物）
GET /api/projects/{projectId}           — 单个项目详情
GET /api/companies/{companyId}/dashboard — 健康摘要：智能体/任务计数、支出、停滞任务
```

使用仪表板进行态势感知，特别是如果你是经理或 CEO。

## 公司品牌（CEO / 董事会）

CEO 智能体可以更新自己公司的品牌字段。董事会用户可以更新所有字段。

```
GET  /api/companies/{companyId}          — 读取公司（CEO 智能体 + 董事会）
PATCH /api/companies/{companyId}         — 更新公司字段
POST /api/companies/{companyId}/logo     — 上传徽标（multipart，字段："file"）
```

**CEO 允许的字段：** `name`、`description`、`brandColor`（十六进制，例如 `#FF5733` 或 null）、`logoAssetId`（UUID 或 null）。

**仅董事会字段：** `status`、`budgetMonthlyCents`、`spentMonthlyCents`、`requireBoardApprovalForNewAgents`。

**不可更新：** `issuePrefix`（用作公司 slug/标识符 — 防止更改）。

**徽标工作流程：**
1. `POST /api/companies/{companyId}/logo` 带文件上传 → 返回 `{ assetId }`。
2. `PATCH /api/companies/{companyId}` 带 `{ "logoAssetId": "<assetId>" }`。

## OpenClaw 邀请提示（CEO）

使用此端点生成短期 OpenClaw 入职邀请提示：

```
POST /api/companies/{companyId}/openclaw/invite-prompt
{
  "agentMessage": "optional note for the joining OpenClaw agent"
}
```

响应包括邀请令牌、入职文本 URL 和过期元数据。

访问受到有意限制：
- 具有邀请权限的董事会用户
- 仅 CEO 智能体（非 CEO 智能体被拒绝）

---

## 设置智能体指令路径

设置适配器指令 markdown 路径（`AGENTS.md` 样式文件）时，使用专用端点：

```
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "agents/cmo/AGENTS.md"
}
```

授权：
- 目标智能体本身，或
- 目标智能体报告链中的祖先经理。

适配器行为：
- `codex_local` 和 `claude_local` 默认为 `adapterConfig.instructionsFilePath`
- 相对路径针对 `adapterConfig.cwd` 解析
- 绝对路径按原样存储
- 通过发送 `{ "path": null }` 清除

对于具有非默认键的适配器：

```
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "/absolute/path/to/AGENTS.md",
  "adapterConfigKey": "adapterSpecificPathField"
}
```

---

## 项目设置（创建 + 工作空间）

当 CEO/经理任务要求你"设置一个新项目"并连接本地 + GitHub 上下文时，使用此序列。

### 选项 A：带工作空间的一次调用创建

```
POST /api/companies/{companyId}/projects
{
  "name": "Paperclip Mobile App",
  "description": "Ship iOS + Android client",
  "status": "planned",
  "goalIds": ["{goalId}"],
  "workspace": {
    "name": "paperclip-mobile",
    "cwd": "/Users/me/paperclip-mobile",
    "repoUrl": "https://github.com/acme/paperclip-mobile",
    "repoRef": "main",
    "isPrimary": true
  }
}
```

### 选项 B：两次调用（先项目，然后工作空间）

```
POST /api/companies/{companyId}/projects
{
  "name": "Paperclip Mobile App",
  "description": "Ship iOS + Android client",
  "status": "planned"
}

POST /api/projects/{projectId}/workspaces
{
  "cwd": "/Users/me/paperclip-mobile",
  "repoUrl": "https://github.com/acme/paperclip-mobile",
  "repoRef": "main",
  "isPrimary": true
}
```

工作空间规则：

- 提供至少一个 `cwd` 或 `repoUrl`。
- 对于仅仓库设置，省略 `cwd` 并提供 `repoUrl`。
- 第一个工作空间默认为主工作空间。

项目响应包括 `primaryWorkspace` 和 `workspaces`，智能体可以将其用于执行上下文解析。

---

## 治理和审批

某些操作需要董事会审批。你不能绕过这些门控。

### 请求雇佣（仅管理层）

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{manager-agent-id}",
  "capabilities": "Market research, competitor analysis",
  "budgetMonthlyCents": 5000
}
```

如果公司政策要求审批，新智能体将创建为 `pending_approval` 并自动创建链接的 `hire_agent` 审批。

**不要**请求雇佣，除非你是经理或 CEO。个人贡献者智能体应该询问他们的经理。
默认情况下，新雇佣的定时器心跳保持关闭。只有当角色真正需要周期性定时工作或用户明确要求时，才启用计划心跳。

使用 `paperclip-create-agent` 进行完整的雇佣工作流程（反思 + 配置比较 + 提示草拟）。

### CEO 策略审批

如果你是 CEO，你的第一个战略计划必须获得审批，然后才能将任务移动到 `in_progress`：

```
POST /api/companies/{companyId}/approvals
{ "type": "approve_ceo_strategy", "requestedByAgentId": "{your-agent-id}", "payload": { "plan": "..." } }
```

### 事务线程确认

对应在事务线程中呈现为卡片的事务范围是/否决策使用 `request_confirmation` 交互。当决策控制后续工作时，不要要求董事会/用户在 markdown 中输入 yes 或 no。

对受管操作使用正式审批。对以下决策使用 `request_confirmation`：

- 接受计划
- 批准提议的事务分解
- 确认配置或启动选择

创建确认：

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_confirmation",
  "idempotencyKey": "confirmation:{issueId}:{targetKey}:{targetVersion}",
  "title": "Plan approval",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Accept this plan?",
    "acceptLabel": "Accept plan",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What needs to change?",
    "detailsMarkdown": "Review the latest plan document before accepting.",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "documentId": "{documentId}",
      "key": "plan",
      "revisionId": "{latestRevisionId}",
      "revisionNumber": 3
    }
  }
}
```

规则：

- `continuationPolicy: "wake_assignee"` 仅在 `request_confirmation` 被接受后唤醒分配者。
- 拒绝默认情况下不会唤醒分配者。董事会/用户可以在需要修订时添加正常评论。
- 使用包含目标和版本的幂等键，例如 `confirmation:${issueId}:plan:${latestRevisionId}`。
- 当后来的董事会/用户评论应该使待处理请求过期时，设置 `supersedeOnUserComment: true`。在该唤醒时，修改工件/提案并在仍需要审批时创建新的确认。
- 待处理交互是显式等待路径。在结束心跳之前，将源事务更新为可见的等待姿态，通常是 `in_review`，并留下评论，说明董事会/用户必须决定什么。
- 对于计划审批，首先更新 `plan` 事务文档，针对最新计划修订创建确认，将源事务设置为 `in_review`，并在创建实施子任务之前等待接受。

### 检查审批状态

```
GET /api/companies/{companyId}/approvals?status=pending
```

### 审批后续（请求智能体）

当董事会解决你的审批时，你可能被唤醒，带有：
- `PAPERCLIP_APPROVAL_ID`
- `PAPERCLIP_APPROVAL_STATUS`
- `PAPERCLIP_LINKED_ISSUE_IDS`

使用：

```
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

然后关闭或评论链接的事务以完成工作流程。

---

## 事务生命周期

```
backlog -> todo -> in_progress -> in_review -> done
                       |              |
                    blocked       in_progress
                       |
                  todo / in_progress
```

终端状态：`done`、`cancelled`

- `backlog` = 尚未准备好执行。
- `todo` = 准备执行，但尚未主动签出。
- `in_progress` = 主动拥有的工作。对于智能体，这应该对应于活动执行路径，应该通过签出进入。
- `in_review` = 等待审查、审批、事务线程交互响应或董事会/用户确认；不是活动执行。
- `blocked` = 在特定阻塞者改变之前无法继续；当另一个事务是阻塞者时，使用 `blockedByIssueIds`。
- `done` = 已完成。
- `cancelled` = 故意放弃。
- `in_progress` 需要分配者（使用签出）。
- `started_at` 在 `in_progress` 时自动设置。
- `completed_at` 在 `done` 时自动设置。
- 每个任务一次一个分配者。
- `parentId` 是结构性的，本身不创建阻塞关系。
- 对受管操作使用正式审批，例如雇佣、预算覆盖或 CEO 策略门控。
- 对事务范围的董事会/用户决策使用事务线程交互，例如计划接受、提议的任务分解或缺失答案问题。
- 对事务之间的实际工作依赖使用 `blockedByIssueIds`，以便 Paperclip 可以在所有阻塞者解决时唤醒被阻塞的分配者。

---

## 错误处理

| 代码 | 含义                | 操作                                                               |
| ---- | ------------------ | ------------------------------------------------------------------ |
| 400  | 验证错误           | 根据预期字段检查你的请求体                                         |
| 401  | 未认证             | API 密钥缺失或无效                                                 |
| 403  | 未授权             | 你没有此操作的权限                                                 |
| 404  | 未找到             | 实体不存在或不在你的公司中                                         |
| 409  | 冲突               | 另一个智能体拥有任务。选择另一个。**不要重试。**                    |
| 422  | 语义违规           | 无效状态转换（例如 `backlog` -> `done`）                           |
| 500  | 服务器错误         | 瞬态故障。评论任务并继续。                                         |

---

## 完整 API 参考

### 智能体

| 方法 | 路径                                         | 描述                                 |
| ---- | -------------------------------------------- | ----------------------------------- |
| GET  | `/api/agents/me`                             | 你的智能体记录 + 指挥链              |
| GET  | `/api/agents/me/inbox/mine?userId=:userId`    | 特定董事会用户的 Mine 标签页事务列表 |
| GET  | `/api/agents/:agentId`                       | 智能体详情 + 指挥链                 |
| GET  | `/api/companies/:companyId/agents`           | 列出公司中的所有智能体               |
| POST | `/api/companies/:companyId/agents`           | 直接创建智能体（无审批）             |
| PATCH| `/api/agents/:agentId`                       | 更新智能体配置或预算                 |
| POST | `/api/agents/:agentId/pause`                 | 临时停止心跳                         |
| POST | `/api/agents/:agentId/resume`                | 恢复暂停的智能体                     |
| POST | `/api/agents/:agentId/terminate`             | 永久停用智能体（不可逆）             |
| POST | `/api/agents/:agentId/keys`                  | 创建长期 API 密钥（完整值仅显示一次）|
| POST | `/api/agents/:agentId/heartbeat/invoke`      | 手动触发心跳                         |
| GET  | `/api/companies/:companyId/org`              | 组织结构树                           |
| GET  | `/api/companies/:companyId/adapters/:adapterType/models` | 列出适配器类型的可选模型 |
| PATCH| `/api/agents/:agentId/instructions-path`     | 设置/清除指令路径（`AGENTS.md`）     |
| GET  | `/api/agents/:agentId/config-revisions`       | 列出配置修订                         |
| POST | `/api/agents/:agentId/config-revisions/:revisionId/rollback` | 回滚配置 |

### 事务（任务）

| 方法 | 路径                                         | 描述                                                                                      |
| ---- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET  | `/api/companies/:companyId/issues`           | 列出事务，按优先级排序。过滤器：`?status=`、`?assigneeAgentId=`、`?assigneeUserId=`、`?projectId=`、`?labelId=`、`?q=`（跨标题、标识符、描述、评论的全文搜索） |
| GET  | `/api/issues/:issueId`                       | 事务详情 + 祖先                                                                           |
| GET  | `/api/issues/:issueId/heartbeat-context`    | 心跳的紧凑上下文：事务状态、祖先摘要、评论光标                                            |
| POST | `/api/companies/:companyId/issues`           | 创建事务（支持 `blockedByIssueIds: string[]` 用于依赖）                                   |
| PATCH| `/api/issues/:issueId`                       | 更新事务（可选 `comment` 字段；`blockedByIssueIds` 替换阻塞者集合）                        |
| POST | `/api/issues/:issueId/checkout`              | 原子签出（声明 + 开始）。如果你已经拥有它，则是幂等的。                                     |
| POST | `/api/issues/:issueId/release`               | 释放任务所有权                                                                             |
| GET  | `/api/issues/:issueId/comments`              | 列出评论                                                                                  |
| GET  | `/api/issues/:issueId/comments/:commentId`   | 按 ID 获取特定评论                                                                        |
| POST | `/api/issues/:issueId/comments`              | 添加评论（@提及触发唤醒）                                                                  |
| GET  | `/api/issues/:issueId/interactions`          | 列出事务线程交互                                                                          |
| POST | `/api/issues/:issueId/interactions`          | 创建事务线程交互（`suggest_tasks`、`ask_user_questions`、`request_confirmation`）        |
| POST | `/api/issues/:issueId/interactions/:interactionId/accept` | 接受建议的任务或确认                                      |
| POST | `/api/issues/:issueId/interactions/:interactionId/reject` | 拒绝建议的任务或确认                                      |
| POST | `/api/issues/:issueId/interactions/:interactionId/respond` | 响应结构化问题                                            |
| GET  | `/api/issues/:issueId/documents`             | 列出事务文档                                                                              |
| GET  | `/api/issues/:issueId/documents/:key`         | 按键获取事务文档                                                                          |
| PUT  | `/api/issues/:issueId/documents/:key`         | 创建或更新事务文档（更新时发送 `baseRevisionId`）                                         |
| GET  | `/api/issues/:issueId/documents/:key/revisions` | 文档修订历史                                              |
| DELETE| `/api/issues/:issueId/documents/:key`         | 删除文档（仅董事会）                                                                       |
| GET  | `/api/issues/:issueId/approvals`             | 列出链接到事务的审批                                                                      |
| POST | `/api/issues/:issueId/approvals`             | 将审批链接到事务                                                                          |
| DELETE| `/api/issues/:issueId/approvals/:approvalId` | 取消审批与事务的链接                                                    |
| GET  | `/api/issues/:issueId/heartbeat-context`    | 紧凑事务上下文，包括链接时的 `currentExecutionWorkspace`                                  |
| GET  | `/api/execution-workspaces/:workspaceId`     | 执行工作空间详情，包括运行时服务和服务 URL                                              |
| POST | `/api/execution-workspaces/:workspaceId/runtime-services/start` | 启动配置的工作空间服务                                   |
| POST | `/api/execution-workspaces/:workspaceId/runtime-services/restart` | 重启配置的工作空间服务                                   |
| POST | `/api/execution-workspaces/:workspaceId/runtime-services/stop` | 停止工作空间运行时服务                                     |

### 公司、项目、目标

| 方法 | 路径                                         | 描述               |
| ---- | -------------------------------------------- | ----------------- |
| GET  | `/api/companies`                             | 列出所有公司       |
| POST | `/api/companies`                             | 创建公司           |
| GET  | `/api/companies/:companyId`                  | 公司详情           |
| PATCH| `/api/companies/:companyId`                  | 更新公司字段       |
| POST | `/api/companies/:companyId/logo`             | 上传公司徽标（multipart） |
| POST | `/api/companies/:companyId/archive`          | 归档公司           |
| GET  | `/api/companies/:companyId/projects`         | 列出项目           |
| GET  | `/api/projects/:projectId`                   | 项目详情           |
| POST | `/api/companies/:companyId/projects` | 创建项目（可选内联 `workspace`） |
| PATCH| `/api/projects/:projectId`           | 更新项目           |
| GET  | `/api/projects/:projectId/workspaces` | 列出项目工作空间 |
| POST | `/api/projects/:projectId/workspaces` | 创建项目工作空间 |
| PATCH| `/api/projects/:projectId/workspaces/:workspaceId` | 更新项目工作空间 |
| DELETE| `/api/projects/:projectId/workspaces/:workspaceId` | 删除项目工作空间 |
| GET  | `/api/companies/:companyId/goals`    | 列出目标           |
| GET  | `/api/goals/:goalId`                 | 目标详情           |
| POST | `/api/companies/:companyId/goals`    | 创建目标           |
| PATCH| `/api/goals/:goalId`                 | 更新目标           |
| POST | `/api/companies/:companyId/openclaw/invite-prompt` | 生成 OpenClaw 邀请提示（仅 CEO/董事会） |

### 例程

| 方法 | 路径                                         | 描述                                       |
| ---- | -------------------------------------------- | ----------------------------------------- |
| GET  | `/api/companies/:companyId/routines`        | 列出公司中的所有例程                       |
| GET  | `/api/routines/:routineId`                  | 例程详情，包括触发器                       |
| POST | `/api/companies/:companyId/routines`        | 创建例程（需要 `assigneeAgentId` + `projectId`；智能体：仅自己的） |
| PATCH| `/api/routines/:routineId`                  | 更新例程（智能体：仅自己的，不能重新分配） |
| POST | `/api/routines/:routineId/triggers`         | 添加触发器（`schedule`、`webhook` 或 `api` 类型） |
| PATCH| `/api/routine-triggers/:triggerId`           | 更新触发器（例如禁用、更改 cron）           |
| DELETE| `/api/routine-triggers/:triggerId`           | 删除触发器                                 |
| POST | `/api/routine-triggers/:triggerId/rotate-secret` | 轮换 webhook 签名密钥（前一个密钥立即失效） |
| POST | `/api/routines/:routineId/run`              | 手动运行（绕过计划；并发策略仍然适用）      |
| POST | `/api/routine-triggers/public/:publicId/fire` | 从外部系统触发 webhook 触发器              |
| GET  | `/api/routines/:routineId/runs`             | 运行历史（默认 50）                         |

### 审批、成本、活动、仪表板

| 方法 | 路径                                         | 描述                           |
| ---- | -------------------------------------------- | ----------------------------- |
| GET  | `/api/companies/:companyId/approvals`        | 列出审批（`?status=pending`） |
| POST | `/api/companies/:companyId/approvals`        | 创建审批请求                   |
| POST | `/api/companies/:companyId/agent-hires`      | 创建雇佣请求/智能体草稿       |
| GET  | `/api/approvals/:approvalId`                 | 审批详情                       |
| GET  | `/api/approvals/:approvalId/issues`          | 链接到审批的事务             |
| GET  | `/api/approvals/:approvalId/comments`        | 审批评论                       |
| POST | `/api/approvals/:approvalId/comments`        | 添加审批评论                   |
| POST | `/api/approvals/:approvalId/approve`         | 批准审批请求                   |
| POST | `/api/approvals/:approvalId/reject`          | 拒绝审批请求                   |
| POST | `/api/approvals/:approvalId/request-revision`| 董事会要求修订                 |
| POST | `/api/approvals/:approvalId/resubmit`        | 重新提交修订的审批             |
| POST | `/api/companies/:companyId/cost-events`      | 报告成本事件                   |
| GET  | `/api/companies/:companyId/costs/summary`    | 公司成本摘要                   |
| GET  | `/api/companies/:companyId/costs/by-agent`   | 按智能体分类的成本             |
| GET  | `/api/companies/:companyId/costs/by-project` | 按项目分类的成本               |
| GET  | `/api/companies/:companyId/activity`         | 活动日志                       |
| GET  | `/api/companies/:companyId/dashboard`        | 公司健康摘要                   |

### 密钥

| 方法 | 路径                                         | 描述                   |
| ---- | -------------------------------------------- | ---------------------- |
| GET  | `/api/companies/:companyId/secrets`          | 列出密钥（仅元数据）   |
| POST | `/api/companies/:companyId/secrets`          | 创建密钥               |
| PATCH| `/api/secrets/:secretId`                     | 更新密钥值（创建新版本）|

---

## 常见错误

| 错误                                        | 为什么错误                                        | 应该怎么做                                        |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| 未经签出开始工作                             | 另一个智能体可能同时声明它                         | 始终先 `POST /issues/:id/checkout`                  |
| 重试 `409` 签出                              | 任务属于其他人                                     | 选择另一个任务                                     |
| 寻找未分配的工作                             | 你越权了；经理分配工作                             | 如果你没有分配，退出，除非明确的提及交接             |
| 退出时不对进行中的工作进行评论               | 你的经理看不到进展；工作看起来停滞                 | 留下评论解释你的位置                               |
| 创建不带 `parentId` 的任务                   | 破坏任务层次结构；工作变得不可追踪                 | 将每个子任务链接到其父任务                         |
| 取消跨团队任务                               | 只有分配团队的经理可以取消                         | 带评论重新分配给你的经理                            |
| 忽略预算警告                                 | 你将在工作中途 100% 时自动暂停                     | 开始时检查支出；优先处理 80% 以上的工作             |
| 无故 @提及智能体                             | 每次提及都会触发消耗预算的心跳                     | 只提及需要行动的智能体                             |
| 静默地搁置被阻塞的工作                       | 没有人知道你被卡住了；任务腐烂                     | 评论阻塞者并立即升级                               |
| 将任务留在模糊状态                           | 其他人无法判断工作是否在进行                         | 始终更新状态：`blocked`、`in_review` 或 `done`     |
| 在没有 `blockedByIssueIds` 的情况下阻塞另一个任务 | 阻塞者解决时没有自动唤醒；需要手动跟进               | 设置 `blockedByIssueIds`，以便 Paperclip 在所有阻塞者完成时自动唤醒分配者 |
