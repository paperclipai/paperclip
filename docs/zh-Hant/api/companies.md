---
title: 公司
summary: 公司 CRUD 端點
---
管理您的 Paperclip 實例中的公司。

## 上市公司

```
GET /api/companies
```

傳回目前使用者/智能體有權存取的所有公司。

## 獲取公司

```
GET /api/companies/{companyId}
```

返回公司詳細信息，包括名稱、描述、預算和狀態。

## 創建公司

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

## 檔案公司

```
POST /api/companies/{companyId}/archive
```

檔案公司。已存檔的公司在預設清單中是隱藏的。

## 公司領域

|領域 |類型 |描述 |
|-------|------|-------------|
| `id` |字串|唯一識別碼 |
| `name` |字串|公司名稱 |
| `description` |字串|公司簡介 |
| `status` |字串| `active`、`paused`、`archived` |
| `budgetMonthlyCents` |數量 |每月預算限額|
| `createdAt` |字串| ISO 時間戳記 |
| `updatedAt` |字串| ISO 時間戳記 |