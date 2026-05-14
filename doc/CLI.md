# CLI 参考

Paperclip CLI 现在同时支持：

- 实例设置/诊断（`onboard`、`doctor`、`configure`、`env`、`allowed-hostname`、`env-lab`）
- 控制面（Control Plane）客户端操作（issues、审批、agents、活动、dashboard）

## 基本用法

开发中使用仓库脚本：

```sh
pnpm paperclipai --help
```

首次本地引导 + 运行：

```sh
pnpm paperclipai run
```

选择本地实例：

```sh
pnpm paperclipai run --instance dev
```

## 部署模式（Deployment Modes）

模式分类和设计意图见 `doc/DEPLOYMENT-MODES.md`。

当前 CLI 行为：

- `paperclipai onboard` 和 `paperclipai configure --section server` 在配置中设置部署模式
- 服务器 onboard/configure 会询问可达性意图并写入 `server.bind`
- `paperclipai run --bind <loopback|lan|tailnet>` 在配置缺失时将快速开始绑定预设传入首次运行 onboard
- 运行时可通过 `PAPERCLIP_DEPLOYMENT_MODE` 覆盖模式
- `paperclipai run` 和 `paperclipai doctor` 仍然不暴露直接的低级 `--mode` 标志

规范行为见 `doc/DEPLOYMENT-MODES.md`。

允许 authenticated/private 主机名（例如自定义 Tailscale DNS）：

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

启动默认本地 SSH 夹具用于环境测试：

```sh
pnpm paperclipai env-lab up
pnpm paperclipai env-lab doctor
pnpm paperclipai env-lab status --json
pnpm paperclipai env-lab down
```

所有客户端命令支持：

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

公司范围命令还支持 `--company-id <id>`。

在任何 CLI 命令上使用 `--data-dir` 可将所有默认本地状态（config/context/db/logs/storage/secrets）从 `~/.paperclip` 隔离出来：

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai issue list --data-dir ./tmp/paperclip-dev
```

## 上下文配置文件（Context Profiles）

在 `~/.paperclip/context.json` 中存储本地默认值：

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
pnpm paperclipai context show
pnpm paperclipai context list
pnpm paperclipai context use default
```

为避免在上下文中存储秘钥，设置 `apiKeyEnvVarName` 并将密钥保留在环境变量中：

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

## 公司命令（Company Commands）

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>
pnpm paperclipai company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

示例：

```sh
pnpm paperclipai company delete PAP --yes --confirm PAP
pnpm paperclipai company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

注意：

- 删除操作受服务器端 `PAPERCLIP_ENABLE_COMPANY_DELETION` 控制。
- 使用 agent 认证时，公司删除是公司范围的。使用当前公司 ID/前缀（例如通过 `--company-id` 或 `PAPERCLIP_COMPANY_ID`），而非其他公司。

## 工单命令（Issue Commands）

```sh
pnpm paperclipai issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm paperclipai issue get <issue-id-or-identifier>
pnpm paperclipai issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm paperclipai issue release <issue-id>
```

## 智能体命令（Agent Commands）

```sh
pnpm paperclipai agent list --company-id <company-id>
pnpm paperclipai agent get <agent-id>
pnpm paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` 是手动运行本地 Claude/Codex 作为 Paperclip 智能体的最快方式：

- 创建一个新的长期智能体 API 密钥
- 将缺失的 Paperclip 技能安装到 `~/.codex/skills` 和 `~/.claude/skills`
- 打印 `PAPERCLIP_API_URL`、`PAPERCLIP_COMPANY_ID`、`PAPERCLIP_AGENT_ID` 和 `PAPERCLIP_API_KEY` 的 `export ...` 行

基于 shortname 的本地设置示例：

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

## 秘钥命令（Secrets Commands）

```sh
pnpm paperclipai secrets list --company-id <company-id>
pnpm paperclipai secrets declarations --company-id <company-id> [--include agents,projects] [--kind secret]
pnpm paperclipai secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
pnpm paperclipai secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
pnpm paperclipai secrets doctor --company-id <company-id>
pnpm paperclipai secrets migrate-inline-env --company-id <company-id> [--apply]
```

秘钥列表和声明从不打印秘钥值。`create` 接受 `--value-env` 以避免 shell 历史记录捕获值。`link` 记录提供商拥有的引用而不将秘钥值复制到 Paperclip 中。对于 AWS 支持的秘钥，`secrets doctor` 报告缺失的非秘钥 provider 环境变量和预期的 AWS SDK 运行时凭证来源；不要将 AWS 引导凭证存储在 Paperclip 秘钥中。

每公司的 provider vault（每个 provider 多个 vault 实例、默认 vault 选择、即将支持的 GCP/Vault）在 Board UI 的 `Company Settings → Secrets → Provider vaults` 或通过 `/api/companies/{companyId}/secret-provider-configs` 配置。目前没有用于 vault 管理的 CLI 接口。详见[秘钥部署指南](../docs/部署/08 密钥管理 secrets.md#provider-vaults)和 [API 参考](../docs/API接口/12%20密钥%20secrets.md#provider-vaults)了解契约。

## 审批命令（Approval Commands）

```sh
pnpm paperclipai approval list --company-id <company-id> [--status pending]
pnpm paperclipai approval get <approval-id>
pnpm paperclipai approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]
pnpm paperclipai approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm paperclipai approval comment <approval-id> --body "..."
```

## 活动命令（Activity Commands）

```sh
pnpm paperclipai activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## 仪表板命令（Dashboard Commands）

```sh
pnpm paperclipai dashboard get --company-id <company-id>
```

## 心跳命令（Heartbeat Command）

`heartbeat run` 现在还支持 context/api-key 选项并使用共享客户端栈：

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## 本地存储默认路径（Local Storage Defaults）

本地 Paperclip 数据位于所选实例根下。`PAPERCLIP_HOME` 选择 home 目录，`PAPERCLIP_INSTANCE_ID` 选择实例。

```text
~/.paperclip/                                     # PAPERCLIP_HOME
└── instances/
    └── default/                                  # 实例根（PAPERCLIP_INSTANCE_ID）
        ├── config.json                           # 运行时配置
        ├── .env                                  # 实例环境变量文件
        ├── db/                                   # 嵌入式 PostgreSQL 数据
        ├── data/
        │   ├── storage/                          # local_disk 上传
        │   └── backups/                          # 自动数据库备份
        ├── logs/
        ├── secrets/
        │   └── master.key                        # local_encrypted 主密钥
        ├── workspaces/                           # 默认智能体工作区
        ├── projects/                             # 项目执行工作区
        ├── companies/                            # 每公司适配器 home（如 codex-home）
        └── codex-home/                           # 每实例 codex home（非公司范围时）
```

规范安装的默认路径：

- 配置：`~/.paperclip/instances/default/config.json`
- 嵌入式数据库：`~/.paperclip/instances/default/db`
- 日志：`~/.paperclip/instances/default/logs`
- 存储：`~/.paperclip/instances/default/data/storage`
- 秘钥密钥：`~/.paperclip/instances/default/secrets/master.key`

通过环境变量覆盖基础 home 或实例：

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

## 存储配置（Storage Configuration）

配置存储 provider 和设置：

```sh
pnpm paperclipai configure --section storage
```

支持的 provider：

- `local_disk`（默认；本地单用户安装）
- `s3`（S3 兼容对象存储）
