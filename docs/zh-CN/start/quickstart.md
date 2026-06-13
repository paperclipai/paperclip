---
title: 快速开始 (Quickstart)
summary: 在几分钟内运行起 Paperclip
---

在 5 分钟内即刻在本地运行起 Paperclip。

## 快速上手 (推荐)

```sh
npx paperclipai onboard --yes
```

这将引导您完成基础的安装向导设置，自动配置您的必备运行环境，并立刻启动 Paperclip。

## 本地开发 (Local Development)

前置依赖项：Node.js 20+ 和 pnpm 9+。

```sh
pnpm install
pnpm dev
```

该命令将直接在 [http://localhost:3100](http://localhost:3100) 端口上拉起启动 API 后端服务与图形前端的 UI 界面。

无需自己手动配置任何额外的外部数据库连接 — 默认情况下，Paperclip 已经直接使用了嵌入式版本的 PostgreSQL 数据库实例（即 PGlite）。

## 单命令启动 (One-Command Bootstrap)

```sh
pnpm paperclipai run
```

该脚本将会在发现系统配置文件可能存在缺失时执行自动引导 onboarding 流程，且内置支持故障自修复检查等保障项。

## 接下来做什么？ (What's Next)

一旦 Paperclip 服务已经就绪并运行：

1. 在 Web UI 界面中先创建一个属于您的公司 (Company)
2. 定义下目前您的公司所设立的终极宏伟目标 (Goal)
3. 创建一名首席执行官 (CEO) 智能体高管并且把它和相关的各种适配环境对接配置好
4. 开始为其逐步搭建起更为庞大的手下打工人团队的架构组织图 (Org chart)
5. 设定下拨的经费预算 (Budgets) 以及初步发下第一批初始工作任务包单
6. 点击确认开始 — 静静看着智能体们进入他们各自的节律心跳脉冲区间，您的“全自动 AI 公司”就彻底运转起来了

<Card title="核心概念 (Core Concepts)" href="/zh-CN/start/core-concepts">
  了解 Paperclip 背后的关键概念
</Card>
