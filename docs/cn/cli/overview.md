---
title: CLI 概述
summary: CLI 安装和设置
---
Paperclip CLI 处理实例设置、诊断和控制平面操作。

## 用法

```sh
pnpm paperclipai --help
```

## 全局选项

所有命令都支持：

|旗帜|描述 |
|------|-------------|
| `--data-dir <path>` |本地 Paperclip 数据根（与 `~/.paperclip` 隔离）|
| `--api-base <url>` | API 基本网址 |
| `--api-key <token>` | API 身份验证令牌 |
| `--context <path>` |上下文文件路径 |
| `--profile <name>` |上下文配置文件名称 |
| `--json` |输出为 JSON |

公司范围的命令也接受 `--company-id <id>`。

对于干净的本地实例，请在运行的命令上传递 `--data-dir`：

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
```

## 上下文配置文件

存储默认值以避免重复标志：

```sh
# Set defaults
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <id>

# View current context
pnpm paperclipai context show

# List profiles
pnpm paperclipai context list

# Switch profile
pnpm paperclipai context use default
```

为了避免在上下文中存储机密，请使用环境变量：

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

上下文存储在`~/.paperclip/context.json`。

## 命令类别

CLI 有两个类别：

1. **[设置命令](/cn/cli/setup-commands)** — 实例引导、诊断、配置
2. **[控制平面命令](/cn/cli/control-plane-commands)** — 问题、智能体、批准、活动