# Paperclip — 产品定义（Product Definition）

> **路径（path）**：`doc/02 产品定义 PRODUCT.md`。API 路径、模式名、枚举值保持英文原文。

## 它是什么（What It Is）

Paperclip 是**自主 AI 公司（autonomous AI companies）**的 **control plane（控制面）**。一个 Paperclip **实例（instance）** 可以托管多家 **company（公司）**；**company（公司）** 是一级对象。

## 核心概念（Core Concepts）

### Company（公司）

一家公司具备：

- **goal（目标）** — 存在理由（例如：「三个月内把 X 做到品类第一、MRR 一百万美元」）  
- **employees（员工）** — 每位员工都是一个 AI **agent（代理/智能体）**  
- **org structure（组织结构）** — 汇报关系  
- **revenue & expenses（收入与支出）** — 在公司维度跟踪  
- **task hierarchy（任务层级）** — 所有工作可追溯到公司目标  

### Employees & Agents（员工与代理）

每位员工对应一个 **agent**。创建公司时先定义 CEO（首席执行官代理），再向下扩展。

每名员工具备：

- **adapter type + config（适配器类型 + 配置）** — agent 如何运行、身份与行为如何定义；由**适配器**决定格式（例如 OpenClaw 可能用 `SOUL.md` / `HEARTBEAT.md`；Claude Code 可能用 `CLAUDE.md`；裸脚本可能用 CLI 参数）。Paperclip 不规定正文格式 —— **adapter（适配器）** 才规定。  
- **role & reporting（角色与汇报）** — 头衔、向谁汇报、下属是谁  
- **capabilities description（能力说明）** — 一段话说明该 agent 做什么、何时 relevant（相关）；帮助其他 agent 发现「该找谁」  

示例：CEO 的 **adapter config** 可能要求每次 **heartbeat（心跳）** 都去「审视高管在做什么、看公司指标、必要时重排优先级、指派新战略 initiative」。工程师的配置可能是「查看被指派的任务、选最高优先级并开始执行」。

接着定义 CEO 的下属：管工程师的 CTO、管市场的 CMO 等。树上每个 agent 都有自己的 **adapter configuration**。

### Agent Execution（代理执行）

Paperclip 用多种方式运行 agent 的 **heartbeat（心跳）**：

1. **local CLI/session adapters（本地 CLI / 会话适配器）** — 启动或恢复 Claude Code、Codex、Gemini、OpenCode、Pi、Cursor 等本地会话，并跟踪 **run（运行）**。  
2. **run a command（运行命令）** — 起一个进程（shell、Python 等）并监控；心跳即「执行并观测」。  
3. **fire-and-forget request（即发即弃请求）** — 向外部的 agent 发 webhook/API，「叫醒」对方；OpenClaw 式 hook 常如此。  
4. **external adapter plugins（外部适配器插件）** — 通过插件/适配器加载路径安装包，自托管环境可扩展运行时，而无需把运行时写死在 core。  

**Agent run（代理运行）** 可使用 **project（项目）** 与 **execution workspace（执行工作区）**、受控 **runtime services（运行时服务）**（如 preview / dev server）、适配器专属会话状态、以及 HTTP / webhook 风格执行。我们有合理默认，但边界仍是 **adapter**：只要能被调用、观测和授权，Paperclip 就能协调。

### Task Management（任务管理）

任务是**层级**的：任一时刻，每件工作都必须能通过父任务链，一路关联到公司顶层 **goal**：

```
我正在调研 Facebook 上 Granola 投放的广告（当前任务）
  因为 → 要为我们的软件创建 Facebook 广告（父任务）
    因为 → 本周要把新注册拉高 100 人（父任务）
      因为 → 本周要把收入做到 2000 美元（父任务）
        因为 → …
          因为 → 我们要在三个月内把「第一 AI 笔记应用」做到 100 万 MRR
```

任务有 **parentage（父子关系）**。每个任务都服务于父任务，直到公司 **goal**。这让自主 agent 保持对齐 —— 永远能回答「我为什么在做这件事？」

当前的 **issue（工单）** 模型包括：稳定 issue 标识、父/子 issue、**blockers（阻塞）**、**单一 assignee（受指派人）**、评论、issue 文档、附件与工作产物、以及 review/approval（评审/审批）交接。该结构让 **board（控制台/董事会界面）** 与 agent 都能检查工作，同时仍允许 agent 把工作拆成更小任务。

## 原则（Principles）

1. **对「你如何运行 agent」保持开放。** Agent 可以是 OpenClaw bot、Python/Node 脚本、Claude Code 会话、Codex 实例 —— 我们不关心。Paperclip 定义的是通信用的 **control plane**，以及 heartbeat 的基础设施；**不**规定 agent 运行时本身。

2. **Company（公司）是组织单元。** 一切都挂在某家公司之下。一个 Paperclip 实例，多家公司。

3. **adapter config 定义 agent。** 每个 agent 都有适配器类型与配置，控制身份与行为；最小契约只是「可被调用」。

4. **一切工作追溯到 goal。** 层级任务意味着没有孤立任务；若说不清某件事对公司 goal 有何意义，就不该存在。

5. **control plane，不是 execution plane（执行平面）。** Paperclip 做编排；agent 在别处运行并回传。

## 用户流程（理想场景）

1. 打开 Paperclip，新建 **company**  
2. 定义公司 **goal**：「三个月内做第一 AI 笔记应用，MRR 一百万美元」  
3. 创建 CEO  
   - 选择 **adapter**（如面向 Claude Code 的 process adapter、面向 OpenClaw 的 HTTP adapter）  
   - 配置 **adapter**（身份、循环行为、执行设置）  
   - CEO 提出战略拆解 → **board** 审批  
4. 定义 CEO 下属：CTO、CMO、CFO…  
   - 各自有独立 **adapter config** 与角色定义  
5. 再继续向下：工程师归 CTO、营销归 CMO…  
6. 设置 **budget（预算）**、定义初始战略任务  
7. 按下运行 —— agent 开始 **heartbeat**，公司运转  

## 部署模式指引（Guidelines）

Paperclip 必须支持的两种运行时模式：

- `local_trusted`（默认）：单机本地、受信任部署，无登录摩擦  
- `authenticated`：需要登录；支持 private（私网）与 public（公网）**曝光策略（exposure）**  

模式定义与 CLI 预期见 `doc/07 部署模式 DEPLOYMENT-MODES.md`。

## 延伸阅读（Further Detail）

完整技术规格见 [`03 规范 SPEC.md`](./03%20规范%20SPEC.md)；任务/工单数据模型见 [`11 任务管理 TASKS.md`](./11%20任务管理%20TASKS.md)。

---

Paperclip 的核心身份是**自主 AI 公司的 control plane**，围绕 **company、org chart、goals、issues/评论、heartbeats、budgets、审批与 board 治理**。公开文档也明确了当前边界：**任务/评论是内建通信模型**，Paperclip **不是**聊天机器人，也**不是**代码评审工具；路线图指向更易上手、云 agent、更易配置、插件、更好的文档、以及 ClipMart/ClipHub 式可复用 **company / template**。

## 应该做 vs 不应该做（What Paperclip should do vs. not do）

**应该（Do）**

- 保持在 **board** 与 **company** 抽象层：用户管理 goals、组织、budgets、审批与产出。  
- 让首五分钟「惊艳」：安装、答几题记、看到 CEO 完成第一件实活。  
- 让工作锚定在 **issues / 评论 / projects / goals** 上，即使界面略带对话感。  
- 把 **agency / 内部团队 / 创业团队** 视为同一抽象的不同模板与标签。  
- 把产出当一等公民：文件、文档、报告、预览、链接、截图。  
- 提供**接入工程工作流**的钩子等：worktree、预览服、PR 链接、外部评审工具。  
- 用 **plugins（插件）** 承载边缘场景：富聊天、知识库、文档编辑器、自定义追踪等。

**不应该（Do not）**

- 不要把核心产品做成通用聊天应用；当前定义明确以任务/评论为中心，「不是聊天机器人」，这条边界有价值。  
- 不要试图做完整 Jira/GitHub 替代品；repo/文档把 Paperclip 定位为组织编排，而不是以 PR 评审为中心。  
- 不要先做企业级细粒度 RBAC；已有 authenticated 模式、membership、instance roles 与 permission grants，但精细化企业治理应是次优先级。  
- 不要默认把生 bash 日志与 transcript 当头屏；默认应是人类可读的意图/进展，原始细节放下层。  
- 不要迫使用户理解 provider/API key 管线，除非必要；此处摩擦在 onboarding/auth 上已真实存在。

## 具体设计目标（Specific design goals）

1. **time-to-first-success（首次成功耗时）在 5 分钟内** —— 新用户一次 sitting 内从安装到「我的 CEO 完成了第一个任务」。  
2. **board 层抽象永远优先** —— 默认 UI 回答：公司在做什么、谁在做、为何重要、花了多少钱、哪些需要我批。  
3. **对话仍附着在工作对象上** —— 「和 CEO 聊」也应落到策略线程、决策、任务或审批。  
4. **渐进式展开（progressive disclosure）** —— 顶层摘要；中层步骤/清单/产物；底层原始日志/工具调用/transcript。  
5. **产出优先（output-first）** —— 工作未完成直到用户能看到结果：文件、文档、预览链接、截图、计划或 PR。  
6. **可观测执行、但不「拜日志教」** —— 运行中、恢复 issue、生产力评审态、阻塞与工作产物应是第一界面；raw transcript 需要时再看。  
7. **local-first（本地优先），cloud-ready（云就绪）** —— 单机与共享/私网/公网/云端，心智模型应一致。  
8. **安全自主（safe autonomy）** —— 允许自动模式；不允许隐蔽的 token 燃烧。  
9. **薄核心、厚边缘（thin core, rich edges）** —— 可选聊天、知识与特殊界面放进插件/扩展，而非撑胖 control plane。
