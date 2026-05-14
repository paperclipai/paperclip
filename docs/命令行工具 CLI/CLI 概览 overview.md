---

## title: CLI 概览
summary: CLI 安装和设置

Paperclip CLI 处理实例设置、诊断和控制平面操作。

## 用法

```sh
pnpm paperclipai --help
```

## 全局选项

所有命令支持：


| 标志                  | 描述                                      |
| ------------------- | --------------------------------------- |
| `--data-dir <path>` | 本地 Paperclip 数据根目录（与 `~/.paperclip` 隔离） |
| `--api-base <url>`  | API 基础 URL                              |
| `--api-key <token>` | API 认证令牌                                |
| `--context <path>`  | 上下文文件路径                                 |
| `--profile <name>`  | 上下文配置文件名称                               |
| `--json`            | 输出为 JSON                                |


公司范围的命令还接受 `--company-id <id>`。

对于干净的本地实例，在运行的命令上传递 `--data-dir`：

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
```

## 上下文配置文件

存储默认值以避免重复标志：

```sh
# 设置默认值
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <id>

# 查看当前上下文
pnpm paperclipai context show

# 列出配置文件
pnpm paperclipai context list

# 切换配置文件
pnpm paperclipai context use default
```

为避免在上下文中存储秘密，请使用环境变量：

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

秘密操作在 `paperclipai secrets` 下可用：

```sh
pnpm paperclipai secrets declarations --company-id <company-id> --kind secret
pnpm paperclipai secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
pnpm paperclipai secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
pnpm paperclipai secrets doctor --company-id <company-id>
pnpm paperclipai secrets migrate-inline-env --company-id <company-id> --apply
```

上下文存储在 `~/.paperclip/context.json`。

## 命令类别

CLI 有两个类别：

1. **[设置命令](/命令行工具%20CLI/设置命令%20setup-commands)** — 实例引导、诊断、配置
2. **[控制平面命令](/命令行工具%20CLI/控制平面命令%20control-plane-commands)** — 问题、代理、批准、活动

