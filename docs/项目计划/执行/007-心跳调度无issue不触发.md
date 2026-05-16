---
id: exec-007-heartbeat-no-issue-guard
status: 进行中
ledger: ./任务执行台账.md
updated: "2026-05-18T12:00"
---

# 任务 007 — 心跳调度层：无 issue 不触发（timer 闸门）

**返回：**[`任务执行台账.md`](任务执行台账.md)

**长期需求总账（动机、HB-01～HB-05、CEO 例外叙事）：** [`../长期需求/02 心跳唤醒闸门与空转治理 2026-05-14-gated-heartbeat.md`](../长期需求/02%20心跳唤醒闸门与空转治理%202026-05-14-gated-heartbeat.md)

---

## 1. 本单要解决什么（一句话）

**只对「定时心跳」路径（`source === "timer"`）**：在入队 `heartbeatRuns` 之前，先判断该 agent 是否在公司内存在 **可归因的经办事项**；若没有，则 **跳过唤醒并留痕**，避免因开放式心跳 prompt 造成空转。

---

## 2. 术语（避免「分配 issue」含糊）

| 用语 | 本单含义 |
| --- | --- |
| **timer 心跳** | `tickTimers` → `enqueueWakeup(..., source: "timer")`，上下文通常 **不带 `issueId`**。 |
| **有可调度经办事项** | 存在至少一条 `issues` 行：`assignee_agent_id = 该 agent`，且 `status` **不属于** `backlog` / `done` / `cancelled`。等价于：状态为 `todo` / `in_progress` / `in_review` / `blocked`（及将来若新增其它「非三段终态、非 backlog」的活跃态，除非代码显式排除）。 |
| **跳过留痕** | 插入 `agent_wakeup_requests`，`status = skipped`，`reason` 为常量字符串（见 §5）。 |

**刻意不与口语「有没有分配」混用**：数据库里可能出现「经办人是该 agent 但仍在 `backlog`」的异常/历史数据——本单规则按 **status 集合** 判定，**不按**「有无 `assigneeAgentId`」单独判定。

---

## 3. 范围与非目标

### 3.1 范围内（本单已实现）

- **仅 timer**：`enqueueWakeup` 在通过 timer 角色白名单、`heartbeat.enabled`、interval 等既有闸门之后，再执行「有可调度经办事项」判断；不满足则 **return null**，不写 `heartbeatRuns`。
- **可观测**：跳过写入 `agent_wakeup_requests`（对齐长期需求 **HB-03** 方向）。

### 3.2 范围外（明确不做 / 未做）

| 项 | 说明 |
| --- | --- |
| **手动 `/heartbeat/invoke`、`POST /wakeup`（`on_demand`）** | **不受**本闸门约束；与长期需求 **HB-02**「闹钟 vs 人有事找你」分拆一致。 |
| **指挥链例外（CEO 无单也可 periodic 清醒）** | 长期需求 **HB-04** 要求显式配置；**当前未实现**——timer Eligible 角色一律走同一「有可调度经办事项」规则。若产品与 `PRODUCT.md` 叙事冲突，须另开执行单 + 改 SPEC。 |
| **Board/UI 展示跳过原因** | 仅 DB/API 可查；界面提示属后续单。 |
| **改适配器 / 改心跳 prompt 文案** | 本单不管；动机见 §6 背景。 |

---

## 4. 验收标准（可对表）

### 4.1 自动化（必须通过）

- 测试文件：`server/src/__tests__/orchestration-heartbeat-guards.test.ts`
- 用例：**timer + eligible agent + 公司内无任何「§2 可调度」issue** → `wakeup` 返回 `null`，且最新一条 `agent_wakeup_requests.reason === heartbeat.timer_no_assigned_issue`。

### 4.2 行为表（Given / When / Then）

| # | Given | When | Then |
| --- | --- | --- | --- |
| A | Agent `role` 不在实例 `timerHeartbeatEligibleAgentRoles` 内 | timer `enqueueWakeup` | 沿用既有跳过（`heartbeat.timer_role_ineligible`），**不**进入本单「经办事项」判断 |
| B | `heartbeat.enabled === false`（runtimeConfig） | timer | 沿用既有 `heartbeat.disabled`，**不**进入本单判断 |
| C | Eligible + enabled，且 **存在** §2「可调度」issue | timer | **允许**继续走后续入队逻辑（与改动前一致；本单不禁锢「有单仍唤醒」） |
| D | Eligible + enabled，且 **不存在** §2「可调度」issue | timer | **不得**新建 `heartbeatRuns`；须有一条 skipped `agent_wakeup_requests`，reason 见 §5 |
| E | 仅有经办但状态为 `backlog`（或 `done`/`cancelled`） | timer | 视同「无可调度」→ 跳过（与 §2 定义一致） |

### 4.3 人工抽检（可选）

1. 选一测试公司，agent 配置 timer 且 eligible，`issues` 表中对该 agent **无** §2 所列状态行。  
2. 触发一轮 `tickTimers`（或等价直接调 API 内部路径）。  
3. 查 `agent_wakeup_requests`：`skipped` + `heartbeat.timer_no_assigned_issue`。

---

## 5. 实现锚点（读代码从这里进）

| 项目 | 位置 |
| --- | --- |
| 跳过 reason 常量 | `server/src/services/orchestration-invariants.ts` → `HEARTBEAT_SKIP_TIMER_NO_ASSIGNED_ISSUE` |
| 判定函数 | `server/src/services/heartbeat.ts` → `agentHasRunnableAssignedIssue` |
| 闸门挂载点 | 同上 → `enqueueWakeup`，在 timer 的 `wakeOnDemand`/policy 分支之后、`issueId` 树篱之前 |

---

## 6. 背景（为什么要调度层管）

心跳 prompt 偏开放式时，**无边界事务**仍可能被拉起执行 → 下游模型/适配器长时间探索；降费与可控性应在 **调度层** 收敛，而非单靠 maxTurns 等兜底（详见 [`005-cursor壳子修复可用composer2.md`](005-cursor壳子修复可用composer2.md) §9.3 类结论及长期需求 §1）。

---

## 7. 与长期需求 HB 条目映射

| HB | 与本单关系 |
| --- | --- |
| HB-01 | 本单落实 **timer 路径**上「有待办才入队」的子集（§2 定义）。 |
| HB-02 | **未改** on_demand / 手动 invoke — 与本单独立。 |
| HB-03 | timer 跳过 **已**写入 skipped 请求；UI 展示仍缺。 |
| HB-04 | **未做**；当前 CEO/CTO 等与 engineer 共用同一 timer 经办判定。 |
| HB-05 | **不关本单**（关单闭环另工单）。 |

---

## 8. 关闭单前检查清单

- [ ] §4.1 Vitest 在 CI/本地通过（嵌入式 Postgres 可用环境）。  
- [ ] 若产品确认 **HB-04** 不做：在 `01.项目需求说明.md` 或长期需求 `02` 中保留「例外未实现」陈述，避免读文档误以为 CEO 已特殊处理。  
- [ ] 若将来改 **§2 状态集合**（例如是否包含某种新状态）：同步改 `agentHasRunnableAssignedIssue` + 本单 §2 表格 + 测试数据。  
- [ ] **SPEC**：长期需求 `02` §0 已注明 HB-01 采纳系契约增量；若组织上要求闭合 SPEC —— 另起文书改 `doc/04 实现规格 SPEC-implementation.md`（本单不替你做）。  

---

## 9. 现场排障：是服务端 timer 闸门，还是 CLI 自己判空退出？

**结论先说：** 两类现象的体感很像（「起来一下又停了」），但 **证据链不同**。007 只覆盖 **`source === "timer"`** 且在 **`enqueueWakeup` 入队前** 就返回的情况——**若根本没创建本次 timer 对应的 run**，才可能是闸门；**若已有 `heartbeat_run` 且走过 running/finished**，多半是 **适配器/CLI 进程跑了一小段后自行结束**（或任务为空、或协议里先拉收件箱再退出）。

### 9.1 先对齐你说的「归档智能体」

仓库里 **agent 没有名叫 `archived` 的状态枚举专文**（常见是 `active` / `idle` / `paused` / `terminated` / `pending_approval` 等）。界面「归档」有时是 **展示分组** 或 **停机/暂停** 的口语：请以 **`agents.status`** 与 Board 上同一字段为准再对照 §9.2。**若口语指名称里带「归档」二字：** 用 **`agents.name ILIKE '%归档%'`**，实测回填见 **§9.5**。

- **`paused` / `terminated` / `pending_approval`**：`tickTimers` **根本不会**给该 agent 发 timer `enqueueWakeup`；若此时仍看到「起来一下」，通常 **不是** 007 timer 闸门路径，而是 **别路唤醒**（人点 invoke、派单、恢复单等）。

### 9.2 判别表（同一时间窗内对着 DB/API 看）

| 若观察到… | 更像 **007 timer 闸门**（服务端未排队） | 更像 **CLI/适配器侧自行结束** |
| --- | --- | --- |
| **`agent_wakeup_requests`（`source=timer`）** | 存在 **`status=skipped`**，且 **`reason=heartbeat.timer_no_assigned_issue`**（或其它 timer 跳过 reason） | 常为 **`queued`→`claimed`/`completed`**，且 **`run_id` 指向一次真实 run** |
| **`heartbeat_runs`** | **没有**因本次 timer  tick **新产生**的 queued/run（或与该 wakeup **无关联**） | 有一条 **短生命周期** run：`queued`→`running`→`finished`/`cancelled`，`invocation_source` 可能是 `timer` 或 **其它** |
| **run 侧产物** | 通常 **没有**本次对应的 adapter 长 transcript（因为进程可能根本没被拉起） | **`heartbeat_run_events` / `result_json`** 里往往能看到退出码、摘要或「无任务」类输出（具体文案依赖适配器） |

### 9.3 注意：唤醒源搞混会误判

- **007 不参与**：`on_demand`（含空 body **`/heartbeat/invoke`**）、`assignment`、`automation` 等——这些路径仍可能 **在没有 timer 闸门的情况下** 排队并拉起 CLI；要靠 **`heartbeat_runs.invocation_source`** 和 **`agent_wakeup_requests.source`** 对齐再看 §9.2。

### 9.4 若仍分不清

在issue里记下同一秒的：**agentId、`agent_wakeup_requests.id`（若有）、`heartbeat_runs.id`（若有）、`invocation_source`、run 起止时间**，再对照上表；这比猜「是不是 007」可靠。

### 9.5 实证回填（routic · **名称**含「归档」的 agent）

**回填日期（文书）：** 2026-05-18  
**数据窗口（库内 `created_at`/`requested_at`）：** 以 **2026-05-15～2026-05-16 UTC** 一段为主（详见当下 `docker exec … psql` 快照）。

**对象界定（对齐口语「归档 agent」）：**

- 公司：**routic**（`companies.issue_prefix = 'ROU'` 且 `status = 'active'`）。
- 筛选：**`agents.name ILIKE '%归档%'`**——**不是**用 `paused`/`terminated` 等 status 代替「归档」。

**唯一命中：** **`归档-Qwen-Coder Next`** · `agents.id = d1737430-9df4-443a-90ad-e392f8474da1` · `adapter_type = qwen_local`（快照时 **`paused`**）。

**`activity_log`（`agent_id` 命中）：** 仅 **`environment.lease_acquired` / `environment.lease_released`** 成对记录；**不足以**单独证明 007 闸门，须对齐下方 wakeup/run/events。

**`agent_wakeup_requests`（`source = timer`）：**

- 现为 **`completed` / `coalesced` / `cancelled`**，`reason` 为 **`heartbeat_timer`**。
- **`status = skipped`** 且可对标 **007「无经办跳过」** reason 的行：**本次查询为 0 行**。

**`heartbeat_runs`：** 多条 **`invocation_source = timer`**，多 **`status = succeeded`**，**`finished_at - started_at`** 约 **21～164s**；亦见 **`cancelled`** 的短 run——均属 **「已有 run」**，与 §9.2 **左侧「未建新 run」** 不符。

**`heartbeat_run_events`（抽样 run：`9e7f0504-802a-4dbf-ab24-4f8f76af95dc`）：**  
`lifecycle: run started` → **`adapter.invoke`** → `lifecycle: run succeeded`（仅 3 条事件）。

**`result_json`（同抽样 run）：** 正文自述含 **`heartbeat_timer`**、**无分配任务（`PAPERCLIP_TASK_ID` 为空）**、**收件箱为空** 等——符合 §9.2 **右侧「适配器侧短跑产出」**。

**映射结论：** 该样本 **不支持** 用 **007 timer 入队前跳过** 解释「起来一下」；更像 **timer 正常排队 → Qwen 适配器执行空任务心跳 → 短时结束**。

**复核入口（只读）：** `docker exec <postgres 容器名> psql -U paperclip -d paperclip -c '…'`；连接串形态见 **[`.env.example`](../../../.env.example)**。

---

## 10. 执行回写

| 日期 | 记录 |
| --- | --- |
| 2026-05-18 | §9.5 **实证回填**：routic「归档-*」agent（名称筛选）timer/wakeup/run/events/`result_json` 对齐 §9.2 **右侧**；**timer skipped=0**。 |
| 2026-05-17 | 增补 §9「现场排障」：区分服务端 timer 跳过 vs CLI/适配器短跑退出；说明「归档」应对齐 `agents.status` 与唤醒源。 |
| 2026-05-16 | 落地 timer 闸门（§5）；Vitest `orchestration-heartbeat-guards`；本文件由「仅验收直觉」收窄为可执行规格，并标明 HB-04/UI/SPEC 缺口。 |
