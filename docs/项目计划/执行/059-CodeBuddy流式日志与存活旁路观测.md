---
status: 已完成
---

# 059 · CodeBuddy 流式日志与存活旁路观测（本轮）

**日期：** 2026-05-19  
**范围：** `codebuddy_local` 适配器 + 运行详情/旁路观测 UI（复用已有字段为主）  
**非目标：** 人类读懂流式 JSON 语义；同一次 run 内切换模型/「继续修」；独立异步解析器（见长期需求 27）

---

## 1. 背景与问题

### 1.1 编排者真实诉求（产品话）

- **不必**从流式日志里读懂「命令行此刻在干什么」（解析器不成熟时，人类也读不懂整段英文或 NDJSON）。
- **必须**能判断：**子进程还在往外吐字吗？** 若长时间无新输出，**距上一行日志过了多久？**
- **总运行时长** 不能作为「该杀进程」的主依据：业内存在单次输入连续运行十余小时的重型任务；原作者侧「跑太久就掐」的策略对这类任务不适用。
- **仍要**在命令行**明确报错、且无头模式下无法自愈**时，尽快结束本次 run，避免进程泄漏、内存膨胀等。

### 1.2 与现有能力的关系

| 能力 | 现状 | 缺口 |
| --- | --- | --- |
| 日志按块落盘 | `heartbeat` 的 `onLog` 每块带 `ts`，NDJSON 存 `run-log` | CodeBuddy 默认 `--output-format json` 时，CLI 可能**结束时才吐整包**，块级「在动」不明显 |
| 旁路：总耗时 | 运行清单/详情有「已运行多久」 | 已有，保留 |
| 旁路：最后输出时间 | 库表 `last_output_at`、`last_output_seq` 等；恢复服务算 `silenceAgeMs` | **界面未统一突出「距上次输出已静默多久」**（事务运行台账有部分 `outputSilence`） |
| 静默盯梢 | `PAPERCLIP_SILENT_ACTIVE_RUN_WATCHDOG`、活跃无输出复核 | 偏**服务端整链**，阈值与「人类旁路读秒」可并存，**本轮不改为以总时长杀 run** |
| 解析失败 | 055：exit 0 不因 JSON 解析失败整单判死 | 与「存活观测」正交 |
| 致命错误停 run | 适配器在**进程结束后**看 exit / `is_error` | **运行中**见 stderr/流式 `result` 错误行即停，本轮要补 |

---

## 2. 目标（验收口径）

### 2.1 流式日志（适配器）

1. CodeBuddy 无头调用默认或推荐配置为 **`--output-format stream-json`**（智能体可覆盖，文档写清）。
2. 子进程 **stdout/stderr 每收到一块即 `onLog`**（不等到进程结束）；与 Cursor 差异：本轮**不要求**把 NDJSON 解析成可读助手正文，**允许原样写入运行日志**（人类只看「在刷」与行数/字节增长）。
3. 运行日志存储中**每条记录保留时间戳**（沿用现有 `ts` 字段，不破坏 047/055 原始记录方向）。

### 2.2 存活旁路（界面 + 已有字段）

4. 对 **status=running** 的 run，旁路同时展示：
   - **已运行时长**（现有）；
   - **距最后一次日志输出已过** \(\Delta t = now - lastOutputAt\)（无输出时降级为「自启动以来」并标注说明）。
5. 流式日志区域：**每条（或每聚合块）展示相对/绝对时间**，便于对照「最后一行是什么时候写的」。
6. **不以总运行时长**作为本轮新增的自动杀进程条件；静默盯梢若触发，产品文案区分「无输出过久」与「总时长过久」。

### 2.3 致命错误快停（适配器 + 控制面）

7. 在 **stream-json 行级**或 **stderr** 上识别「无头模式下不可继续」的终局失败（至少包含）：
   - 非零退出（进程结束回调，已有）；
   - 流式 JSON 中 `type:"result"` 且 `is_error:true` 或 `subtype` 为错误类（以 CodeBuddy 本地文档 §3.4 为准）；
   - stderr 中匹配可维护的**致命模式表**（实现期列样例：认证失败、额度用尽、Max turns exceeded、进程级崩溃关键字等）。
8. 命中后：**尽快终止子进程**并结束 run（`errorMessage`/`errorCode` 人类可读中文为主），避免长时间挂死。
9. **明确排除（中期）**：同 run 内「换模型后继续」「交互式恢复」——无头 CLI 不支持则不做。

---

## 3. 技术方案（实现契约）

### 3.1 适配器 `codebuddy-local`（本轮必做）

| 项 | 做法 |
| --- | --- |
| 输出格式 | `outputFormat` 默认改为 `stream-json`；`execute.ts` 组装 `--print --output-format stream-json -y …` |
| 流式转发 | `runChildProcess` 继续直传 `onLog`；可选：行缓冲仅用于**快停检测**，不向用户隐藏原始 chunk |
| 结束后解析 | 保留现有 `parseCodeBuddyStreamJsonOutput` / `parseCodeBuddyJsonOutput` 写 `sessionId`、`usage`、`summary`；与 055 一致：exit 0 解析失败不冒充执行失败 |
| 快停 | 在 `onLog` 包装层增量扫描完整行：见 `result`+错误 → 调 `runChildProcess` 已有终止能力（或向 heartbeat 返回可识别错误码）；实现期单测 fixture 行 |
| 可选 | `includePartialMessages` 配置项 → `--include-partial-messages`（**非本轮必验收**，仅当实测能明显增加「在动」频率再默认开） |

参考文档：

- 仓库内：`docs/适配器/10 CodeBuddy 本地适配器 codebuddy-local.md`
- 用户本地：`CodeBuddy CLI/07`、`12`、`21`（`stream-json` 行事件、`is_error`）

### 3.2 控制面 / UI（本轮尽量小）

| 项 | 做法 |
| --- | --- |
| 数据 | 复用 `heartbeatRuns.lastOutputAt`（已在 `onLog` 路径刷新，见 `heartbeat.ts` `flushOutputProgress`） |
| API | 运行详情/活跃 run 接口已含 `lastOutputAt` 时，**仅 UI 展示**；缺字段再补暴露 |
| UI 落点 | 优先：`HeartbeatRunDetailPanel` / `RunTranscriptView` / 事务侧 `IssueRunLedger` 运行中卡片——展示「距上次输出」与日志行时间 |
| 文案 | `ui/src/lib/i18n.ts` 中文；区分「已运行」与「已静默」 |

### 3.3 与长期需求 27 的边界

- **本轮**：适配器负责 **拉起 + 流式落原始日志 + 快停**；结构化摘要仍可在进程结束后由适配器内同步解析（055 已宽松）。
- **后续**：原始记录与解析器异步拆分、两层状态 UI，不阻塞本轮。

---

## 4. 非目标（显式排除）

- 不要求人类从流式日志理解工具调用细节或模型思考内容。
- 不实现 `--input-format stream-json` 单进程多轮（降进程数）——另开需求。
- 不调整「总时长超限」的全局 watchdog 策略（可配置关闭已存在）；本轮只加强 **无输出 Δt** 的可读性。
- 不在本轮铺满 `promptCacheCorrelation` 以外的适配器。

---

## 5. 验证计划

1. **手动**：CodeBuddy 智能体跑一条长任务；运行详情中可见日志行时间向前推进；旁路「距上次输出」秒数在吐字时归零/变小，停吐后递增。
2. **手动**：构造认证失败或 `max-turns` 过小；run 在报错出现后 **分钟内** 结束，无长期僵尸 `codebuddy`/`node` 进程（任务管理器或 `codebuddy ps`）。
3. **自动**：`codebuddy-local` 单元测试——行级 `result`+`is_error` 触发快停逻辑（mock `onLog`/`runChildProcess`）；可选 Windows 路径 `stream-json` 假进程 fixture。
4. **回归**：055 exit0 解析跳过路径仍通过；与 048 Windows 启动链不冲突。

---

## 6. 分期对照

| 阶段 | 内容 |
| --- | --- |
| **本轮（059）** | stream-json 默认 + 日志时间线 + 旁路 Δt + 致命错误快停 |
| **中期** | 同 run 内恢复策略（换模型、续跑指令）；编排器与 CLI 能力对齐后再做 |
| **长期（027/047）** | 异步解析器、两层执行/解析状态 |

---

## 7. 关联文档

- [`../长期需求/27 适配器执行与异步解析器拆分-长期需求 2026-05-18.md`](../长期需求/27%20适配器执行与异步解析器拆分-长期需求%202026-05-18.md)
- [`055-运行详情深链与resultJson原样读出.md`](055-运行详情深链与resultJson原样读出.md)
- [`../5月17日 cursor助手对话记录-整理版.md`](../5月17日%20cursor助手对话记录-整理版.md)（观测 vs 解析、人类不读 stdin 全量）
- 用户本地 **CodeBuddy CLI** 文档目录（无头 / stream-json / include-partial-messages）

---

## 8. 修改记录

| 日期 | 摘要 |
| --- | --- |
| 2026-05-19 | 初稿：存活旁路（最后输出 Δt）、流式原始日志、致命错误快停；明确非目标与可行性（复用 lastOutputAt） |
