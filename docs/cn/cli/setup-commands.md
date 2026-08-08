---
title: 设置命令
summary: 载入、运行、检查和配置
---
实例设置和诊断命令。

## `paperclipai run`

一命令引导并启动：

```sh
pnpm paperclipai run
```

是否：

1. 如果配置丢失则自动启动
2. 运行 `paperclipai doctor` 并启用修复
3. 检查通过后启动服务器

选择具体实例：

```sh
pnpm paperclipai run --instance dev
```

## `paperclipai onboard`

交互式首次设置：

```sh
pnpm paperclipai onboard
```

第一个提示：

1. `Quickstart`（推荐）：本地默认（嵌入式数据库，无LLM提供者，本地磁盘存储，默认机密）
2. `Advanced setup`：全交互配置

入职后立即开始：

```sh
pnpm paperclipai onboard --run
```

非交互式默认值+立即启动（在服务器监听上打开浏览器）：

```sh
pnpm paperclipai onboard --yes
```

## `paperclipai doctor`

带有可选自动修复功能的健康检查：

```sh
pnpm paperclipai doctor
pnpm paperclipai doctor --repair
```

验证：

- 服务器配置
- 数据库连接
- 秘密适配器配置
- 存储配置
- 缺少关键文件

## `paperclipai configure`

更新配置部分：

```sh
pnpm paperclipai configure --section server
pnpm paperclipai configure --section secrets
pnpm paperclipai configure --section storage
```

## `paperclipai env`

显示已解决的环境配置：

```sh
pnpm paperclipai env
```

## `paperclipai allowed-hostname`

允许使用私有主机名进行身份验证/私有模式：

```sh
pnpm paperclipai allowed-hostname my-tailscale-host
```

## 本地存储路径

|数据|默认路径|
|------|-------------|
|配置 | `~/.paperclip/instances/default/config.json` |
|数据库| `~/.paperclip/instances/default/db` |
|日志| `~/.paperclip/instances/default/logs` |
|存储| `~/.paperclip/instances/default/data/storage` |
|秘密钥匙| `~/.paperclip/instances/default/secrets/master.key` |

覆盖：

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

或者直接在任何命令上传递 `--data-dir`：

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai doctor --data-dir ./tmp/paperclip-dev
```