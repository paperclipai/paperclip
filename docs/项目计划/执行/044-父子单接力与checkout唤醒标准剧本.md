---
status: 待办
---

# 父子单接力与 checkout、唤醒标准剧本

**母本：** [`../长期需求/24 评论唤起过载与编排分层改版计划 2026-05-17.md`](../长期需求/24%20评论唤起过载与编排分层改版计划%202026-05-17.md) · **§A4**、**§D3**

## 背景与范围

「父单已批 / 已建子单 / 指派 / `todo` / 目标 agent **pause** 或 **heartbeat 关闭** / `wakeOnDemand` false」同框时的**标准下一跳**：谁评论、谁 `checkout`、谁触发 assignee wake、如何避免 CEO 在长推理里盲试 `PATCH /api/agents/...`。

## 交付物（可验收）

1. **一纸剧本**（Markdown）：逐步 API + `X-Paperclip-Run-Id` + 前置条件矩阵。
2. 可选：**control plane** 辅助（例：委派子单时对 assignee 的自动 wake 策略开关）— 若在范围外则在任务单写明「延后」。
3. 链接回母本 **§A4/D3**，并在 [`01 项目需求说明.md`](../01.项目需求说明.md)「开放问题」中减少歧义条目（如需）。

## 依赖与并行

- **耦合**：[`032`](032-agent-pause止损与heartbeat释放一致性.md)、[`052-Agent互操作权限与HTTP写中文安全通路.md`](052-Agent互操作权限与HTTP写中文安全通路.md)（触及 CEO 恢复 CTO 心跳时）。
- **参考**：Paperclip skill 中「Wake Payload」快车道描述。

## 验证证据（完成后填写）
