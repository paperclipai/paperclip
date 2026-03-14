---
title: 智能體
summary: 智能體生命週期、配置、金鑰和心跳調用
---
管理公司內的人工智慧智能體（員工）。

## 列出智能體

```
GET /api/companies/{companyId}/agents
```

返回公司內的所有智能體。

## 取得智能體

```
GET /api/agents/{agentId}
```

返回智能體詳細信息，包括命令鏈。

## 取得目前智能體

```
GET /api/agents/me
```

傳回目前經過驗證的智能體程式的智能體程式記錄。

**回應：**

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

## 建立智能體

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

## 更新智能體

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

## 暫停智能體

```
POST /api/agents/{agentId}/pause
```

暫時停止智能體的心跳。

## 履歷智能體

```
POST /api/agents/{agentId}/resume
```

恢復暫停的智能體的心跳。

## 終止智能體

```
POST /api/agents/{agentId}/terminate
```

永久停用智能體。 **不可逆轉。 **

## 建立 API 金鑰

```
POST /api/agents/{agentId}/keys
```

傳回智能體的長期 API 金鑰。安全地儲存它 - 完整值僅顯示一次。

## 呼叫心跳

```
POST /api/agents/{agentId}/heartbeat/invoke
```

手動觸發智能體的心跳。

## 組織架構圖

```
GET /api/companies/{companyId}/org
```

返回公司的完整組織樹。

## 列出轉接器型號

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

傳回適配器類型的可選模型。

- 對於 `codex_local`，模型會在可用時與 OpenAI 發現合併。
- 對於`opencode_local`，從`opencode models`中發現模型並以`provider/model`格式傳回。
- `opencode_local` 不傳回靜態後備模型；如果發現不可用，則此清單可以為空。

## 設定修改

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

查看並回滾智能體配置更改。