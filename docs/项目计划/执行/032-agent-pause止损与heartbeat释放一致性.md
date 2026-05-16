---
id: exec-032-agent-pause-heartbeat-release
parent: ../00.项目任务清单.md
legacy_ref: "032"
status: 已完成
updated: "2026-05-16"
---

# 032 — agent pause 止损与 heartbeat 释放一致性

**返回：**[`../00.项目任务清单.md`](../00.项目任务清单.md)  
**探查结论：**[`../探查/018-探查-agent-pause-checkout-recovery链路与止损结论.md`](../探查/018-探查-agent-pause-checkout-recovery链路与止损结论.md)

## 目标

- pause/terminate/budget 停机时减少 **checkout / wakeup / recovery** 链路上的次生损伤。  
- 保持 **failed → process-loss 重试** 场景下 **同源 checkout 可延续** 的既有语义。

## 交付（Git）

- **提交：**`7f71fb0`  
- **文件：**  
  - `server/src/services/heartbeat.ts`  
  - `server/src/services/issues.ts`  
  - `server/src/routes/agents.ts`  
  - `server/src/__tests__/agent-pause-cleanup.test.ts`（新建）

## 行为摘要

1. **`cancelPendingWakeupsForAgentScope`**：`cancelActiveForAgentInternal` 末尾对同一公司/agent 取消 **`run_id is null`** 且状态为 **queued / deferred_issue_execution** 的 wakeup；文案与 **pause/terminate/传入 reason** 或 budget pause 一致。  
2. **`cancelActiveForAgent(agentId, reason?)`**：terminate 路由传入 **`Cancelled due to agent termination`**。  
3. **`cancelBudgetScopeWork(agent)`**：不再二次调用 budget pending wakeup（已由 `cancelActiveForAgentInternal` 内含）。  
4. **`releaseIssueExecutionAndPromote`**：事务内读 DB **`dbRunRow`**；**仅当** run 为 **`cancelled` 且 `checkoutRunId === run.id`** 时与 execution 一并清 **`checkoutRunId`**（failed 等路径保留 checkout）；对 **操作型 control-plane cancel**（pause / termination / budget pause 约定 error 前缀）早返回 **`released`**，避免 stranded escalation；recovery 判定使用 **`runSnapshotForOutcome`**，blocked 结果携带 **`latestRun`**。  
5. **`clearExecutionRunIfTerminal`**：清除 terminal execution 锁时，若 **`checkoutRunId === executionRunId`** 一并清 checkout。

## 验证证据（本地）

```bash
pnpm --filter @paperclipai/server exec vitest run src/__tests__/agent-pause-cleanup.test.ts
pnpm --filter @paperclipai/server exec vitest run src/__tests__/heartbeat-process-recovery.test.ts
pnpm --filter @paperclipai/server exec vitest run src/__tests__/issue-stale-execution-lock-routes.test.ts
pnpm --filter @paperclipai/server typecheck
```

**结论：**上述在本轮开发机上均已通过（嵌入式 Postgres 不可用时会跳过部分套件）。

## 残留 / 下一单

未交付：**观测面**、**一键释放 checkout**、**recovery 产品闸门** → 见 **[033-控制面-issue-run观测与checkout应急操作.md](033-控制面-issue-run观测与checkout应急操作.md)**。
