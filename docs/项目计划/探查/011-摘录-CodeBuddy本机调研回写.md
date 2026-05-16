# 摘录：本机 CodeBuddy CLI 调研 → 回仓库

> 源目录（作者本机，不随 Git 分发）：`C:\Users\wuhen\工具优化\02-智能体-agents\02-CLI调研与接入\CodeBuddy CLI`  
> 关联纪要：[探查-CodeBuddy无头四路执行纪要.md](探查-CodeBuddy无头四路执行纪要.md) · [探查-回形针进程泄露根因.md](探查-回形针进程泄露根因.md)  
> 规则：逐篇阅读；**只抄对回形针/适配器/排障有用**的点，避免整文搬运。

---

## 08.0 CodeBuddy CLI 无头模式深入调研.md

**对回形针有用：**

- **非交互必备**：`-p/--print` 下若要让工具真正干活，需 **`-y` 或 `--dangerously-skip-permissions`**（与 `codebuddy_local` 默认 `dangerouslySkipPermissions` + 传 `-y` 一致）。
- **输出**：`--output-format` 支持 `text` / `json` / `stream-json`（适配器已用 json / 可选 stream-json）。
- **会话**：`--resume <id>`、`--continue`；多轮可在非交互用 `-p` + `--resume`。
- **与「进程模型」强相关的一点**：官方写 **`--input-format stream-json` + `--output-format stream-json`** 时，可通过 **stdin 多行 JSONL 对同一进程持续发轮次**，**不必每次重启 `codebuddy` 二进制**。当前 Paperclip `codebuddy_local` 是 **单次 spawn + stdin 一次性 prompt 字符串**，**未**用 stream-json 常驻单进程；若未来要减「每 heartbeat 立新进程」的开销/泄漏面，这是**官方支持的另一条路**（产品决策另议）。
- **结构化输出**：`--output-format json` + `--json-schema` 可拿 `structured_output`（集成解析时可参考，adapter 当前按数组/result 解析）。
- **实操**：长任务外用 OS `timeout`、批量请求间限速——与 Board 侧重 `timeoutSec` / 并发策略可对照。

*官网参考链（文内）：* [CLI 参考（中文）](https://www.codebuddy.ai/docs/zh/cli/cli-reference)

---

## 08.1 CodeBuddy CLI 参考.md

**对回形针 / 进程排障有用：**

- **官方一等命令（与「堆里 node」强相关）**：
  - `codebuddy daemon start|stop|status|restart`（守护进程）
  - `codebuddy ps` —— **列出活跃 Worker**
  - `codebuddy logs <pid|name>` / `attach` / **`kill <pid|name>`** —— **按 CodeBuddy 自己的命名空间收尾**
  - 回形针目前只 persist **spawn 出来的那层 `pid`**；若 CLI **再拉 Worker / Daemon / `--bg` 会话**，**应在排障脚本或文档里教会操作者同时看 `codebuddy ps`**，不能只盯 `heartbeatRuns.processPid`。
- **后台与多实例**：`--bg` 为 detached，日志到 **`~/.codebuddy/logs/`**；`--name` 与 `--bg` 配合便于 `ps`/`kill` 命中。**误用多个 `--bg` 或 Daemon + 多次 `-p` 叠加上去，会放大「看不见的孩子」问题。**
- **与适配器对齐**：`--max-turns`（Paperclip `maxTurnsPerRun`）、`-y`、`--system-prompt-file`（仅 `-p`；与 adapter `instructionsFilePath` 映射一致）、`--tools` / `--allowedTools` / `--disallowedTools` 可收紧工具面减少胡跑子进程。
- **`--agents` JSON**：子代理会改变工具/轮次边界；Board 配错会间接导致 **更多 subagent 活动** → CPU。

---

## 08.2 CodeBuddy 配置文件.md

**对回形针有用：**

- **设置分层**：用户 `~/.codebuddy/settings.json`，项目 `.codebuddy/settings.json` / `settings.local.json`。在**某工作区 cwd** 跑无头时，会吃到项目级设置——**与 Paperclip materialized workspace 路径强相关**；换 worktree 可能换一套 hooks/权限。
- **可能放大 CPU/子进程的默认项**（若在项目/用户设置里打开）：
  - `hooks` / **`disableAllHooks`**：Hook 会在工具前后跑 shell；排查泄漏时可临时 **`disableAllHooks: true`** 对照。
  - `memory.memoryExtraction`：**后台记忆提取**（默认文里示例可开）；`autoMemoryEnabled` 等会持续写 `~/.codebuddy/memories/`。
  - `promptSuggestionEnabled`：**轮次结束后自动猜下一步**（默认 `true`）；无头批任务时可能带来**额外模型/工具轮次**。
  - `alwaysThinkingEnabled`：思考模式常更耗 token/轮次。
- **安全与 `-y`**：`permissions.disableBypassPermissionsMode` 设为 `"disable"` 会**禁掉** `-y`/`--dangerously-skip-permissions`——若团队 settings 如此，**Paperclip 注入的 `-y` 会失效或行为异常**，表现为「工具全被拦」或反复重试。
- **`trustedDirectories` / `trustAll`**：影响启动时目录信任弹窗；无头场景常需事先信任，否则会卡权限/交互。
- **`gateway.runTimeoutMs`** 等：远端 gateway 超时，与「进程挂很久」有关时可对照。

---

## 08.3 CodeBuddy 身份和访问管理.md

**对回形针有用：**

- **`CODEBUDDY_INTERNET_ENVIRONMENT`**：中国区 **`internal`**、iOA **`ioa`**、海外默认不置或 `public`。智能体 **`config.env`** 里若漏设，会出现**连错端点/认证失败**，进而**重试、cron、多进程**放大。
- **认证优先级**：`CODEBUDDY_AUTH_TOKEN` **>** `apiKeyHelper` **>** `CODEBUDDY_API_KEY`。往 agent `env` 里塞多个时知道谁覆盖谁。
- API Key 获取入口（文内表）：海外 / copilot.tencent.com / iOA —— 与给 Board 操作者的 **onboarding 文案**可共用。

---

## 08.4 CodeBuddy Bash 沙箱.md

**对回形针有用：**

- **子进程继承边界**：沙箱内 Bash 拉起的脚本/程序在 **Linux（bubblewrap）/ macOS（Seatbelt）** 上应继承同一隔离；**与 Windows 路径是否等价需本机核实**。
- **排障提示**：`watchman` 与沙箱不兼容（文内建议 `jest --no-watchman`）；`docker` 常需 `excludedCommands` 强制沙箱外执行——否则反复失败/重试会叠进程。
- **启用方式**：交互里 `/sandbox`；无头时看 **`settings.json` 的 `sandbox`** 段。Paperclip 若在 **无沙箱 + `-y`** 下跑 Bash，自主性高、**子进程面也更大**。

---

## 08.7 CodeBuddy 环境变量参考.md

**对回形针有用（智能体 `config.env` 可显式设）：**

- **认证/端点**：`CODEBUDDY_BASE_URL`、`CODEBUDDY_INTERNET_ENVIRONMENT`（同 08.3）、代理 `HTTP(S)_PROXY`。
- **模型分轨**：`CODEBUDDY_MODEL`、`CODEBUDDY_SMALL_FAST_MODEL`、`CODEBUDDY_BIG_SLOW_MODEL`、**`CODEBUDDY_CODE_SUBAGENT_MODEL`**（子代理）、`MAX_THINKING_TOKENS`。
- **Bash 与「后台化」**：`BASH_DEFAULT_TIMEOUT_MS`、`BASH_MAX_TIMEOUT_MS`；**`CODEBUDDY_BASH_ASSISTANT_BUDGET_MS`**——超长前台 Bash 会**自动转后台任务**（子 agent 不吃这条）；**`CODEBUDDY_BASH_AUTO_BACKGROUND_DISABLED=1`** 可关此行为便于对照复现。
- **少旁路进程/轮询**：**`CODEBUDDY_DISABLE_HOT_RELOAD=1`**；**`CODEBUDDY_DISABLE_CRON=1`**（禁用计划任务/Cron 工具链）；`CODEBUDDY_SKIP_BUILTIN_MARKETPLACE`；第三方市场自动更新默认关，打开会变长连/更新检查面。
- **内存**：`CODEBUDDY_DISABLE_AUTO_MEMORY`、`CODEBUDDY_MEMORY_ENABLED` 等——无头批量时可对照 **关记忆** 看 CPU/磁盘是否下降。
- **MCP**：`MCP_TIMEOUT`、`MCP_TOOL_TIMEOUT`——超时会重试/挂起，放大并行 run 时的问题。

---

## 08.10 CodeBuddy CLI 无头模式接入回形针技术方案.md

**对回形针有用（与当前实现对齐的要点）：**

- **推荐路径**：内置 **`codebuddy_local`**：`execute.ts` **stdin 注入 prompt**、`--print --output-format json`、**`-y`**、可选 **`--resume`**、`maxTurns`/`effort`/`instructionsFilePath`；heartbeat 侧持久化 **session** 供续跑。
- **process adapter 路径**：文内标明 **stdin 不支持**、无结构化解析——与 **豆包「每任务 spawn」** 的对比应以 **官方 adapter 方案** 为准，**不要混用半套 process JSON**。
- **本文件带机器绝对路径（npm global `codebuddy`）**：入库摘录只记语义；换机以 `which codebuddy` 为准。

---

## 08.11 CodeBuddy CLI Daemon 模式与后台会话.md

**对回形针有用：**

- **Worker 注册**：运行中 CLI 进程通过 **PID 文件记在 `~/.codebuddy/sessions/`**；与 **只记录 `runChildProcess` 顶层 pid** 的回形针形成 **双层命名空间**。
- **`--bg`**：等价文意上是 **`--print -y`** + 日志进 **`~/.codebuddy/logs/{name}.log`**；**若人工或脚本与 Paperclip 同时起 `--bg`/Daemon**，会出现 **Paperclip 不知道的 Worker**。
- **`daemon start`**：detached HTTP 服务；**默认 delegate 模式**——主 agent 协调、**实现多交给 subagent**，易从「一个回形针 run」扩成 **多子进程树**。
- **运维收口**：优先 **`codebuddy ps` / `kill` / `daemon stop`**，再才考虑 OS 级 `taskkill`。

---

## 08.5 CodeBuddy Hook 参考指南.md

**对回形针有用：**

- Hook **按作用域合并**（用户/项目/本地/企业），**同一事件多个 hook 可并行跑**——工具一多，等于**额外 shell/子进程扇出**；排障可 **`disableAllHooks: true`** 做 A/B。
- 覆盖 **`SubagentStart` / `SubagentStop`** 等：子代理活跃时 hook 也会触发；与 **CPU 爆**、**多 Worker** 同机并存时要一起查。
- 单 hook **60s 超时**自动断，但若 hook 脚本自己再 fork，**不保证**整 subtree 干净。

---

## 08.6 CodeBuddy Hooks 入门指南.md

**对回形针有用：** 与 §08.5 同主题；落地操作在交互 **`/hooks`** 面板。无头/Paperclip 排障仍以 **`settings.json` + disableAllHooks** 为主。

---

## 08.8 CodeBuddy CLI 无头模式调研.md

**对回形针有用：** 粗览级；文中 **`--yolo`** 等称呼**请以官方 CLI `--help` 与 [CLI 参考](https://www.codebuddy.ai/docs/zh/cli/cli-reference) 为准**（正式 flag 为 `-y` / `--dangerously-skip-permissions`）。**摘录优先级：08.0 > 08.1 > 本文**。

---

## 08.9 CodeBuddy CLI 远程控制.md

**对回形针有用：** **Gateway**（`/gateway`、Tunnel `cloudflared`、默认端口 8321）会多拉 **常驻服务与子进程**；远程任务 **`bypassPermissions`**。若开发机曾开 Gateway 又叠 Paperclip，**进程树要分两条线查**。

---

## 08.12 CodeBuddy CLIGit Worktree 支持.md

**对回形针有用：** `--worktree` 在 **`.codebuddy/worktrees/`** 下建隔离目录；文内强调 **多子代理可各占 worktree 并行**——与 **Paperclip 已为每 issue 准备 workspace/worktree** 叠加时，避免 **CLI 再隐式创 worktree** 导致双倍 IO/进程。

---

## 08.13 CodeBuddy 成本管理.md

**对回形针有用：** 主要是 **`/cost`、`/context`** 的人类交互命令；无头 JSON 里已有 usage。对「泄漏」直接帮助有限，**对压测 token/轮次**有帮助。

---

## 08.14 CodeBuddy 工具参考.md

**对回形针有用：** 与 **Board 上收窄 `allowedTools` / `extraArgs`** 一致：工具越多，**Bash/MCP/浏览器** 链越长；具体表以官方「工具参考」为准，文内为本地摘抄时可当索引。

---

## 08.15 CodeBuddy 定时任务.md

**对回形针有用：** `/loop`、Cron 类能力在**会话存活期间**有效；无头单次 `-p` 退出后会话结束则任务应清。若在长线/ Daemon 场景仍见轮询，可用环境变量 **`CODEBUDDY_DISABLE_CRON=1`**（见 §08.7）硬关。

---

## 08.16 CodeBuddy模型配置.md

**对回形针有用：** 模型别名与 **adapter `config.model`**（ Paperclip 侧 `custom-local:` 前缀等）需一致；大模型/思考模式更易 **长耗时 + 高 CPU**。

---

## 08.17 CodeBuddy 的记忆.md

**对回形针有用：** 与 §08.7 内存 env、§08.2 `memory.*` 同主题；无头压测可关 **`CODEBUDDY_DISABLE_AUTO_MEMORY`** 对照磁盘与后台写。

---

## 08.18 CodeBuddy 插件参考文档.md

**对回形针有用：** 插件与市场加载会 **加长启动、多 watch/update**； env **`CODEBUDDY_SKIP_BUILTIN_MARKETPLACE`**、**`CODEBUDDY_AUTO_UPDATE_THIRD_PARTY_MARKETPLACES`** 见 §08.7。

---

## CodeBuddy Code 安装指南.md

**对回形针有用：** **Node ≥ 18.20**；全局包 **`@tencent-ai/codebuddy-code`**；`codebuddy --version` 自检。与 Paperclip agent **SANDBOX_INSTALL_COMMAND** 一致。

---

## CodeBuddy Code 故障排除.md

**对回形针有用（Windows）：** 建议装 **Git Bash**；可设 **`CODEBUDDY_CODE_GIT_BASH_PATH`**；**`CODEBUDDY_SKIP_GIT_BASH_CHECK=1`** 抑提示；**`codebuddy` 不在 PATH** 时查 `npm config get prefix`。Bash 走 PowerShell 降级时，**部分 worktree/命令行为变样**，易表现为「卡住—重试—多进程」。

---

*（本目录 08.x 已逐篇过目并回写；新增长文可续增 § 节选。）*
