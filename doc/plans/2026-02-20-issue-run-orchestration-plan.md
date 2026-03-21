# 任务运行编排计划

## 背景

我们观察到单个任务（例如 PAP-39）上的级联唤醒产生了多个同时运行：

- 来自 `issue_commented` 的负责人自唤醒
- 来自 `issue_comment_mentioned` 的对管理者/CTO 的提及唤醒
- 同一任务上的重叠运行

当前行为是以运行为中心和以智能体为中心的。它在 `heartbeat.wakeup` 中按智能体+任务合并，但不强制每个任务跨所有智能体只有一个活跃执行槽。

## 当前已知情况

- 目前唯一可靠的任务/运行关联是从 `heartbeat_runs.context_snapshot.issueId` 中派生的，运行状态为 `queued` 或 `running`。
- 任务上的 `checkoutRunId` 是工作所有权锁，不是编排锁。
- 唤醒从多个路由创建（`issues`、`approvals`、`agents`），全部通过 `heartbeat.wakeup` 汇聚。

## 目标

1. 当目标智能体与当前活跃任务运行者具有相同的规范化名称时，防止同一任务的自唤醒级联。
2. 允许跨智能体唤醒请求，但在当前任务运行者退出之前不运行它们。
3. 保证每个任务同一时间最多只有一个活跃（排队或运行中）执行所有者。
4. 将此强制执行集中在编排中（不是提示/技能规则）。

## 非目标

- 替换代码变更所有权的签出语义。
- 改变管理者升级策略本身。
- 全局强制智能体名称唯一性（作为单独的治理决策处理）。

## 提议模型

在 `issues` 上使用显式的任务级编排锁。

### 新增任务属性

- `executionRunId: uuid | null`（FK 到 `heartbeat_runs.id`，`ON DELETE SET NULL`）
- `executionAgentNameKey: text | null`（规范化的小写/去空格智能体名称）
- `executionLockedAt: timestamptz | null`

`executionRunId` 是规范的"谁当前拥有此任务编排权"字段。

## 编排规则

### 规则 A：不允许相同智能体名称的自唤醒

如果唤醒是任务范围的，且 `issues.executionRunId` 指向一个活跃运行，其 `executionAgentNameKey` 与唤醒智能体名称键匹配：

- 不创建新的心跳运行
- 将唤醒请求写为 `coalesced`，原因为 `issue_execution_same_name`
- 返回现有运行引用

### 规则 B：不同名称可以唤醒但需等待

如果任务有一个由不同智能体名称键持有的活跃执行锁：

- 接受唤醒请求
- 将请求持久化为延迟（新唤醒状态 `deferred_issue_execution`）
- 暂不创建运行

当活跃任务运行完成时，将该任务的最旧延迟请求提升为排队运行并转移 `executionRunId`。

### 规则 C：每个任务一个活跃执行所有者

对于任务范围的唤醒，运行创建仅在持有任务行事务锁时完成。这确保同一时间只有一个排队/运行中的运行可以成为所有者。

## 实现计划

## 阶段 1：模式 + 共享合约

1. 添加任务列：`execution_run_id`、`execution_agent_name_key`、`execution_locked_at`。
2. 在 `packages/shared/src/types/issue.ts` 中扩展共享 `Issue` 类型。
3. 添加迁移和导出更新。

## 阶段 2：在 `heartbeat.wakeup` 中集中任务执行门控

1. 在 `enqueueWakeup` 中，像今天一样从上下文/负载派生 `issueId`。
2. 如果没有 `issueId`，保持现有行为。
3. 如果 `issueId` 存在：
   - 事务 + `SELECT ... FOR UPDATE` 锁定任务行
   - 解析/修复陈旧的 `executionRunId`（如果引用的运行不是 `queued|running`，清除锁）
   - 应用规则 A/规则 B/规则 C
4. 名称规范化助手：
   - `agentNameKey = agent.name.trim().toLowerCase()`

## 阶段 3：运行完成时的延迟队列提升

1. 在运行终态（`succeeded`、`failed`、`cancelled`、孤儿被回收）时：
   - 如果运行拥有 `issues.executionRunId`，清除任务锁
   - 将该任务的最旧延迟唤醒提升为排队运行
   - 将任务锁设置为提升的运行
   - 触发 `startNextQueuedRunForAgent(promotedAgentId)`

## 阶段 4：路由清理（"全面应用"）

1. 按智能体 id 保持路由端去重，但依赖心跳门控作为事实来源。
2. 确保所有任务相关唤醒调用在负载/上下文快照中包含 `issueId`。
3. 添加显式原因码使日志中的抑制/延迟明显。

## 阶段 5：测试

1. `heartbeat.wakeup` 的单元测试：
   - 相同名称自唤醒被抑制
   - 不同名称唤醒被延迟
   - 所有者完成后锁释放和延迟唤醒被提升
   - 陈旧锁恢复
2. 集成测试：
   - 活跃负责人运行期间的 `@CTO` 评论不创建并发活跃运行
   - 任何时刻每个任务只有一个活跃所有者
3. 回归测试：
   - 非任务唤醒不变
   - 没有任务上下文的任务的现有分配/定时器行为不变

## 遥测 + 可调试性

- 在 `agent_wakeup_requests.reason` 中添加结构化原因：
  - `issue_execution_same_name`
  - `issue_execution_deferred`
  - `issue_execution_promoted`
- 为锁转移事件添加活动日志详情：
  - 从运行 id / 到运行 id / 任务 id / 智能体名称键

## 发布策略

1. 发布模式 + 功能标志（`ISSUE_EXECUTION_LOCK_ENABLED`）默认关闭。
2. 在开发环境启用并验证 PAP-39 类型场景。
3. 在预发布环境启用，高日志详细度。
4. 稳定运行后默认启用。

## 验收标准

1. 单个任务同时永远不会有多于一个活跃执行所有者运行（`queued|running`）。
2. 同一任务的相同名称自唤醒被抑制，不被生成。
3. 不同名称唤醒被接受但延迟，直到任务执行锁被释放。
4. 活跃任务运行期间提及 CTO 不会在该任务上并发启动 CTO。
5. 并行性仍然可以通过单独的任务/子任务实现。

## 后续（单独但相关）

签出冲突逻辑应独立修正，以便 `checkoutRunId = null` 的负责人可以通过当前运行 id 获取签出，而不会出现错误的 409 循环。
