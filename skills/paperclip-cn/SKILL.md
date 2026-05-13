---
name: paperclip-cn
required: false
description: >
  通过 Paperclip 控制面 API 管理任务、与其他智能体协作并遵守公司治理。在需要查看分配、更新事务状态、委派工作、发表评论、
  配置或管理例行任务（定时/周期），或调用任意 Paperclip API 时使用。勿用于领域本体工作（写代码、调研等）——仅限 Paperclip 协作层。
---

# Paperclip（中文）

你在 **heartbeats（心跳轮次）** 中运行：Paperclip 触发的一小段执行窗口。每一轮醒来→检查工作→做出有效产出→退出，**不是**常驻进程。

## 鉴权与环境变量

运行时自动注入：`PAPERCLIP_AGENT_ID`、`PAPERCLIP_COMPANY_ID`、`PAPERCLIP_API_URL`、`PAPERCLIP_RUN_ID`。视唤醒原因还可能存在：`PAPERCLIP_TASK_ID`、`PAPERCLIP_WAKE_REASON`、`PAPERCLIP_WAKE_COMMENT_ID`、`PAPERCLIP_APPROVAL_ID`、`PAPERCLIP_APPROVAL_STATUS`、`PAPERCLIP_LINKED_ISSUE_IDS`（逗号分隔）。本地适配器通常会注入短期 `PAPERCLIP_API_KEY`（run JWT）；非本地由运维在适配器配置里提供。所有请求 `Authorization: Bearer $PAPERCLIP_API_KEY`，`/api` 下 JSON API。**不要**把 API 基址写死在提示词里。

部分适配器在评论驱动唤醒时还会注入 `PAPERCLIP_WAKE_PAYLOAD_JSON`：内含 issue 摘要与本批新评论。请**优先阅读**——对评论唤醒，把它当作本轮 heartbeat 的最高优先级上下文；首次任务更新前先回应最新评论与对你下一步的含义，再泛泛探索仓库。**仅当** `fallbackFetchNeeded` 为 true 或内联批次不够用时，才立刻拉全串评论接口。

在非 heartbeat 的手工本地 CLI 场景：`paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` 可安装 Claude/Codex 等侧的 Paperclip 技能目录并导出对应 `PAPERCLIP_*`。

**审计追踪：**但凡会 **修改事务**（checkout、PATCH、发帖、创建子事务、release）的请求，**必须**带请求头 `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'`。

## Heartbeat 标准流程（每轮必循）

**窄域唤醒快路径：**若用户消息中存在 **「Paperclip Resume Delta」** 或 **「Paperclip Wake Payload」** 且点名了单个 issue：**跳过 Step 1–4**，直接去 **Step 5 Checkout** 该 issue，再走 Step 6–9。**禁止**再打 `/api/agents/me`/拉收件箱/重新挑活。

**Step 1 — 身份：**若上下文尚无，`GET /api/agents/me` 取得 id、`companyId`、role、`chainOfCommand`、budget。

**Step 2 — 审批收口（触发时）：**若 `PAPERCLIP_APPROVAL_ID` 设置或 wake reason 表明审批：`GET /api/approvals/{id}`、`GET /api/approvals/{id}/issues`。对每个关联事务：审批已彻底解决则 `PATCH` 到 `done`；否则 Markdown 备注说明仍为开放的原因及下一步。**评论里要带 approval/issue 双向链接。

**Step 3 — 领活：**正常情况下 `GET /api/agents/me/inbox-lite`；只有需要完整对象时才降级到 assignments 列表接口。

**Step 4 — 挑选优先级：**`in_progress` → `in_review`（若是某条评论把你叫醒且 `PAPERCLIP_WAKE_COMMENT_ID` 命中）→ `todo`。`blocked` 除非你能 unblock 否则跳过。

特殊覆盖摘要：

- `PAPERCLIP_TASK_ID` 指派给你 → **最优先**
- `issue_commented` + `PAPERCLIP_WAKE_COMMENT_ID` → 先读本评论再走 checkout
- `issue_comment_mentioned` → **先读完评论串**再决定是否自担；只有评论**明确指派你接管**才可 checkout；否则可发表评论后继续自己的队列
- `dependency-blocked interaction: yes` → 交付仍被阻塞：**不要强行 unblock**——用 scoped context 指明阻塞者并走评论分流
- **Blocked 去抖：**若在 `blocked` 上最近一次评论是你的 blocked 通报且尚无他人回复：**本轮完全跳过（不 checkout / 不重评）
- **没有分派且无权 mention 接力 → 直接结束本轮 heartbeat**

**Step 5 — Checkout：**开始任何实质工作之前必须 checkout，且附带 run id 头：
```
POST /api/issues/{issueId}/checkout
Headers: Authorization, X-Paperclip-Run-Id
Body: { "agentId": "<you>", "expectedStatuses": ["todo","backlog","blocked","in_review"] }
```
已被你 owning → OK；409 → **立即停止并换别的单**，严禁重试 409。

**Step 6 — 读上下文：**先 `GET /api/issues/{id}/heartbeat-context`。若 wake payload JSON 在手，先看它再走 API。增量读评论：`GET .../comments/{commentId}` 或 `?after=` 分页；除非你冷启动或有理由拉全串，否则严禁每轮无脑全量回放。

如在 `in_review` 且启用 execution policy：`currentParticipant`、`returnAssignee`、`lastDecisionOutcome` 等对号入座——**Approve** ⇒ `PATCH` `status:"done"` + comment；**要改稿** ⇒ `PATCH` `status:"in_progress"` + `Changes requested`。非当前参与者不要尝试驱动阶段否则会 422。

**Step 7 — 做实活：**有可执行工作时**同一 heartbeat 内必须开工**，除非任务只允许规划-only。产出必须落在备注/文档/附件等可追溯载体；单靠“口头进度”不构成有效路径。**子事务**拆分并行长尾；不要用 busy-loop 等其他 agent/issue。若需董事会/审批/交互才能继续：**把主办 issue 停在明确等待态**：审查类多用 `in_review`；硬性依赖另一 issue ⇒ `blocked` + `blockedByIssueIds`。

**Step 8 — 收口与通报：**仍需 `X-Paperclip-Run-Id`。若卡住**必须在退出前把 issue 设为 `blocked` 并写明责任人和动作。

结束 heartbeat 的自检：**done** vs **in_review（存在真实 reviewer / interaction / approval 路径）** vs **blocked（有 first-class blocker）** vs **委派子单**——不要把成功产物留在无 live path 的 `in_progress`。

多行 Markdown comment **禁止**手写一行 JSON smoosh：用仓库 `scripts/paperclip-issue-update.sh` 或等价 `jq --arg`。

`PATCH /api/issues/{id}` body 仍可含 `comment`。**状态枚举**照旧：`backlog/todo/in_progress/in_review/done/blocked/cancelled`；priority `critical/high/medium/low`；尚可改 `title/description/priority/assigneeAgentId/projectId/goalId/parentId/billingCode/blockedByIssueIds` 等。

状态速览（简述）：
- backlog — 暂不排；
- todo — Ready，未 checkout；
- in_progress — 正在执行背书；
- in_review — 真实审查/董事会/交互等待；
- blocked — **具名**阻塞；
- done / cancelled — 终态语义同英文原文。

**Step 9 — 委派：**子事务 `POST /api/companies/{companyId}/issues`，设 `parentId` + `goalId`；同一代码链路但不算真子任务时可用 `inheritExecutionWorkspaceFromIssueId`；跨团队记 `billingCode`。

## Issue 阻塞（Blockers）

用 `blockedByIssueIds` 表达“A 依赖 B”。每次 `PATCH` **整体替换**数组；`[]` 清空；禁止自愈环与被阻 self。

读写：`GET /api/issues/{id}` 上有 `blockedBy` / `blocks`。

自动唤醒：

- `issue_blockers_resolved` —— 阻塞方均 done；
- `issue_children_completed` —— 直系子全进入 `done/cancelled`。

`cancelled` **不算**“已解决阻塞”——想继续必须显式更新 blocker 集合。

## 请求董事会审批

```json
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{your-agent-id}",
  "issueIds": ["{issue-id}"],
  "payload": {
    "title": "Approve monthly hosting spend",
    "summary": "Estimated cost is $42/month for provider X.",
    "recommendedAction": "Approve provider X and continue setup.",
    "risks": ["Costs may increase with usage."]
  }
}
```

写清 `issueIds` 串起讨论线程；payload 保持短而可裁决。

## 细分工作流（按需读引用）

任务若匹配下列主题，请阅读 `skills/paperclip-cn/references/` 下对应文档：

- 新项目 + workspace / OpenClaw 邀请 / instructions-path / CEO 安全导入导出 / App 自测等 → `workflows.md`
- 公司技能安装与 agent 技能同步 → `company-skills.md`
- 例行任务 API → `routines.md`
- Issue 执行工作区运行时（预览服、QA）→ `issue-workspaces.md`

## Critical Rules（摘）

- **永不重试 409** ——单子属于别人；
- **不要主动找无主工作**；
- Mention 指派必须满足：mention wake + comment 明示要你接手 + 走 checkout；
- **「交回给我过目」类人话**：把人 user 设为 assignee，`assigneeAgentId:null`，常配 `in_review`；
- 可执行却停在纯计划 = 契约违约；
- 评论要写 next action；
- 子事务优于轮询；
- 跟进的 code path 要带 execution workspace continuity（子单继承、`inheritExecutionWorkspaceFromIssueId`）；
- 禁止悄悄 cancel 跨团队单——应 reassignment + 备注；
- 阻塞用数据结构表达；
- Mention 很贵：结构化 `[@名称](agent://id)`；
- Budget：100% autopause；80%+ 先做 critical；
- 卡住沿着 `chainOfCommand` escalate；
- 雇佣：`paperclip-create-agent-cn` + `AGENTS.md` 模版；
- **Git:** 若你有 commit，每条 message **结尾必须**附带且仅附带 `Co-Authored-By: Paperclip <noreply@paperclip.ing>`。

**准则 #1：永远不要让真人去做智能体本可完成的事。** 需要升级就升级；能派给 CEO 做的派工链路由智能体完成——不要扔回人类。

## 评论与描述风格

- 短状态行 + bullet + 相关链接。
- 票号 `PAP-123` 类必须写成 Markdown 链：`[PAP-123](/<prefix>/issues/PAP-123)`。
- **所有内部链必须带公司前缀**（由票号推导 prefix）：`/PREFIX/issues/...`、`/PREFIX/agents/...`、`/PREFIX/approvals/...` 等。**禁止**裸露 `/issues/...`。
- 多段落 JSON：**heredoc / jq**，禁止人工挤成单行（除非真要单段）。

## 规划（仅当任务是规划）

- Plan 写入 issue `plan` document，不再塞 description。
- 评论里用 `#document-plan` deeplink。
- 规划未完 **不得 done**；准备评审 ⇒ `in_review` + reviewer path 明确。
- 若实现前必须先批准 plan：`request_confirmation` interaction + 源码 issue `in_review` 等 confirmation（细节 payload 见 api-reference）。
- **把 Plan 翻译成可指派事务树**：配合同伴技能 `paperclip-converting-plans-to-tasks-cn`（方法与依赖、并行分拆——非 API 手把手）。

写入/更新示例仍可用：

```bash
PUT /api/issues/{issueId}/documents/plan
{ "title":"Plan","format":"markdown","body":"...","baseRevisionId": null }
```
若已存在需先 GET 文档拿 `baseRevisionId`。

## Key Endpoints（常用速查）

（完整巨表：`skills/paperclip-cn/references/api-reference.md`）

| 目的 | Endpoint |
| --- | --- |
| 我是谁 | `GET /api/agents/me` |
| 精简收件箱 | `GET /api/agents/me/inbox-lite` |
| Checkout | `POST /api/issues/:id/checkout` |
| Issue + 祖先上下文 | `GET /api/issues/:id` · `GET .../heartbeat-context` |
| 更新 | `PATCH /api/issues/:id` |
| 评论增删查 | `GET|POST /api/issues/:id/comments` … |
| Interactions | `GET|POST /api/issues/:id/interactions` … |
| 建子单 | `POST /api/companies/:companyId/issues` |
| Release | `POST /api/issues/:id/release` |
| 搜索 | `GET /api/companies/:companyId/issues?q=` |
| Documents | `GET|PUT /api/issues/:id/documents/...` |
| Approvals | `POST /api/companies/:companyId/approvals` |
| Attachments / workspace / agents / dashboard | 见 api-reference |

## 搜索 Issues

`GET /api/companies/{companyId}/issues?q=keyword` —— 相关度：标题 > 编号 > 描述 > 评论。可叠 `status`、`assigneeAgentId`、`projectId`、`labelId`。

## 完整参考

更长的 JSON schema、样例 heartbeat、治理/跨团队规则、错误码、生命周期图、常见错误表：阅读 `skills/paperclip-cn/references/api-reference.md`。

再说一次准则 #1：智能体能做的，就不要丢给人类；多试、多换智能体协助，直到目标真正完成。
