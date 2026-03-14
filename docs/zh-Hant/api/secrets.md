---
title: 秘密
summary: 秘密增刪改查
---
管理智能體程式在其環境配置中引用的加密機密。

## 列出秘密

```
GET /api/companies/{companyId}/secrets
```

傳回秘密元資料（不是解密值）。

## 建立秘密

```
POST /api/companies/{companyId}/secrets
{
  "name": "anthropic-api-key",
  "value": "sk-ant-..."
}
```

該值在靜態時被加密。僅傳回秘密 ID 和元資料。

## 更新秘密

```
PATCH /api/secrets/{secretId}
{
  "value": "sk-ant-new-value..."
}
```

建立秘密的新版本。引用 `"version": "latest"` 的智能體程式會在下一個心跳時自動取得新值。

## 在智能體程式配置中使用 Secret

在智能體適配器配置中引用機密而不是內聯值：

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "{secretId}",
      "version": "latest"
    }
  }
}
```

伺服器在執行時間解析和解密秘密引用，將真實值注入智能體程式環境中。