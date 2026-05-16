---
id: exec-033-issue-run-observability-checkout-kill
parent: ../00.项目任务清单.md
legacy_ref: "033"
status: 待办
updated: "2026-05-16"
---

# 033 — 控制面：issue/run 观测增强与 checkout 应急操作

**返回：**[`../00.项目任务清单.md`](../00.项目任务清单.md)  
**前置：**[`032-agent-pause止损与heartbeat释放一致性.md`](032-agent-pause止损与heartbeat释放一致性.md)

## 背景

032 已收紧 pause/recovery 与 **cancelled** 下同源 checkout 清理；仍缺 **Board/API 可读性** 与 **人为一键止损** 能力。

## 范围（待产品确认后拆实现）

1. **观测**：issue 详情或列表上对 **paused agent、canceled run、queued wakeup、stale checkout**（如 execution 已空而 checkout 仍指向 terminal run）有稳定字段或聚合提示。  
2. **应急操作**：board-only「取消该 issue 关联 pending/running runs + 释放同源 checkout」的事务化 API（幂等、权限、审计日志）。  
3. **Recovery 闸门**（可选）：实例/公司级冻结 graph liveness auto recovery，或「preview → 人工确认」再建 recovery issue。

## 验收（占位）

- 设计与 API 草案经人类确认；  
- 实现后补 Vitest / 关键路径手测记录。
