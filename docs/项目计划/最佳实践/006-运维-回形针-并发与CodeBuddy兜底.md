# 运维兜底：收敛并发 · 进程可观测 · 避免「一棍子全杀」

> 配合 [001-运维-回形针本地.md](001-运维-回形针本地.md)。**`pnpm dev:nuke` 仍是最后手段**，日常按 **阶梯升级**，尽量只结束**认得的进程**。

---

## 1. 收敛多并发（运营策略）

- **活跃 CodeBuddy 智能体数量**：Board 上少开「同一时刻都在跑 issue」的无头 agent；routine / 唤醒别叠在同一分钟。
- **单 agent**：设合理的 **`timeoutSec`**、**`maxTurnsPerRun`**（智能体配置 JSON），避免单次 run 无限拉长、占满子进程。
- **与 CLI 常驻形态混用**：若本机开过 **`codebuddy daemon`** 或 **`codebuddy --bg`**，与回形针 **`spawn codebuddy -p`** 并行，进程数会**双线叠加**——习惯上开发机二选一或收工全停。

---

## 2. 可监控：先看什么

| 层级 | 看什么 |
| --- | --- |
| 回形针 dev | `pnpm dev:list` / `pnpm dev:stop`（已登记进程） |
| 回形针 run | DB / UI 里 **heartbeat run** 的 **`processPid`**（仅**直接子进程**） |
| CodeBuddy 自身 | **`codebuddy ps`**、必要时 **`codebuddy logs <name>`**；Worker 登记目录 **`~/.codebuddy/sessions/`**（用户 home，不在本仓） |

结论：**不能只盯一种**——Paperclip pid 与 CodeBuddy Worker 可能不一致。

---

## 3. 阶梯收尾（推荐顺序）

1. **回形针前台终端**：对跑着 API 的窗口 **Ctrl+C**。
2. **仓库根**：`pnpm dev:stop`（先停「登记过的 dev」）。
3. **CodeBuddy**：`codebuddy ps` → 对确认无业务的会话 **`codebuddy kill <name或pid>`**。
4. **端口孤儿**（如 3100）：见 [001-运维-回形针本地.md](001-运维-回形针本地.md)「停止与查看状态」— **按 PID 核对命令行** 再 `Stop-Process`，勿盲杀。
5. **仅当仍无法恢复、且已确认可承受副作用**：`pnpm dev:nuke`（或先 `-DryRun`）。**避免** `taskkill /F /IM node.exe` 类「清全场」作为常规动作。

---

## 4. 与「数据库挂了」的关系

一键强力杀进程可能打断**内嵌 Postgres**或留下锁文件；外链库则可能出现**半关闭连接**。杀进程后若库异常，按 [001-运维-回形针本地.md](001-运维-回形针本地.md) 数据库/锁章节与 **[摘录-CodeBuddy本机调研回写.md](../探查/011-摘录-CodeBuddy本机调研回写.md)** 的环境前提处理。

---

*2026-05-15*
