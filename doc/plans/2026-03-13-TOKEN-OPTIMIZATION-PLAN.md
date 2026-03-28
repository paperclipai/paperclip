# Token 优化计划

日期：2026-03-13
相关讨论：https://github.com/paperclipai/paperclip/discussions/449

## 目标

在不降低 agent 能力、控制平面可见性或任务完成质量的前提下，实质性地减少 token 消耗。

本计划基于：

- 当前 V1 控制平面设计
- 当前 adapter 和心跳（heartbeat）实现
- 上述关联的用户讨论
- 2026-03-13 默认 Paperclip 实例的本地运行时数据

## 执行摘要

该讨论在两个方向上是正确的：

1. 我们应该更积极地保持 session 和提示缓存的局部性。
2. 我们应该将稳定的启动指令与每次心跳的动态上下文分离。

但仅靠这两点还不够。

在审查代码和本地运行数据之后，token 问题似乎有四个不同的原因：

1. **有 session 的 adapter 上的计量虚高。** 部分 token 计数器，尤其是 `codex_local`，似乎记录的是累计 session 总量而非每次心跳的增量。
2. **可避免的 session 重置。** 任务 session 在定时器唤醒和手动唤醒时被有意重置，这破坏了常见心跳路径的缓存局部性。
3. **重复获取上下文。** `paperclip` skill 要求 agent 在每次心跳时重新获取任务分配、issue 详情、祖先链和完整评论线程。当前 API 尚未提供高效的增量替代方案。
4. **庞大的静态指令面。** Agent 指令文件和全局注入的 skill 在启动时被重新引入，即使其中大部分内容未变且当前任务并不需要。

正确的做法是：

1. 修复遥测数据，使数字可信
2. 在安全的地方保持复用
3. 使上下文检索增量化
4. 添加 session 压缩/轮换，防止长期 session 变得越来越昂贵

## 已验证的发现

### 1. Token 遥测数据目前至少存在部分虚高

从本地默认实例观察到：

- `heartbeat_runs`：2026-02-18 至 2026-03-13 期间共 11,360 次运行
- `usage_json.inputTokens` 汇总：`2,272,142,368,952`
- `usage_json.cachedInputTokens` 汇总：`2,217,501,559,420`

对于观测到的提示大小，这些总量作为真实的每次心跳使用量是不可信的。

佐证：

- `adapter.invoke.payload.prompt` 平均值较小：
  - `codex_local`：平均约 193 字符，最大 6,067 字符
  - `claude_local`：平均约 160 字符，最大 1,160 字符
- 尽管如此，许多 `codex_local` 运行报告了数百万个输入 token
- 本地数据中某个复用的 Codex session 跨越 3,607 次运行，记录的 `inputTokens` 增长至 `1,155,283,166`

解读：

- 对于有 session 的 adapter，尤其是 Codex，我们很可能将运行时报告的使用量存储为 **session 总量**，而非**每次运行的增量**
- 这使趋势报告、优化工作和客户信任都变得更差

这**并不**意味着没有真实的 token 问题。这意味着我们在评估优化效果之前，需要一个可信的基准。

### 2. 定时器唤醒目前会丢弃可复用的任务 session

在 `server/src/services/heartbeat.ts` 中，`shouldResetTaskSessionForWake(...)` 在以下情况下返回 `true`：

- `wakeReason === "issue_assigned"`
- `wakeSource === "timer"`
- 手动按需唤醒

这意味着许多正常的心跳即使在工作区稳定的情况下也会跳过已保存的任务 session 恢复。

本地数据支持这一影响：

- `timer/system` 运行次数：共 6,587 次
- 仅 976 次有前一个 session
- 仅 963 次以相同的 session 结束

因此，定时器唤醒是最主要的心跳路径，但大多数情况下并未恢复先前的任务状态。

### 3. 我们反复要求 agent 重新加载相同的任务上下文

`paperclip` skill 目前在几乎每次心跳时都要求 agent 执行以下操作：

- 获取任务分配
- 获取 issue 详情
- 获取祖先链
- 获取完整的 issue 评论

当前 API 的形态强化了这种模式：

- `GET /api/issues/:id/comments` 返回完整的评论线程
- 没有面向心跳消费的 `since`、游标、摘要或汇总端点
- `GET /api/issues/:id` 返回完整的丰富 issue 上下文，而非最小化的增量负载

这是安全的，但代价高昂。它迫使模型反复消费未发生变化的信息。

### 4. 静态指令负载与动态心跳提示未被清晰分离

用户讨论建议使用引导提示（bootstrap prompt），方向是正确的。

当前状态：

- UI 暴露了 `bootstrapPromptTemplate`
- adapter 执行路径目前并未使用它
- 多个 adapter 直接将 `instructionsFilePath` 内容添加到每次运行的提示或系统提示中

结果：

- 稳定指令与动态心跳内容走同一路径被重新发送或重新应用
- 我们没有刻意针对提供商的提示缓存进行优化

### 5. 我们注入的 skill 面超出了大多数 agent 的实际需求

本地 adapter 将仓库 skill 注入到运行时 skill 目录中。

关于 `codex_local` 的重要细节：

- Codex 不会直接从当前工作树读取 skill。
- Paperclip 从当前检出中发现仓库 skill，然后将其符号链接到 `$CODEX_HOME/skills` 或 `~/.codex/skills`。
- 如果已有的 Paperclip skill 符号链接指向另一个活跃的检出，当前实现会跳过它，而不是重新指向。
- 即使 Paperclip 侧的 skill 变更已落地，这也可能导致 Codex 使用来自不同工作树的过期 skill 内容。
- 这既是正确性风险，也是 token 分析风险，因为运行时行为可能无法反映被测试检出中的指令。

当前仓库 skill 大小：

- `skills/paperclip/SKILL.md`：17,441 字节
- `.agents/skills/create-agent-adapter/SKILL.md`：31,832 字节
- `skills/paperclip-create-agent/SKILL.md`：4,718 字节
- `skills/para-memory-files/SKILL.md`：3,978 字节

在任何公司特定指令之前，skill markdown 接近 58 KB。

并非所有这些内容都一定在每次运行时加载到模型上下文中，但它增加了启动时的指令面，应视为 token 预算问题。

## Principles

We should optimize tokens under these rules:

1. **Do not lose functionality.** Agents must still be able to resume work safely, understand why tasks exist, and act within governance rules.
2. **Prefer stable context over repeated context.** Unchanged instructions should not be resent through the most expensive path.
3. **Prefer deltas over full reloads.** Heartbeats should consume only what changed since the last useful run.
4. **Measure normalized deltas, not raw adapter claims.** Especially for sessioned CLIs.
5. **Keep escape hatches.** Board/manual runs may still want a forced fresh session.

## Plan

## Phase 1: Make token telemetry trustworthy

This should happen first.

### Changes

- Store both:
  - raw adapter-reported usage
  - Paperclip-normalized per-run usage
- For sessioned adapters, compute normalized deltas against prior usage for the same persisted session.
- Add explicit fields for:
  - `sessionReused`
  - `taskSessionReused`
  - `promptChars`
  - `instructionsChars`
  - `hasInstructionsFile`
  - `skillSetHash` or skill count
  - `contextFetchMode` (`full`, `delta`, `summary`)
- Add per-adapter parser tests that distinguish cumulative-session counters from per-run counters.

### Why

Without this, we cannot tell whether a reduction came from a real optimization or a reporting artifact.

### Success criteria

- per-run token totals stop exploding on long-lived sessions
- a resumed session’s usage curve is believable and monotonic at the session level, but not double-counted at the run level
- cost pages can show both raw and normalized numbers while we migrate

## Phase 2: Preserve safe session reuse by default

This is the highest-leverage behavior change.

### Changes

- Stop resetting task sessions on ordinary timer wakes.
- Keep resetting on:
  - explicit manual “fresh run” invocations
  - assignment changes
  - workspace mismatch
  - model mismatch / invalid resume errors
- Add an explicit wake flag like `forceFreshSession: true` when the board wants a reset.
- Record why a session was reused or reset in run metadata.

### Why

Timer wakes are the dominant heartbeat path. Resetting them destroys both session continuity and prompt cache reuse.

### Success criteria

- timer wakes resume the prior task session in the large majority of stable-workspace cases
- no increase in stale-session failures
- lower normalized input tokens per timer heartbeat

## Phase 3: Separate static bootstrap context from per-heartbeat context

This is the right version of the discussion’s bootstrap idea.

### Changes

- Implement `bootstrapPromptTemplate` in adapter execution paths.
- Use it only when starting a fresh session, not on resumed sessions.
- Keep `promptTemplate` intentionally small and stable:
  - who I am
  - what triggered this wake
  - which task/comment/approval to prioritize
- Move long-lived setup text out of recurring per-run prompts where possible.
- Add UI guidance and warnings when `promptTemplate` contains high-churn or large inline content.

### Why

Static instructions and dynamic wake context have different cache behavior and should be modeled separately.

For `codex_local`, this also requires isolating the Codex skill home per worktree or teaching Paperclip to repoint its own skill symlinks when the source checkout changes. Otherwise prompt and skill improvements in the active worktree may not reach the running agent.

### Success criteria

- fresh-session prompts can remain richer without inflating every resumed heartbeat
- resumed prompts become short and structurally stable
- cache hit rates improve for session-preserving adapters

## Phase 4: Make issue/task context incremental

This is the biggest product change and likely the biggest real token saver after session reuse.

### Changes

Add heartbeat-oriented endpoints and skill behavior:

- `GET /api/agents/me/inbox-lite`
  - minimal assignment list
  - issue id, identifier, status, priority, updatedAt, lastExternalCommentAt
- `GET /api/issues/:id/heartbeat-context`
  - compact issue state
  - parent-chain summary
  - latest execution summary
  - change markers
- `GET /api/issues/:id/comments?after=<cursor>` or `?since=<timestamp>`
  - return only new comments
- optional `GET /api/issues/:id/context-digest`
  - server-generated compact summary for heartbeat use

Update the `paperclip` skill so the default pattern becomes:

1. fetch compact inbox
2. fetch compact task context
3. fetch only new comments unless this is the first read, a mention-triggered wake, or a cache miss
4. fetch full thread only on demand

### Why

Today we are using full-fidelity board APIs as heartbeat APIs. That is convenient but token-inefficient.

### Success criteria

- after first task acquisition, most heartbeats consume only deltas
- repeated blocked-task or long-thread work no longer replays the whole comment history
- mention-triggered wakes still have enough context to respond correctly

## Phase 5: Add session compaction and controlled rotation

This protects against long-lived session bloat.

### Changes

- Add rotation thresholds per adapter/session:
  - turns
  - normalized input tokens
  - age
  - cache hit degradation
- Before rotating, produce a structured carry-forward summary:
  - current objective
  - work completed
  - open decisions
  - blockers
  - files/artifacts touched
  - next recommended action
- Persist that summary in task session state or runtime state.
- Start the next session with:
  - bootstrap prompt
  - compact carry-forward summary
  - current wake trigger

### Why

Even when reuse is desirable, some sessions become too expensive to keep alive indefinitely.

### Success criteria

- very long sessions stop growing without bound
- rotating a session does not cause loss of task continuity
- successful task completion rate stays flat or improves

## Phase 6: Reduce unnecessary skill surface

### Changes

- Move from “inject all repo skills” to an allowlist per agent or per adapter.
- Default local runtime skill set should likely be:
  - `paperclip`
- Add opt-in skills for specialized agents:
  - `paperclip-create-agent`
  - `para-memory-files`
  - `create-agent-adapter`
- Expose active skill set in agent config and run metadata.
- For `codex_local`, either:
  - run with a worktree-specific `CODEX_HOME`, or
  - treat Paperclip-owned Codex skill symlinks as repairable when they point at a different checkout

### Why

Most agents do not need adapter-authoring or memory-system skills on every run.

### Success criteria

- smaller startup instruction surface
- no loss of capability for specialist agents that explicitly need extra skills

## Rollout Order

Recommended order:

1. telemetry normalization
2. timer-wake session reuse
3. bootstrap prompt implementation
4. heartbeat delta APIs + `paperclip` skill rewrite
5. session compaction/rotation
6. skill allowlists

## Acceptance Metrics

We should treat this plan as successful only if we improve both efficiency and task outcomes.

Primary metrics:

- normalized input tokens per successful heartbeat
- normalized input tokens per completed issue
- cache-hit ratio for sessioned adapters
- session reuse rate by invocation source
- fraction of heartbeats that fetch full comment threads

Guardrail metrics:

- task completion rate
- blocked-task rate
- stale-session failure rate
- manual intervention rate
- issue reopen rate after agent completion

Initial targets:

- 30% to 50% reduction in normalized input tokens per successful resumed heartbeat
- 80%+ session reuse on stable timer wakes
- 80%+ reduction in full-thread comment reloads after first task read
- no statistically meaningful regression in completion rate or failure rate

## Concrete Engineering Tasks

1. Add normalized usage fields and migration support for run analytics.
2. Patch sessioned adapter accounting to compute deltas from prior session totals.
3. Change `shouldResetTaskSessionForWake(...)` so timer wakes do not reset by default.
4. Implement `bootstrapPromptTemplate` end-to-end in adapter execution.
5. Add compact heartbeat context and incremental comment APIs.
6. Rewrite `skills/paperclip/SKILL.md` around delta-fetch behavior.
7. Add session rotation with carry-forward summaries.
8. Replace global skill injection with explicit allowlists.
9. Fix `codex_local` skill resolution so worktree-local skill changes reliably reach the runtime.

## Recommendation

Treat this as a two-track effort:

- **Track A: correctness and no-regret wins**
  - telemetry normalization
  - timer-wake session reuse
  - bootstrap prompt implementation
- **Track B: structural token reduction**
  - delta APIs
  - skill rewrite
  - session compaction
  - skill allowlists

If we only do Track A, we will improve things, but agents will still re-read too much unchanged task context.

If we only do Track B without fixing telemetry first, we will not be able to prove the gains cleanly.
