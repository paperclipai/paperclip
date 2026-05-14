# 验收清单

## 完成标准

- [x] 需求边界清楚。  
- [x] 变更面可控（本轮主要为控制面 API / Board 状态，无产品业务大改）。  
- [x] 对外行为有描述（routic：分配 → 自动签出/唤醒 → agent 执行 → issue `done`）。  
- [x] 已记录可复查的验证证据。  
- [x] 已列出残留风险或未跑检查。  

## 验证证据

| 日期 | 命令 / 检查 | 结果 | 备注 |
| --- | --- | --- | --- |
| 2026-05-14 04:45 | `requirements.md` 已填 | 通过 | 使用方、目标、范围、开放问题已写 |
| 2026-05-14 04:45 | Routic 技能已安装 | 通过 | 7 个技能；`init` + `doctor` 成功 |
| 2026-05-14 04:52 | 静态盘点完成 | 通过 | 项目 / 公司 / agent / 适配器 / 命令 / 技能 |
| 2026-05-14 05:05 | 修复 1：4 份缺失 AGENTS.md | 通过 | 前端 / 研究 / 测试 / 归档 instructions |
| 2026-05-14 05:05 | 修复 2：CTO extraArgs | 通过 | 逗号拼接错误已改为合法参数 |
| 2026-05-14 05:05 | 修复 3：技能绑定 | 部分 | 6/8（codebuddy_local / cursor ✅；qwen_local ⚠️ 不支持） |
| 2026-05-14 10:04 | T-005 端到端 | 通过 | `PATCH` agent `idle`；`POST` 创建 **ROU-17**；harness + 唤醒；issue `done`；cwd=`C:\Users\wuhen\code\paperclip` |
| 2026-05-14 10:06 | T-006 僵尸 run | 通过 | `live-runs` + `heartbeat-runs` cancel 循环；必要时 `PATCH` ROU-17 回 `done` |
| 2026-05-14 10:15 | Board：系统通知（ROU-18 恢复） | 通过 | 续跑无 live path → adapter_failed 文案；blocked；Recovery owner CEO |
| 2026-05-14 10:15 | Board：开发-Cursor 评论 | 通过 | 复核 ROU-17；清 `blockedByIssueIds` |
| 2026-05-14 12:00 | T-007 代码阅读 | 通过 | `heartbeat.ts` / `cursor-local` 收尾路径；竞态 + 恢复 + OS 子进程 |
| 2026-05-14 12:00 | T-008 API 快照 | 通过 | CEO idle；无 live run；ROU-8 / ROU-18 状态见当时快照 |
| 2026-05-14 12:30 | Board 人工结案 | 通过 | 人类在 Board 将相关工单标为完成 |
| 2026-05-14 12:45 | 新建 Board **ROU-19** + 仓库 `探查-活动日志异常汇总.md` | 通过 | 从活动接口归纳 cancel / adapter_failed / recovery / qwen skills |
| 2026-05-14 | **ROU-19** 深度探查：恢复链代码追踪 | 通过 | 阅读 `heartbeat.ts:9327`（cancelRunInternal）、`recovery/service.ts:1784`（reconcileStrandedAssignedIssues）、`recovery/service.ts:1833`（恢复单自身卡住检测）、`recovery/service.ts:1596`（escalateStrandedRecoveryIssueInPlace）；报告已补充完整恢复链路追踪 + 代码行号引用 + 5 条目分类结论（2 预期 / 1 计费需跟进 / 1 设计正确 / 1 已知限制） |
| 2026-05-14 | **ROU-19** 最终探查结论 | 通过 | `探查-活动日志异常汇总.md` 完整版：全量 500 条活动数据分类 + 19 条 failure 根因归类 + 恢复链 cancel→blocked 代码级分析 + 综合分类表（预期 vs 计费/适配器/产品需跟进）+ 5 项后续行动建议。已更新 `tasks.md` T-009→已完成。Board API 暂时不可达，需人工 PATCH ROU-19 为 done |
| 2026-05-14 13:10 | 新建 Board **ROU-20**（中英混排探查）+ 本地 **T-010** | 通过 | 初建时指派 CEO、项目误指上游「Paperclip 开发」；见下行纠正 |
| 2026-05-14 14:00 | Board **ROU-19** / **ROU-20** 项目与 ROU-20 受指派人 | 通过 | `PATCH`：`projectId`→「Paperclip 控制面（本 fork 仓库）」、`projectWorkspaceId`→`paperclip-latest-fork`；`executionWorkspaceId:null`（避免把 project workspace id 误填进 execution workspace）；ROU-20 `assigneeAgentId`→**开发-Cursor**；Board 评论说明原因 |
| 2026-05-14 | **ROU-20** / T-010 中英混排探查 | 通过 | 仓库 `docs/00-project/探查-控制台任务中英混排.md`；结论：工单内容语言 + 服务端英文模板 issue + 部分英文 UI + 技能间接影响 agent 产出 |
| 2026-05-14 | **T-011 / ROU-21** 代码探查 + 防御 + **探查活动实践方案** | 部分 | `探查-ROU-21-完成后反复唤醒.md` 已补 **§探查活动实践方案**（API 路径 A→F、`live-runs` 探查注意、`判读速查`、收口话术）；`queueIssueAssignmentWakeup` **`done`/`cancelled` 不唤醒**；Board 仍待按该方案填数后收口 |
| 2026-05-14 | **`process_lost_retry` 机制探测** | 通过 | 仓库 `docs/00-project/探查-process_lost_retry.md`：`reapOrphanedRuns`、启动/周期阈值、`enqueueProcessLossRetry`、`SESSIONED_LOCAL_ADAPTERS` 与 `qwen_local` 差异、API 取证步骤 |
| 2026-05-14 | **ROU-20** API 运行记录快照 | 通过 | `探查-ROU-20-运行记录.md`：`/api/issues/ROU-20/runs` + 6 条 `heartbeat-runs` 详情；两条独立 `process_lost`→`process_lost_retry` 链；末条 `cancelled`（agent pause） |

## 残留风险

- Fork NTFS：`pnpm dev` 易死锁、`vite build` 易挂，开发机建议 `pnpm dev:once`。  
- Hermes 外置化分支稳定性待观察。  
- routic agent 曾需人工取消 **暂停** 才能拉活（T-005 前 Cursor agent）。  
- `GET /issues/.../runs` 与 issue `status` 可能短暂不一致；**cancel run** 可能触发 automation 续跑，需对照 `live-runs` 或 Board 注释收尾。  
- **Cursor 池子 / Spend limit**：即使用 **composer-2-fast**，仍可能出现 **adapter_failed**（英文提示常为 Ultra/Spend）；Paperclip 可能走恢复单（如 ROU-18）并指派 CEO；**ROU-19 探查已确认**需对照 Cursor 账户计费页确认池子独立性。  
- **恢复链 cancel→blocked 边界交互**：手动取消恢复单（如 ROU-18）的 run 会触发恢复系统将其 escalate 为 blocked，而非保持 cancelled。这是因为 `UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES` 包含 `cancelled` 且不区分来源。**ROU-19 已识别**，改进建议已写入探查文档。  
- **Board 中英混排**：**ROU-20** 已归因（见 `探查-控制台任务中英混排.md`）；若要做一致中文体验，需单独决策 Board i18n / 系统 creation 文案 / agent 模板。  
