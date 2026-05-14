# 探查：ROU-21 完成后仍反复唤醒 CTO

## 现象（来自吴衡）

Board 工单 **ROU-21** 在 **已完成** 后，仍 **多次唤醒 CTO**（`issue_assigned` / 心跳 run 反复排队等体感）。需区分：**正常级联**（子单完成唤醒父单负责人）与 **异常重复**（同一原因、短时间高密度、或已终态仍 `issue_assigned`）。

## 建议取证（Board / API）

1. **活动**  
   `GET /api/companies/{companyId}/activity`（或 Board「活动」）按时间过滤，看 **ROU-21** 与 **CTO agentId** 交叉：`heartbeat.invoked`、`issue.updated`、`issue.comment_added`、`issue.monitor_*`、恢复类 `issue.created` 等。

2. **心跳 run**  
   `GET /api/companies/{companyId}/heartbeat-runs?agentId={ctoId}&limit=50`  
   对照每次 run 的 `contextSnapshot.issueId` / `wakeReason` / `wakeupRequestId` 是否都指向 **ROU-21** 或 **依赖链上的其它单**。

3. **ROU-21 自身字段**  
   `status`、`parentId`、`blockedByIssueIds`、`executionPolicy.monitor`（是否仍 `monitorNextCheckAt`）、`assigneeAgentId` 是否在 **done 之后仍被 PATCH**。

## 代码侧初步结论（本 fork）

### 1. `queueIssueAssignmentWakeup` 未排除终态（已加防御）

`server/src/services/issue-assignment-wakeup.ts` 中，原先仅在 **`backlog` 或无 assignee** 时跳过，**未排除 `done` / `cancelled`**。若任一路径把 **已关闭工单** 仍传入该函数，会 **误发 `issue_assigned` 唤醒**。

**已改**：对 `done`、`cancelled` 直接 return，避免误唤醒。（若未来存在「合法地对终态工单再发 assignment wake」的产品需求，需另开契约，不可静默依赖此路径。）

### 2. PATCH issue + comment 路径（预期行为）

`server/src/routes/issues.ts` 合并唤醒时：

- **关单瞬间**若同时满足 `becameDone`，会对 **`listWakeableBlockedDependents`** 与 **`getWakeableParentAfterChildCompletion`** 命中对象各发唤醒 —— **一次 PATCH 可能唤醒 CTO 多次**，但通常 **issueId 不同**（依赖方 / 父单）。若 ROU-21 是 **父单** 且多个子单同时收尾，体感会像「ROU-21 相关连炸」。
- **评论唤醒**：`skipAssigneeCommentWake = selfComment || isClosed`，其中 `isClosed` 取自 **`existing.status`（更新前）**；若关单与评论不在同一请求内，需看第二次请求时是否仍误判（一般 `existing` 已是 `done` 则会跳过 assignee comment wake）。

### 3. Issue monitor

`tickDueIssueMonitors` / `triggerIssueMonitor` 仅 **`in_progress` / `in_review`**，**不应**对纯 `done` 工单继续排 monitor wake。若 **done 后 monitor 字段未清** 但状态已变，需另查是否有 **状态与 executionPolicy 不同步** 的边角（本次未复现，仅作备选）。

### 4. 恢复 / 生产力回顾 / routine

`recovery/service.ts`、`productivity-review.ts`、`routines.ts` 等路径会 `enqueueWakeup`，多数对 **`done`/`cancelled` 有 SQL 或早退**。若 ROU-21 为 **恢复单** 或 **routine 派生子单**，需在活动日志里对 `originKind` / `wakeReason` 做交叉验证。

## 下一步（产品 / Board）

1. 用上述 API 固定 **ROU-21 + CTO** 的 **时间线 + wakeReason 分布**，确认是 **单次 PATCH 多目标唤醒** 还是 **同一 issueId 重复唤醒**（后者更偏 bug）。  
2. 若确认为 **误发 assignment wake**：本仓库已加 **终态过滤**；部署后复测同一操作是否仍复现。  
3. 若仍存在 **同一 issueId 高密度重复**：继续从 **`enqueueWakeup` 去重 / `idempotencyKey` / 延迟唤醒晋升（deferred wake）** 方向查（需带具体 run id 与堆栈日志再开子任务）。
