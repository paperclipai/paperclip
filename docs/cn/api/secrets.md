---
title: 秘密
summary: 秘密增删改查
---
管理智能体在其环境配置中引用的加密机密。

## 列出秘密

```
GET /api/companies/{companyId}/secrets
```

返回秘密元数据（不是解密值）。

## 创建秘密

```
POST /api/companies/{companyId}/secrets
{
  "name": "anthropic-api-key",
  "value": "sk-ant-..."
}
```

该值在静态时被加密。仅返回秘密 ID 和元数据。

## 更新秘密

```
PATCH /api/secrets/{secretId}
{
  "value": "sk-ant-new-value..."
}
```

创建秘密的新版本。引用 `"version": "latest"` 的智能体会在下一个心跳时自动获取新值。

## 在智能体配置中使用 Secret

在智能体适配器配置中引用机密而不是内联值：

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

服务器在运行时解析和解密秘密引用，将真实值注入智能体进程环境中。