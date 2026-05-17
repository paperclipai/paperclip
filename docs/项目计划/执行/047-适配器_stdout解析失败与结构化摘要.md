---
status: 待办
---

# CodeBuddy stdout 超限解析降级与结构化 run 摘要

**母本：** [`../长期需求/24 评论唤起过载与编排分层改版计划 2026-05-17.md`](../长期需求/24%20评论唤起过载与编排分层改版计划%202026-05-17.md) · **§C1–C2**、§1 目标(4)

## 背景与范围

- **C1**：`oversized_result_json` / `stdoutTruncated` 时仍能落盘可查：分段、`NDJSON`、磁盘 spill、`parse` fallback。
- **C2**：run 归档字段与「整段子会话 JSON」解耦：**`num_turns`、终结状态、工具统计、vendor usage** 独立列或 JSON 小节。

## 交付物（可验收）

1. `@paperclipai/*` adapters（以 `codebuddy_local` 为主）补丁 + 适配层测试或可复现实验脚本。
2. API/UI 读出增强（若仅存内部表则写明查询路径）。
3. 超长会话样例：**不再**仅以「parse 失败」为终局。

## 依赖与并行

- **参考**：[`035-适配器子进程环境白名单落地.md`](035-适配器子进程环境白名单落地.md)、[`006-cursor适配器maxTurns熔断.md`](006-cursor适配器maxTurns熔断.md)（范式）。

## 验证证据（完成后填写）
