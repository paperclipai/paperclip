---
status: 待办
---

# CodeBuddy stdout 超限解析降级与结构化 run 摘要

**母本：** [`../长期需求/24 评论唤起过载与编排分层改版计划 2026-05-17.md`](../长期需求/24%20评论唤起过载与编排分层改版计划%202026-05-17.md) · **§C1–C2**、§1 目标(4)

## 背景与范围

- **技术设计（契约草案）：** [`../技术设计/047-适配器原始记录与异步解析器拆分-技术设计 2026-05-18.md`](../技术设计/047-适配器原始记录与异步解析器拆分-技术设计%202026-05-18.md)  
- **长期架构母本：** [`../长期需求/27 适配器执行与异步解析器拆分-长期需求 2026-05-18.md`](../长期需求/27%20适配器执行与异步解析器拆分-长期需求%202026-05-18.md)（执行/解析职责拆分、口语映射；本文 **047** 为落地抓手之一）。  
- **C1**：`oversized_result_json` / `stdoutTruncated` 时仍能落盘可查：分段、`NDJSON`、磁盘 spill、`parse` fallback。
- **C2**：run 归档字段与「整段子会话 JSON」解耦：**`num_turns`、终结状态、工具统计、vendor usage** 独立列或 JSON 小节。

---

## 产品共识：适配器 vs 解析器（2026-05-19，真值口径）

> 与 [`059-CodeBuddy流式日志与存活旁路观测.md`](059-CodeBuddy流式日志与存活旁路观测.md)（**已关闭**，`95c82b6f`）衔接：**059 管运行中「原始流可见 + 存活旁路」**；**047 管跑完后「别全文硬解析、结构化可延后」**。

### 1. 人类要什么

- **展示**：能边看边刷 **原始 stdout/stderr**（带时间戳即可），**不要求** UI 读懂整段 NDJSON / 超长 JSON。
- **成败**：能判断这次 run **业务上成功还是失败**，**不要求**为展示去 `JSON.parse` 全量 stdout。
- **台账**（可选、可晚）：`usage`、`session_id`、`num_turns` 等结构化字段 **允许缺失或异步补写**，**不得**因「账没算出来」把「进程已正常结束」记成整单失败（[`055`](055-运行详情深链与resultJson原样读出.md) 方向延续）。

### 2. 原始日志真源（今日实现，047 不得破坏）

| 项 | 约定 |
| --- | --- |
| **落盘** | 每块 `onLog` → 实例目录下 **`data/run-logs/<company>/<agent>/<runId>.ndjson`**（一行一条：`ts` + `stream` + `chunk` 原文） |
| **库表** | Postgres 存 **`logRef` / `logBytes` / `lastOutputAt`** 等元数据，**不**按块存全文日志 |
| **实时** | WebSocket `heartbeat.run.log` + HTTP 按偏移读文件；UI **原始模式** 只展示 chunk，不依赖结束解析 |
| **展示 ≠ 解析** | 运行详情读日志 **只走上述文件（及 WS）**；与结束后结构化解析 **解耦** |

### 3. 适配器边界（Adapter，047 要收薄）

**必须：**

1. 拉起子进程、注入提示词/环境、流式 `onLog`（[`059`](059-CodeBuddy流式日志与存活旁路观测.md) 已默认 `stream-json`）。
2. 运行中 **行级** 检测致命错误（如 `type:result` + `is_error`、stderr 模式表）并快停——**仅用于终止子进程**，不把 NDJSON 转成可读正文。
3. 子进程回收后，用 **轻量终局判定** 给出 **执行阶段** 结论（见下 §4），**禁止**以「全文 `JSON.parse(stdout)` 成功」作为 run 成功的唯一条件。
4. **禁止**将完整 stdout 默认写入 `resultJson` 作为常态（解析跳过时的临时兜底应改为 **logRef 指针 + 可选短摘录**，实现期落地）。

**不得再承担（迁出至解析器或删掉）：**

- 对 **整段** `proc.stdout` 做同步全量解析以决定 run 成败。
- 为 UI 展示而解析流式 JSON 语义（工具调用、思考块等）。

### 4. 解析器边界（Parser，047 核心交付）

**必须：**

1. 消费 **已落盘的原始记录**（优先 `run-logs/*.ndjson` 或 spill/manifest），**可异步**、可重试、可换策略。
2. **CodeBuddy `stream-json` 终局判定（适配器可内联调用同一纯函数，逻辑归属解析契约）：**
   - 从原始流 **尾部扫描最后一行完整 `type:result`**（或 spill 的 result 帧），读 `is_error` / `subtype` / `result` 文本；
   - 与 **子进程 `exitCode`（及 signal / timedOut）** 联合判定业务成败；
   - **无 result 行但 `exitCode===0`**：执行成功，结构化字段可为空（对齐 055）。
3. 结构化产出（可晚写）：`usage`、`session_id`、`num_turns`、摘要小节等 → 写入 `usageJson` / 扩展字段 / 解析状态位；失败时 **解析失败**，不覆盖执行成功。
4. **禁止**「全文一次 `JSON.parse`」作为唯一路径；超大输入走 **tail-only / 分片 / manifest**（对齐技术设计 §5）。

**明确不做：** 拉起进程、改 cwd/env、替代 heartbeat 的 `onLog` 落盘链。

### 5. 与 059 / 055 的分工

| 单号 | 职责 |
| --- | --- |
| **059**（已完成） | 运行中：stream-json 按块落盘、距上次输出、致命错误快停 |
| **055**（已完成） | exit 0 时解析失败不判死；`getRun` 原样读 `resultJson` |
| **047**（本单） | 收薄适配器：终局 = **尾行 result + exitCode**；展示只认 run-log；结构化进解析器；超大 stdout 降级 |

---

## 交付物（可验收）

1. **`codebuddy_local`（优先）**：`execute` 终局不再依赖 `parseCodeBuddyStreamJsonOutput(proc.stdout)` 全文；改为 **tail `type:result` + exitCode**；`resultJson` 默认不塞全量 stdout（仅 `logRef` / 短诊断）。
2. **解析器模块（或 `adapter-utils` 子路径）**：纯函数 + fixture——尾行 result、截断、无 result 但 exit 0、超大 NDJSON 分片；与适配器解耦单测。
3. **内存与体量**：`runChildProcess` 侧 **禁止无界 `stdout +=`**（阈值后 spill 或仅保留 tail 窗口供终局扫描）；与 C1 一致。
4. API/UI：运行详情 **展示路径** 文档化/回归为「只读 run-log」；结构化字段显示 **解析中 / 解析失败** 与 **执行成功** 分层（字段名实现期定）。
5. 超长会话样例：**不再**因 sync 全文 parse 失败而整单失败；原始日志始终可查。

## 依赖与并行

- **前置（已完成）**：[`055-运行详情深链与resultJson原样读出.md`](055-运行详情深链与resultJson原样读出.md)、[`059-CodeBuddy流式日志与存活旁路观测.md`](059-CodeBuddy流式日志与存活旁路观测.md)（`95c82b6f`）。
- **参考**：[`035-适配器子进程环境白名单落地.md`](035-适配器子进程环境白名单落地.md)、[`006-cursor适配器maxTurns熔断.md`](006-cursor适配器maxTurns熔断.md)（范式）。
- **计量口径**：[`../最佳实践/015-实践-CLI累计计量与成本控制面台账口径.md`](../最佳实践/015-实践-CLI累计计量与成本控制面台账口径.md)（usage 来自 result 行，与会话累计展示正交）。

## 验证证据（完成后填写）

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | 运行中：run-log 边写边看，原始模式不需结束解析 | |
| 2 | 结束后：仅 tail `type:result` + exitCode 判定成败；无全文 parse | |
| 3 | 超大 stdout：无 OOM；原始 ndjson 可查；解析可失败但执行仍成功 | |
| 4 | `resultJson` 不含全量 stdout 常态副本 | |

## 修改记录

| 日期 | 摘要 |
| --- | --- |
| 2026-05-19 | 写入适配器/解析器边界共识：展示=run-log；终局=尾行 result+exitCode；禁止全文硬解析与 resultJson 整包 stdout |
