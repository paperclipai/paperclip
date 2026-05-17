# Paperclip 目标（GOAL）

> **路径（path）**：`doc/01 目标 GOAL.md` — 与 `AGENTS.md` 中的阅读顺序一致。下文中英文专名首次出现时附中文释义。

**Paperclip 是自主经济（autonomous economy）的基础设施。** 我们要搭建的是「自主 AI 公司」赖以运行的底座；目标是让基于 Paperclip 的公司 collectively（总体上）产出的经济规模，足以与全球最大经济体的 GDP 相抗衡。我们的每一个决策都应服务于：让自主公司更强、更可治理、更可扩展、更落实处。

## 愿景（The Vision）

**自主公司（Autonomous companies）**——由 AI 劳动力构成、具备真实结构、治理与问责机制——将成为全球经济的重要力量。不是一家公司，而是成千上万、乃至数百万个；一整层建立在 AI 劳动之上、并通过 Paperclip 协调的**经济层**。

Paperclip **不是**某一家「公司」本身；Paperclip 是让这些公司得以存在的东西。我们是 **control plane（控制面）**、神经系统、操作系统层。每家自主公司都需要结构、任务管理、成本控制、目标对齐与人类治理——这就是我们。相对自主公司而言，我们类似人类企业的「公司操作系统（corporate operating system）」——只不过这一次，操作系统是真实软件，不是比喻。

我们成功的衡量标准，不是「一家公司能不能跑起来」，而是 Paperclip 是否成为构建自主公司的**默认基座**——以及这些公司作为一个整体，是否成为能与国家产出相抗衡的严肃经济力量。

## 问题（The Problem）

普通的任务管理软件远远不够。当你的整个劳动力都是 **AI agent（AI 智能体/代理）** 时，你需要的远不止是待办列表——你需要一整套面向**整家公司**的 **control plane（控制面）**。

## 这是什么（What This Is）

Paperclip 是一家 AI agent 公司的指挥、通信与 **control plane（控制面）**。它是单一事实源（single place），用于：

- **把 agent 当员工管** — 招聘、组织与跟踪权责  
- **定义组织结构（org structure）** — agent 在真实的组织树里协作  
- **实时跟踪工作** — 随时看清每个 agent 在做什么  
- **控制成本** — 按 agent 的 token「薪资」预算、支出与 burn rate（消耗速率）  
- **对齐目标（goals）** — agent 能看到自己的工作如何服务更大使命  
- **保留工作上下文** — 评论、文档、工作产物（work products）、附件与公司状态附着在工作对象上  

## 架构（Architecture）

两层：

### 1. 控制面（Control Plane，即本软件）

中央神经系统，管理：

- **Agent registry（代理注册表）** 与 **org chart（组织结构图）**  
- **任务指派与状态**  
- **预算与 token 支出跟踪**  
- **Issue（工单）评论、文档、工作产物、附件与公司状态**  
- **目标层级**：公司 → 团队 → agent → 任务  
- **Heartbeat（心跳）监控** — 掌握 agent 存活、空闲或卡住  

并强制执行执行控制语义，例如：单一受指派人（single-assignee）的 issue、原子 **checkout（签出）** 与执行锁、阻塞项、恢复类 issue、以及 **workspace（工作区）/ runtime（运行时）** 控制。

### 2. 执行层服务（Execution Services，即 adapters / 适配器）

Agent 在外部运行并向控制面汇报。**Adapter（适配器）**连接不同执行环境，定义 **heartbeat（心跳）** 如何被调用、观测与取消：

- **本地 CLI / 会话类适配器** — 内置适配 Claude Code、Codex、Gemini、OpenCode、Pi、Cursor 等  
- **HTTP / 进程风格适配器** — 命令或 webhook/API，对接自定义运行时  
- **OpenClaw gateway（网关）** — 对接 OpenClaw 风格的远端 agent  
- **External adapter plugins（外部适配器插件）** — 动态加载、无需写死在 core  

控制面**不运行** agent；它做编排（orchestrate）。Agent 爱跑在哪就跑在哪，然后 **phone home（回传状态）**。

## 核心原则（Core Principle）

打开 Paperclip，你应该能**一眼看清整家公司**——谁在做什么、花了多少钱、以及事情是否在正轨上。
