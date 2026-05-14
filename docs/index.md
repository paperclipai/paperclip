---
title: docs 索引
summary: 本仓库 docs/ 中文资料导航（预备作对外可读资料库；工程契约仍以 doc/ 与 AGENTS.md 为准）
---

本文档为 **`docs/` 目录的人工阅读顺序索引**。未改名、未批量修链；路径均为相对 `docs/index.md` 的 Markdown 链接，在 Obsidian / VS Code 中可逐一点开。

工程级契约与开发入口仍以根目录 **`AGENTS.md`** 所列 **`doc/GOAL.md`、`doc/SPEC-implementation.md`、`doc/DEVELOPING.md`** 等为准。

---

## 建议阅读顺序（顶层）

1. [入门](#入门) — 产品是什么、如何本地跑起来、核心概念  
2. [公司](#公司) — 代理公司包 / Markdown 规范  
3. [指南](#指南) — 看板操作与智能体开发日常  
4. [命令行](#命令行) — CLI  
5. [API 接口](#api-接口) — REST 参考  
6. [适配器](#适配器) — 各工具适配与扩展  
7. [部署](#部署) — 模式、环境、容器、云上  
8. [规格说明](#规格说明) — 产品与蓝图类长稿  
9. [项目计划](#项目计划) — 仓库内协作（需求、任务单、执行与探查、长期需求）；语气和范围见该目录说明  
10. [docs 根目录散篇](#docs-根目录散篇)

资源管理器里若目录未按此顺序排列，属**文件夹名排序**正常现象，以本节顺序为准即可。

---

## 入门

- [01 什么是 Paperclip](入门/01%20什么是Paperclip%20what-is-paperclip.md)
- [02 快速入门](入门/02%20快速入门%20quickstart.md)
- [03 核心概念（中文）](入门/03%20核心概念%20core-concepts.md)
- [Core concepts（英文，与中文并列）](入门/core-concepts.md)
- [04 架构](入门/04%20架构%20architecture.md)

---

## 公司

- [01 公司规范](公司/01%20公司规范%20companies-spec.md)

---

## 指南

**顶层**

- [01 执行策略](指南/01%20执行策略%20execution-policy.md)
- [02 Docker 中运行 OpenClaw](指南/02%20Docker%20中运行%20OpenClaw%20openclaw-docker-setup.md)

**董事会操作员**

- [01 创建公司](指南/董事会操作员/01%20创建公司%20creating-a-company.md)
- [02 组织结构](指南/董事会操作员/02%20组织结构%20org-structure.md)
- [03 仪表板](指南/董事会操作员/03%20仪表板%20dashboard.md)
- [04 委派如何工作](指南/董事会操作员/04%20委派如何工作%20delegation.md)
- [05 管理任务](指南/董事会操作员/05%20管理任务%20managing-tasks.md)
- [06 管理智能体](指南/董事会操作员/06%20管理智能体%20managing-agents.md)
- [07 批准](指南/董事会操作员/07%20批准%20approvals.md)
- [08 活动日志](指南/董事会操作员/08%20活动日志%20activity-log.md)
- [09 成本和预算](指南/董事会操作员/09%20成本和预算%20costs-and-budgets.md)
- [10 导入和导出公司](指南/董事会操作员/10%20导入和导出公司%20importing-and-exporting.md)
- [11 执行工作区和运行时服务](指南/董事会操作员/11%20执行工作区和运行时服务%20execution-workspaces-and-runtime-services.md)

**智能体开发者**

- [01 智能体如何工作](指南/智能体开发者/01%20智能体如何工作%20how-agents-work.md)
- [02 心跳协议](指南/智能体开发者/02%20心跳协议%20heartbeat-protocol.md)
- [03 任务工作流](指南/智能体开发者/03%20任务工作流%20task-workflow.md)
- [04 处理批准](指南/智能体开发者/04%20处理批准%20handling-approvals.md)
- [05 成本报告](指南/智能体开发者/05%20成本报告%20cost-reporting.md)
- [06 编写技能](指南/智能体开发者/06%20编写技能%20writing-a-skill.md)
- [07 评论和沟通](指南/智能体开发者/07%20评论和沟通%20comments-and-communication.md)

---

## 命令行

- [01 CLI 概览](命令行/01%20CLI%20概览%20overview.md)
- [02 控制平面命令](命令行/02%20控制平面命令%20control-plane-commands.md)
- [03 设置命令](命令行/03%20设置命令%20setup-commands.md)

---

## API 接口

- [01 API 概览](API接口/01%20API%20概览%20overview.md)
- [02 认证](API接口/02%20认证%20authentication.md)
- [03 公司](API接口/03%20公司%20companies.md)
- [04 智能体](API接口/04%20智能体%20agents.md)
- [05 事务](API接口/05%20事务%20issues.md)
- [06 目标和项目](API接口/06%20目标和项目%20goals-and-projects.md)
- [07 例程](API接口/07%20例程%20routines.md)
- [08 批准](API接口/08%20批准%20approvals.md)
- [09 活动](API接口/09%20活动%20activity.md)
- [10 仪表板](API接口/10%20仪表板%20dashboard.md)
- [11 成本](API接口/11%20成本%20costs.md)
- [12 密钥](API接口/12%20密钥%20secrets.md)
- [13 远程导入密钥](API接口/13%20远程导入密钥%20secrets-remote-import.md)

---

## 适配器

- [01 适配器概览](适配器/01%20适配器概览%20overview.md)
- [02 创建适配器](适配器/02%20创建适配器%20creating-an-adapter.md)
- [03 外部适配器](适配器/03%20外部适配器%20external-adapters.md)
- [04 适配器 UI 解析器](适配器/04%20适配器%20UI%20解析器%20adapter-ui-parser.md)
- [05 HTTP 适配器](适配器/05%20HTTP%20适配器%20http.md)
- [06 进程适配器](适配器/06%20进程适配器%20process.md)
- [07 Claude 本地适配器](适配器/07%20Claude%20本地适配器%20claude-local.md)
- [08 Codex 本地适配器](适配器/08%20Codex%20本地适配器%20codex-local.md)
- [09 Gemini 本地适配器](适配器/09%20Gemini%20本地适配器%20gemini-local.md)
- [10 CodeBuddy 本地适配器](适配器/10%20CodeBuddy%20本地适配器%20codebuddy-local.md)
- [11 Qwen 本地适配器](适配器/11%20Qwen%20本地适配器%20qwen-local.md)
- [12 Cursor 本地适配器](适配器/12%20Cursor%20本地适配器%20cursor-local.md)

---

## 部署

- [01 部署概览](部署/01%20部署概览%20overview.md)
- [02 部署模式](部署/02%20部署模式%20deployment-modes.md)
- [03 本地开发](部署/03%20本地开发%20local-development.md)
- [04 容器部署](部署/04%20容器部署%20docker.md)
- [05 数据库](部署/05%20数据库%20database.md)
- [06 存储](部署/06%20存储%20storage.md)
- [07 环境变量](部署/07%20环境变量%20environment-variables.md)
- [08 密钥管理](部署/08%20密钥管理%20secrets.md)
- [09 Tailscale 私有访问](部署/09%20Tailscale%20私有访问%20tailscale-private-access.md)
- [10 亚马逊部署](部署/10%20亚马逊部署%20aws-ecs.md)

---

## 规格说明

- [01 智能体配置和活动 UI](规格说明/01%20智能体配置和活动%20UI%20agent-config-ui.md)
- [02 cliphub 计划](规格说明/02%20cliphub计划%20cliphub-plan.md)

---

## 项目计划

- [README（工作顺序与入口）](项目计划/README.md)
- [index（长链接表）](项目计划/index.md)
- [长期需求（跨工单蓝图与规则）](项目计划/长期需求/README.md)

细目（执行单、探查、最佳实践等）请从以上两页进入，避免本索引重复维护两份列表。

---

## docs 根目录散篇

- [01 智能体运行指南](01%20智能体运行指南%20agents-runtime.md)
- [02 反馈投票](02%20反馈投票%20feedback-voting.md)

---

## 维护说明

新增或重命名 **`docs/`** 下的文档时，请同步更新本文件中的对应小节（或在其上级目录已有专用 `index` 时，在本文件只保留「入口链接」一行）。

**Next**：若你希望 Obsidian 一开库就落到本页，可把 `docs` 库根或默认笔记指向 **`docs/index.md`**。
