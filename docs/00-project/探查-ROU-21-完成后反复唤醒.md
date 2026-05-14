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

---

## 探查活动实践方案（可照抄执行）

**目的**：把「体感上 ROU-21 还在折腾 CTO」落成 **可对比的时间线**，并区分 **级联（多张单）** 与 **同一 issueId 误重复**。

### 0）前置（一次记在备忘录）

| 变量 | 怎么拿 |
|------|--------|
| `BASE` | 一般为 `http://127.0.0.1:3100/api`（按你实例改主机/端口） |
| `COMPANY_ID` | Board 当前公司，或 `GET {BASE}/companies` 里对应公司的 `id`（UUID） |
| `ISSUE_REF` | 人类可读标识 **`ROU-21`**，或该单的 **UUID**（两条都支持） |
| `CTO_AGENT_ID` | `GET {BASE}/companies/{COMPANY_ID}/agents` 里 CTO 行的 `id` |

**身份**：以下 `GET` 需 **Board 已登录** 的会话。最省事的做法是在 **已登录 Board 的浏览器** 里打开 DevTools → **Network**，对任一 API 请求 **Copy as cURL**，把其中的 `Cookie:` 头复用到下面命令；不要把手抄的 Cookie 贴进公开仓库或聊天。

### A）工单活动（看 ROU-21 自身发生了什么）

```http
GET {BASE}/issues/{ISSUE_REF}/activity
```

关注关单前后：`issue.updated`、`issue.comment_added`、与 assignee/唤醒相关的条目；`details` 里是否仍出现 **终态后不该有的 assign 动作**。

### B）公司活动（按 CTO 或按工单实体缩小范围）

```http
GET {BASE}/companies/{COMPANY_ID}/activity?agentId={CTO_AGENT_ID}&limit=200
```

若已知 ROU-21 的 **issue UUID**，可再加实体过滤（减少噪音）：

```http
GET {BASE}/companies/{COMPANY_ID}/activity?entityType=issue&entityId={ROU21_ISSUE_UUID}&limit=200
```

### C）工单关联 runs（轻量对照）

```http
GET {BASE}/issues/{ISSUE_REF}/runs
```

用于看「哪些 run 与这张单关联、时间顺序」，再与 D）交叉。

### D）CTO 心跳 run 列表（**核心表**）

```http
GET {BASE}/companies/{COMPANY_ID}/heartbeat-runs?agentId={CTO_AGENT_ID}&limit=50
```

`limit` 可选，最大 **1000**（见 `server/src/routes/agents.ts`）。

**建议抄表字段**（每条 run 一行）：`id`、`createdAt`、`status`、`invocationSource`、`triggerDetail`（若有）、`contextSnapshot.issueId`、`contextSnapshot.wakeReason`、`contextSnapshot.wakeSource`、`wakeupRequestId`（若 JSON 里有）。

### E）单条 run 深查（怀疑重复时）

```http
GET {BASE}/heartbeat-runs/{runId}
```

看完整 `contextSnapshot`、错误/重试信息；对比多条 run 是否 **同一 `wakeupRequestId` 或同一 `wakeReason` + 同一 `issueId` 秒级连发**。

### F）仅排队 / 运行中（看「现在是否还在打 CTO」）

```http
GET {BASE}/companies/{COMPANY_ID}/live-runs?limit=50
```

默认行为是 **真·live**；若带 `minCount` 会掺历史 run 做 UI 填充，探查时建议 **不传 `minCount`**，避免把已结束的 run 误当成仍在跑。

### 判读速查

| 你在 D/E 里看到的现象 | 更可能的解释 |
|------------------------|--------------|
| 关单后短时间多条 run，但 **`contextSnapshot.issueId` 各不相同** | 依赖/父单 **级联合法**（一次 PATCH 多目标），多为 **产品预期** |
| 多条 run **`contextSnapshot.issueId` 均为 ROU-21 的 UUID**，且 `wakeReason` 像 **`issue_assigned`** 或同类 assignment 唤醒、时间非常密 | **同一单误重复唤醒**；部署 **`queueIssueAssignmentWakeup` 终态跳过** 后应显著减少或消失 |
| 活动里仍有 **`issue.monitor_*`** 且工单已 `done` | 走 **monitor 与 executionPolicy 是否不同步** 的备选线（与 assignment 是不同根因） |

### 探查收口要写进证据的一句话

> 在 **{时间窗}** 内，针对 CTO 的 heartbeat run 中，**同一 `issueId`（ROU-21）** 出现 **{N}** 次，其中 **`issue_assigned`（或具体 wakeReason）** 占 **{M}** 次；部署终态防御后复测为 **{N'}/{M'}**。

把该句（填好数字）贴回 **T-011 / acceptance** 即可把「Board 复核」从进行中收口。

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

1. 按上文 **「探查活动实践方案」** 跑一遍 **A→F**，把 **判读速查** 里的表填实（至少完成 **D + E**）。  
2. 若确认为 **误发 assignment wake**：本仓库已加 **终态过滤**；部署后复测同一操作是否仍复现。  
3. 若仍存在 **同一 issueId 高密度重复**：继续从 **`enqueueWakeup` 去重 / `idempotencyKey` / 延迟唤醒晋升（deferred wake）** 方向查（需带具体 **run id**、**wakeupRequestId**、活动片段再开子任务）。
