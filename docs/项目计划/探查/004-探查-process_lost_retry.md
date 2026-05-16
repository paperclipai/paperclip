# 探查：`process_lost_retry`（孤儿 heartbeat run 与一次自动重试）

## 结论摘要

- **`process_lost_retry`** 是 **`agent_wakeup_requests.reason`** 与 **`heartbeat_runs.contextSnapshot.wakeReason`** 上的标记，表示：**上一趟本地子进程已被判定丢失，系统自动排队再跑一趟**（新 run 状态为 **`queued`**，带 `retryOfRunId`、`retryReason: "process_lost"`）。
- **触发入口**：`heartbeatService.reapOrphanedRuns` —— DB 中 `status === "running"`，但当前 API 进程内存里 **没有** `runningProcesses` / `activeRunExecutions` 记录该 run。
- **启动**：`server/src/index.ts` 调用 **`reapOrphanedRuns()`**（**无** `staleThresholdMs`）→ 典型于 **API 重启** 后旧 run 仍标为 `running`。
- **周期**：同一文件内 `setInterval` 调用 **`reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })`** → 仅当 `updatedAt` 早于约 **5 分钟** 才收割，减轻误杀。
- **最多一次自动重试**：`shouldRetry = tracksLocalChild && (processPid || processGroupId) && processLossRetryCount < 1`；第二次再丢则 **`failed` + `process_lost`** 并 **`releaseIssueExecutionAndPromote`**，不再排队 `process_lost_retry`。
- **适配器范围**：`SESSIONED_LOCAL_ADAPTERS`（`isTrackedLocalChildProcessAdapter`）决定「按本地 pid/进程组细判」；**当前集合不含 `qwen_local`** —— 若 Qwen 也会落 `processPid`/`processGroupId`，则仍可能 **`process_lost` 收尾但不会走自动 `process_lost_retry`**（与 cursor/codex 等路径不一致），属后续产品对齐点。

## 代码锚点（本 fork）

| 主题 | 位置 |
|------|------|
| 排队重试（写 `wakeReason: process_lost_retry`） | `server/src/services/heartbeat.ts` — `enqueueProcessLossRetry` |
| 孤儿收割 + `shouldRetry` | 同上 — `reapOrphanedRuns`（约 `6442` 行起） |
| 本地会话适配器集合 | 同上 — `SESSIONED_LOCAL_ADAPTERS`（约 `313` 行起） |
| 启动 / 周期调用 | `server/src/index.ts` — `reapOrphanedRuns()` 与 `reapOrphanedRuns({ staleThresholdMs: … })` |
| 失败文案（含「server may have restarted」） | `server/src/services/heartbeat.ts` — `buildProcessLossMessage` |
| 行为单测 | `server/src/__tests__/heartbeat-process-recovery.test.ts` — 如 `queues exactly one retry when the recorded local pid is dead` |

## 判读：预期 vs 可疑

| 现象 | 倾向 |
|------|------|
| **API 刚重启**后出现 `process_lost` + 一条 `process_lost_retry` 的 queued run | **预期**：旧进程内存丢失，DB 仍 `running` |
| 子进程仍存活但句柄丢了 | 走 **`process_detached`**，**不**当 `process_lost`（见 `reapOrphanedRuns` 中 `processPidAlive` 分支） |
| **同一原 run** 出现 **多条** `process_lost_retry` 子链 | **可疑**：应被 `processLossRetryCount < 1` 挡住，需带 **run id** 查库与日志 |
| 工单已 **`done`/`cancelled`** 仍执行重试 run | **可疑边角**：`enqueueProcessLossRetry` 更新 `issues.executionRunId` 有条件 `executionRunId === 旧 run`；重试 run 仍可能 `queued`，需在具体案例里对 `executeRun` 与 issue 状态交叉验证 |

## 取证（API）

1. 取 **重试 run**：`GET /api/heartbeat-runs/{retryRunId}` —— 看 `contextSnapshot.wakeReason === "process_lost_retry"`、`retryOfRunId`、`retryReason`。  
2. 取 **原 run**：`GET /api/heartbeat-runs/{retryOfRunId}` —— 看 `errorCode`、`processPid`/`processGroupId`、`processLossRetryCount`、`finishedAt`。  
3. 对照 **是否发生过** `pnpm dev:stop`、杀 `node`、崩溃、或 **5 分钟+** 无心跳更新。  
4. 公司维度列表（可选）：`GET /api/companies/{companyId}/heartbeat-runs?agentId={agentId}&limit=100`，在 JSON 中筛 `contextSnapshot.wakeReason`。

## 与 `evaluateScheduledRetryGate` 的关系

**`process_lost_retry` 新 run 直接为 `queued`**，由 `resumeQueuedRuns` → `startNextQueuedRunForAgent` → `executeRun` 驱动；**不是** `scheduled_retry` 状态那条 **`promoteScheduledRetryRun`** 路径，因此 **不会**在晋升时走 `evaluateScheduledRetryGate`（该门控主要服务 `scheduled_retry` / 部分 bounded retry 场景）。

---

**最后更新**：会话探测整理入档（实现以仓库当前 `master` 为准）。
