---
id: exec-010-agent-dispatch-reclaim
status: 待办
ledger: ./任务执行台账.md
updated: "2026-05-16T12:00"
---

# 任务 010 — 解决 agent 任务执行的派单和回收问题

**返回：**[`任务执行台账.md`](任务执行台账.md)

---

## 1. 需求

### 要什么

解决 agent 生命周期管理中的三个问题：
1. **僵尸 run**：issue 已 `done`，但 run 状态未同步关闭（仍 `running`）
2. **重复派单**：同一任务产出了两个 issue（标题内容完全一致，ID 不同），一个 checkout 了另一个闲置
3. **裸唤醒**：`on_demand` 唤醒请求没有关联任何 issue，只挂了一句 wakeReason 文字

### 验收直觉

1. issue done → run 自动标记 finished（或至少在下次 heartbeat 时回收）
2. 同一 agent 不允许创建标题完全相同的重复 issue（或创建时做幂等检查）
3. 裸唤醒（无 issueId）不应产生 run，或直接拒绝

---

## 2. 发现过程（2004-05-13 实测）

### 现场数据

Cursor agent `b064fe96`（Composer 2 Fast），routic 公司 `cc098628`，Paperclip 开发项目 `001c415e`。

| Run ID | Issue ID | 标题 | Issue 状态 | Run 状态 | 问题 |
|--------|----------|------|-----------|---------|------|
| `f9c6fd33` | `17af1b45` | ROU-9（packages/shared 探查） | **done** | **running** | 僵尸：issue 5分38秒就跑完了，run 至今 running，processPid 18476 早已消失 |
| `8d4887ae` | 无 | — | — | queued | 裸唤醒：`on_demand/manual`，context 只有 `wakeReason: "模块探查任务 ROU-9"`，无 issueId |
| `21c0be5f` | `3ccfc5cf` | ROU-10 ①（packages/db 探查） | in_progress | queued | 通过 API 创建 + checkout |
| `36c3fa12` | `cfd9e263` | ROU-10 ②（packages/db 探查） | todo | queued | **重复**：标题/描述完全一致，比 ① 早 17 秒创建，未 checkout |

### 时间线

```
15:00:36  ROU-10 ② (cfd9e263) 被创建  ← 来源不明，wakeReason: "issue_assigned"
15:00:53  run 36c3fa12 queued，挂到 ROU-10 ②
15:01:10  ROU-10 ① (3ccfc5cf) 被创建  ← AI 通过 POST /api/issues 创建
15:01:32  run 21c0be5f queued，挂到 ROU-10 ①
15:01:XX  ROU-10 ① checkout → in_progress
    ...   所有 queued run 无人领取（agent 进程不存在）
```

### 根因分析

1. **僵尸 run**：ROU-9 跑完后 agent 进程退出，Paperclip 没有监听进程退出事件来关闭 run。上次 `PATCH agent status=idle` 只改了 agent 表，没碰 run 表。

2. **重复派单**：ROU-10 ② 先于 ① 出现，来源是 `wakeReason: "issue_assigned"`。推测是在 AI 创建 ① 的过程中，assign 操作触发了系统自动生成了一个 issue（或唤醒流程在已有 issue 不存在时 create 了一个）。具体需查 `issue-assignment-wakeup` 服务逻辑。

3. **裸唤醒**：`on_demand` 唤醒调用时只传了 reason 文字，没有 bind 到具体 issue。服务器接受了它并创建了 run，但这个 run 永远无法被正确关联。

---

## 3. 执行方案

### 本轮已落地（编排层，无 UI、无适配器）

1. **裸唤醒（无 issue）** — **HB-010 bare wake**  
   - **`source === "on_demand"`** 且 **`reason` 非空**（trim 后）且 **解析不到 `issueId`**（payload / snapshot / resume 覆盖均无效）→ **不入队**，`agent_wakeup_requests.reason = heartbeat.on_demand_bare_wake`。  
   - **例外**：传统空 body `/heartbeat/invoke`（无 `reason`）仍可入队，避免破坏既有探测/E2E。  
   - 代码：`heartbeat.ts` → `enqueueWakeup`。

2. **僵尸 run（issue 已终态，run 仍 running）** — **HB-010 terminal reconcile**  
   - `heartbeat.reconcileTerminalIssueRunningRuns`：`running` 且 snapshot `issueId` 指向 **`done`/`cancelled`** 的 issue → `cancelRunInternal`（释放执行锁逻辑沿用既有路径）。  
   - **调度**：每次 **`tickTimers`** 开头调用（与定时心跳同节奏）。  
   - 常量消息：`RUN_CANCEL_ISSUE_TERMINAL_WHILE_RUNNING`（`orchestration-invariants.ts`）。

3. **最小验证**：`server/src/__tests__/orchestration-heartbeat-guards.test.ts`。

### 仍未在本轮落地

- **重复 issue（标题完全一致）**：需在 `POST /issues` 或产品策略层单独定幂等规则（避免误伤合法同名）；保留为后续单。

### 参考路径（继续排查时）

- `server/src/services/heartbeat.ts` — `enqueueWakeup` / `claimQueuedRun` / `tickTimers`
- `server/src/services/issue-assignment-wakeup.ts`
- `server/src/routes/agents.ts` — wakeup / invoke
- `server/src/services/run-liveness.ts`

---

## 4. 执行回写

- 2026-05-16：已落地裸唤醒闸门 + 终态 issue 对 running run 的编排回收；Vitest 证据见 `orchestration-heartbeat-guards.test.ts`。**重复 issue** 未改。
