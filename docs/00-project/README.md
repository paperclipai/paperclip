# 项目概览（本仓库 / routic 控制面）

## 本项目是什么

Paperclip 是「可复制的软件公司」三层架构里的**执行平面**——贾维斯管策略、赫尔墨斯管路由、Paperclip 管执行。当前工作区是 fork（HenkDz/paperclip，端口 3101+），上游为 paperclipai/paperclip（常见 3100）。目标是让 routic 公司的 agent 通过心跳自动拉任务执行，跑通 **issue → run → done** 全链路。

## 当前阶段

- **阶段**：探索验证期 — 让 Paperclip 在当前环境稳定可用  
- **主线目标**：端到端跑通一次完整任务（建单 → agent 拉活 → 执行 → 结案）  
- **主要风险点**：agent 进程与僵尸 run、Hermes 外置化分支稳定性、Windows NTFS 与 Cursor 池子/计费提示等  

## 文档索引

- **需求**：`requirements.md`  
- **任务**：`tasks.md`  
- **验收**：`acceptance.md`  
- **活动异常归纳**（与 Board **ROU-19** 对应）：`探查-活动日志异常汇总.md`  
- **完成后仍反复唤醒 agent**（与 Board **ROU-21** 对应）：`探查-ROU-21-完成后反复唤醒.md`（含 **探查活动实践方案** API 步骤）  
- **孤儿进程与 `process_lost_retry`**（heartbeat 自动重试）：`探查-process_lost_retry.md`  
- **ROU-20 运行记录**（中英混排单、含 `process_lost_retry` 时间线）：`探查-ROU-20-运行记录.md`  
- **工单 → runs → 详情** 的 API 取证操作路径（含 Windows 踩坑）：`实践-工单运行记录API取证路径.md`  

## 给 AI 的约定

实现前先读本目录；重要结论与范围变更写回 `requirements.md` / `tasks.md` / `acceptance.md`，便于人类与后续会话追溯。

---

## 为什么这里一度是英文？

不是「系统检测到项目语言自动切成英文」，而是常见几件事叠在一起：

1. **Routic / Paperclip 上游模板**里，标题和表头常用英文（`Tasks`、`Done`、`Execution Order`），早期从模板生成或从英文会话粘贴时就会保留。  
2. **本仓库主体**（`doc/`、`AGENTS.md`）仍以英文产品文档为主；`docs/00-project` 是后来加的 **routic 控制面旁注**，语言风格未统一。  
3. **谁在写**：AI 或人类用英文写第一版时，后续没有强制「全中文」规则，就会混排。

本次已把 **`docs/00-project` 内面向「项目管理」的 Markdown** 统一为中文标题与说明；**API 路径、issue 号、代码路径** 仍保留英文原文，避免歧义。
