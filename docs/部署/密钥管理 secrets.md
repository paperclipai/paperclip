---
title: 密钥管理
summary: 主密钥、加密和严格模式
---

Paperclip 使用本地主密钥加密休息时的密钥。包含敏感值（API 密钥、令牌）的代理环境变量存储为加密密钥引用。

## 保管边界

Paperclip 保护密钥值，直到它们被传递给代理或工作负载：

- 存储：值由活动提供商在休息时加密。本地提供商使用从不离开主机的密钥对它们进行加密。
- 传输：值在调用前在服务器端解密并注入到代理进程环境、SSH 命令环境、沙箱驱动程序或 HTTP 请求中。Paperclip 不向董事会 UI 返回解密值。
- 审计：每次解析记录一个非敏感事件（密钥 ID、版本、提供商 ID、消费者、结果），而不包含值或提供商凭据。

一旦值到达消费进程，Paperclip 就不能再保证保密性。代理（或沙箱，或远程主机）可以读取该值，将其写入自己的日志或转录，或将其传递给下游工具。将你绑定到代理的任何密钥视为暴露给该代理。通过绑定（仅绑定每个代理需要的内容）、提供商支持的短期提供商凭据以及当代理转录或下游系统可能已捕获值时进行轮换来限制爆炸半径。

## 在运行中使用密钥

创建公司密钥不会自动创建环境变量。你通过将其绑定到支持密钥引用的代理、项目、环境或插件配置字段来使用密钥。

对于代理和项目环境变量：

1. 在 `公司设置 > 密钥` 中创建或链接密钥。
2. 打开代理的 `环境变量` 字段，或项目的 `环境` 字段。
3. 添加进程期望的环境变量键，如 `GH_TOKEN` 或 `OPENAI_API_KEY`。
4. 将行源设置为 `密钥`，选择存储的密钥，并选择 `最新` 或固定版本。

在运行时，Paperclip 在服务器端解析所选密钥，并在绑定行下的环境键下注入解析后的值。存储的密钥名称可以是人类可读的；绑定键是代理进程接收的内容。

项目环境适用于该项目中的每个问题运行。当项目环境键匹配代理环境键时，在 Paperclip 注入自己的 `PAPERCLIP_*` 运行时变量之前，项目值优先。

## 默认提供商：`local_encrypted`

密钥使用存储在以下位置的本地主密钥加密：

```
~/.paperclip/instances/default/secrets/master.key
```

该密钥在入门期间自动创建。密钥从不离开你的机器。Paperclip 在创建或加载密钥文件时尽力执行 `0600` 权限。`paperclipai doctor` 和提供商运行状况 API 在文件可由组或其他用户读取时发出警告。

将密钥文件与数据库备份一起备份。没有密钥的数据库备份无法解密本地密钥，而没有数据库元数据的密钥备份不足以恢复命名的密钥版本。

## 配置

### CLI 设置

入门写入默认密钥配置：

```sh
pnpm paperclipai onboard
```

更新密钥设置：

```sh
pnpm paperclipai configure --section secrets
```

验证密钥配置：

```sh
pnpm paperclipai doctor
pnpm paperclipai secrets doctor --company-id <company-id>
```

### 环境覆盖

| 变量 | 描述 |
|----------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | 作为 base64、hex 或原始字符串的 32 字节密钥 |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | 自定义密钥文件路径 |
| `PAPERCLIP_SECRETS_STRICT_MODE` | 设置为 `true` 以强制执行密钥引用 |

## 严格模式

启用严格模式时，敏感环境键（匹配 `*_API_KEY`、`*_TOKEN`、`*_SECRET`）必须使用密钥引用，而不是内联纯值。

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

推荐用于本地信任以外的任何部署。

经过身份验证的部署默认严格模式开启，除非通过配置或 `PAPERCLIP_SECRETS_STRICT_MODE=false` 显式覆盖。

## 外部引用

提供商拥有的密钥可以通过使用 `managedMode: "external_reference"` 加上提供商 `externalRef` 来链接，而无需将值复制到 Paperclip 中。Paperclip 存储元数据和非敏感指纹，而不是值。运行时解析仍然是服务器端和绑定强制的。

内置的 AWS、GCP 和 Vault 提供商 ID 当前接受外部引用元数据，但运行时解析需要部署中的提供商配置。他们的提供商运行状况检查将其报告为警告，直到配置。

对于在 AWS 上托管的 Paperclip Cloud，请参阅 AWS Secrets Manager 操作合同 — 所需的环境变量、IAM/KMS 范围、命名和标签约定以及备份/轮换/事件运行手册 — 在 `doc/SECRETS-AWS-PROVIDER.md`。

## 提供商保险库

提供商保险库是命名、公司范围的配置，将密钥材料指向支持的提供商后端之一。每个公司可以配置多个保险库，包括每个提供商系列多个保险库，并为每个提供商系列选择一个默认保险库用于新密钥操作。在配置任何保险库之前创建的现有密钥继续通过部署级别的默认提供商解析 — 无需迁移。

### 在哪里配置

在董事会 UI 中打开 `公司设置 → 密钥` 并切换到 `提供商保险库` 选项卡。从那里你可以：

- 为任何支持的提供商系列创建保险库。
- 编辑现有保险库的非密钥配置。
- 为每个提供商系列设置一个就绪保险库作为公司默认值。
- 禁用保险库（保留审计历史的软删除）。
- 对保险库运行运行状况检查并内联读取最新结果。

相同的操作在 `/api/companies/{companyId}/secret-provider-configs` 下公开用于自动化。请参阅[密钥 API 参考](/api/secrets#provider-vaults)了解完整的路由表。

### 提供商凭据的保管

提供商保险库有意仅存储**非敏感**配置：区域、项目 ID、命名空间、前缀、KMS 密钥 ID、挂载路径、地址和类似路由元数据。API、UI 和活动日志从不接受、返回或显示提供商凭据值。提交名称如 `accessKeyId`、`secretAccessKey`、`token`、`password`、`serviceAccountJson`、`privateKey`、`keyFile`、`unsealKey` 或任何常见凭据别名的字段在验证时被拒绝。

这保持了 AWS 提供商的引导规则适用于每个提供商系列：**提供商凭据存在于部署基础设施身份中，而不是 Paperclip 公司密钥中**。允许的凭据源是附加到 Paperclip 服务器的工作负载标识（实例配置文件、IRSA、ECS 任务角色）、用于本地运行的 `AWS_PROFILE` / SSO / 共享配置、引导服务器的编排器密钥存储，或用于本地开发的短期 shell 凭据。不要将长期 API 密钥粘贴到保险库配置中。

### 保险库状态

每个保险库都有一个状态，驱动运行时可以对其执行的操作：

| 状态 | 含义 |
|---------------|-----------------------------------------------------------------------------------------------|
| `ready` | 可选择用于创建/轮换/解析。有资格成为默认值。 |
| `warning` | 保存的配置存在但运行状况需要注意（例如缺少 AWS 环境）。仍然可选择。 |
| `coming_soon` | 作为草稿元数据可见和可编辑，但被锁定在所有运行时操作之外。 |
| `disabled` | 软删除。从密钥创建/轮换流程中隐藏。 |

`gcp_secret_manager` 和 `vault` 被固定为 `coming_soon`，直到它们的运行时模块发布。设置 UI 允许你为这些提供商保存草稿配置（并在保险库列表中显示它们），但针对即将推出的保险库的目标密钥创建、轮换和解析调用会因清晰的运行时锁定错误而失败。

### 默认保险库行为

公司可以将每个提供商系列的**一个**就绪（或警告）保险库标记为默认值。密钥创建和轮换对话框预选所选提供商的默认保险库，因此操作员不必记住要选择哪个保险库。即将推出和禁用的保险库不能被标记为默认值；尝试这样做会返回验证错误。设置新默认值会自动清除该提供商的先前默认值。

如果创建的密钥没有任何 `providerConfigId`（尚无保险库存在，或者操作员清除选择器），运行时解析回退到部署级别的提供商配置 — 现有安装使用的相同路径。这使在配置任何提供商保险库之前创建的密钥无需迁移即可工作。在 UI 中选择默认值是显式选择，而不是运行时回退：创建调用仍然发送显式的 `providerConfigId`。

### 每提供商多个保险库

来自同一提供商系列的多个保险库是一流的。常见模式：

- 两个 AWS 保险库指向不同的区域或 KMS 密钥以进行环境分离。
- 一个暂存 Vault 地址与生产地址并存。
- 一个专用的 GCP 项目用于单个产品线，而公司的其余部分使用另一个。

每个保险库都有自己的显示名称、状态、默认标志和运行状况记录。操作员在创建或轮换密钥时明确选择保险库；预选默认保险库以避免意外路由到错误的帐户。

### 每保险库运行状况检查

`POST /api/secret-provider-configs/{id}/health` 运行提供商特定的运行状况探测并将结果存储在保险库行中。设置 UI 公开相同的操作并内联呈现结果。运行状况响应包括状态、面向操作员的消息和结构化指导（例如缺少环境变量名称、预期的凭据源和备份提醒）。它们从不包含提供商凭据或密钥值。即将推出的保险库总是返回 `runtime_locked` 运行状况代码，并且从不调用提供商模块。

### 提供商特定注意事项

**本地加密保险库** 包装现有的 `local_encrypted` 提供商。上面描述的主密钥路径和轮换指南仍然适用。本地保险库配置主要是簿记加上对密钥文件与数据库一起备份的明确确认。

**AWS Secrets Manager 保险库** 读取每保险库的 `region`、`namespace`、`secretNamePrefix`、`kmsKeyId`、`ownerTag` 和 `environmentTag` 以路由托管写入和外部引用读取。保险库配置补充（并且可以覆盖）部署级别的 `PAPERCLIP_SECRETS_AWS_*` 环境。引导凭据仍然来自 AWS SDK 默认凭据链 — 请参阅 `doc/SECRETS-AWS-PROVIDER.md` 了解完整的 IAM 和 KMS 合同。

**GCP Secret Manager** 和 **HashiCorp Vault** 保险库即将推出。你可以保存草稿 `projectId`、`location`、`namespace`、`address` 和 `mountPath` 元数据，以便公司在提供商模块发布时准备就绪。保险库 `address` 值必须是仅限源的 `http(s)://host[:port]` URL；包含嵌入式凭据、路径、查询字符串或片段的地址被拒绝。

### 从 AWS 保险库远程导入

AWS 提供商保险库可以将现有的 AWS Secrets Manager 条目导入为 Paperclip `external_reference` 密钥。这是一个仅限元数据的链接：Paperclip 存储 AWS ARN/路径、指纹/版本引用和绑定元数据。它在预览或导入期间不读取、复制、存储、记录或显示远程明文密钥值。

董事会 UI 中的操作员流程：

1. 打开 `公司设置 -> 密钥`。
2. 确认至少有一个 AWS 提供商保险库是 `ready` 或 `warning`。
3. 在 `密钥` 选项卡中，选择 `从保险库导入`。
4. 选择一个 AWS 保险库，搜索远程库存，并根据需要加载更多页面。
5. 选中要导入的行，查看/编辑 Paperclip 名称和键，然后提交。
6. 查看结果摘要，了解创建、跳过和失败的行。

预览列表故意是分页和搜索优先的。AWS 帐户可能有大量每个区域的库存，`ListSecrets` 返回不透明的 `NextToken` 游标。不要期望 Paperclip 在后台爬取整个帐户；故意加载页面，并在请求被限制时使用退避重试。

远程导入公开 Paperclip 运行时角色可见的 AWS 密钥元数据，包括名称/ARN 和安全派生字段，如日期、是否存在描述或 KMS 密钥，以及标签计数。将名称、ARN、标签和搜索文本视为可能敏感的操作元数据。API 和活动日志不得存储原始描述、标签、明文值、提供商凭据或原始 AWS 错误 blob。

必需的 AWS 姿态：

- 预览需要可选的 `secretsmanager:ListSecrets` 权限在 `Resource: "*"` 上。AWS 不支持将 `ListSecrets` 限制为单个密钥 ARN 或标签作为 IAM 边界。
- 预览/导入不得调用 `secretsmanager:GetSecretValue`、`secretsmanager:BatchGetSecretValue` 或 KMS 解密。
- 导入引用的运行时解析仍然需要 `secretsmanager:GetSecretValue` 在所选外部 ARN/路径上，以及当该密钥使用客户管理的密钥时的 KMS 解密。
- 将托管创建/轮换/删除权限范围限定在 Paperclip 部署前缀。不要仅仅因为启用了导入库存而扩大托管写入/删除权限。

安全范围来自部署姿态，而不是 AWS 列表过滤：每个环境/帐户的专用 Paperclip 运行时角色、指向预期帐户和区域的 AWS 保险库、仅在库存暴露可接受的地方启用导入的角色，以及仅董事会访问导入路由。标签和名称过滤是搜索辅助工具，而不是权限模型。

如果导入预览失败：

- `AccessDenied` 或 `not authorized`：运行时角色缺少 `secretsmanager:ListSecrets`；仅当该保险库应启用远程导入时才添加可选的库存语句。
- 限制：在短延迟后重试，并在加载更多页面之前缩小搜索范围。
- 无效游标：刷新预览；AWS `NextToken` 值是不透明的，可能过期或变陈旧。
- 导入后运行时解析失败：验证所选外部密钥的 `GetSecretValue` 和 KMS 解密范围。在库存中可见并不是运行时角色可以读取值的证明。

### 备份和恢复

每个提供商系列都有不同的备份故事：

- `local_encrypted`：将本地主密钥文件和 Paperclip 数据库一起备份。单独任何一个都不足以恢复加密值，保险库行只记录路径和确认，而不是密钥字节。
- `aws_secrets_manager`：备份 Paperclip 的数据库以获取保险库元数据（保险库 ID、区域、前缀、KMS 密钥 ID、默认标志、绑定、版本指针）。实际的密钥值位于 AWS Secrets Manager 中配置的前缀下；通过将相同的 Paperclip 公司指向相同的 AWS 命名空间并确认运行时角色仍然具有 `GetSecretValue` 加 KMS 解密来恢复。完整的恢复清单在 `doc/SECRETS-AWS-PROVIDER.md` 中。
- `gcp_secret_manager` 和 `vault`：当它们即将推出时，只有草稿保险库配置存在于 Paperclip 中。数据库备份捕获它。在运行时支持登陆之前，提供商端没有要恢复的内容。

### AWS 提供商引导边界

AWS Secrets Manager 提供商无法从 Paperclip `company_secrets` 自行引导。其初始 AWS 访问必须在服务器可以创建或解析 AWS 支持的公司密钥之前存在，无论你使用部署级别的默认值还是每公司保险库。

对于 Paperclip Cloud，在启用董事会 UI 中的 AWS 支持密钥之前，配置服务器运行时 IAM 角色/工作负载标识、KMS 密钥、部署前缀和非密钥 `PAPERCLIP_SECRETS_AWS_*` 环境配置。对于自托管和本地运行，请使用 AWS SDK 默认凭据链：实例配置文件、ECS 任务角色、EKS IRSA/OIDC Web 身份、通过 `AWS_PROFILE` 的 AWS SSO/共享配置，或用于本地开发的短期 shell 凭据。

不要在 Paperclip 密钥中存储 AWS 根凭据或长期 IAM 用户访问密钥。引导材料属于基础设施 IAM/工作负载标识、进程环境、AWS 配置文件或编排器密钥存储。

## 迁移内联密钥

如果你有配置中带有内联 API 密钥的现有代理，请将它们迁移到加密密钥引用：

```sh
pnpm paperclipai secrets migrate-inline-env --company-id <company-id>
pnpm paperclipai secrets migrate-env --company-id <company-id> --apply

# 用于直接数据库维护的低级脚本
pnpm secrets:migrate-inline-env         # 干运行
pnpm secrets:migrate-inline-env --apply # 应用迁移
```

对常规操作使用 CLI 命令，因为它通过 Paperclip API，创建或轮换密钥记录，并使用审计日志更新代理环境绑定。

## 可移植声明

公司导出仅包括环境声明。它们不包括密钥 ID、提供商引用、加密材料或明文值。

```sh
pnpm paperclipai secrets declarations --company-id <company-id> --kind secret
```

在将包导入另一个实例之前，使用这些声明在目标部署中创建本地值或链接托管提供商引用。对于托管提供商（如 AWS Secrets Manager），托管提供商仍然是值保管人；Paperclip 存储元数据和提供商版本引用，而不是提供商凭据或明文密钥值。

## 代理配置中的密钥引用

代理环境变量使用密钥引用：

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

服务器在运行时解析和解密这些，将真实值注入代理进程环境。