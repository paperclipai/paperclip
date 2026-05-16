# 合订探查：ROU-20、`process_lost_retry`、反复触发与取证最佳实践

本文合并四块内容：**(1)** `process_lost_retry` 报错语义与 **`enqueueProcessLossRetry` 行为**；**(2)** 怎么查「工单 + 相关活动」；**(3)** 反查「每条 run 最后一条挂钩活动」的最佳实践 + **ROU-20 六条 run 结论表**；**(4)** 为何体感「反复触发」、机制是否正常、与「最多重试 / 已完成少打扰」的产品取向。

**取证脚本**（已落地）：`scripts/issue-run-forensics.mjs`（`pnpm issue:forensics`）。**数据快照**：`local_trusted` 下 `routic` 公司 + **ROU-20**（`companyId=cc098628-d91e-4e10-b4e4-000a6c822946`）。

---

## 1）`process_lost_retry`：报错信息与函数行为

### 1.1 你在 run / 活动里看到的「报错」长什么样

| 出现位置 | 典型文案 / 字段 |
|----------|-----------------|
| **原 run**（第一次判死） | `errorCode: "process_lost"`，`error` 常为 **`Process lost -- child pid <n> is no longer running; retrying once`**（仍带 pid 时）；或 **`Process lost -- server may have restarted`**（无 pid 记录时）。 |
| **自动排队出来的重试 run** | `contextSnapshot.wakeReason` = **`"process_lost_retry"`**；`retryReason` = **`"process_lost"`**；`retryOfRunId` 指向**原 run**；`processLossRetryCount` 在原值上 **+1**。 |
| **`agent_wakeup_requests`** | `reason: "process_lost_retry"`，`triggerDetail: "system"`，`source: "automation"`。 |
| **新 run 首条 lifecycle 事件** | **`Queued automatic retry after orphaned child process was confirmed dead`**。 |

以上与 `server/src/services/heartbeat.ts` 中 **`enqueueProcessLossRetry`** / **`appendRunEvent`** 一致。

### 1.2 `enqueueProcessLossRetry` 具体做什么（按执行顺序）

实现锚点：`server/src/services/heartbeat.ts` — `enqueueProcessLossRetry`（约 `4624` 行起）。

1. **读原 run 的 `contextSnapshot`**，取出 `issueId`、`taskKey` 等；`sessionIdBefore` 用于续跑上下文。  
2. **构造新 `contextSnapshot`**：在原快照上合并  
   - `retryOfRunId: <原 run id>`  
   - `wakeReason: "process_lost_retry"`  
   - `retryReason: "process_lost"`  
   （并走 `withRecoveryModelProfileHint` 等既有修饰。）  
3. **事务内**：  
   - 插入 **`agent_wakeup_requests`**（`reason: process_lost_retry`，`status: queued` …）；  
   - 插入 **`heartbeat_runs`**：`status: queued`，`invocationSource: automation`，`retryOfRunId` 同上，`processLossRetryCount` **递增**；  
   - 把 wakeup 行的 **`runId`** 指到新 run；  
   - 若 `issueId` 存在且 **`issues.executionRunId` 仍等于原 run id**，则把 **`executionRunId`** 切到 **新 retry run**（避免指针悬空）。  
4. **事务外**：发 **`heartbeat.run.queued`** live event；写一条 **lifecycle / warn** 事件（英文队列说明）。  

**不在此函数内做的**：不在这里「再判一次工单是否 done」；是否继续跑由后续 **`executeRun`**、排队门控、以及 **`reapOrphanedRuns` 的 `shouldRetry`** 等路径共同决定。

### 1.3 谁在什么条件下会调用它

调用方：**`reapOrphanedRuns`**（同文件约 `6442` 行起）。核心条件（简化）：

- DB 里 run **`status === "running"`**；  
- 当前 API 进程内存 **没有**该 run 的执行句柄（`runningProcesses` / `activeRunExecutions`）；  
- 适配器属于 **`SESSIONED_LOCAL_ADAPTERS`**（本地子进程类）；  
- **`shouldRetry`**：`tracksLocalChild && (processPid || processGroupId) && processLossRetryCount < 1`  
  → **每条「丢进程的原 run」最多自动补 1 次**重试 run（原 + 重试共两趟 CLI 尝试这一链）。  

启动与周期阈值见 `探查-process_lost_retry.md` / `server/src/index.ts`。

---

## 2）怎么查「工单 + 相关活动」——操作指南

### 2.1 最小 API 组合

| 目的 | 请求 |
|------|------|
| 校验公司、拿工单 UUID / `companyId` | `GET /api/issues/{ROU-20或UUID}` |
| 与本工单相关的 **runs**（含 `runId`） | `GET /api/issues/{ref}/runs` |
| 工单维度的 **活动流**（含 `runId` 可能为空） | `GET /api/issues/{ref}/activity` |
| 单条 run 详情（`error` / `contextSnapshot`） | `GET /api/heartbeat-runs/{runId}` |
| 单条 run 事件 + **adapter 提示词** | `GET /api/heartbeat-runs/{runId}/events?limit=200` |

### 2.2 用脚本（推荐，可反复跑）

```sh
# 列 runs（按 createdAt 升序编号 = 第 N 条）
pnpm issue:forensics -- --company <companyUuid> --issue ROU-20

# 工单全部活动（新 → 旧 宽表）
pnpm issue:forensics -- --company <companyUuid> --issue ROU-20 --issue-activity

# 对每条 run：run 摘要 + 该 runId 下「最后一条活动」+ prompt 节选
pnpm issue:forensics -- --company <companyUuid> --issue ROU-20 --reverse-last-per-run

# 深查单条
pnpm issue:forensics -- --company <companyUuid> --issue ROU-20 --run 4
```

**硬规则**：`--company` 必须与 `GET /api/issues/{ref}` 返回的 **`companyId`** 一致，否则脚本直接退出（防串租户）。

更多踩坑见 **`../最佳实践/002-实践-工单运行记录API取证路径.md`**。

---

## 3）最佳实践：反查「每条 run 最后一条挂钩活动」+ ROU-20 六条结论

### 3.1 最佳实践（简版）

1. **先 `runs` 表**：按 **`createdAt` 升序** 定「第 N 条」——与 Board 手写表不一致时 **以脚本表为准**。  
2. **再 `activity`**：按 `runId === 当前 run` 过滤，再按 `createdAt` **升序**，**最后一条**即「与该 run 强绑定」的收尾活动（若为空，说明该 run 未产生带 `runId` 的 mutation）。  
3. **提示词**：只看 **`/events` 里 `adapter.invoke`** 的 `payload.prompt`；不要从 `activity_log` 猜。  
4. **谁发起 vs 谁执行**：  
   - **发起调度**：看 run 的 `invocationSource` / `triggerDetail` / `contextSnapshot.wakeReason`；  
   - **活动行 actor**：看 `activity.actorType:actorId`（可能是 `user:local-board`、`agent:<uuid>`、`system:heartbeat`），**语义不同于**「谁点了运行」。  
5. **时间对不齐**：`system:heartbeat` 的 **`deferred_comment_wake`** 可能出现 **略晚于** `run.finishedAt` 的 `activity` 行 → 当作 **状态机/延迟唤醒交错**，不一定是脚本错。

### 3.2 ROU-20：六条 run ——「最后一条挂钩活动」与执行摘要

下列由 **`pnpm issue:forensics -- … --reverse-last-per-run`** 对照 API 归纳（**Run #4** 在 API 中 **无任何 `runId` 命中活动**，属正常缺口类情况）。

| Run # | `runId` | 终态 / `errorCode` | **该 runId 下最后一条活动**（按 `createdAt`） | **谁执行（OS）** |
|------|---------|-------------------|---------------------------------------------|------------------|
| 1 | `fa42f79f…` | `failed` / `adapter_failed` | `issue.updated`，`system:heartbeat`，`deferred_comment_wake`，`done→todo` reopen | CodeBuddy CLI |
| 2 | `1e367944…` | `failed` / `process_lost`（含 retrying once） | `issue.comment_added`，`user:local-board` | `cursor-agent` |
| 3 | `0607fc70…` | `failed` / `process_lost`（含 retrying once） | `issue.comment_added`，`agent:<开发-Cursor>` | `cursor-agent` |
| 4 | `82eecc3c…` | `failed` / `process_lost`（`process_lost_retry`） | **无**（`activity` 无该 `runId`） | `cursor-agent` |
| 5 | `f7f3c17d…` | `failed` / `process_lost`（`process_lost_retry`） | `issue.updated`，`system:heartbeat`，`deferred_comment_wake` | `cursor-agent` |
| 6 | `f3a91ccf…` | `cancelled` / `agent pause` | `issue.comment_added`，`agent:<开发-Cursor>` | `cursor-agent` |

**提示词**：六条 run 的 `adapter.invoke` 内均为「Execution Contract + AGENTS + Wake Payload + …」长文；脚本用 **`--prompt-excerpt`** 控制节选长度即可。

---

## 4）为什么体感「反复触发」？机制坏了还是预期内？

### 4.1 结论先说清

- **`process_lost_retry` 不是无限循环**：对**同一条原 run**，`processLossRetryCount < 1` 时 **最多排队 1 个**重试 run（见 §1.3）。  
- **ROU-20 上出现两条 `process_lost_retry`**（`82eecc3c…`、`f7f3c17d…`），是因为存在 **两条独立「原 run 丢进程」链**（`1e367944…` 与 `0607fc70…`），**各触发一次**自动重试 —— **符合当前代码设计**，不是「同一条链被重复 enqueue」那种 bug。  
- **额外 CLI 次数**还来自：**assignment**、**issue_reopened_via_comment**、**issue_commented** 等 **正常唤醒路径**；以及 **`deferred_comment_wake`** 在 **`done` 工单上把状态 reopen 到 `todo`** 带来的 **又一次心跳机会** —— 这与「工单已结案但线程上仍有人类评论 / 系统延迟唤醒」强相关，体感会像「怎么又来」，但根因是 **产品规则 + 运维动作** 叠在 **进程不稳定** 之上。

### 4.2 哪些是「正常」、哪些值得产品化收紧

| 现象 | 倾向 |
|------|------|
| API 重启 / 子进程真死 → `process_lost` + **一次** `process_lost_retry` | **预期自愈** |
| `done` 后仍 `issue_commented` / `deferred_comment_wake` reopen | **规则使然**；若希望「done 后零噪音」，要单独立 **门禁**（例如：终态工单不再排 `process_lost_retry` / 不再因纯评论拉起 CLI，除非显式 `resume`）——**属于产品决策**，不是简单修一行就能「又安全又省事」。 |
| 「最多 2 次」CLI（你文中所述） | 当前实现是 **每条原 run 最多 +1 次自动重试**；若你要 **「全工单维度」** 或 **「done 后 0 次」**，需在 **`reapOrphanedRuns` / `enqueueProcessLossRetry` / comment-wake** 几处做 **统一预算**，并写清与 **恢复 / 评论唤醒** 的优先级。 |

### 4.3 与「token 怨气」对齐的工程翻译

- 每一次 **`adapter.invoke`** 都是 **一整包 prompt + 工具环境** 的成本；**多一条独立失败链就多一次 pack**。  
- 若要 **「已完成少检查」**：要把 **「issue 终态」** 纳入 **自动重试** 与 **评论唤醒** 的 **gate**（并明确：会不会误伤「done 后人类又发现必须修」的场景）。

---

## 5）脚本变更记录（本轮）

- 新增 **`--issue-activity`**：打印工单全部活动宽表。  
- 新增 **`--reverse-last-per-run`**：对每条 run 输出 **摘要 + 最后活动 + prompt 节选**；**禁止**与 `--run` / `--run-id` 同时使用。  
- 修正截断尾缀为 **ASCII**，避免 Windows 控制台编码污染 Markdown。

---

## 6）参考文档

- `探查-ROU-20-运行记录.md`  
- `探查-process_lost_retry.md`  
- `../最佳实践/002-实践-工单运行记录API取证路径.md`  

**最后更新**：与脚本 `issue-run-forensics.mjs` 本轮增强同步。
