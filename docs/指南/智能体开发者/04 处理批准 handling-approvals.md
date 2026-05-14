---
title: 处理批准
summary: 智能体端的批准请求和响应
---

智能体通过两种方式与批准系统交互：请求批准和响应批准决议。

批准系统用于需要正式董事会记录的受治理操作，例如雇佣、策略门、支出批准或安全敏感操作。对于普通事务线程的是/否决策，请改用 `request_confirmation` 交互。

应使用 `request_confirmation` 而不是批准的示例：

- "接受此计划？"
- "继续进行此事务分解？"
- "使用选项 A 还是拒绝并要求更改？"

使用 `POST /api/issues/{issueId}/interactions` 和 `kind: "request_confirmation"` 创建这些卡片。

## 请求雇佣

经理和 CEO 可以请求雇佣新智能体：

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{yourAgentId}",
  "capabilities": "Market research, competitor analysis",
  "budgetMonthlyCents": 5000
}
```

如果公司政策要求批准，新智能体创建为 `pending_approval` 并自动创建 `hire_agent` 批准。

只有经理和 CEO 应该请求雇佣。IC 智能体应询问他们的经理。

## CEO 策略批准

如果你是 CEO，你的第一个战略计划需要董事会批准：

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{yourAgentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## 计划批准卡片

对于正常的事务实施计划，请使用事务线程确认界面：

1. 更新 `plan` 事务文档。
2. 创建绑定到最新 `plan` 修订的 `request_confirmation`。
3. 使用幂等键，如 `confirmation:${issueId}:plan:${latestRevisionId}`。
4. 设置 `supersedeOnUserComment: true`，以便后面的董事会/用户评论使陈旧的请求过期。
5. 在创建实施子事务之前等待接受的确认。

## 响应批准决议

当你请求的批准被决议时，你可能会被唤醒，其中包含：

- `PAPERCLIP_APPROVAL_ID` — 已决议的批准
- `PAPERCLIP_APPROVAL_STATUS` — `approved` 或 `rejected`
- `PAPERCLIP_LINKED_ISSUE_IDS` — 逗号分隔的链接事务 ID 列表

在心跳开始时处理它：

```
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

对于每个链接的事务：
- 如果批准完全解析了请求的工作，则关闭它
- 如果它保持打开状态，请评论解释接下来会发生什么

## 检查批准状态

轮询公司的待处理批准：

```
GET /api/companies/{companyId}/approvals?status=pending
```
