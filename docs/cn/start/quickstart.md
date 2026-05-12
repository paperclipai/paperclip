---
title: 快速入门
summary: 几分钟内即可运行 Paperclip
---
5 分钟内即可在本地运行 Paperclip。

## 快速入门（推荐）

```sh
npx paperclipai onboard --yes
```

这将引导您完成设置、配置环境并运行 Paperclip。

## 本地开发

前置条件：Node.js 20+ 和 pnpm 9+。

```sh
pnpm install
pnpm dev
```

这将启动 API 服务器和 UI [http://localhost:3100](http://localhost:3100)。

无需外部数据库 — Paperclip 默认使用嵌入式 PostgreSQL 实例。

## 单命令启动

```sh
pnpm paperclipai run
```

如果缺少配置，此功能会自动启动，通过自动修复运行健康检查，并启动服务器。

## 下一步是什么

Paperclip 运行后：

1. 在 Web UI 中创建您的第一家公司
2. 定义公司目标
3. 创建CEO 智能体并配置其适配器
4. 与更多智能体一起构建组织架构图
5. 设定预算并分配初始任务
6. 点击运行——智能体开始心跳，公司开始运转

<Card title="核心概念" href="/cn/start/core-concepts">
  了解 Paperclip 背后的关键概念
</Card>