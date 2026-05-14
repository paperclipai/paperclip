# 任务

## 当前任务

| 编号 | 标题 | 负责人 | 状态 | 下一步 | 证据 |
| --- | --- | --- | --- | --- | --- |
| T-001 | 补齐项目需求 | 人类 + AI | 已完成 | `requirements.md` 已写清使用方、目标、范围 | 2026-05-14 04:45 |
| T-002 | 将 Routic 技能安装进工作区 | AI | 已完成 | 已安装 7 个技能，并跑过 `routic init` / `routic doctor` | 2026-05-14 04:45 |
| T-003 | 静态盘点：项目 / 公司 / agent / 适配器 / 命令 / 技能 | AI | 已完成 | 发现 3 类问题：4 份 instructions 缺失、CTO extraArgs 逗号、0/8 技能绑定 | 2026-05-14 04:52 |
| T-004 | 修复审计结论（instructions + extraArgs + 技能） | AI | 已完成 | 新建 4 份 AGENTS.md、修正 CTO extraArgs、6/8 agent 已绑技能（qwen_local 仍不支持） | 2026-05-14 05:05 |
| T-005 | 端到端：issue → checkout → 心跳 → 执行 → 结案 | AI | 已完成 | Paperclip **ROU-17** 已 `done`；harness 签出 + 分配唤醒；Cursor run `ec440b46-3123-46c0-8c7c-c0807ee757a7` | 2026-05-14 10:04 |
| T-006 | 僵尸 run 清理 | AI | 已完成 | 对卡住 `running` 的 heartbeat run 调用 `POST /api/heartbeat-runs/:id/cancel` 直至 `live-runs` 为空；**ROU-17** 保持 `done` | 2026-05-14 10:06 |
| T-007 | 任务已结束，Cursor CLI / live 仍不退出，只能手动停 | AI | 已完成 | 结论：**issue `done` 与 run 行仍 `running` 不同步** 多见于 (1) Board/agent 先 PATCH 关单，heartbeat 里 `setRunStatus`（`heartbeat.ts` ~7838）尚未落库或续跑插队；(2) 恢复/continuation 在 issue 已闭后仍排队（例 ROU-18）；(3) **adapter_failed**（Cursor 池子/额度）时 CLI 进程与 DB 状态解耦。**OS 侧**：Windows 子进程树未全杀时 CLI 仍「活着」。未改产品代码 | 代码：`server/src/services/heartbeat.ts`；Board：ROU-18 |
| T-008 | routic 公司 CEO 当时在干什么 | AI | 已完成 | API 快照：CEO **idle**、**heartbeat 关**、**live-runs 无**；曾指派 **ROU-8 blocked**（Recover ROU-5）；**ROU-18 done** | 见 `acceptance.md` |
| T-009 | 活动日志异常探查（与 Board **ROU-19** 对应） | CTO（Board） | 已完成 | 全量活动 API 数据 + 恢复链代码对照分析完成。结论：大部分为预期运维残留或已知限制；需计费跟进 1 项（Cursor Ultra limit）、适配器跟进 2 项（CodeBuddy DLL/parse）；恢复链 cancel→blocked 边界交互已识别并记录改进建议 | 2026-05-14：`探查-活动日志异常汇总.md` 完整版；代码：`server/src/services/recovery/service.ts`；Board 待标 done |
| T-010 | 控制台任务中英混排：是否英文技能 / 自动生成导致 | 开发-Cursor（Board） | 已完成 | 归因结论见 `探查-控制台任务中英混排.md`；Board **ROU-20** `done` + 评论 | 2026-05-14：代码阅读 recovery / heartbeat / productivity-review / i18n / routines |
| T-011 | Bug：已完成任务仍反复唤醒 agent（Board **ROU-21** → CTO） | AI（本地）+ Board 复核 | 进行中 | 按 `探查-ROU-21-完成后反复唤醒.md` **「探查活动实践方案」** 跑 A→F，填 **判读速查**；对比部署前后 **同一 ROU-21 issueId** 的 run 次数 / `issue_assigned` 占比 | 同上文档 §实践方案；`issue-assignment-wakeup.ts` |

## 执行顺序

1. **T-011 / ROU-21**：按 `探查-ROU-21-完成后反复唤醒.md` **实践方案（A→F）** 取证；确认误唤醒是否随 **`queueIssueAssignmentWakeup` 终态跳过** 消失。  
2. ~~**T-009 / ROU-19**~~：已完成（见 `探查-活动日志异常汇总.md`）。  
3. ~~**T-010 / Board 中英混排单**~~：已完成（见 `探查-控制台任务中英混排.md` / Board **ROU-20**）；若要做全局中文 Board 再单列决策。  
4. 回顾 `requirements.md` 的 **开放问题**；需要时在 Board 或本表「当前任务」续写新行。  
5. 若要少动手、多自动：再考虑给执行 agent **打开 heartbeat** 并调间隔。  

## 状态取值

- 待办  
- 进行中  
- 待审  
- 已完成  
- 已阻塞  

## 规则

**不得**在 `acceptance.md` 没有证据的情况下，把任务标成「已完成」。

**进行中的任务不得改。** 工单或本表任务处于「进行中」（或已有未收尾的 live run / 执行中状态）时，**不得**用 Board、API 或其它方式去改指派、项目、工作区、标题、描述等核心字段；须先与人对齐，再结束或挂起当前执行，或**另开新工单**承接变更后的目标。

**转任务不得粗暴。** 改指派、换项目或工作区时，须保留可追溯说明（Board 评论或新工单正文写清原因与边界），禁止仅靠一串 PATCH 清字段、改绑却不留记录的做法；优先用**新子单 / 迁移单**承接，而不是在运行中硬改父单。
