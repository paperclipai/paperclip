---
title: 机密 (Secrets)
summary: 机密 CRUD
---

管理智能体在其环境配置中引用的加密机密（Secrets）。

## 列出机密

```
GET /api/companies/{companyId}/secrets
```

返回机密数据的元数据（而不是解密后的值）。

## 创建机密

```
POST /api/companies/{companyId}/secrets
{
  "name": "anthropic-api-key",
  "value": "sk-ant-..."
}
```

值在静态存储时会被加密。只返回机密 ID 和元数据。

## 更新机密

```
PATCH /api/secrets/{secretId}
{
  "value": "sk-ant-new-value..."
}
```

创建一个新版本的机密。引用 `"version": "latest"` 的智能体会在下一次心跳时自动获取新值。

## 在智能体配置中使用机密

在智能体适配器配置中引用机密，而不是使用内联的明文：

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

服务器会在运行时解析解密引用的机密，并将真正的值注入到智能体进程环境里。
