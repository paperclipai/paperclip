---
name: terminal-bench-loop
required: false
description: >
  在 Paperclip 里以「有界的、人在回路」闭环驱动单条 Terminal-Bench 题目直至冒烟通过：每次迭代在同一 App worktree 上做有界冒烟，
  落盘工件，按「工作停滞诊断」技能（`diagnose-why-work-stopped`）的取证范式定位停机点；任何真正的产品补丁须先经董事会确认方可实施，再在同一 worktree 重跑。
  适用于工单中出现「Terminal-Bench 跑圈」「迭代到通过」「loop fix-git」等措辞。
---

**中文名：** Terminal-Bench 题目「跑圈」——有界迭代、冒烟通过、董事会点头后再改产品  
**系统 id：** `terminal-bench-loop`（Terminal-Bench = 一类终端/工具链基准测评题目集）

# Terminal-Bench 跑圈

在 Paperclip 中把一条 Terminal-Bench 问题推到冒烟通过的操作要领：拓扑固定、运行次数受限、产品补丁在合并前必须经过董事会关卡、worktree 指针稳定。

定位为**运营 + 诊断**，本技能**本身不授权直接写产品代码**——所有被接受的产品补丁必须落在单独的实现类子事务上。

开始前读 `doc/execution-semantics.md`，保证循环（loop）父工单任一时刻的状态都能在该文档范式下解释为：终态、`done`/`cancel`，显式存活（激活的 run/wake）、显式等待（带类型化等待者的 `in_review`）、或具名 `blocked`。

## 何时使用

工单标题/正文：

- 英文常见措辞如「run Terminal-Bench in a loop」「把某 task 经由 Paperclip 跑循环」
- 「drive fix-git」「iterate till pass」「bench loop」
- 附了既有循环父工单链接，请你跑下一轮

也包括：循环树已开好，你只负责下一轮迭代/诊断/重跑。

## 何时不要使用

- 目标是改 Harbor 封装层 / harbor 适配器本体 → 走工程链路。
- 目标是提交可比榜成绩：本链路默认 **冒烟/不可比榜（non-comparable）**。
- 与 Terminal-Bench 无关的普通产品缺陷。
- **未获授权改动公司技能库**：库变更交给技能库负责人单独立项。

## 三次不变式（与 diagnose 对齐）

每次迭代、每个拟议产品补丁都要同时满足——否则否决或重做，并在循环工单评论里写明如何守住：

1. **有成效的工作始终在动**：每条循环父工单永远有具名的下一步负责人。
2. **只有真实阻塞才让停：**董事会确认 / QA / 凭证 / 预算耗尽——伪静默 `in_review` 必须被拉回。
3. **禁止无限回路：**迭代上限、时钟预算、`request_confirmation` 关卡拦住未经批准的产品补丁。

## 输入——第 1 轮迭代之前必须记在循环根工单

缺任一项则标 `blocked`，并写明解除阻塞的责任人：

- 来源事务；
- Terminal-Bench **单任务 id**；
- 迭代预算（常 3–5）+ **每次墙上时钟上限**；
- Paperclip App 侧执行 workspace/事务（第一轮创建，后续复用 `inheritExecutionWorkspaceFromIssueId`）；
- 完整 `paperclip-bench` 命令（须把 `PAPERCLIPAI_CMD` 固定在被测 App worktree 内）；
- Harbor / Runner 调度 JSON（示例：`PAPERCLIP_HARBOR_RUNNER_CONFIG`）——须写全 assignee、`heartbeat_strategy`、adapter、`reuse_host_home`、`stop_budget`；
- 工件根路径；
- 批准策略（默认董事会 `request_confirmation` / CTO）。

任何变更都要注明从哪一轮起生效。

## 事务拓扑（必须能建成树）

- **循环父工单：**存放输入、迭代计数器、指针、迭代史。运行中多为 `in_progress`；仅当类型化等待者**直接挂在父工单**上才可 `in_review`；`blocked` 表示子链才是真门槛；终态 = `done`/`cancel`。
- **迭代子工单：**一轮一条；用阻塞关系挂住上一轮终态，避免两轮并行；
- **App 实现：**首轮创建隔离 worktree；之后所有实现/重跑均 `inheritExecutionWorkspaceFromIssueId` 绑定同一指针。

只用 `blockedByIssueIds` 表达依赖。

## 流程摘要

### 0. 执行契约
读 `execution-semantics` 文档用语，不自造状态机。

### 1. 循环父工单
复用已有或新建：`Terminal-Bench loop: <task>`。验证 worktree 指针仍有效——否则 `blocked`。

### 2. 迭代子工单
计数 +1，建 `Iteration N: <task>`，阻塞前一迭代终态；超预算则只 `cancel` 或 `in_review`（申请延期）。

### 3. 有界冒烟
- `PAPERCLIPAI_CMD` 必须在被测 App worktree；禁止误测操作者手头的 Paperclip 主 checkout。
- 必须附上 dispatch 配置；否则仅是测试架缺失，不计作产品结论。
- 记录：runs、manifest、`results.jsonl`、taxonomy、工件路径。

### 4. 诊断
对冒烟子树套用 diagnose 范式：精确到 `(issue,status)`，分类停滞事务，区分产品/测试架/题目本身。

### 5. 决策
本轮只能落入：通过 / 提议产品修复 / 非产品侧重试 / 真实阻塞 / 预算或董事会终止。

### 6. 产品修复 ⇒ 确认
迭代子工单写 `plan` + **同一事务**上的 `request_confirmation`；迭代子工单 → `in_review`；循环父工单 ⇒ `blocked` **指向该迭代子工单**，避免父工单静默挂在 `in_review`；接受后才建实现/QA/CTO/重跑链；实现继承 worktree 环境。

### 7. 重跑
相同命令、同一 worktree。workspace 漂移则宣告循环失效。

### 8. 通过
走 QA + CTO 链；循环父工单仍 `blocked` 指向该链；除非你刻意把类型化等待者挂在父工单。**禁止「父工单 in_review 却仅靠子链当等待者」——这是本技能要避免的悬空审查。**

### 9. 停止条件
必须用状态迁移显式收口：董事会拒绝 / 预算耗尽 / 具名真实阻塞 / 通过 QA+CTO。

## 冒烟自检（与本仓库脚本）

`pnpm smoke:terminal-bench-loop-skill` 读取 **`skills/terminal-bench-loop/SKILL.md`**（即本文件）。需要校验控制面拓扑时可照常运行该命令。

## 常见陷阱

- 冒烟跑在操作者手头的 Paperclip 主 checkout —— 必须用被测 App worktree；
- 省略 dispatch JSON 导致 `BEN-1` 之类未分配 / 无心跳 —— 测试架问题，不算产品信号；
- 未经 `request_confirmation` 就建实现事务；
- 把冒烟当可比榜跑分；
- recovery 递归加深；
- 在循环心跳里悄悄改公司技能库。
