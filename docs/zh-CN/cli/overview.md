---
title: CLI 概览 (Overview)
summary: CLI 命令行工具安装与设置
---

Paperclip 命令行 (CLI) 用于处理实例部署设置、环境诊断以及各类控制平面的操作。

## 使用方法 (Usage)

```sh
pnpm paperclipai --help
```

## 全局选项 (Global Options)

所有命令均支持以下参数：

| 参数标志 | 描述 |
|------|-------------|
| `--data-dir <path>` | 本地的 Paperclip 数据根目录（可以用来与全局 `~/.paperclip` 实施隔离） |
| `--api-base <url>` | API 的基础 URL 地址 |
| `--api-key <token>` | API 的认证令牌 |
| `--context <path>` | 上下文 Context 配置文件的路径 |
| `--profile <name>` | Context 中的配置组 (profile) 名称 |
| `--json` | 以 JSON 格式输出结果 |

所有隶属于公司级别的命令还支持 `--company-id <id>` 选项。

如有需要创建一个干净的本地独立排障实例，你可以在运行命令时传入 `--data-dir` 选项：

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
```

## 配置上下文 (Context Profiles)

为了避免每次都在命令行中重复敲一大推 flag，您可以设置并存储默认上下文：

```sh
# 设置默认值
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <id>

# 查看当前上下文环境
pnpm paperclipai context show

# 打印所有预设的 profile 配置列表
pnpm paperclipai context list

# 切换激活特定的 profile 配置环境
pnpm paperclipai context use default
```

为了避免直接在配置文件中明文存储敏感密码机密，您可以设置它转去读取某个特定的环境变量：

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

所有的 Context 配置数据默认存储在 `~/.paperclip/context.json` 目录下。

## 命令分类目录 (Command Categories)

CLI 命令行工具主要分为两大类：

1. **[安装部署命令 (Setup commands)](/cli/setup-commands)** — 包含实例引导 (bootstrap)、运行诊断 (diagnostics)、以及底层配置 (configuration)
2. **[控制平面命令 (Control-plane commands)](/cli/control-plane-commands)** — 用于管理任务 (issues)、智能体 (agents)、审批流程 (approvals) 以及活动日志 (activity)
