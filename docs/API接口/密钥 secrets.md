---
title: 密钥
summary: 密钥 CRUD
---

管理代理在其环境配置中引用的加密密钥。

## 列出密钥

```
GET /api/companies/{companyId}/secrets
```

返回密钥元数据（不包括解密值）。

## 创建密钥

```
POST /api/companies/{companyId}/secrets
{
  "name": "anthropic-api-key",
  "value": "sk-ant-..."
}
```

该值在休息时被加密。只返回密钥 ID 和元数据。

要链接提供商拥有的密钥而不将值复制到 Paperclip 中，请创建外部引用密钥：

```json
{
  "name": "prod-stripe-key",
  "provider": "aws_secrets_manager",
  "managedMode": "external_reference",
  "externalRef": "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/stripe",
  "providerVersionRef": "version-id-or-label"
}
```

Paperclip 仅存储提供商引用和非敏感指纹。当配置提供商时，通过强制执行绑定上下文并记录访问事件的服务器运行时路径解析该值。

## 提供商健康状况

```
GET /api/companies/{companyId}/secret-providers/health
```

返回提供商设置诊断、警告和本地备份指南。健康响应绝不能包含密钥值或提供商凭据。

对于 `aws_secrets_manager`，未就绪的健康响应会指出缺失的非密钥提供商环境变量、服务器运行时期望的 AWS SDK 默认凭据源，以及 AWS 引导凭据不得存储在 Paperclip `company_secrets` 中的保管规则。

等效的 CLI 检查是：

```sh
pnpm paperclipai secrets doctor --company-id {companyId}
```

## 提供商保险库

提供商保险库是命名、公司范围的配置，用于将密钥材料路由到受支持的提供商后端之一。请参阅[密钥部署指南](/部署/密钥管理%20secrets#provider-vaults)了解操作员模型和保管规则。

以下所有路由都需要董事会认证和公司访问权限。变更路由会发出 `secret_provider_config.*` 活动日志条目。此表面中的任何路由都不返回提供商凭据值；在验证时拒绝在 `config` 中提交凭据形状字段。

### 列出保险库

```
GET /api/companies/{companyId}/secret-provider-configs
```

返回公司的所有保险库（包括用于审计的禁用行），每个保险库包含 id、provider、displayName、status、isDefault、非敏感 `config`、最新健康状况快照（`healthStatus`、`healthCheckedAt`、`healthMessage`、`healthDetails`）、`disabledAt` 和审计列。

### 创建保险库

```
POST /api/companies/{companyId}/secret-provider-configs
{
  "provider": "aws_secrets_manager",
  "displayName": "Prod US-East",
  "isDefault": true,
  "config": {
    "region": "us-east-1",
    "namespace": "paperclip",
    "secretNamePrefix": "paperclip",
    "kmsKeyId": "arn:aws:kms:us-east-1:123456789012:key/abcd-...",
    "environmentTag": "production"
  }
}
```

每个提供商的 `config` 形状：

- `local_encrypted`：可选 `backupReminderAcknowledged: boolean`。
- `aws_secrets_manager`：必需 `region`；可选 `namespace`、`secretNamePrefix`、`kmsKeyId`、`ownerTag`、`environmentTag`。
- `gcp_secret_manager`（即将推出）：可选 `projectId`、`location`、`namespace`、`secretNamePrefix`。
- `vault`（即将推出）：可选仅限来源的 HTTPS `address`、`namespace`、`mountPath`、`secretPathPrefix`。包含嵌入式凭据、路径、查询字符串或片段的 `address` 值被拒绝。

`status` 默认为 `local_encrypted` 和 `aws_secrets_manager` 的 `ready`，以及 `gcp_secret_manager` 和 `vault` 的 `coming_soon`。即将推出和禁用的保险库不能标记为 `isDefault`。设置 `isDefault: true` 会在同一事务中清除同一提供商的先前默认值。

### 获取保险库

```
GET /api/secret-provider-configs/{id}
```

### 更新保险库

```
PATCH /api/secret-provider-configs/{id}
{
  "displayName": "Prod US-East-2",
  "config": {
    "region": "us-east-2",
    "kmsKeyId": "arn:aws:kms:us-east-2:123456789012:key/abcd-..."
  }
}
```

`config` 在更新时整体替换 — 传递完整的提供商配置有效负载，而不是部分差异。`gcp_secret_manager` 和 `vault` 的状态转换仅限于 `coming_soon` 和 `disabled`，直到它们的运行时模块发布。

### 禁用保险库

```
DELETE /api/secret-provider-configs/{id}
```

软删除保险库：状态翻转为 `disabled`，清除 `isDefault`，并盖上 `disabledAt`。禁用的保险库保留在 `GET` 结果中以供审计目的，但不再在密钥创建/轮换流程中提供。

### 设置默认值

```
POST /api/secret-provider-configs/{id}/default
```

将目标保险库标记为其提供商系列的默认值，并清除先前的默认值。当目标是 `coming_soon` 或 `disabled` 时返回 422。

### 运行健康状况检查

```
POST /api/secret-provider-configs/{id}/health
```

运行提供商特定的健康状况探测并将结果持久化在保险库上。响应形状：

```json
{
  "configId": "<uuid>",
  "provider": "aws_secrets_manager",
  "status": "ready" | "warning" | "error" | "coming_soon" | "disabled",
  "message": "Provider vault is ready to handle managed writes",
  "details": {
    "code": "provider_ready",
    "message": "...",
    "guidance": ["..."]
  },
  "checkedAt": "2026-05-06T14:00:00.000Z"
}
```

健康响应从不包含提供商凭据或密钥值。对于 AWS 保险库，`details.guidance` 可能包括缺失的非密钥环境名称和预期的 AWS SDK 凭据源；即将推出的保险库总是返回 `status: "coming_soon"` 和 `code: "runtime_locked"`，并且从不调用提供商模块。

### 在创建或轮换密钥时选择保险库

`POST /api/companies/{companyId}/secrets` 和 `POST /api/secrets/{secretId}/rotate` 都接受可选的 `providerConfigId` 字段，将密钥固定到特定的保险库。当省略（或 null）时，操作通过部署级别的提供商配置运行 — 现有安装已经使用的相同路径。董事会 UI 在提交前预选所选提供商的公司默认保险库，因此调用者通常应发送显式的 `providerConfigId`。即将推出和禁用的保险库以 422 拒绝；不匹配密钥提供商的保险库以相同方式拒绝。

```json
POST /api/companies/{companyId}/secrets
{
  "name": "prod-stripe-key",
  "provider": "aws_secrets_manager",
  "providerConfigId": "<vault-uuid>",
  "managedMode": "external_reference",
  "externalRef": "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/stripe"
}
```

### 响应编辑规则

此表面中的每个路由都强制执行相同的编辑合同：

- 密钥值永远不会返回。董事会 UI 从不提供“显示值”功能；解析在运行时在绑定下在服务器端发生。
- 提供商凭据值从不接受、存储、返回、记录或在错误消息中回显。提交凭据形状字段会失败验证并带有不泄露的错误。
- 活动日志条目记录保险库 id、提供商、displayName、status 和 isDefault 转换 — 从不记录 `config` 有效负载或健康状况详细信息正文。

## 从 AWS Secrets Manager 远程导入

远程导入将现有的 AWS Secrets Manager 条目链接到 Paperclip 作为 `external_reference` 密钥。导入仅存储提供商引用元数据；它不将远程密钥明文复制到 Paperclip 中。

路由仅限董事会和公司范围。`providerConfigId` 必须指向状态为 `ready` 或 `warning` 的同一公司 AWS 提供商保险库。禁用、即将推出、非 AWS 和跨公司保险库被拒绝。导入的密钥稍后通过所选保险库解析，因此运行时读取仍然需要对所选外部密钥的 `secretsmanager:GetSecretValue` 和任何必需的 KMS 解密权限。

### 预览远程导入候选

```
POST /api/companies/{companyId}/secrets/remote-import/preview
{
  "providerConfigId": "<aws-vault-uuid>",
  "query": "stripe",
  "nextToken": "opaque-provider-token",
  "pageSize": 50
}
```

`query` 是可选的，并传递给 AWS Secrets Manager 库存过滤。将其视为非密钥元数据，因为 AWS 可能会在 CloudTrail 中记录列表请求参数。`nextToken` 是不透明的 AWS 游标；调用者必须原样传回并且不能合成偏移量。`pageSize` 是可选的，在 UI 中默认为 50，上限为 100。

预览仅使用 AWS `ListSecrets`。它不得调用 `GetSecretValue` 或 `BatchGetSecretValue`，不得请求 `SecretString`，并且不得要求 KMS 解密。响应包含用于显示和冲突决策的清理元数据：

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
        "createdDate": "2026-05-06T00:00:00.000Z",
        "lastChangedDate": "2026-05-06T00:00:00.000Z",
        "hasDescription": true,
        "hasKmsKey": true,
        "tagCount": 3
      },
      "status": "ready",
      "importable": true,
      "conflicts": []
    }
  ]
}
```

候选状态：

- `ready`：该行可以选择用于导入。
- `duplicate`：Paperclip 密钥已经链接到同一提供商保险库的相同规范提供商引用。
- `conflict`：该行有名称/键冲突或提供商护栏失败。

冲突类型是 `exact_reference`、`name`、`key` 和 `provider_guardrail`。Paperclip 自己托管命名空间下的 AWS 引用作为外部引用被阻止；对于这些资源，请改用 Paperclip 托管的密钥流程。

### 导入选定的远程引用

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
        "createdDate": "2026-05-06T00:00:00.000Z"
      }
    }
  ]
}
```

`secrets` 数组接受 1-100 行。每行可以覆盖建议的 Paperclip `name`、`key`、可选的 Paperclip `description`、`providerVersionRef` 和清理的 `providerMetadata`。空白描述存储为 `null`；AWS 提供商描述不会复制到 Paperclip 描述中。后端在提交时重新检查重复引用和名称/键冲突；陈旧的预览不会绕过这些检查。

导入响应是行级的：

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

行状态：

- `imported`：Paperclip 创建了一个活动的 `external_reference` 密钥和一个仅元数据版本行。
- `skipped`：该行有完全引用重复或名称/键冲突。
- `error`：提供商拒绝该引用或该行验证失败。

预览/导入的活动日志仅存储聚合计数、提供商 id 和保险库 id。它们不得存储远程密钥名称、ARN、描述、标签、明文值、提供商凭据或原始 AWS 错误 blob。

## 轮换密钥

```
POST /api/secrets/{secretId}/rotate
{
  "value": "sk-ant-new-value..."
}
```

创建密钥的新版本。引用 `"version": "latest"` 的代理在下次心跳时自动获取新值。当糟糕的 `latest` 推出会同时影响许多代理时，请固定到特定版本。

## 在代理配置中使用密钥

在代理适配器配置中引用密钥，而不是内联值：

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

服务器在运行时解析和解密密钥引用，将真实值注入代理进程环境。Paperclip 的保管保证在注入时结束：代理进程可以读取、记录或转发该值，因此请将绑定到代理的任何密钥视为暴露给该代理。请参阅[密钥部署指南](/部署/密钥管理%20secrets#custody-boundaries)中的保管边界说明。

## 可移植性

公司导出/导入 API 将代理和项目环境需求表示为包清单中的声明。导出省略密钥值、密钥 ID、提供商引用和加密的提供商材料。使用：

```sh
pnpm paperclipai secrets declarations --company-id {companyId}
```

在移动包之前检查导出会发出的声明。