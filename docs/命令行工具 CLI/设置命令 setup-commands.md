---
title: 设置命令
summary: 入门、运行、诊断和配置
---

实例设置和诊断命令。

## `paperclipai run`

单命令引导和启动：

```sh
pnpm paperclipai run
```

执行：

1. 如果配置缺失，自动入门
2. 运行 `paperclipai doctor` 并启用修复
3. 当检查通过时启动服务器

选择特定实例：

```sh
pnpm paperclipai run --instance dev
```

## `paperclipai onboard`

交互式首次设置：

```sh
pnpm paperclipai onboard
```

如果 Paperclip 已配置，重新运行 `onboard` 会保留现有配置。使用 `paperclipai configure` 更改现有安装上的设置。

第一个提示：

1. `快速入门`（推荐）：本地默认值（嵌入式数据库，无 LLM 提供商，本地磁盘存储，默认秘密）
2. `高级设置`：完整交互式配置

入门后立即启动：

```sh
pnpm paperclipai onboard --run
```

非交互式默认值 + 立即启动（服务器监听时打开浏览器）：

```sh
pnpm paperclipai onboard --yes
```

在现有安装上，`--yes` 现在保留当前配置，只是使用该设置启动 Paperclip。

## `paperclipai doctor`

带可选自动修复的运行状况检查：

```sh
pnpm paperclipai doctor
pnpm paperclipai doctor --repair
```

验证：

- 服务器配置
- 数据库连接
- 秘密适配器配置，包括所选时的 AWS Secrets Manager 非秘密环境配置
- 存储配置
- 缺失的密钥文件

## `paperclipai configure`

更新配置部分：

```sh
pnpm paperclipai configure --section server
pnpm paperclipai configure --section secrets
pnpm paperclipai configure --section storage
```

`--section secrets` 更新部署级别的提供商，用作未针对特定公司保险库的秘密的后备。每公司提供商保险库（命名实例、默认保险库选择、每提供商多个保险库、即将推出的 GCP/Vault）位于董事会 UI 中的 `公司设置 → 秘密 → 提供商保险库` 和 `/api/companies/{companyId}/secret-provider-configs` API 下。

## `paperclipai env`

显示已解析的环境配置：

```sh
pnpm paperclipai env
```

当配置时，这现在包括面向绑定的部署设置，如 `PAPERCLIP_BIND` 和 `PAPERCLIP_BIND_HOST`。

## `paperclipai allowed-hostname`

允许用于已认证/私有模式的私有主机名：

```sh
pnpm paperclipai allowed-hostname my-tailscale-host
```

## 本地存储路径


| 数据   | 默认路径                                                |
| ---- | --------------------------------------------------- |
| 配置   | `~/.paperclip/instances/default/config.json`        |
| 数据库  | `~/.paperclip/instances/default/db`                 |
| 日志   | `~/.paperclip/instances/default/logs`               |
| 存储   | `~/.paperclip/instances/default/data/storage`       |
| 秘密密钥 | `~/.paperclip/instances/default/secrets/master.key` |


使用以下命令覆盖：

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

或者直接在任何命令上传递 `--data-dir`：

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai doctor --data-dir ./tmp/paperclip-dev
```

