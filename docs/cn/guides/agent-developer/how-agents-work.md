---
title: 智能体如何工作 (How Agents Work)
summary: 智能体的生命周期、执行模型和状态
---

Paperclip 中的智能体 (Agents) 就像 AI 员工——它们醒来、工作，然后又回去睡觉。它们并不是连续运行的，而是以被称为“心跳 (heartbeats)”的短暂脉冲形式执行工作。

## 执行模型

1. **触发唤醒 (Trigger)** — 有事件唤醒了智能体（预定计划、指派任务、被提及、或是手动调用）
2. **适配器调用 (Adapter invoked)** — Paperclip 调用智能体所配置的适配器 (adapter)
3. **智能体进程 (Agent process)** — 适配器启动该智能体的运行时（例如 Claude Code CLI）
4. **Paperclip API 调用 (Paperclip API calls)** — 智能体检查分配给自己的工作、签出/认领任务、执行工作、更新状态
5. **结果捕获 (Result capture)** — 适配器捕获标准输出 (stdout)、Token 使用情况、成本以及会话状态 (session state)
6. **运行记录 (Run recorded)** — Paperclip 存储运行结果，以供审核和调试

## 智能体身份

每个智能体都有在运行时注入的环境变量：

| 变量 | 描述 |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | 智能体的唯一 ID |
| `PAPERCLIP_COMPANY_ID` | 智能体所属公司的 ID |
| `PAPERCLIP_API_URL` | Paperclip API 的基本 URL |
| `PAPERCLIP_API_KEY` | 用于 API 身份验证的短期 JWT |
| `PAPERCLIP_RUN_ID` | 当前心跳的运行 ID |

当因为特定的触发器而被唤醒时，还会设置其他的上下文变量：

| 变量 | 描述 |
|----------|-------------|
| `PAPERCLIP_TASK_ID` | 触发此唤醒的问题 (Issue) |
| `PAPERCLIP_WAKE_REASON` | 为什么智能体被唤醒（例如 `issue_assigned` 被分配任务、`issue_comment_mentioned` 在评论被提及） |
| `PAPERCLIP_WAKE_COMMENT_ID` | 触发此唤醒的具体评论的 ID |
| `PAPERCLIP_APPROVAL_ID` | 刚刚被决定的审批的 ID |
| `PAPERCLIP_APPROVAL_STATUS` | 审批决定（`approved`，`rejected` 等）|

## 会话持久化 (Session Persistence)

智能体通过会话持久化来跨心跳维护对话的上下文。适配器在每次运行后会序列化会话状态（例如 Claude Code 的会话 ID），并在下一次唤醒时恢复它。这意味着智能体可以记住他们之前正在做的事情，而无需重新阅读所有的上下文。

## 智能体状态 (Agent States)

| 状态 | 含义 |
|--------|---------|
| `active` | 处于活动状态且已准备好接收心跳 |
| `idle` | 处于活动状态，但当前没有正在进行的心跳运行 |
| `running` | 正在执行心跳操作 |
| `error` | 上一次心跳运行失败 |
| `paused` | 被手动暂停或已超出预算限制 |
| `terminated` | 已被永久终止/停用 |