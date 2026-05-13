---
name: terminal-bench-loop-cn
required: false
description: >
  在 Paperclip 里以「有界的、人在回路」闭环驱动单条 Terminal-Bench 题目直至 smoke through：每次迭代在同一 App worktree 上 bounded smoke，
  落盘工件，按 diagnose-why-work-stopped-cn 技能的取证范式定位停机点；任何真正的产品补丁须先董事会确认后方可实施，再在同一 worktree 重跑。
  适用于工单要求「Terminal-Bench 跑圈」「iterate 到 pass」「loop fix-git」等措辞。
---

# Terminal-Bench Loop（中文）

在 Paperclip 中把一条 Terminal-Bench 问题推到 smoke ✅ 的操作技能：拓扑固定、runs 受限、产品在修前必须经过 board gate、worktree 指针稳定。

定位为**运营 + 诊断**，本技能**自己不授权写产品代码**——所有被接受的产品补丁必须落在单独的 implementation children 之上。

开始前读 `doc/execution-semantics.md`，保证 loop issue 任一时刻的状态都能在该文档范式下解释为：终态、`done/cancel`，显式 live（激活 run/wake）、显式 waiting（带 typed waiter 的 `in_review`）、或命名的 `blocked`。

## 何时使用

工单标题/body：

- 「run Terminal-Bench in a loop」「把 \<task\> loop 走 Paperclip」
- 「drive fix-git」「iterate till pass」「bench loop」
- 附了既有 loop parent 链接让你跑下一轮

也已有人把 loop tree 开好，你只负责下一轮 iteration/diagnose/rerun 的场景。

## 何时不要用

- 目标是改 Harbor wrapper / harbor 适配器本体 → 走工程链路。
- 目标是提交可比榜成绩：本链路默认 **smoke/non-comparable**。
- 与 Terminal-Bench 无关的普通产品 bug。
- **未获授权改动公司 skill 库**：库变更单独交 skill-library owner。

## 三条不变式（与 diagnose 对齐）

每次 iteration、每个拟议产品补丁都要同时满足——否则否决或重做并在 loop comment 明示如何守住：

1. **有成效的工作始终在动**：每条 loop issue 永远有 named next owner。
2. **只有真实 blocker 才让停：** board 确认 / QA / 凭证 / exhausted budget——伪静默 `in_review` 必须被拉回。
3. **禁止无限回路：**迭代上限、时钟预算、`request_confirmation` 前的产品补丁 gate。

## 输入——Iteration 1 之前必须记在 loop root

缺任一项 = blocked，写出 unblock owner：

- Source issue；
- Terminal-Bench **单任务 id**；
- iteration budget（常 3–5）+ **每次 wall-clock ceiling**；
- Paperclip App 侧执行 workspace/issue（第一轮创建，后继复用 `inheritExecutionWorkspaceFromIssueId`）；
- 完整 `paperclip-bench` 命令（包含把 `PAPERCLIPAI_CMD` pin 在被测 App worktree 内）；
- Harbor / Runner dispatch JSON（示例：`PAPERCLIP_HARBOR_RUNNER_CONFIG`）——必须把 assignee、`heartbeat_strategy`、adapter、`reuse_host_home`、`stop_budget` **写全**；
- Artifact root path；
- 批准策略（默认 board `request_confirmation` / CTO）。

任何变更都要写是哪一轮起生效。

## Issue 拓扑（必须可被树建模）

- **Loop parent：**存输入、iteration 计数器、指针、迭代史。运行中多为 `in_progress`；只有当 typed waiter **直接挂在 parent** 上才能 `in_review`；blocked 则说明子链是真正门槛；terminal = `done`/`cancel`.
- **Iteration child：**一轮一条；blocked 上一轮 terminal，避免两轮并行；
- **App implementation：**首轮创建 isolation worktree；之后所有 implementation/rerun 皆 `inheritExecutionWorkspaceFromIssueId` 绑定同一指针。

只用 `blockedByIssueIds`。

## Procedure 摘要

### 0. Execution contract
读 `execution-semantics` 用词，不自造状态机。

### 1. Loop issue
reuse 已有或新建：`Terminal-Bench loop: <task>`。验证 worktree pointer 仍有效——否则 blocked。

### 2. Iteration child
计数 +1，建 `Iteration N: <task>`，blocked predecessor，超预算就只 cancel / in_review(extension).

### 3. Bounded smoke
- `PAPERCLIPAI_CMD` 必须在被测 App worktree；禁止误测操作者手头 Paperclip 主 checkout。
- 必须附上 dispatch config；否则仅是 harness miss，不计作产品 verdict。
- 记录：runs、manifest、`results.jsonl`、taxonomy、artifact paths。

### 4. Diagnose
对 smoke  subtree 套用 diagnose 范式： pinpoint `(issue,status)`，分类 stalled issues，判断是否产品/harness/task。

### 5. Decision
本轮只能落入：Pass / propose product fix / non-product retry / real blocker / budget or board halt。

### 6. Product fix ⇒ confirmation
iteration child `plan` + **同 issue**上的 `request_confirmation`；iteration → `in_review`；loop parent ⇒ `blocked` **指向 iteration child**，避免 parent 静默 `in_review`；acceptance 之后才建 impl/QA/CTO/rerun chains；impl 继承 worktree env。

### 7. Rerun
相同命令在同一 worktree。workspace 漂移则 invalidate loop。

### 8. Pass
QA + CTO chains；loop parent 仍 `blocked` 指向链；除非你刻意把 typed waiter 挂 parent。**禁止「parent in_review」却仅靠孩子链当 waiter——这是本技能要避免的悬空 review。**

### 9. Stop 条件
必须用状态迁移显式收口：Board reject / exhausted budget / real blocker named / pass QA+CTO。

## 冒烟自检（与本仓库脚本）

仓库内脚本 `pnpm smoke:terminal-bench-loop-skill` 读取的是英文 canonical：`skills/terminal-bench-loop/SKILL.md`。本 `-cn` 副本与之并行挂载，条款应与上文保持一致；校验控制面拓扑时仍可运行同一 smoke（它验证英文路径文件的 contract 措辞）。

## Pitfalls（要点）

- Smoke 跑在操作者手头的 Paperclip 主 checkout —— 必须用被测 App worktree；
- 省略 dispatch JSON 导致 `BEN-1` 之类未分配 / 无 heartbeat —— harness 问题，不算产品信号；
- 未经 `request_confirmation` 就建 implementation；
- 把 smoke 当 comparable bench；
- recovery 递归 deepen；
- 在 loop heartbeat 里悄悄改公司 skill 库。
