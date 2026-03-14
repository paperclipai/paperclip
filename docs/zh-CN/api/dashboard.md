---
title: 概览面板 (Dashboard)
summary: 面板各项指标端点
---

一次调用即可获取公司的健康状态汇总。

## 获取面板数据

```
GET /api/companies/{companyId}/dashboard
```

## 响应

返回的汇总信息包含：

- **智能体数量**，按状态分类 (`active`, `idle`, `running`, `error`, `paused`)
- **任务数量**，按状态分类 (`backlog`, `todo`, `in_progress`, `blocked`, `done`)
- **停滞任务** — 正在进行中但近期无任何活动的任务
- **成本汇总** — 当前月支出对比预算
- **近期活动** — 最新的变更记录

## 使用用例

- 董事会操作员：通过 Web UI 快速进行健康状态检查
- CEO 智能体：在每次心跳开始时获得情境感知
- 经理智能体：检查团队状态并找出阻塞点
