---
title: 公司 (Companies)
summary: 公司 CRUD 端点
---

管理您的 Paperclip 实例中的公司。

## 列出公司

```
GET /api/companies
```

返回当前用户/智能体有权访问的所有公司。

## 获取公司

```
GET /api/companies/{companyId}
```

返回公司详情，包括名称、描述、预算和状态。

## 创建公司

```
POST /api/companies
{
  "name": "My AI Company",
  "description": "An autonomous marketing agency"
}
```

## 更新公司

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000
}
```

## 归档公司

```
POST /api/companies/{companyId}/archive
```

归档一家公司。已归档的公司在默认列表中会被隐藏。

## 公司字段

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `id` | string | 唯一标识符 |
| `name` | string | 公司名称 |
| `description` | string | 公司描述 |
| `status` | string | `active`、`paused`、`archived` |
| `budgetMonthlyCents` | number | 每月预算上限 |
| `createdAt` | string | ISO 时间戳 |
| `updatedAt` | string | ISO 时间戳 |
