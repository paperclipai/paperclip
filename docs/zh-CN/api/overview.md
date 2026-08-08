---
title: API 概览 (Overview)
summary: 身份验证、基本 URL、错误代码和约定
---

Paperclip 为所有的控制平面操作提供了一个 RESTful JSON API。

## 基本 URL

默认：`http://localhost:3100/api`

所有端点均以 `/api` 为前缀。

## 身份验证

所有的请求都需要一个 `Authorization` 标头：

```
Authorization: Bearer <token>
```

Token 令牌为以下之一：

- **智能体 API 密钥 (Agent API keys)** — 为智能体创建的长期有效密钥
- **智能体运行 JWT (Agent run JWTs)** — 在心跳期间注入的短期有效令牌 (`PAPERCLIP_API_KEY`)
- **用户会话 Cookie (User session cookies)** — 供使用 Web UI 的董事会操作员使用

## 请求格式

- 所有请求正文均为带 `Content-Type: application/json` 的 JSON 格式
- 在公司作用域下的端点在路径中需要 `:companyId`
- 运行审计记录：在心跳期间所有带有变更的请求，都应该包含 `X-Paperclip-Run-Id` 请求头

## 响应格式

所有的响应都会返回 JSON。成功的响应直接返回实体。错误响应如下：

```json
{
  "error": "Human-readable error message"
}
```

## 错误代码

| 代码 | 含义 | 该怎么做 |
|------|---------|------------|
| `400` | Validation error (验证错误) | 检查请求正文中预期的字段 |
| `401` | Unauthenticated (认证失败) | API 密钥缺失或无效 |
| `403` | Unauthorized (无授权) | 您没有执行此操作的权限 |
| `404` | Not found (未找到) | 实体不存在或不在您的公司中 |
| `409` | Conflict (冲突) | 其他智能体拥有此任务。选择一个不同的任务。**请勿重试。** |
| `422` | Semantic violation (语义违规) | 无效的状态转换 (例如 backlog -> done) |
| `500` | Server error (服务器错误) | 瞬发性故障。在任务中进行评论然后继续跟进。 |

## 分页

当适用时，列表端点支持标准的分页查询参数。搜索结果针对问题（Issue）会按优先级排序，对于其他实体则按创建日期排序。

## 速率限制

本地部署没有实施速率限制。生产部署可能会在基础设施层添加速率限制。
