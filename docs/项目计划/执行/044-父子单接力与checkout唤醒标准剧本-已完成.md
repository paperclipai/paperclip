---
status: 已完成
---

# 父子单接力与 checkout、唤醒标准剧本

**母本 / 拆单出处：** **[`长期需求/24 …` §A4、§D3](../长期需求/24%20评论唤起过载与编排分层改版计划%202026-05-17.md)**（拆分表行 **044**）· **套路** **[`016-实践-042至053编排开发收口套路`](../最佳实践/016-实践-042至053编排开发收口套路.md)**。

---

## 背景与范围（人话）

写好「父单已批 → 建子 → 指派 → 经办 pause / heartbeat 关 / `wakeOnDemand` false」同框时 **下一跳谁先谁后**，对齐 **REST 能力与身份**，避免 CEO 在长推理里盲试 **`PATCH /api/agents`** 却调不到 **`resume`/`wakeup`（Board）**。

**非目标：** 本轮**未**落地「委派子单即自动 wakeup」的实例开关——见剧本 §7 **[延后]**。

---

## 探查结论

- **checkout 后唤醒：** `routes/issues.ts` + [`issues-checkout-wakeup.ts`](../../../server/src/routes/issues-checkout-wakeup.ts)：经办**自带 run 认领自己** ⇒ **一般不二次 wake**。  
- **pause/resume：** `routes/agents.ts` ⇒ **Board only**。  
- **代唤醒：** `handleWakeupRoute` ⇒ Board 可调他人；agent key **仅自述**。

---

## 评审与开口选项

**无开口**：剧本以现行路由为准。

---

## 落地说明（人话）

一纸可复制的 **Markdown 剧本**：**[`最佳实践/017-实践-044父子单接力与checkout唤醒标准剧本.md`](../最佳实践/017-实践-044父子单接力与checkout唤醒标准剧本.md)**（含 **`X-Paperclip-Run-Id`**、前置矩阵、curl 占位、回填 **D3** 契约表）。

**[`01 项目需求说明.md`](../01.项目需求说明.md)**：**R6** 增链到 **017**，减少「链路散落无明文」的歧义。

---

## 代码与测试索引

| 层级 | 说明 |
| --- | --- |
| **文稿（主交付）** | **`docs/项目计划/最佳实践/017-实践-044父子单接力与checkout唤醒标准剧本.md`** |
| **服务端依据**（引用） | `server/src/routes/issues.ts`、`server/src/routes/issues-checkout-wakeup.ts`、`server/src/routes/agents.ts` |

**代码变更：** **无**（本单契约以文档收口）。

---

## 验证证据

- **日期：** 2026-05-17  
- **复审：** 与 `agents.ts`/`issues.ts` 路由源代码交叉核对 **`assertBoard`、`shouldWakeAssigneeOnCheckout`、`handleWakeupRoute` actor 分枝**。  
- **自动化测试：** 未新增（行为未改）。

---

## 依赖与备忘

[`032-agent-pause止损与heartbeat释放一致性.md`](032-agent-pause止损与heartbeat释放一致性.md) · [`052`（待办）](052-Agent互操作权限与UTF-8写中文安全通路.md)。技能侧参考 **`skills/paperclip/SKILL.md`** Wake 快车道。
