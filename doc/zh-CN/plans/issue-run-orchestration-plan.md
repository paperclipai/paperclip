# 发布运行编排计划

## 上下文

我们观察到单个问题（例如 PAP-39）的级联唤醒同时产生多个运行：

- 受让人从`issue_commented`自我唤醒
- 从 `issue_comment_mentioned` 向经理/CTO 提及唤醒
- 对同一问题的重叠运行

当前的行为是以运行为中心和以智能体为中心的。它合并 `heartbeat.wakeup` 中的每个智能体+任务，但不会在所有智能体之间强制每个问题使用单个活动执行槽。

## 我们今天所知道的

- 今天唯一可靠的问题/运行链接来自运行状态为 `queued` 或 `running` 的 `heartbeat_runs.context_snapshot.issueId`。
- `checkoutRunId` 的问题是工作所有权锁，而不是编排锁。
- 唤醒是从多个路由（`issues`、`approvals`、`agents`）和通过 `heartbeat.wakeup` 的所有漏斗创建的。

## 目标

1. 当目标智能体与当前活动的问题运行程序具有相同的规范化名称时，防止同一问题的自唤醒级联。
2. 允许跨智能体唤醒请求，但在当前问题运行程序退出之前不要运行它们。
3. 保证每个问题一次最多有一个活动（排队或运行）执行所有者。
4. 将这种强制执行集中在编排中（而不是提示/技能规则）。

## 非目标

- 替换代码更改所有权的签出语义。
- 更改经理升级政策本身。
- 在全球范围内强制执行智能体名称的唯一性（作为单独的治理决策处理）。

## 建议模型

在 `issues` 上使用显式问题级编排锁。

### 新发行的房产

- `executionRunId: uuid | null`（FK 至 `heartbeat_runs.id`、`ON DELETE SET NULL`）
- `executionAgentNameKey: text | null`（规范化小写/修剪的智能体名称）
- `executionLockedAt: timestamptz | null`

`executionRunId` 是规范的“谁当前拥有此问题的编排”字段。

## 编排规则

### 规则 A：禁止使用相同智能体名称进行自我唤醒

如果唤醒是问题范围的，并且 `issues.executionRunId` 指向 `executionAgentNameKey` 与唤醒智能体名称键匹配的活动运行：

- 不创建新的心跳运行
- 将唤醒请求写入 `coalesced`，原因为 `issue_execution_same_name`
- 返回现有的运行参考

### 规则 B：不同的名字可能会醒来，但会等待

如果问题具有由不同智能体名称密钥持有的活动执行锁：

- 接受唤醒请求
- 将请求保留为延迟（新的唤醒状态 `deferred_issue_execution`）
- 尚未创建运行

当活动问题运行完成时，将该问题的最早的延迟请求提升到排队运行并传输 `executionRunId`。

### 规则 C：每个问题有一个活跃执行所有者

对于问题范围的唤醒，只有在持有问题行上的事务锁时才能创建运行。这确保一次只有一个排队/正在运行的运行可以成为所有者。

## 实施计划

## 第一阶段：架构 + 共享合约1.添加问题栏：`execution_run_id`、`execution_agent_name_key`、`execution_locked_at`。
2、在`packages/shared/src/types/issue.ts`中扩展共享的`Issue`类型。
3. 添加迁移和导出更新。

## 第 2 阶段：将问题执行门集中在 `heartbeat.wakeup`

1. 在`enqueueWakeup`中，像今天一样从上下文/有效负载中派生`issueId`。
2. 如果没有`issueId`，则保留现有行为。
3、如果`issueId`存在：
   - 问题行上的交易 + `SELECT ... FOR UPDATE`
   - 解决/修复过时的`executionRunId`（如果引用的运行不是`queued|running`，则清除锁定）
   - 应用规则 A/规则 B/规则 C
4. 名称规范化助手：
   - `agentNameKey = agent.name.trim().toLowerCase()`

## 第 3 阶段：运行完成时的延迟队列提升

1. 运行时终端状态（`succeeded`、`failed`、`cancelled`、孤儿收获）：
   - 如果运行拥有`issues.executionRunId`，则清除问题锁定
   - 将最早的延迟问题唤醒提升到排队运行
   - 将问题锁定到升级的运行
   - 触发`startNextQueuedRunForAgent(promotedAgentId)`

## 第 4 阶段：路线卫生（“无处不在”）

1. 通过智能体 ID 保持路由端唤醒重复数据删除，但依赖心跳门作为事实来源。
2. 确保所有与问题相关的唤醒调用在负载/上下文快照中包含 `issueId`。
3. 添加明确的原因代码，以便日志使抑制/延迟变得明显。

## 第 5 阶段：测试

1. `heartbeat.wakeup` 的单元测试：
   - 同名自我唤醒被抑制
   - 不同名称唤醒延迟
   - 所有者完成时释放锁并提升延迟唤醒
   - 过时的锁恢复
2. 集成测试：
   - 在活动受让人运行期间使用 `@CTO` 进行评论不会创建并发活动运行
   - 任何时候每个问题只有一位活跃所有者
3. 回归测试：
   - 非问题唤醒不变
   - 对于没有问题上下文的任务，现有的分配/计时器行为不变

## 遥测+可调试性

- 在`agent_wakeup_requests.reason`中添加结构化原因：
  - `issue_execution_same_name`
  - `issue_execution_deferred`
  - `issue_execution_promoted`
- 添加锁传输事件的活动日志详细信息：
  - 从运行 ID / 到运行 ID / 问题 ID / 智能体名称键

## 推出策略

1. 船舶模式+功能标志（`ISSUE_EXECUTION_LOCK_ENABLED`）默认关闭。
2. 在开发中启用并验证 PAP-39 样式场景。
3. 在暂存中启用高日志详细程度。
4. 稳定运行后默认开启。

## 验收标准

1. 单个问题永远不会有多个活动执行所有者同时运行 (`queued|running`)。
2. 同一问题的同名自唤醒被抑制，而不是产生。
3. 接受不同名称的唤醒，但会推迟到释放执行锁为止。
4. 在活动问题运行期间提及 CTO 不会同时针对该问题启动 CTO。
5. 通过单独的问题/子问题仍然可以实现并行性。

## 后续行动（单独但相关）签出冲突逻辑应独立纠正，以便具有 `checkoutRunId = null` 的受让人可以通过当前运行 ID 获取签出，而不会出现错误 409 循环。