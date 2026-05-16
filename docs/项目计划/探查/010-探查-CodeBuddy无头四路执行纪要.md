# 探查执行纪要：CodeBuddy 无头 × 回形针（四路 + 官方文档退路）

执行日期：2026-05-14  
关联假设：[探查-回形针进程泄露根因.md](探查-回形针进程泄露根因.md)  
豆包方案原文：[回形针调度codebuddy cli 进程泄露的优化方案-豆包.md](../最佳实践/005-回形针调度codebuddy%20cli%20进程泄露的优化方案-豆包.md)  
**本机 CLI 调研摘录（逐篇回写）：** [摘录-CodeBuddy本机调研回写.md](摘录-CodeBuddy本机调研回写.md)

---

## 零、与摘录合并后的总括（四路结论 + 调研回写）

四路推论**不变**；摘录把**可操作的 CLI 侧杠杆**写全了，这里只列与「进程/Cpu/追踪」**强相关**的合并点：

1. **追踪**：回形针只管 **`runChildProcess` 顶层 pid**；**CodeBuddy 自有** **`codebuddy ps` / `kill`**、Worker 登记 **`~/.codebuddy/sessions/`**；**Daemon / `--bg`** 可能与 Paperclip run **并行存在**——失控排查**两条线都要看**。
2. **降噪 env（智能体 `config.env`，以 `codebuddy --help` 与官方为准）**：例如 **`CODEBUDDY_DISABLE_CRON`**、**`CODEBUDDY_DISABLE_HOT_RELOAD`**、关自动记忆的变量类、**`CODEBUDDY_INTERNET_ENVIRONMENT`**（中国区）等——见摘录 §08.7。
3. **配置侧**：**`disableAllHooks`**、`promptSuggestionEnabled`、`memoryExtraction` 等会改变 **后台活动与并行 hook**——见摘录 §08.2、§08.5。
4. **常驻形态**：**`daemon start`** 默认 **delegate**、**多 subagent**；与「单次 `-p` 即退出」模型不同——见摘录 §08.11；勿与 Paperclip 单次 execute **混在脑子里当成一个进程**。
5. **流式多轮单进程**：官方支持 **`--input-format stream-json`** 多轮 stdin **不重启二进制**；当前 `codebuddy_local` **未用**——若未来要改造编排，摘录 §08.0 与 §08.10 可作输入。

详情与原文路径：**始终以 [摘录-CodeBuddy本机调研回写.md](摘录-CodeBuddy本机调研回写.md) 为索引**。

---

## 第一路：社区 / 官方实践（无头怎么用、资料多不多）

- **官方文档是有的**，并非只有零散帖：[CodeBuddy CLI Reference](https://www.codebuddy.ai/docs/cli/reference)、[Headless 说明入口](https://www.codebuddy.ai/docs/cli/headless)（与 reference 中 `-p/--print` 一致）。
- **共识用法（官方）**：非交互＝`-p`/`--print`；需要工具授权时须带 **`--dangerously-skip-permissions`**（或项目里若 CLI 接受短选项则与适配器一致）。另有 `--output-format`、`--resume`、`--allowedTools` 等。
- **「社区贴很少」**：相对 Anthropic Claude Code，中文二手帖可能少；**一手以官方 CLI Reference 为准**即可，不必先翻论坛。

---

## 第二路：本地代码 — `claude_local` vs `codebuddy_local` 适配器差异（执行相关）

| 维度 | `codebuddy_local` | `claude_local` |
| --- | --- | --- |
| 进程入口 | `packages/adapters/codebuddy-local/src/server/execute.ts` 调 **`runChildProcess`**（`@paperclipai/adapter-utils/server-utils`） | `packages/adapters/claude-local/src/server/execute.ts` 走 **`runAdapterExecutionTargetProcess`** 等 **execution-target** 路径（本地/远程/桥接） |
| 适用面 | 当前实现聚焦 **本机 `codebuddy` 一条命令** | 支持 **SSH 远端、sandbox bridge、Paperclip bridge** 等 |
| 无头参数 | 显式拼 **`--print`**、`--output-format`（默认 json / 可 stream-json）、**`-y`**（对应配置 `dangerouslySkipPermissions`）、`--max-turns`、`--resume` 等 | `--print` + **Claude 专用** permission args（`buildClaudeExecutionPermissionArgs`）等 |
| 终端提前收尾 | 本路径 **未接** `terminalResultCleanup`（与部分终端型适配器不同） | 存在更完整的远端/运行时准备（`prepareAdapterExecutionTargetRuntime` 等） |

**结论（实施层）**：两条适配器在「单次 run = 起子进程跑 CLI」上类似，但 **Claude 路径显著更厚**（远端与运行时）；**CodeBuddy 路径薄、参数全在本地 `execute` + `runChildProcess`**。

---

## 第三路：豆包方案 — 哪些说得对、哪些和本仓库/官方 CLI 对不上

### 可采纳的「方向」（与通用子进程卫生一致）

- 关注 **进程是否随 run 结束而退出**、**超时后是否 SIGTERM/SIGKILL**、**多智能体/多唤醒叠大量并行 run** 会线性放大进程数 —— 与现象一致。
- **`runChildProcess` 本身**：注册 `runningProcesses`、超时发信号、`close` 后清理；**不是「完全不打 exit 钩子」那种裸 spawn**（见 `packages/adapter-utils/src/server-utils.ts`）。

### 不宜原样照搬的点

1. **「全局只启 1 个 codebuddy 无头、stdin 排队」**  
   - 与 **当前 Paperclip 模型不符**：每次 `adapter.execute` 是一次 **`spawn codebuddy ...`**（见 `codebuddy-local` `execute.ts`），**不是**常驻单例 JSON stdin 协议。要改成单例＝**产品级改 orchestration**，不是改个「并发=1」勾选框。
2. **`--no-watch` / `--disable-file-watcher` / `--no-daemon` / `--single-worker` / `--no-auto-update`**  
   - **CodeBuddy 官方 CLI Reference（2026-05-14 抓取）未见上述开关**；若强行写进智能体 `extraArgs`，**可能直接非法参数或行为未定义**。需以本机 `codebuddy --help` 与官方 reference 为准再决定，**不能因豆包文稿就信**。
3. **`taskkill /F /IM node.exe` / 定时杀光 node**  
   - **会误杀本机所有 Node 应用**（含 IDE、别的服务），仅适合「单机救命且无其他负载」的极端场景，**不应写进常规运维**。
4. **「回形针里关掉每次任务独立进程」**  
   - Board 上**没有**豆包描述的那种字面配置项；实际控制面在：**多少智能体在跑、唤醒/心搏频率、多少 issue 同事务处理、各 agent 的 `timeoutSec`/`maxTurnsPerRun`/extraArgs** 等。

### 和「智能体配置」怎么落地

- **该限制的首先是**：并行 **run** 的数量（业务上少同时挂满 CodeBuddy agent）、每条 run 的 **`timeoutSec`**、**`maxTurnsPerRun`**、以及 **允许的 CLI 实参**（仅加 **官方存在** 的 `extraArgs`）。
- **不该假设**：存在一个「Node 进程数」字段让 Paperclip 替你限 cgroup；那是 OS/容器层能力，**不是**当前 agent JSON 的一等字段。

---

## 第四路：回形针怎么追踪「无头 CLI」起的进程 / 子进程

### 追踪到什么粒度

1. **Spawn 瞬间**：`runChildProcess` 在子进程起来后调用 **`onSpawn({ pid, processGroupId, startedAt })`**。
2. **落库**：`server/src/services/heartbeat.ts` 里 **`persistRunProcessMetadata`** 写入 **`heartbeatRuns.processPid` / `processGroupId` / `processStartedAt`**。
3. **运行中 Map**：同一函数把 run 记进 **`runningProcesses`**（按 `runId`），用于超时与信号。
4. **非 Win**：`spawn` 使用 **`detached: true`**（Unix），`processGroupId` 用于 **向进程组发 Signal**（`signalRunningProcess` / `terminateLocalService` 中对 PGID 的分支）。
5. **Windows**：`detached` 为 false；超时/终止路径会 **`killWindowsProcessTree(pid)`**（`adapter-utils`）尽量清 **子树**，但 **仍取决于 CodeBuddy 再.spawn 的进程是否脱离作业/是否可被 taskkill /T 覆盖**。

### 追踪不到什么

- **孙女进程**若脱离 Node/作业对象、或 **独立守护**，则 **仅看 `processPid` 不够**；Paperclip **没有**内置「递归枚举整棵 CodeBuddy 子树并长期跟踪」的查看器。
- **若第四路确认「深链追踪不够」**，再走 **第五路**：对照官方 **headed vs headless** 文档与 `--help`，区分交互会话与 `-p` 单跑的行为差异（官方 reference + headless 专页即起点）。

---

## 第五路（子任务）：CodeBuddy 无头 vs 有头 — 教程/文档落点

- **CLI Reference（全局选项、`-p`、权限、session）**：<https://www.codebuddy.ai/docs/cli/reference>  
- **Headless**：<https://www.codebuddy.ai/docs/cli/headless>  
- **Best practices**：<https://www.codebuddy.ai/docs/cli/best-practices>  

无需先「全网教程」；**优先官方三条**，再补问题关键词搜索。

---

## 下一动作（实施者）

1. 在本机对 **`codebuddy --help`** 做一次 **实参核对**，确认能否增加任何「降噪/限制」类官方开关；能则只通过 **`extraArgs`** 或适配器增量（须 SPEC/需求背书）。  
2. 若再发生 CPU 爆表：**抓** `heartbeatRuns.processPid`、任务管理器进程树、同一时刻 **活跃 run 数**，对照本纪要第二节、第四节判断是否「并行 run 过多」或「CodeBuddy 子进程脱离」。  
3. 豆包文稿保留作「思路参考」，**以官方 CLI + 本仓库 `execute.ts`/`runChildProcess` 为准**做改造判断。  
4. **按 [摘录-CodeBuddy本机调研回写.md](摘录-CodeBuddy本机调研回写.md)** 做一轮 **env / settings / `codebuddy ps`** 对照实验，把结果补进本文件或假设单（仍非最终根因裁定）。  
5. **命令级本机复核（2.97.1）**：[实践-CodeBuddy无头命令本机验证.md](实践-CodeBuddy无头命令本机验证.md)

---

*本文件为执行纪要。摘录更新：2026-05-15。*
