# AWS Secrets Manager 提供者

Paperclip Cloud 所使用的托管 `aws_secrets_manager` 秘密提供者（Secret Provider）的操作契约。

## 范围

- 当 Paperclip Cloud 运行在 AWS 上时，用于 Paperclip 管理的秘密的托管提供者。
- 秘密值的真实数据源（Source of Truth）是 AWS Secrets Manager，而非 Postgres。
- Paperclip 仅存储所有权、绑定、版本选择、审计和运行时解析所需的元数据。
- AWS 提供者的引导凭据（Bootstrap Credentials）属于部署/运行时凭据，而非 Paperclip 管理的公司秘密。
- 对已有 AWS 秘密的远程导入仅为元数据层面。预览/导入使用 AWS 清单元数据并创建 Paperclip 外部引用；不会将明文复制到 Paperclip 中。
- 每个公司的 AWS 提供者保险库（Provider Vault）（即 `aws_secrets_manager` 的命名实例，拥有独立的 region、namespace、prefix、KMS key id 和 tags）通过管理面板 UI 在 `Company Settings → Secrets → Provider vaults` 中管理。参见 [Provider Vaults](../docs/部署/密钥管理 secrets.md#provider-vaults) 了解运营者模型，参见 [Provider Vaults API](../docs/API接口/密钥%20secrets.md#provider-vaults) 了解路由。本文档中的引导信任模型仍然适用——保险库配置仅携带非敏感的路由元数据，绝不包含 AWS 凭据。

## 引导信任模型

AWS 提供者存在一个先有鸡还是先有蛋的边界：Paperclip 无法使用 `company_secrets` 来解锁存储这些秘密的 AWS 提供者。初始 AWS 信任必须在 Paperclip 服务器启动之前就已存在。

允许的引导位置：

- 附加到 Paperclip 服务器运行时的基础设施 IAM 或工作负载身份（Workload Identity）。
- 用于启动 Paperclip 服务器的进程环境或编排器秘密存储。
- 本地 AWS SDK 来源，如 `AWS_PROFILE`、AWS SSO/共享配置、Web 身份、容器元数据或实例元数据。
- 仅限本地开发使用的短期 Shell 凭据。

不要要求运营者将 AWS 根凭据或长期 IAM 用户访问密钥粘贴到 Paperclip 管理面板 UI 中。不要将这些引导密钥存储在 `company_secrets` 中。

## Paperclip Cloud 引导

Paperclip Cloud 必须在任何管理面板用户创建 AWS 支持的公司秘密之前，配置好 AWS 后端资源：

1. 创建或选择部署 KMS 密钥。
2. 为部署创建 Paperclip 服务器运行时角色。
3. 附加一个最小 IAM 策略，限定在部署的 Secrets Manager 前缀和已配置的 KMS 密钥范围内。
4. 使用以下非秘密提供者环境变量配置服务器运行时。
5. 从已部署的运行时执行 `paperclipai doctor` 或提供者健康检查端点，确认提供者报告了预期的 region、prefix、deployment id、KMS 设置和 AWS SDK 凭据来源。

一旦就绪，管理面板 UI 就可以创建 Paperclip 管理的 AWS 秘密，Paperclip 将在部署/公司命名空间下写入它们。

## 自托管和本地引导

自托管的 AWS 部署应使用 AWS SDK 默认凭据提供者链（Default Credential Provider Chain）。首选基于角色的来源：

- EC2 实例配置文件（Instance Profile）。
- ECS 任务角色（Task Role）。
- EKS IRSA 或其他 OIDC Web 身份角色。
- 通过 `AWS_PROFILE` 使用 AWS SSO/共享配置。

本地开发可以使用：

```sh
aws sso login --profile paperclip-dev
AWS_PROFILE=paperclip-dev \
PAPERCLIP_SECRETS_PROVIDER=aws_secrets_manager \
PAPERCLIP_SECRETS_AWS_REGION=us-east-1 \
PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID=dev-local \
PAPERCLIP_SECRETS_AWS_KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/abcd-... \
pnpm dev
```

临时 `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` 环境凭据仅可作为本地应急方案或短期测试来源。它们不应写入 Paperclip 配置、提交到 `.env` 文件、存储在 `company_secrets` 中，或用作 Paperclip Cloud 的默认引导路径。

## 部署配置

必需的环境变量：

```sh
PAPERCLIP_SECRETS_PROVIDER=aws_secrets_manager
PAPERCLIP_SECRETS_AWS_REGION=us-east-1
PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID=prod-us-1
PAPERCLIP_SECRETS_AWS_KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/abcd-...
```

可选环境变量：

```sh
PAPERCLIP_SECRETS_AWS_PREFIX=paperclip
PAPERCLIP_SECRETS_AWS_ENVIRONMENT=production
PAPERCLIP_SECRETS_AWS_PROVIDER_OWNER=paperclip
PAPERCLIP_SECRETS_AWS_ENDPOINT=
PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS=30
```

Paperclip 管理的秘密的命名约定：

```text
paperclip/{deploymentId}/{companyId}/{secretKey}
```

Paperclip 管理的秘密的标签集：

- `paperclip:managed-by=paperclip`
- `paperclip:provider-owner=<owner tag>`
- `paperclip:deployment-id=<deployment id>`
- `paperclip:company-id=<company id>`
- `paperclip:secret-key=<secret key>`
- `paperclip:environment=<environment tag>`

## IAM 和 KMS 假设

启动姿态：

- 每个部署一个 Paperclip 应用角色。
- 启动时每个部署一个部署范围的 KMS 密钥。
- 未来的每公司 KMS 密钥保持兼容，因为 Paperclip 将提供者引用和版本元数据与值分开存储。

最小 IAM 边界：

- 允许 `secretsmanager:CreateSecret`、`PutSecretValue`、`GetSecretValue` 和 `DeleteSecret`。
- 将资源限定在部署前缀范围内：

```text
arn:aws:secretsmanager:<region>:<account-id>:secret:paperclip/<deployment-id>/*
```

- 允许对已配置的部署 CMK 执行 `kms:Encrypt`、`kms:Decrypt`、`kms:GenerateDataKey` 和 `kms:DescribeKey`。
- 拒绝部署前缀之外的通配符访问。
- 优先使用工作负载身份/基于角色的认证。不要在 Paperclip 配置中内联存储 AWS 凭据。

最小策略示例：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PaperclipDeploymentSecrets",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:GetSecretValue",
        "secretsmanager:DeleteSecret"
      ],
      "Resource": "arn:aws:secretsmanager:<region>:<account-id>:secret:paperclip/<deployment-id>/*"
    },
    {
      "Sid": "PaperclipDeploymentKms",
      "Effect": "Allow",
      "Action": [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:GenerateDataKey",
        "kms:DescribeKey"
      ],
      "Resource": "arn:aws:kms:<region>:<account-id>:key/<key-id>"
    }
  ]
}
```

运营预期：

- Paperclip 管理的秘密只能由 Paperclip 或拥有等效应急访问权限的运营者删除。
- 外部引用可通过 Paperclip 运行时解析，但 Paperclip 不应删除外部秘密资源。

## 远程导入清单 IAM

远程导入预览需要一项额外的 AWS 权限：

```json
{
  "Sid": "PaperclipRemoteSecretInventory",
  "Effect": "Allow",
  "Action": "secretsmanager:ListSecrets",
  "Resource": "*"
}
```

这与托管的创建/轮换/删除策略是刻意分开的。AWS 将 `ListSecrets` 视为账户/区域级别的清单操作；不要将秘密 ARN、名称、标签或 AWS 请求过滤器作为其 IAM 边界。使用 `Resource: "*"` 并决定每个提供者保险库背后的 AWS 账户和区域是否可接受清单暴露。

远程导入预览/导入不得调用：

- `secretsmanager:GetSecretValue`
- `secretsmanager:BatchGetSecretValue`
- `kms:Decrypt`

这些权限仅在绑定的运行时解析导入的外部引用时才需要。对于导入的引用，将读取权限限定在运营者批准的、Paperclip 被允许消费的外部前缀范围内：

```json
{
  "Sid": "PaperclipResolveImportedExternalReferences",
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": [
    "arn:aws:secretsmanager:<region>:<account-id>:secret:<approved-external-prefix>/*"
  ]
}
```

如果选定的外部秘密使用客户管理的 KMS 密钥（Customer-Managed KMS Keys），还需授予这些密钥的 `kms:Decrypt` 和 `kms:DescribeKey` 权限。将托管的写入/删除权限限定在 `paperclip/<deployment-id>/*` 范围内；不要为远程导入而扩大范围。

安全范围建议：

- 优先每个环境/账户使用一个 Paperclip 运行时角色。
- 将提供者保险库指向目标 AWS 账户和区域，而非使用广泛的中央管理角色。
- 仅在可接受清单暴露的账户中启用 `ListSecrets`。
- 将预览/导入限制在管理面板中；Agent API 密钥不得调用这些路由。
- 将 AWS 标签/名称过滤器仅视为搜索体验，而非权限强制手段。

Paperclip 还会阻止将自身托管命名空间下的引用作为外部引用导入。对于 `paperclip/{deploymentId}/{companyId}/{secretKey}` 资源，请使用 Paperclip 管理流程。

## 已有 AWS 秘密

V1 将已有的 AWS Secrets Manager 条目保留为**链接的外部引用**，而非被采用的 Paperclip 管理资源。

当 Paperclip 应负责创建和轮换值时，使用 Paperclip 管理流程。AWS 秘密名称由部署和公司范围派生：

```text
paperclip/{deploymentId}/{companyId}/{secretKey}
```

当秘密已存在于运营者拥有的路径时，使用外部引用流程，例如：

```text
/paperclip-bench/anthropic_api_key
```

在此模式下，Paperclip 仅存储路径或 ARN，在运行时解析它，并记录脱敏的访问事件。运营者在 AWS 中轮换实际值。仅当 AWS 路径、ARN 或固定的提供者版本发生变化时，才更新 Paperclip 引用。

Paperclip 目前不提供"采用已有 AWS 秘密"的流程来接管任意现有秘密的未来 `PutSecretValue` 写入。后续添加该功能需要明确的确认 UX、范围验证、预期的 Paperclip 标签以及安全/云运维审查。

## 数据保管

- Paperclip 存储 `externalRef`、`providerVersionRef`、provider id、指纹哈希、状态和绑定元数据。
- Paperclip 不在 `company_secret_versions.material` 中存储 AWS 秘密明文。
- 运行时解析仅在绑定的消费者需要时才从 AWS 获取值。

## 轮换操作手册

手动 Paperclip 管理的轮换：

1. 通过 Paperclip 秘密轮换流程写入新值。
2. Paperclip 使用 `PutSecretValue` 创建新的 AWS 秘密版本。
3. Paperclip 在 `company_secret_versions` 中记录新的 `providerVersionRef`。
4. 重新运行或重启消费 `latest` 的受影响工作负载，或在需要分阶段发布安全性时，在上线前将消费者固定到特定的 Paperclip 版本。

建议：

- 对于高风险上线，优先使用固定的 Paperclip 秘密版本。
- 将提供者原生自动轮换视为后续增强；当前 V1 流程是显式创建新版本加上受控上线。

## 备份与恢复操作手册

必须保留的内容：

- 秘密所有权、绑定、状态和提供者版本引用的 Paperclip 数据库元数据。
- 配置的部署前缀下的 AWS Secrets Manager 命名空间。
- 配置的 KMS 密钥及其解密权限。

恢复清单：

1. 恢复 Paperclip 数据库元数据。
2. 确认相同的 AWS Secrets Manager 命名空间仍然存在。
3. 确认 Paperclip 运行时角色可以对恢复的前缀调用 `GetSecretValue`。
4. 确认角色仍对 `PAPERCLIP_SECRETS_AWS_KMS_KEY_ID` 引用的 CMK 拥有解密访问权限。
5. 运行下文的在线冒烟测试或有针对性的运行时秘密解析测试。

## 提供者中断操作手册

症状：

- 秘密创建/轮换/解析操作因 AWS 提供者错误而失败。
- Agent 运行在适配器调用前因必需的秘密解析失败而中止。
- 远程导入预览无法列出 AWS 清单。

即时操作：

1. 确认 AWS 区域健康状况和 Secrets Manager 可用性。
2. 确认运行时角色仍拥有 `GetSecretValue` 和 KMS 解密权限。
3. 检查是否存在意外的 prefix、region、deployment id 或 KMS 密钥配置漂移。
4. 在 AWS 服务健康恢复后重试单次解析。
5. 如果中断持续，暂停需要秘密访问的高风险运行，而非不断重试。

远程导入专项操作：

- 缺少列表权限：仅在该保险库的 AWS 账户和区域已批准清单导入时，添加 `Resource: "*"` 的 `secretsmanager:ListSecrets`。
- 限流：缩小搜索范围，短暂等待，然后使用退避策略重试。避免全账户枚举。
- 无效或过期的游标：刷新预览并丢弃旧的 `NextToken`。
- 大型账户：有意地逐页加载，每个保险库/搜索保持一个进行中的预览请求，不运行后台全账户爬取。
- 导入后运行时读取失败：验证选定外部秘密的 `GetSecretValue` 和 KMS 解密权限。`ListSecrets` 中的可见性不证明具有读取权限。

## 事件响应操作手册

潜在事件：

- 由 IAM 范围漂移导致的跨公司访问。
- KMS 策略漂移导致解密失败或过度宽泛的访问。
- 疑似秘密在日志、转录或下游 Agent 输出中泄露。

响应步骤：

1. 停止或暂停受影响的 Paperclip 运行。
2. 审计最近的 Paperclip 秘密访问事件，确定受影响的秘密 ID 和消费者。
3. 审计 AWS CloudTrail，在相关保险库账户、区域、部署前缀和已批准外部前缀上查看 `ListSecrets`、`GetSecretValue`、`PutSecretValue` 和 `DeleteSecret` 调用。
4. 通过 Paperclip 管理的版本控制在 AWS 中轮换受影响的秘密。
5. 在恢复正常流量之前重新调整 IAM 和 KMS 策略范围。
6. 如果值可能已到达 Agent 转录或外部系统，将其视为已泄露并立即轮换。

## 可选在线冒烟测试

本地可安全跳过此步骤。仅针对专用的 AWS 测试命名空间运行。

前提条件：

- 拥有上述部署范围 IAM 权限的 AWS 凭据或工作负载身份。
- `PAPERCLIP_SECRETS_PROVIDER=aws_secrets_manager`
- 已设置必需的 `PAPERCLIP_SECRETS_AWS_*` 环境变量。

建议的冒烟测试：

1. 通过 Paperclip 管理面板或 API 在一个临时公司下创建测试秘密。
2. 确认生成的 AWS 秘密名称与 `paperclip/{deploymentId}/{companyId}/{secretKey}` 匹配。
3. 轮换一次秘密，确认 Paperclip 元数据中出现新的 `providerVersionRef`。
4. 通过绑定的运行时路径解析秘密，而非添加通用的明文查看端点。
5. 删除临时秘密，确认 AWS 按配置的恢复窗口安排删除。
