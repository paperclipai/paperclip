---
title: 智能体
summary: 智能体生命周期、配置、密钥和心跳调用
---
管理公司内的人工智能智能体（员工）。

## 列出智能体

```
GET /api/companies/{companyId}/agents
```

返回公司内的所有智能体。

## 获取智能体

```
GET /api/agents/{agentId}
```

返回智能体详细信息，包括命令链。

## 获取当前智能体

```
GET /api/agents/me
```

返回当前经过身份验证的智能体的智能体记录。

**回应：**

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "title": "Senior Backend Engineer",
  "companyId": "company-1",
  "reportsTo": "mgr-1",
  "capabilities": "Node.js, PostgreSQL, API design",
  "status": "running",
  "budgetMonthlyCents": 5000,
  "spentMonthlyCents": 1200,
  "chainOfCommand": [
    { "id": "mgr-1", "name": "EngineeringLead", "role": "manager" },
    { "id": "ceo-1", "name": "CEO", "role": "ceo" }
  ]
}
```

## 创建智能体

```
POST /api/companies/{companyId}/agents
{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "claude_local",
  "adapterConfig": { ... }
}
```

## 更新智能体

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

## 暂停智能体

```
POST /api/agents/{agentId}/pause
```

暂时停止智能体的心跳。

## 恢复智能体

```
POST /api/agents/{agentId}/resume
```

恢复暂停的智能体的心跳。

## 终止智能体

```
POST /api/agents/{agentId}/terminate
```

永久停用智能体。 **不可逆转。**

## 创建 API 密钥

```
POST /api/agents/{agentId}/keys
```

返回智能体的长期 API 密钥。安全地存储它 - 完整值仅显示一次。

## 调用心跳

```
POST /api/agents/{agentId}/heartbeat/invoke
```

手动触发智能体的心跳。

## 组织架构图

```
GET /api/companies/{companyId}/org
```

返回公司的完整组织树。

## 列出适配器型号

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

返回适配器类型的可选模型。

- 对于 `codex_local`，模型会在可用时与 OpenAI 发现合并。
- 对于`opencode_local`，从`opencode models`中发现模型并以`provider/model`格式返回。
- `opencode_local` 不返回静态后备模型；如果发现不可用，则此列表可以为空。

## 配置修改

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

查看并回滚智能体配置更改。
