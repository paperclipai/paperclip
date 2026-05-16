# 探查：agent pause / checkout / recovery 链路与止损结论

**关联执行单：**[`../执行/032-agent-pause止损与heartbeat释放一致性.md`](../执行/032-agent-pause止损与heartbeat释放一致性.md)  
**关联代码提交（本地）：**`7f71fb0`（不向远端推送与否见 `AGENTS.md`）

---

## 1. 现象与控制面目标

故障态下若继续自动派单/recovery，会放大损失。典型体感包括：

- Board **pause agent** 后，queued/running run 被取消，但 issue 侧仍像「占着」checkout 或仍有 pending wakeup；
- **continuation / accepted interaction** 路径被其它 run 或 pause/recovery 打断；
- 源工单 **ROU-60/61** 一类问题在自动 recovery 下长出 **Recover stalled…** / **Unblock liveness…** 等子单，看起来像「编号扩散」。

本轮先在代码侧厘清 **pause → cancel → release → recovery** 的链路，再落地 **最小止损补丁**（见执行单）。

---

## 2. Pause（Board）路径（代码真值）

- `POST /agents/:id/pause`：`svc.pause` 后再调 `heartbeat.cancelActiveForAgent(agentId)`。
- `cancelActiveForAgentInternal`：对该 agent 上处于 **queued / running / scheduled_retry** 的 run：`setRunStatus(cancelled)`、`setWakeupStatus(cancelled)`，并对每个 run 调 **`releaseIssueExecutionAndPromote`**。
- **修复前缺口（已记入执行单）**：  
  - **`checkoutRunId`**：heartbeat 释放路径长期只清 **`executionRunId`**，与 `checkout()` 把二者设为同一 run id 的语义不一致，易产生「执行锁已卸、checkout 仍指向已 terminal/cancelled run」。  
  - **无 `runId` 的 wakeup**：budget agent 暂停会清 pending wakeup；Board pause **曾对 `agent_wakeup_requests` 中 `run_id is null` 的 queued/deferred 未对齐**，残留队列可能在 resume 后再次兑现。
- **Recovery 与 pause**：`reconcileStrandedAssignedIssues` 对 assignee **paused** 会 skip；但若 **release** 路径仍按「cancelled + assignee 不可 invoke」去 **escalate stranded**，会在人为停机时误造 **Recover stalled** ——需在实现上区分 **操作型 cancel** 与 **故障型 stalled**（见执行单）。

---

## 3. `checkoutRunId` vs `executionRunId`（为何不能「一律一起清」）

- **Checkout API** 通常把 **`checkoutRunId` 与 `executionRunId` 设为同一 heartbeat run id**。  
- **process-loss / failed → retry** 路径依赖：**释放 execution 后**，issue 上 **`checkoutRunId` 仍可短暂保留为「原 failed run id」**，以便 harness 语义与重试排队一致（参见 `heartbeat-process-recovery` 相关用例）。  
- 因此：**仅在「cancelled 且与 checkout 同源」时在 `releaseIssueExecutionAndPromote` 内清 checkout**；**failed/timed_out** 等路径不在此处强行清 checkout。  
- **terminal 锁清理**（`clearExecutionRunIfTerminal`，多在重新 checkout 前）：若 **`checkoutRunId === executionRunId`**，可与 execution 一并清掉，避免 PATCH/checkout 被脏 checkout 卡住。

---

## 4. Recovery「扩散」机制（解释多层子单）

两条自动化链路都会 **新建 issue**，叠加后像「从 ROU-60/61 长出 62/63」：

1. **Stranded assigned recovery**：`Recover stalled issue {源标识}`，`parentId` = 源 issue，`originKind` = `stranded_issue_recovery`。  
2. **Issue graph liveness**：可对依赖链再建 **`Unblock liveness incident for {recovery标识}`**，`parentId` 挂在 recovery issue 上，`originKind` = `harness_liveness_escalation`。

已 pause 的 assignee 不会挡住「换一个 invokable owner」建 escalation——停机 playbook 仍建议必要时 **关实例 experimental 的 graph liveness auto recovery**（见实例设置侧文档，此处不展开）。

---

## 5. 观测面与 Board 操作（本轮未交付，留在 backlog）

以下更适合 **产品/Board** 后续迭代，未纳入 commit `7f71fb0`：

| 方向 | 说明 |
|------|------|
| API/UI 显式状态 | paused、canceled run、queued wakeup、**stale checkout**（execution 已空但 checkout 仍指向 terminal run 等）一眼可读 |
| 一键应急 | 「停止该 issue 关联 pending/running runs + 释放同源 checkout」的 board-only 操作（须权限与事务设计） |
| Recovery 闸门 | 公司级/实例级「停机冻结自动 recovery」或「仅 preview 再建单」 |

对应 backlog 见任务清单 **033** 执行单。

---

## 6. 给其他协作者 / GPT 的一句话

**先看执行单与 commit diff**：pause/terminate/budget 的 **操作型 cancelled** 不得触发 stranded escalation；**release** 路径仅在 **cancelled + checkout 同源** 时清 checkout；**failed** 重试语义勿打断。
