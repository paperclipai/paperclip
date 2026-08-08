---
title: 保密管理
summary: 主密钥、加密和严格模式
---
Paperclip 使用本地主密钥加密静态机密。包含敏感值（API 密钥、令牌）的智能体环境变量存储为加密的秘密引用。

## 默认提供商：`local_encrypted`

秘密使用存储在以下位置的本地主密钥进行加密：

```
~/.paperclip/instances/default/secrets/master.key
```

该密钥是在入职期间自动创建的。钥匙永远不会离开您的机器。

## 配置

### CLI 设置

Onboarding 写入默认机密配置：

```sh
pnpm paperclipai onboard
```

更新机密设置：

```sh
pnpm paperclipai configure --section secrets
```

验证机密配置：

```sh
pnpm paperclipai doctor
```

### 环境覆盖

|变量|描述 |
|----------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | Base64、十六进制或原始字符串形式的 32 字节密钥 |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` |自定义密钥文件路径 |
| `PAPERCLIP_SECRETS_STRICT_MODE` |设置为 `true` 以强制执行秘密引用 |

## 严格模式

启用严格模式时，敏感环境键（匹配 `*_API_KEY`、`*_TOKEN`、`*_SECRET`）必须使用秘密引用而不是内联纯值。

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

建议用于本地可信之外的任何部署。

## 迁移内联机密

如果您的现有智能体在其配置中具有内联 API 密钥，请将它们迁移到加密的秘密引用：

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## 智能体配置中的秘密引用

智能体环境变量使用秘密引用：

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "8f884973-c29b-44e4-8ea3-6413437f8081",
      "version": "latest"
    }
  }
}
```

服务器在运行时解析并解密这些内容，将真实值注入智能体进程环境中。