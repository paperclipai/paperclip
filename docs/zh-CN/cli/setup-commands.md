---
title: 部署命令 (Setup Commands)
summary: 包含开箱引导 (onboard)、运行 (run)、诊断 (doctor) 和通用配置
---

专用于实例的初始安装部署配置与环境诊断类的命令集。

## `paperclipai run`

包含一键自动引导并直接启动系统服务：

```sh
pnpm paperclipai run
```

它在后台执行了：

1. 如果发现系统配置文件缺失，则会自动开启向导 (Auto-onboards)
2. 运行 `paperclipai doctor` 执行并尝试自动修复配置故障 
3. 一旦所有检查项均通过，正式启动后台服务器

指定选定一个具体的环境实例来运行：

```sh
pnpm paperclipai run --instance dev
```

## `paperclipai onboard`

互动式交互界面的首次配置向导：

```sh
pnpm paperclipai onboard
```

第一个交互提示会问您：

1. `Quickstart`（强烈推荐快速启动）：沿用全套本地默认组合（使用嵌入式数据库、默认无配置 LLM 提供商、落盘本地磁盘和默认密钥）
2. `Advanced setup`：全交互式的极客高级完整手动配置

也可以在回答完向导配置完毕后立刻顺路启动服务器以供测试：

```sh
pnpm paperclipai onboard --run
```

采用非交互式模式，全都默认选“是”且一键无脑立即启动（成功启动服务器后会自动弹开默认浏览器画面）：

```sh
pnpm paperclipai onboard --yes
```

## `paperclipai doctor`

对底层所有组件发起健康状态安全体检，并附带有自动修复纠偏功能：

```sh
pnpm paperclipai doctor
pnpm paperclipai doctor --repair
```

将验证并体检如下依赖模块：

- 服务器环境基础配置
- 本地或远程数据库的连通性
- Secret 凭证管理适配器的配置是否正常工作
- Storage 存储配置是否挂载就绪
- 检查必需的核心关键文件是否发生缺失

## `paperclipai configure`

专项去修改某一块特定的配置组区域：

```sh
pnpm paperclipai configure --section server
pnpm paperclipai configure --section secrets
pnpm paperclipai configure --section storage
```

## `paperclipai env`

直接向您打印出已经经过最终解析计算的系统运行基础所有环境变量配置信息：

```sh
pnpm paperclipai env
```

## `paperclipai allowed-hostname`

在强认证/私有模式下给您内部自己搭建的私有 host 主机名大开绿灯放行通过机制：

```sh
pnpm paperclipai allowed-hostname my-tailscale-host
```

## 默认本地存储落盘路径 (Local Storage Paths)

| 数据类别 | 默认路径 |
|------|-------------|
| 配置信息 Config | `~/.paperclip/instances/default/config.json` |
| 数据库文件 Database | `~/.paperclip/instances/default/db` |
| 日志归档 Logs | `~/.paperclip/instances/default/logs` |
| 存储块 Storage | `~/.paperclip/instances/default/data/storage` |
| 凭证母钥 Secrets key | `~/.paperclip/instances/default/secrets/master.key` |

您也可以利用以下环境变量来进行强行覆写重载：

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

或者使用更便捷地 `--data-dir` flag直接加在任意相关命令的尾巴上：

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai doctor --data-dir ./tmp/paperclip-dev
```
