# 需求说明

## 使用方与痛点

**吴衡** — 一个人 + 一群 AI，建一家可复制的软件开发公司。

当前痛点：

- 手动管理多个 agent 的状态、任务分配、执行追踪——没有统一控制平面  
- 不知道 agent 在干什么、花了多少钱、产出是什么  
- 每次启动 agent 都要手动操作：创建 issue → checkout → 启动进程 → 盯心跳  
- 贾维斯（CEO/策略层）和赫尔墨斯（信使/路由层）缺少可靠的执行平面  

## 目标结果

当 Paperclip 在当前环境中就绪时：

- routic 公司的 agent（b064fe96 Cursor agent）可以通过心跳自动拉取排队中的 run 并执行  
- 完整的 issue→checkout→heartbeat→run→completion 链路至少跑通一次  
- 吴衡可以通过 Paperclip Board 看到：谁在干什么、花了多少钱、产出是什么  
- 僵尸 run 能被识别和清理（不会堆积阻塞后续任务）  

**不应改变：**

- Paperclip 上游代码的核心行为（本 fork 不是上游贡献）  
- 现有数据库结构和 API 契约  
- 已有的 routic 公司配置和 agent 定义  

## 范围

### 范围内

- 理解 Paperclip 完整生命周期：company → agent → issue → checkout → heartbeat → run → done  
- routic 公司（cc098628-d91e-4e10-b4e4-000a6c822946）的 agent 心跳验证  
- 端到端执行一次完整任务（创建 issue → agent 自动拉取 → 执行 → 完成）  
- 僵尸 run 诊断与清理流程  
- 本地开发环境稳定性（端口 3100，PGlite，避开 NTFS 坑）  

### 范围外

- Paperclip 上游新功能开发  
- Cloud 部署 / 多用户认证  
- 新 adapter 开发  
- 生产环境配置  
- 向 upstream 提交 PR  

## 开放问题

- Paperclip 当前 fork 的 Hermes 外置化分支是否稳定？是否切到 `feat/externalize-hermes-adapter`？  
- routic 公司的 agent b064fe96（Composer 2 Fast）是否需要重新配置 adapter？  
- 心跳轮询间隔多少合适？当前是否仍有僵尸 run 需手动清理？  
- 贾维斯和赫尔墨斯通过什么接口对接 Paperclip？API key 还是直接数据库操作？  
- **Cursor 用量与池子**：agent 已指定 **composer-2-fast**（走 Auto/Composer 池，非按 token 的 API 模型池），但适配器仍可能回报 **adapter_failed / usage limit** 类文案（常与 **Ultra 月度额度、Spend limit、或 Cursor 侧池子切分**有关，**不等于**「没指定 composer」）。需在 Board **ROU-19** 探查单中对照完整错误串与 Cursor 账户计费页，区分「真池子顶满」vs「错误文案/路由 bug」。  
- **Board 中英混排**：控制台里标题/评论/系统通知中英夹杂，是否主要由 **英文 bundled 技能**、**未做 i18n 的系统串**、**agent 英文模板**、**外部 CLI 原文** 导致？结论与改进选项见 Board **ROU-20** / 本地 **T-010**。  
- **CLI 是否流式打印 agent 输出**：见下文「需求草案：CLI 流式输出」；短期可先 **`--debug`** 看原始 chunk，大改可搁置。  
- **已完成工单仍反复唤醒 agent（例：ROU-21 多次唤醒 CTO）**：见 `探查-ROU-21-完成后反复唤醒.md`；需区分「依赖/父单级联合法唤醒」与「终态误发 `issue_assigned`」；本仓库已对 `queueIssueAssignmentWakeup` 增加 **`done`/`cancelled` 跳过**，上线后应用活动 API 复测。  

## 需求草案：CLI 流式输出

### 现象（吴衡侧）

在终端里跑 **Paperclip 心跳 / agent 执行**（例如通过 `paperclipai` 相关命令观察某次 `heartbeat-run`）时，体感是 **进程跑完后才一大段输出**，而不是像本地直接跑 `cursor` / `codebuddy` 那样逐 token / 逐行刷出来。

### 目标

- **能选**：至少有一种 **官方支持的用法**，在终端里 **尽量接近实时** 地看到子进程 stdout/stderr（可接受「按行」或「按 JSONL 事件」粒度，不强制 token 级）。  
- **可解释**：文档写清「为什么有时仍是一坨出来」（子进程缓冲、非 TTY、适配器解析策略）。  

### 现状（基于本仓库代码，便于评估）

1. **服务端（heartbeat → run）**  
   子进程 stdout/stderr 在 `adapter-utils` 的 `runChildProcess` 里按 **`data` 事件** 追加；`heartbeat` 里对每段 chunk 会 **`runLogStore.append`** 并 **`publishLiveEvent`**（`heartbeat.run.log`）。即：**落库与对前端的 live 通道已经是「有 chunk 就发」**，瓶颈往往不在这一层。

2. **终端 CLI（`cli/src/commands/heartbeat-run.ts`）**  
   - 用 **`while` + 约 200ms 轮询**：拉 `/api/heartbeat-runs/:id/events` 与 `/api/heartbeat-runs/:id/log`，不是长连 SSE。  
   - **未加 `--debug` 时**：stdout 会先拼进缓冲区，再 **按换行切行** 后交给各 adapter 的 `formatStdoutEvent` 做「好看」输出，**整行未到齐前不会打印**；stderr 仍会较快透出。  
   - **`--debug` 时**：stdout/stderr **按 chunk 原样** `printRawChunk`，最接近「流式」。

3. **外部 CLI（Cursor / CodeBuddy 等）**  
   若子进程发现 **stdout 不是 TTY**，库/运行时可能 **块缓冲**，Paperclip 只能收到「更大块」的 `data`，这是 **进程外不可完全控** 的部分。

### 可选实现方向（按改动面排序）

| 方向 | 内容 | 难度 | 说明 |
| --- | --- | --- | --- |
| A. 文档与开关 | 在 CLI / 开发文档中明确：**观察实时输出请带 `--debug`**；说明非 debug 为「按行美化」 | **低** | 零或极少代码 |
| B. 缩小轮询延迟 | 将 `POLL_INTERVAL_MS` 可配置或默认调小（如 50ms） | **低～中** | 更吃 CPU/请求数 |
| C. 非 debug 也支持「原始 stdout 流」 | 增加例如 `--raw-stdout`，跳过 `formatStdoutEvent`，但仍按 chunk 写终端 | **中** | 与 debug 类似，语义更清晰 |
| D. CLI 改 SSE / WebSocket | 订阅服务端已有 live 事件，去掉轮询 | **中～高** | 要接 API、鉴权、重连、与现有 `events` 分页对齐 |
| E. 子进程 PTY + 全适配器验收 | 伪终端骗过子进程行缓冲；各适配器验证 | **高** | 跨平台、维护成本高 |

### 难度结论与是否搁置

- **「像 Board 里那样完整结构化 + 终端里又完全实时」**：**偏高**（格式化与缓冲天然矛盾，外加第三方 CLI 缓冲行为）。  
- **「能实时看到子进程在吐什么」**：**不高**——**已有 `--debug`**；若仍嫌不够，再做 **C（独立 `--raw-stdout`）** 或 **B** 即可。  
- **D / E**：建议 **暂时搁置**，除非产品明确要把「终端体验」做成一等公民并愿意付维护成本。

### 建议的下一步（本 fork / routic）

1. 先在本需求下记一笔：**验收路径 = 带 `--debug` 跑一次心跳 CLI**，确认是否已满足「流式」预期。  
2. 若仍不满意：开 **小改动**（B 或 C），不要一上来 SSE/PTY。  
3. **D / E** 进入 `docs/00-project` 的 backlog 仅作备选，**不排进当前 sprint**。  
