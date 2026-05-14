# 执行策略：审查和批准工作流

Paperclip 的执行策略系统确保任务以适当的监督级别完成。它不是依靠智能体记住将工作移交给审查，而是**运行时强制执行**审查和批准阶段。

## 概览

执行策略是任何事务上可选的结构化对象，定义了执行者完成工作后必须发生的事情。它支持三层执行：

| 层 | 目的 | 范围 |
|---|---|---|
| **需要评论** | 每个智能体运行必须向事务发回评论 | 运行时不变量（始终开启） |
| **审查阶段** | 审查者检查质量/正确性并可以要求更改 | 每事务，可选 |
| **批准阶段** | 经理/利益相关者给出最终签署 | 每事务，可选 |

这些层组合在一起。事务可以只有审查、只有批准、两者按顺序、或两者都没有（只是需要评论的后备）。

## 数据模型

### 执行策略（事务字段：`executionPolicy`）

```ts
interface IssueExecutionPolicy {
  mode: "normal" | "auto";
  commentRequired: boolean;       // 始终为 true，由运行时强制执行
  stages: IssueExecutionStage[];  // 有序的审查/批准阶段列表
}

interface IssueExecutionStage {
  id: string;                                 // 自动生成的 UUID
  type: "review" | "approval";                // 阶段类型
  approvalsNeeded: 1;                         // 尚未支持多批准
  participants: IssueExecutionStageParticipant[];
}

interface IssueExecutionStageParticipant {
  id: string;
  type: "agent" | "user";
  agentId?: string | null;    // 当类型为 "agent" 时设置
  userId?: string | null;     // 当类型为 "user" 时设置
}
```

参与者可以是智能体或董事会用户。每个阶段可以有多个参与者；运行时选择第一个符合条件的参与者，优先考虑任何明确请求的负责人，同时排除原始执行者。

### 执行状态（事务字段：`executionState`）

跟踪事务当前在其策略工作流中的位置：

```ts
interface IssueExecutionState {
  status: "idle" | "pending" | "changes_requested" | "completed";
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: "review" | "approval" | null;
  currentParticipant: IssueExecutionStagePrincipal | null;
  returnAssignee: IssueExecutionStagePrincipal | null;
  completedStageIds: string[];
  lastDecisionId: string | null;
  lastDecisionOutcome: "approved" | "changes_requested" | null;
}
```

### 执行决策（表：`issue_execution_decisions`）

每个审查/批准操作的审计跟踪：

```ts
interface IssueExecutionDecision {
  id: string;
  companyId: string;
  issueId: string;
  stageId: string;
  stageType: "review" | "approval";
  actorAgentId: string | null;
  actorUserId: string | null;
  outcome: "approved" | "changes_requested";
  body: string;              // 解释决定的必需评论
  createdByRunId: string | null;
  createdAt: Date;
}
```

## 工作流

### 顺利路径：审查 + 批准

```
┌──────────┐    执行者     ┌───────────┐   审查者    ┌───────────┐   批准者    ┌──────┐
│  待处理   │───完成───────▶│ 审核中    │───批准─────▶│ 审核中    │───批准─────▶│ 已完成 │
│ (编码员)  │    工作       │ (QA)      │             │ (CTO)     │             │      │
└──────────┘                └───────────┘             └───────────┘             └──────┘
```

1. **事务创建**，`executionPolicy` 指定审查阶段（例如，QA）和批准阶段（例如，CTO）。
2. **执行者工作** 处于 `进行中` 状态。
3. **执行者转换为 `已完成`** — 运行时拦截此操作：
   - 状态更改为 `审核中`（不是 `已完成`）
   - 事务重新分配给第一个审查者
   - `executionState` 进入审查阶段的 `待处理`
4. **审查者审查** 并转换为 `已完成` 并附评论：
   - 创建决策记录：`{ outcome: "approved" }`
   - 事务保持 `审核中`，重新分配给批准者
   - `executionState` 进入批准阶段
5. **批准者批准** 并转换为 `已完成` 并附评论：
   - 创建决策记录：`{ outcome: "approved" }`
   - `executionState.status` 变为 `已完成`
   - 事务达到实际 `已完成` 状态

### 要求更改流程

```
┌───────────┐   审查者要求   ┌─────────────┐   执行者    ┌───────────┐
│ 审核中    │───更改─────────▶│ 进行中      │───重新提交─▶│ 审核中    │
│ (QA)      │                │ (编码员)    │             │ (QA)      │
└───────────┘                └─────────────┘             └───────────┘
```

1. **审查者要求更改** 通过转换为除 `已完成` 之外的任何状态（通常是 `进行中`），并附上解释需要更改内容的评论。
2. 运行时自动：
   - 设置状态为 `进行中`
   - 重新分配给原始执行者（存储在 `returnAssignee` 中）
   - 设置 `executionState.status` 为 `changes_requested`
3. **执行者进行更改** 并再次转换为 `已完成`。
4. 运行时路由回**同一审查阶段**（不是开始），使用相同的审查者。
5. 此循环继续，直到审查者批准。

### 策略变体

**仅审查**（无批准阶段）：
```json
{
  "stages": [
    { "type": "review", "participants": [{ "type": "agent", "agentId": "qa-agent-id" }] }
  ]
}
```
执行者完成 → 审查者批准 → 完成。

**仅批准**（无审查阶段）：
```json
{
  "stages": [
    { "type": "approval", "participants": [{ "type": "user", "userId": "manager-user-id" }] }
  ]
}
```
执行者完成 → 批准者签署 → 完成。

**多个审查者/批准者：**
每个阶段支持多个参与者。运行时选择一个来操作，排除原始执行者以防止自我审查。

## 需要评论的后备

独立于审查阶段，每个事务绑定的智能体运行必须留下评论。这在运行时级别强制执行：

1. **运行完成** — 运行时检查智能体是否为此运行发布了评论。
2. **如果没有评论**：`issueCommentStatus` 设置为 `retry_queued`，智能体以原因 `missing_issue_comment` 再次唤醒。
3. **如果重试后仍然没有评论**：`issueCommentStatus` 设置为 `retry_exhausted`。不再重试。失败被记录。
4. **如果发布了评论**：`issueCommentStatus` 设置为 `satisfied` 并链接到评论 ID。

这可以防止智能体完成工作但没有留下任何痕迹的静默完成。

### 运行级别跟踪字段

| 字段 | 描述 |
|---|---|
| `issueCommentStatus` | `satisfied`、`retry_queued` 或 `retry_exhausted` |
| `issueCommentSatisfiedByCommentId` | 链接到满足要求的评论 |
| `issueCommentRetryQueuedAt` | 计划重试唤醒的时间戳 |

## 访问控制

- 只有**活动的审查者/批准者**（执行状态中的 `currentParticipant`）可以推进或拒绝当前阶段。
- 非参与者尝试转换事务将收到 `422 无法处理的实体` 错误。
- 批准和更改请求**都需要评论**——空或仅空白的评论将被拒绝。

## API 使用

### 在事务创建时设置执行策略

```bash
POST /api/companies/{companyId}/issues
{
  "title": "实现功能 X",
  "assigneeAgentId": "coder-agent-id",
  "executionPolicy": {
    "mode": "normal",
    "commentRequired": true,
    "stages": [
      {
        "type": "review",
        "participants": [
          { "type": "agent", "agentId": "qa-agent-id" }
        ]
      },
      {
        "type": "approval",
        "participants": [
          { "type": "user", "userId": "cto-user-id" }
        ]
      }
    ]
  }
}
```

如果省略，阶段 ID 和参与者 ID 会自动生成。阶段内的重复参与者会自动去重。没有有效参与者的阶段会被删除。如果没有有效的阶段剩余，策略设置为 `null`。

### 更新现有事务的执行策略

```bash
PATCH /api/issues/{issueId}
{
  "executionPolicy": { ... }
}
```

如果在审查进行中删除策略（`null`），执行状态将被清除，事务将返回给原始执行者。

### 推进阶段（审查者/批准者批准）

活动的审查者或批准者将事务转换为 `已完成` 并附评论：

```bash
PATCH /api/issues/{issueId}
{
  "status": "done",
  "comment": "已审查 — 实现看起来正确，测试通过。"
}
```

运行时确定这是完成工作流还是推进到下一阶段。

### 要求更改

活动的审查者转换为任何非 `已完成` 状态并附评论：

```bash
PATCH /api/issues/{issueId}
{
  "status": "in_progress",
  "comment": "移动端按钮对齐有问题。请修复 flex 容器。"
}
```

运行时自动重新分配给原始执行者。

## UI

### 新事务对话框

创建新事务时，**审查者**和**批准者**按钮与负责人选择器一起出现。单击任一按钮会打开参与者选择器，其中包含：
- "无审查者" / "无批准者"（清除）
- "我"（当前用户）
- 智能体和董事会用户的完整列表

选择会自动构建 `executionState.stages` 数组。

### 事务属性窗格

对于现有事务，属性面板显示可编辑的**审查者**和**批准者**字段。每个阶段可以添加多个参与者。更改通过 API 保存到事务的 `executionPolicy`。

## 设计原则

1. **运行时强制执行，不依赖提示。** 智能体不需要记住移交工作。运行时拦截状态转换并相应路由。
2. **迭代式，而非终端式。** 审查是一个循环（要求更改 → 修改 → 重新审查），而不是一次性门控。系统在重新提交时返回到同一阶段。
3. **灵活的角色。** 参与者可以是智能体或用户。并非每个组织都有"QA"——审查者/批准者模式足够通用，适用于同行审查、经理签署、合规检查或多参与方工作流。
4. **可审计。** 每个决定都记录了操作者、结果、评论和运行 ID。完整的审查历史记录可按事务查询。
5. **保持单一执行不变量。** 审查唤醒和评论重试尊重现有的约束，即每个事务一次只能有一个智能体运行处于活动状态。