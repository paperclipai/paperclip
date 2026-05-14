---
title: 远程导入密钥
summary: AWS Secrets Manager 仅元数据远程导入 API
---

远程导入让董事会将现有的 AWS Secrets Manager 条目链接为 Paperclip `external_reference` 密钥，而无需将明文复制到 Paperclip 中。

两个路由都是仅限董事会和公司范围的。所选提供商保险库必须属于公司，使用 `aws_secrets_manager`，并具有可选择状态（`ready` 或 `warning`）。禁用、即将推出或跨公司保险库被拒绝。

远程导入是库存和元数据工作流。预览仅调用 AWS `ListSecrets`，导入存储 Paperclip 外部引用以及指纹/版本元数据。两个路由都不调用 `GetSecretValue` 或 `BatchGetSecretValue`，不请求 `SecretString`，不需要 KMS 解密，不记录原始远程元数据，也不将密钥明文复制到 Paperclip 中。

## 预览远程 AWS 密钥

```
POST /api/companies/{companyId}/secrets/remote-import/preview
{
  "providerConfigId": "<aws-vault-uuid>",
  "query": "stripe",
  "nextToken": "optional-provider-page-token",
  "pageSize": 50
}
```

`query` 是可选的，并作为库存过滤器发送到 AWS。将其视为非密钥元数据，因为 AWS 可能会在 CloudTrail 中记录列表请求参数。`nextToken` 是不透明的 AWS 游标；原样传回。`pageSize` 上限为 100。

响应：

```json
{
  "providerConfigId": "<aws-vault-uuid>",
  "provider": "aws_secrets_manager",
  "nextToken": null,
  "candidates": [
    {
      "externalRef": "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/stripe",
      "remoteName": "prod/stripe",
      "name": "prod/stripe",
      "key": "prod-stripe",
      "providerVersionRef": null,
      "providerMetadata": {
        "lastChangedDate": "2026-05-06T00:00:00.000Z",
        "hasDescription": true
      },
      "status": "ready",
      "importable": true,
      "conflicts": []
    }
  ]
}
```

候选 `status` 值：

- `ready`：没有现有的完全外部引用，也没有名称/键冲突。
- `duplicate`：现有密钥已具有完全提供商 `externalRef`。
- `conflict`：建议的 Paperclip `name` 或 `key` 已在使用中。

冲突 `type` 值为 `exact_reference`、`name`、`key` 和 `provider_guardrail`。Paperclip 自己托管命名空间下的 AWS 引用作为外部引用被阻止，因此一个公司无法通过广泛的运行时角色导入另一个公司的 Paperclip 托管的 AWS 密钥。

## 导入远程 AWS 密钥引用

```
POST /api/companies/{companyId}/secrets/remote-import
{
  "providerConfigId": "<aws-vault-uuid>",
  "secrets": [
    {
      "externalRef": "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/stripe",
      "name": "Stripe production key",
      "key": "stripe-production-key",
      "description": "Stripe key used by production checkout",
      "providerVersionRef": null,
      "providerMetadata": {
        "lastChangedDate": "2026-05-06T00:00:00.000Z",
        "hasDescription": true
      }
    }
  ]
}
```

导入响应是行级的。就绪的行成为活动的 `external_reference` 密钥，仅包含版本元数据。完全引用重复和名称/键冲突的行被跳过，而不会使整个请求失败。`secrets` 数组接受 1-100 行，后端在提交时重新检查重复和冲突。每行可能包括可选的 Paperclip `description`，在审查期间输入；空白描述存储为 `null`。AWS 提供商描述不会复制到此字段中。

```json
{
  "providerConfigId": "<aws-vault-uuid>",
  "provider": "aws_secrets_manager",
  "importedCount": 1,
  "skippedCount": 1,
  "errorCount": 0,
  "results": [
    {
      "externalRef": "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/stripe",
      "name": "Stripe production key",
      "key": "stripe-production-key",
      "status": "imported",
      "reason": null,
      "secretId": "<paperclip-secret-id>",
      "conflicts": []
    }
  ]
}
```

活动日志仅记录聚合计数和提供商/保险库 ID，不记录远程密钥名称、ARN、标签或值。

如果 Paperclip 运行时角色可以列出 AWS 密钥但缺乏对该特定密钥的 `secretsmanager:GetSecretValue` 或所需的 KMS 解密权限，导入的引用在未来的绑定运行时解析期间仍可能失败。