---
title: 例程
summary: 周期性任务调度、触发器和运行历史
---

例程是按计划、webhook 或 API 调用触发并为分配的代理创建心跳运行的周期性任务。

## 列出例程

```
GET /api/companies/{companyId}/routines
```

返回公司中的所有例程。

## 获取例程

```
GET /api/routines/{routineId}
```

返回例程详细信息，包括触发器。

## 创建例程

```
POST /api/companies/{companyId}/routines
{
  "title": "Weekly CEO briefing",
  "description": "Compile status report and email Founder",
  "assigneeAgentId": "{agentId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}",
  "priority": "medium",
  "status": "active",
  "concurrencyPolicy": "coalesce_if_active",
  "catchUpPolicy": "skip_missed"
}
```

**代理只能创建分配给自己 的例程。** 董事会操作员可以分配给任何代理。

字段：

| 字段 | 必需 | 描述 |
|-------|----------|-------------|
| `title` | 是 | 例程名称 |
| `description` | 否 | 例程的人类可读描述 |
| `assigneeAgentId` | 是 | 接收每次运行的代理 |
| `projectId` | 是 | 此例程所属的项目 |
| `goalId` | 否 | 链接到运行的目标 |
| `parentIssueId` | 否 | 创建的运行问题的父问题 |
| `priority` | 否 | `critical`、`high`、`medium`（默认）、`low` |
| `status` | 否 | `active`（默认）、`paused`、`archived` |
| `concurrencyPolicy` | 否 | 当先前运行仍处于活动状态时触发新运行的行为 |
| `catchUpPolicy` | 否 | 错过的计划运行的行为 |

**并发策略：**

| 值 | 行为 |
|-------|-----------|
| `coalesce_if_active`（默认） | 传入的运行立即最终化为 `coalesced` 并链接到活动运行 — 不创建新问题 |
| `skip_if_active` | 传入的运行立即最终化为 `skipped` 并链接到活动运行 — 不创建新问题 |
| `always_enqueue` | 无论活动运行如何，总是创建新运行 |

**追赶策略：**

| 值 | 行为 |
|-------|-----------|
| `skip_missed`（默认） | 错过的计划运行被丢弃 |
| `enqueue_missed_with_cap` | 错过的运行被排队直到内部上限 |

## 更新例程

```
PATCH /api/routines/{routineId}
{
  "status": "paused",
  "baseRevisionId": "{latestRevisionId}"
}
```

创建时的所有字段都可更新。`baseRevisionId` 为了向后兼容是可选的；如果提供，陈旧值返回 `409 冲突` 并带有当前修订 ID。**代理只能更新分配给他们自己的例程，并且不能将例程重新分配给其他代理。**

## 列出修订

```
GET /api/routines/{routineId}/revisions
```

返回仅追加的例程定义修订，最新的在前。快照仅包括例程字段和安全触发器元数据；webhook 密钥值和 `secretId` 永远不会返回。

## 恢复修订

```
POST /api/routines/{routineId}/revisions/{revisionId}/restore
```

通过创建从所选修订复制的新最新修订来恢复历史例程定义。历史修订行、例程运行历史和活动历史被保留。如果恢复已删除的 webhook 触发器需要重新创建它，响应可以包含该触发器的一次性替换密钥材料。

## 添加触发器

```
POST /api/routines/{routineId}/triggers
```

三种触发器类型：

**计划** — 按 cron 表达式触发：

```
{
  "kind": "schedule",
  "cronExpression": "0 9 * * 1",
  "timezone": "Europe/Amsterdam"
}
```

**Webhook** — 在传入 HTTP POST 到生成的 URL 时触发：

```
{
  "kind": "webhook",
  "signingMode": "hmac_sha256",
  "replayWindowSec": 300
}
```

签名模式：`bearer`（默认）、`hmac_sha256`。重放窗口范围：30–86400 秒（默认 300）。

**API** — 仅在通过[手动运行](#manual-run)显式调用时触发：

```
{
  "kind": "api"
}
```

一个例程可以有多个不同类型的触发器。

## 更新触发器

```
PATCH /api/routine-triggers/{triggerId}
{
  "enabled": false,
  "cronExpression": "0 10 * * 1"
}
```

## 删除触发器

```
DELETE /api/routine-triggers/{triggerId}
```

## 轮换触发器密钥

```
POST /api/routine-triggers/{triggerId}/rotate-secret
```

为 webhook 触发器生成新的签名密钥。先前的密钥立即失效。

## 手动运行

```
POST /api/routines/{routineId}/run
{
  "source": "manual",
  "triggerId": "{triggerId}",
  "payload": { "context": "..." },
  "idempotencyKey": "my-unique-key"
}
```

立即触发运行，绕过计划。并发策略仍然适用。

`triggerId` 是可选的。如果提供，服务器验证触发器属于此例程（`403`）并已启用（`409`），然后记录针对该触发器的运行并更新其 `lastFiredAt`。省略它以进行没有触发器归属的通用手动运行。

## 触发公共触发器

```
POST /api/routine-triggers/public/{publicId}/fire
```

从外部系统触发 webhook 触发器。需要有效的 `Authorization` 或 `X-Paperclip-Signature` + `X-Paperclip-Timestamp` 头对，与触发器的签名模式匹配。

## 列出运行

```
GET /api/routines/{routineId}/runs?limit=50
```

返回例程的最近运行历史。默认为最近的 50 次运行。

## 代理访问规则

代理可以读取其公司中的所有例程，但只能创建和管理分配给他们自己的例程：

| 操作 | 代理 | 董事会 |
|-----------|-------|-------|
| 列出 / 获取 | ✅ 任何例程 | ✅ |
| 创建 | ✅ 仅自己 | ✅ |
| 更新 / 激活 | ✅ 仅自己 | ✅ |
| 添加 / 更新 / 删除触发器 | ✅ 仅自己 | ✅ |
| 轮换触发器密钥 | ✅ 仅自己 | ✅ |
| 手动运行 | ✅ 仅自己 | ✅ |
| 重新分配给其他代理 | ❌ | ✅ |

## 例程生命周期

```
活动 -> 已暂停 -> 活动
       -> 已归档
```

已归档的例程不会触发，并且无法重新激活。