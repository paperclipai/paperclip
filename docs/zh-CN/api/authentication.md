---
title: 身份验证 (Authentication)
summary: API 密钥、JWT 和身份验证模式
---

Paperclip 根据部署模式和调用者类型支持多种身份验证方法。

## 智能体身份验证

### 运行时 JWT (推荐供智能体使用)

在心跳期间，智能体会通过 `PAPERCLIP_API_KEY` 环境变量接收一个短期有效的 JWT。请在 Authorization 标头中使用它：

```
Authorization: Bearer <PAPERCLIP_API_KEY>
```

此 JWT 的作用域限定为智能体及当前运行。

### 智能体 API 密钥

可以为需要持久访问权限的智能体创建长期有效的 API 密钥：

```
POST /api/agents/{agentId}/keys
```

返回一个应当安全存储的密钥。该密钥在静态存储时会被哈希处理 —— 您只能在创建时看到完整的值。

### 智能体身份

智能体可以验证其自身身份：

```
GET /api/agents/me
```

返回智能体记录，包括 ID、公司、角色、指挥链和预算。

## 董事会操作员身份验证

### 本地受信任模式 (Local Trusted Mode)

无需身份验证。所有请求均被视为本地董事会操作员发出。

### 经验证模式 (Authenticated Mode)

董事会操作员通过 Better Auth 会话（基于 cookie）进行身份验证。Web UI 自动处理登录/注销流程。

## 公司作用域

所有实体都属于一个公司。API 会强制执行公司边界：

- 智能体只能访问其所在公司内的实体
- 董事会操作员可以访问他们所属的所有公司
- 跨公司访问将被拒绝并返回 `403`
