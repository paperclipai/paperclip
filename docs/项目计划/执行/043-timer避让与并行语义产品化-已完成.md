---
status: 已完成
---

# timer 退让与并行语义产品化（`maxConcurrentRuns`）

**母本 / 拆单出处：** **[`长期需求/24 评论唤起过载与编排分层改版计划 2026-05-17.md`](../长期需求/24%20评论唤起过载与编排分层改版计划%202026-05-17.md)** §A3、拆分表 **[043]** 行。**套路：** **[`016-实践-042至053编排开发收口套路`](../最佳实践/016-实践-042至053编排开发收口套路.md)**。

**依赖：** **[`042-多源唤醒合并与有效触发归因-已完成.md`](042-多源唤醒合并与有效触发归因-已完成.md)**（归因优先级与时间线可读性）。

---

## 背景与范围（人话）

在 **`maxConcurrentRuns` 常为 1** 时，`heartbeat_timer` 若仍照旧入队，会和评论/指派/按需等唤起**并排排进 `queued`**，看起来像「同一时间又 heartbeat 又叫醒」。本子把行为钉死为产品语义：**有较重唤醒占着流水线时，这轮定时心跳退让**——不新开 timer run（或说它把「排档期」让给非 timer）。

---

## 探查结论

- **并发语义落点：** `enqueueWakeup`（`heartbeat.ts`）在入队前；`claimQueuedRun`/`startNextQueuedRunForAgent` 仍负责「槽满留队」（既有逻辑）。
- **042：** `effectiveTrigger` 继续在**合并快照**里说清谁压着谁；**043**补的是：**timer 在入口就别占坑**，减少无意义队列长度与调度抖动。
- **非目标：** 不改 `042` 优先级公式；不提供 Board 勾选 UI（退让秒数先用环境常量 + 代码默认）。

---

## 技术设计

1. **`source === "timer"` 且已通过 HB-007（有可分派工单）`** 之后，数一数该 `agentId` 是否已有 **`queued` / `running` / `scheduled_retry` 且 `invocationSource` ≠ `timer`** 的 `heartbeat_runs`。
2. 若有 → **`agent_wakeup_requests` 写入 `skipped`，`reason` = `heartbeat.timer_yield_non_timer_pending`**；并调整 **`agents.lastHeartbeatAt`**（否则 `tickTimers` 会因间隔判据每拍反复撞同一分支）。
3. **退让时间：** `computeDeferredTimerBaseline(now, intervalSec, deferSec)`；默认 **`deferSec` = `HEARTBEAT_TIMER_NON_TIMER_PENDING_DEFER_SEC`（默认 120，可通过环境变量改）**。`deferSec === 0` 表示把时钟拨到「现在」（等同丢弃本轮再等满间隔）。

---

## 评审与开口选项

**无开口选项，按技术设计直接实施。** 全局可调仅 **`PAPERCLIP_TIMER_YIELD_NON_TIMER_DEFER_SEC`**（秒，0〜86400），缺省沿用代码默认。

---

## 落地说明（人话）

- 操作者在 **心跳任务**页会看到脚注：并行常为 1 时，评论类唤醒占用队列/运行时，定时心跳不会再叠一条 heartbeat run；（UI 见 `HeartbeatTasks.tsx`）。
- **智能体配置**里 **`maxConcurrentRuns`** 问号文案**解释上述语义**及对 **042 `effectiveTrigger` 的补充读法。
- 取证：`agent_wakeup_requests` 里 `skipped` + `heartbeat.timer_yield_non_timer_pending`。

---

## 代码与测试索引

| 层级 | 路径 |
| --- | --- |
| 常量 / 语义闸 | `server/src/services/orchestration-invariants.ts`（**HB-043**、`HEARTBEAT_SKIP_TIMER_NON_TIMER_PENDING`、退让秒数与环境变量说明） |
| 退让基数计算 / 计数 | `server/src/services/heartbeat-timer-yield.ts` |
| 入队闸 | `server/src/services/heartbeat.ts` · `enqueueWakeup` |
| UI 脚注 | `ui/src/pages/HeartbeatTasks.tsx`、`ui/src/lib/i18n.ts`（`heartbeatTasksPage.concurrencySemanticsFootnote`、`agentConfigHelp.maxConcurrentRuns`） |
| 运维交叉 | **`docs/项目计划/最佳实践/004-实践-工单心跳与僵尸run排障.md`** §5 |

**测试：** `server/src/__tests__/heartbeat-timer-yield.test.ts`（退让时间纯函数；本机嵌入式 Postgres 不可用时的 **端到端 enqueue 冒烟**请参考同目录其它 `heartbeat-*.test.ts` 范式，需在可启动 embedded Postgres 的环境下补跑）。

---

## 验证证据

- **日期：** 2026-05-17  
- **命令：** `pnpm exec vitest run server/src/__tests__/heartbeat-timer-yield.test.ts`（**5 passed**）。  
- **说明：** 本仓库当前工作区嵌入式 Postgres **启动迁移失败**（与既有 `heartbeat-concurrency-caps` 等套件相同，`company_secret_bindings` 建表阶段报错）；故本轮以 **HB-043 数学闸 + 常量契约**为准，全链接路需在可用 Postgres 的沙箱复核。

---

## 参考链

[`007-心跳调度无issue不触发.md`](007-心跳调度无issue不触发.md)、[`032-agent-pause止损与heartbeat释放一致性.md`](032-agent-pause止损与heartbeat释放一致性.md)、[`033-控制面-issue-run观测与checkout应急操作.md`](033-控制面-issue-run观测与checkout应急操作.md)、[`004-实践-工单心跳与僵尸run排障.md`](../最佳实践/004-实践-工单心跳与僵尸run排障.md)。
