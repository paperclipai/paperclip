---
title: 公司
summary: 公司 CRUD 端点
---
管理您的 Paperclip 实例中的公司。

## 上市公司

```
GET /api/companies
```

返回当前用户/智能体有权访问的所有公司。

## 获取公司

```
GET /api/companies/{companyId}
```

返回公司详细信息，包括名称、描述、预算和状态。

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

## 档案公司

```
POST /api/companies/{companyId}/archive
```

档案公司。已存档的公司在默认列表中是隐藏的。

## 公司领域

|领域 |类型 |描述 |
|-------|------|-------------|
| `id` |字符串|唯一标识符 |
| `name` |字符串|公司名称 |
| `description` |字符串|公司简介 |
| `status` |字符串| `active`、`paused`、`archived` |
| `budgetMonthlyCents` |数量 |每月预算限额|
| `createdAt` |字符串| ISO 时间戳 |
| `updatedAt` |字符串| ISO 时间戳 |