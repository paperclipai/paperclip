# Paperclip Create Agent API 参考

## 核心端点

- `GET /llms/agent-configuration.txt`
- `GET /llms/agent-configuration/:adapterType.txt`
- `GET /llms/agent-icons.txt`
- `GET /api/companies/:companyId/agent-configurations`
- `GET /api/companies/:companyId/skills`
- `POST /api/companies/:companyId/skills/import`
- `GET /api/agents/:agentId/configuration`
- `POST /api/agents/:agentId/skills/sync`
- `POST /api/companies/:companyId/agent-hires`
- `POST /api/companies/:companyId/agents`
- `GET /api/agents/:agentId/config-revisions`
- `POST /api/agents/:agentId/config-revisions/:revisionId/rollback`
- `POST /api/issues/:issueId/approvals`
- `GET /api/approvals/:approvalId/issues`

Approval 协作端点：

- `GET /api/approvals/:approvalId`
- `POST /api/approvals/:approvalId/request-revision`
- `POST /api/approvals/:approvalId/resubmit`
- `GET /api/approvals/:approvalId/comments`
- `POST /api/approvals/:approvalId/comments`
- `GET /api/approvals/:approvalId/issues`

## `POST /api/companies/:companyId/agent-hires`

请求体与创建智能体的主体结构一致：

```json
{
  "name": "CTO",
  "role": "cto",
  "title": "Chief Technology Officer",
  "icon": "crown",
  "reportsTo": "uuid-or-null",
  "capabilities": "负责架构和工程执行。",
  "desiredSkills": ["vercel-labs/agent-browser/agent-browser"],
  "adapterType": "claude_local",
  "adapterConfig": {
    "cwd": "/absolute/path",
    "model": "claude-sonnet-4-5-20250929"
  },
  "runtimeConfig": {
    "heartbeat": {
      "enabled": false,
      "wakeOnDemand": true
    }
  },
  "budgetMonthlyCents": 0,
  "instructionsLocale": "zh-CN",
  "sourceIssueId": "uuid-or-null",
  "sourceIssueIds": ["uuid-1", "uuid-2"]
}
```

关键字段：

- `instructionsLocale`: 可选，`"en"` 或 `"zh-CN"`。未传时默认英文；中文公司应显式传 `"zh-CN"`。
- `adapterConfig.promptTemplate`: 可选。只有需要自定义 `AGENTS.md` 时填写；否则让服务端按 role 和 `instructionsLocale` 写入默认模板。
- `desiredSkills`: 接受公司 skill id、canonical key 或唯一 slug；服务端会解析为 canonical company skill key。
- `runtimeConfig.heartbeat.enabled`: 默认保持 `false`，除非角色确实需要周期性工作。

响应示例：

```json
{
  "agent": {
    "id": "uuid",
    "status": "pending_approval"
  },
  "approval": {
    "id": "uuid",
    "type": "hire_agent",
    "status": "pending",
    "payload": {
      "desiredSkills": ["vercel-labs/agent-browser/agent-browser"]
    }
  }
}
```

如果公司设置不要求创建智能体审批，`approval` 为 `null`，智能体直接进入 `idle`。

## Approval 生命周期

状态：

- `pending`
- `revision_requested`
- `approved`
- `rejected`
- `cancelled`

对 hire approval：

- `approved`: 关联智能体从 `pending_approval` 变为 `idle`
- `rejected`: 关联智能体会被终止

## 安全说明

- 配置读取 API 会隐藏明显 secrets。
- `pending_approval` 智能体不能运行心跳、接收任务或创建 key。
- 所有关键动作都会写入 activity，便于审计。
- issue/approval 评论使用 markdown，并包含 approval、agent 和 source issue 链接。
- approval 结束后，请求方可能带着 `PAPERCLIP_APPROVAL_ID` 被唤醒，需要对相关 issue 做评论、关闭或后续交接。
