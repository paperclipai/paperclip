# 实践：044 父子单接力与 checkout、唤醒标准剧本

**工单：** **[`044-父子单接力与checkout唤醒标准剧本-已完成.md`](../执行/044-父子单接力与checkout唤醒标准剧本-已完成.md)**  
**母本：** **[`长期需求/24…` §A4、§D3](../长期需求/24%20评论唤起过载与编排分层改版计划%202026-05-17.md)**  
**耦合：** **`032`** pause 与_wakeup 收口 · **`052`**（上下级 PATCH/UTF-8 若另起） · **`014`** 审阅/接力口径

---

## 1. 想解决什么问题（人话）

「父单批了、子单建了、指派给 CTO，但这台人 **pause**、或 **heartbeat 关**、或 **`wakeOnDemand` false」——下一个该谁动、谁先调哪个 API？」  
本篇把 **评论 / interaction / checkout / wakeup** 的**推荐顺序**写死，避免 CEO 在长推理里去乱试 `PATCH /api/agents`，却忘了 **resume / wakeup 实际是 Board 能力或另一条身份链**。

---

## 2. 硬规则（产品与代码一致）

| 规则 | 说明 |
| --- | --- |
| **可变更是务带头** | 凡 `POST/PATCH` 会改写工单、评论、interaction、checkout、指派等，头部带 **`X-Paperclip-Run-Id: {runId}`**（沿用 [`skills/paperclip/SKILL.md`](../../../skills/paperclip/SKILL.md)、[`docs/API接口/01 API 概览 overview.md`](../../API接口/01%20API%20概览%20overview.md)）。Board 会话发起的操作若无「当前 run」，按你们治理约定仍可调用；**不要用 CEO agent key 冒充 Board 可调 API**。 |
| **checkout 认领** | `POST /api/issues/{issueId}/checkout`，body 含 `agentId`、`expectedStatuses`。同一 assignee **已有活动 run** 且头里带了 **自己的** `runId` 再 checkout：**服务端不再重复派发 assignee wakeup**（`shouldWakeAssigneeOnCheckout`，见 [`issues-checkout-wakeup.ts`](../../../server/src/routes/issues-checkout-wakeup.ts)）。其它角色代 checkout → **仍会 `heartbeat.wakeup` assignee**。 |
| **pause / resume** | `POST /api/agents/:id/pause`、`POST /api/agents/:id/resume`：**Board**（[`agents.ts`](../../../server/src/routes/agents.ts) `assertBoard`）。**CEO 的 agent Bearer 不能直接 resume CTO**。 |
| **代唤醒** | `POST /api/agents/:id/wakeup`（或 `/heartbeat/invoke`）：若为 **Board** → 可叫醒**公司内任一**智能体（`assertBoardCanManageAgentsForCompany`）；若为 **agent** → **只能叫醒自己**。即：**CEO agent key 不能用来 POST `/agents/{ctoId}/wakeup`**。 |

---

## 3. 前置条件矩阵（先对表再看步骤）

按子单经办人智能体逐项打勾：

| 条件 | 若「是」 | 若不满足 |
| --- | --- | --- |
| 经办 `status !== paused` | 可走 checkout / wakeup | **先 Board `resume`**（或人类看板解除 pause） |
| `heartbeat.enabled` | 可走 timer／调度链路 | **只能**按需：`wakeup`、`评论唤起`、`checkout` wake、interaction `wake_assignee` |
| `heartbeat.wakeOnDemand !== false` | `POST …/wakeup` 可走 | 仅能依赖 **指派/评论/checkout** 等仍允许的路径；否则先改配置或由 Board/human |

**032 补充：** pause 会 **`cancelActiveForAgent`** 并清理部分 pending wakeup；recovery / checkoutRunId 与 failed 的差别见 **`032` 结案**——剧本里不要做「paused 还送 wakeup」的假动作。

---

## 4. 标准剧本 α：父批子办 → 指派 CTO → 叫醒干活

**目标：** CTO 领到子单后能跑起来，且不重复堆一批无意义 wakeup。

**推荐顺序**

1. **（可选）父单留痕：** `PATCH /api/issues/{parentId}` 带 `comment` 说明子单指针或活动链接；**可变操作带头**。
2. **建子单：** `POST /api/companies/{companyId}/issues` — `parentId`、`assigneeAgentId`（CTO）、`status: "todo"` 等。**Board 或无 run 的人类操作可无 `X-Paperclip-Run-Id`；agent 发起的必须带头。**
3. **若 CTO paused：** Board `POST /api/agents/{ctoId}/resume`。
4. **叫醒 CTO（二选一或多选组合，按实际需要）：**
   - **代 checkout：** 任何 **非「CTO 自己当前 run」** 的认领（含 Board）：`POST /api/issues/{childId}/checkout` body `agentId=ctoId` → 服务端在满足 `shouldWakeAssigneeOnCheckout` 时 **`assignment` wakeup**。  
   - **显式 wakeup：** Board（或托管 Board 的编排器密钥） `POST /api/agents/{ctoId}/wakeup`，body `source`、`reason`、`payload.issueId` 等。**勿用 CEO agent key** 直呼 CTO wakeup。
   - **评论唤起：** Board/人类 `POST /api/issues/{childId}/comments`（或由既有评论线程触发档位），走 **042/041** 档位与归因。
   - **`interaction`**：需人在回路时 `POST …/interactions`，需要接力继续时 **`continuationPolicy: "wake_assignee"`**（见 [`03 任务工作流`](../../指南/智能体开发者/03%20任务工作流%20task-workflow.md)）。
5. **CTO 自己跑稳定后：** CTO 在当前 run 下对自己负责工单 `checkout`/`PATCH`，**继续使用同一 `X-Paperclip-Run-Id`**，别再让 CEO PATCH agent 配置兜底。

---

## 5. 标准剧本 β：CEO 在长会话里——禁止靠猜 PATCH

**反模式：** CEO run 里去 `PATCH /api/agents/{ctoId}` 拧 `heartbeat` / pause，容易 **422/403**，或把 CTO 推到不可预期配置。

**正路短句：**

- **解冻 / 放行执行权：** Board **resume**。  
- **补一轮唤起：** Board **`/wakeup`** 或 **interaction / 评论**（按合规档位）。  
- **配置级 `wakeOnDemand` / heartbeat：** Board **PATCH agent**（或迁移到 **`052`** 若讨论写密权限）。

---

## 6. Curl 骨架（占位符自行替换）

```http
PATCH /api/issues/{issueId}
Authorization: Bearer {token}
Content-Type: application/json
X-Paperclip-Run-Id: {ceoRunId}
{ "assigneeAgentId": "{ctoAgentId}", "comment": "@CTO：子任务已就位。" }
```

```http
POST /api/issues/{childIssueId}/checkout
Authorization: Bearer {boardOrDelegatedToken}
Content-Type: application/json
X-Paperclip-Run-Id: {delegatorRunIdOrOmitBoard}
{
  "agentId": "{ctoAgentId}",
  "expectedStatuses": ["todo","backlog","blocked","in_review"]
}
```

```http
POST /api/agents/{ctoAgentId}/wakeup
Authorization: Bearer {BoardSessionBearer}
Content-Type: application/json
{
  "source": "assignment",
  "reason": "parent_delegate_followup",
  "payload": { "issueId": "{childIssueId}" }
}
```

---

## 7. 「延后」与产品缺口（工单已登记）

**尚未做：** 「委派创建子单时是否自动 wakeup assignee」的 **Board 可选策略开关**——当前只靠 **checkout wakeup**、`/wakeup`、评论档位等既有路径组合；若要「建子必醒」须在 **`server/services/issues`/`routes`** 加闸与 **[`049`](../执行/049-审批参与者身份提示与执行阶段可查.md)** 一起看。

---

## 8. API 契约摘要（回填 D3）

| 意图 | 方法 | 头 / 备注 |
| --- | --- | --- |
| 派工 / 改状态 / 顺带评论 | `PATCH /issues/:id` | 可变：**`X-Paperclip-Run-Id`** |
| 认领 | `POST /issues/:id/checkout` | 同上；**自认领+自己 run ⇒ 一般不二次 wake** |
| 人机交互接力 | `POST /issues/:id/interactions` | 按需 `continuationPolicy`、`wake_assignee` |
| 叫醒（非 timer） | `POST /agents/:id/wakeup` | Board 叫醒他人；**agent 仅自拍** |

---

上级入口：[最佳实践 README](README.md) · [`016` — 042～053 套路](016-实践-042至053编排开发收口套路.md)
