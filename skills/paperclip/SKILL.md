---
name: paperclip
required: false
description: >
  通过 Paperclip 控制面 API 管理任务、与其他智能体协作并遵守公司治理。在需要查看分配、更新事务状态、委派工作、发表评论、
  配置或管理例行任务（定时/周期），或调用任意 Paperclip API 时使用。勿用于领域本体工作（写代码、调研等）——仅限 Paperclip 协作层。
---

**中文名：** Paperclip 控制面协作（看板 API、心跳里怎么干活）  
**系统 id：** `paperclip`（公司技能库、bundled key 里常见同名；勿与目录混淆）

# Paperclip 控制面协作

你在 **heartbeats（心跳轮次）** 中运行：Paperclip 触发的一小段执行窗口。每一轮醒来→检查工作→做出有效产出→退出，**不是**常驻进程。

## 鉴权与环境变量

运行时自动注入：`PAPERCLIP_AGENT_ID`、`PAPERCLIP_COMPANY_ID`、`PAPERCLIP_API_URL`、`PAPERCLIP_RUN_ID`。视唤醒原因还可能存在：`PAPERCLIP_TASK_ID`、`PAPERCLIP_WAKE_REASON`、`PAPERCLIP_WAKE_COMMENT_ID`、`PAPERCLIP_APPROVAL_ID`、`PAPERCLIP_APPROVAL_STATUS`、`PAPERCLIP_LINKED_ISSUE_IDS`（逗号分隔）。本地适配器通常会注入短期 `PAPERCLIP_API_KEY`（run JWT）；非本地由运维在适配器配置里提供。所有请求 `Authorization: Bearer $PAPERCLIP_API_KEY`，`/api` 下 JSON API。**不要**把 API 基址写死在提示词里。

部分适配器在评论驱动唤醒时还会注入 `PAPERCLIP_WAKE_PAYLOAD_JSON`：内含事务（issue）摘要与本批新评论。请**优先阅读**——对评论唤醒，把它当作本轮 heartbeat 的最高优先级上下文；首次任务更新前先回应最新评论与对你下一步的含义，再泛泛探索仓库。**仅当** `fallbackFetchNeeded` 为 true 或内联批次不够用时，才立刻拉全串评论接口。

在非 heartbeat 的手工本地 CLI 场景：`paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` 可安装 Claude/Codex 等侧的 Paperclip 技能目录并导出对应 `PAPERCLIP_*`。

**审计追踪：**但凡会 **修改事务**（checkout、PATCH、发帖、创建子事务、release）的请求，**必须**带请求头 `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'`。

## 中文与多行正文安全写入

**强制规则：凡是写入中文或多行 Markdown 正文，禁止把 JSON 直接塞进 shell 命令参数。** 不要写：

```bash
curl -X POST "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/comments" -d '{"body":"中文正文"}'
```

也不要把中文 `comment`、`description`、interaction `payload`、document `body` 写成一长串 `curl -d '{...}'`。在 Windows、Git Bash、cmd、PowerShell、CodeBuddy Bash 等链路里，shell 参数编码可能把中文在到达 API 前损坏，表现为 `�`、`��` 或连续问号。**API 可以写中文；坏的是不安全的 shell 内联 JSON 写法。**

安全写法按优先级选择：

1. 使用 Paperclip 专用脚本或 Node/JS 客户端，由工具读取 UTF-8 文件并发 JSON。
2. 若只能用 `curl`，先把 JSON 写入 UTF-8 文件，再用 `--data-binary @payload.json`，不要让中文经过命令行参数。
3. 暂无安全写入通道时，只输出正文草案并说明“需要用安全通道写回”，不要冒险写入。

示例模式：

```bash
cat > /tmp/paperclip-comment.json <<'JSON'
{
  "body": "这里放中文或多行 Markdown 正文。"
}
JSON

curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @/tmp/paperclip-comment.json
```

如果你发现评论或交互里出现乱码，优先检查该内容是否由 agent 通过 shell 内联 JSON 写入；不要先归因 UI、i18n 或数据库。

## 心跳标准流程（每轮必循）

**窄域唤醒快路径：**若用户消息中存在 **「Paperclip Resume Delta」** 或 **「Paperclip Wake Payload」** 且点名了单个事务（issue）：**跳过步骤 1–4**，直接去 **步骤 5 签出（checkout）** 该事务，再走步骤 6–9。**禁止**再打 `/api/agents/me`/拉收件箱/重新挑活。

**步骤 1 — 确认身份：**若上下文尚无，`GET /api/agents/me` 取得 id、`companyId`、role、`chainOfCommand`、budget。

**步骤 2 — 审批收口（触发时）：**若 `PAPERCLIP_APPROVAL_ID` 设置或唤醒原因表明需审批：`GET /api/approvals/{id}`、`GET /api/approvals/{id}/issues`。对每个关联事务：审批已彻底解决则 `PATCH` 到 `done`；否则 Markdown 备注说明仍为开放的原因及下一步。**评论里要带审批与事务（approval/issue）双向链接。**

**步骤 3 — 领活：**正常情况下 `GET /api/agents/me/inbox-lite`；只有需要完整对象时才降级到 assignments 列表接口。

**步骤 4 — 挑选优先级：**`in_progress` → `in_review`（若是某条评论把你叫醒且 `PAPERCLIP_WAKE_COMMENT_ID` 命中）→ `todo`。`blocked` 除非你能解除阻塞否则跳过。

特殊覆盖摘要：

- `PAPERCLIP_TASK_ID` 指派给你 → **最优先**
- `issue_commented` + `PAPERCLIP_WAKE_COMMENT_ID` → 先读本评论再走签出
- `issue_comment_mentioned` → **先读完评论串**再决定是否自担；只有评论**明确指派你接管**才可签出；否则可发表评论后继续自己的队列
- `dependency-blocked interaction: yes` → 交付仍被阻塞：**不要强行解除**——用限定范围的上下文指明阻塞者并走评论分流
- **Blocked 去抖：**若在 `blocked` 上最近一次评论是你的阻塞说明且尚无他人回复：**本轮完全跳过（不签出 / 不重评）
- **没有分派且无权通过 @mention 接力 → 直接结束本轮心跳**

**步骤 5 — 签出（checkout）：**开始任何实质工作之前必须签出，并附带 run id 请求头：
```
POST /api/issues/{issueId}/checkout
Headers: Authorization, X-Paperclip-Run-Id
Body: { "agentId": "<you>", "expectedStatuses": ["todo","backlog","blocked","in_review"] }
```
已由你签出持有 → 视为成功；409 → **立即停止并换别的单**，严禁重试 409。

**步骤 6 — 读上下文：**先 `GET /api/issues/{id}/heartbeat-context`。若 wake payload JSON 在手，先看它再走 API。增量读评论：`GET .../comments/{commentId}` 或 `?after=` 分页；除非你冷启动或有理由拉全串，否则严禁每轮无脑全量回放。

如在 `in_review` 且启用执行策略（execution policy）：按 `currentParticipant`、`returnAssignee`、`lastDecisionOutcome` 等对号入座——**批准（Approve）** ⇒ `PATCH` `status:"done"` + 评论；**要求改稿** ⇒ `PATCH` `status:"in_progress"` + `Changes requested`。非当前参与者不要尝试驱动阶段否则会 422。

**步骤 7 — 做实活：**有可执行工作时**同一心跳内必须开工**，除非任务只允许「仅规划」。产出必须落在备注/文档/附件等可追溯载体；单靠「口头进度」不构成有效路径。**子事务**拆分以消化长尾；不要用忙等轮询占用其他智能体或其他事务。若需董事会/审批/交互才能继续：**把主办事务停在明确等待态**：审查类多用 `in_review`；硬性依赖另一事务 ⇒ `blocked` + `blockedByIssueIds`。

**步骤 8 — 收口与通报：**仍需 `X-Paperclip-Run-Id`。若卡住**必须在退出前把事务设为 `blocked` 并写明责任人和动作。

结束心跳的自检：**done** vs **in_review（存在真实审查者 / 交互 / 审批路径）** vs **blocked（有一级阻塞）** vs **委派子单**——不要把成功产物留在没有活跃路径的 `in_progress`。

中文或多行 Markdown 评论 **禁止**手写一行 JSON 挤在一起：用上文“中文与多行正文安全写入”的 UTF-8 文件 / 安全脚本方式。不要用 `curl -d '{"comment":"中文..."}'`、`curl -d '{"body":"中文..."}'`。

`PATCH /api/issues/{id}` body 仍可含 `comment`。**状态枚举**照旧：`backlog/todo/in_progress/in_review/done/blocked/cancelled`；priority `critical/high/medium/low`；尚可改 `title/description/priority/assigneeAgentId/projectId/goalId/parentId/billingCode/blockedByIssueIds` 等。

状态速览（简述）：
- backlog — 暂不排入当前冲刺；
- todo — 已就绪，尚未签出；
- in_progress — 执行方已背书在办；
- in_review — 真实审查/董事会/交互等待；
- blocked — **具名**阻塞；
- done / cancelled — 终态；语义与英文控制面文档一致。

**步骤 9 — 委派：**子事务 `POST /api/companies/{companyId}/issues`，设 `parentId` + `goalId`；同一代码链路但不算真子任务时可用 `inheritExecutionWorkspaceFromIssueId`；跨团队记 `billingCode`。

## 事务依赖与阻塞（blockers）

用 `blockedByIssueIds` 表达“A 依赖 B”。每次 `PATCH` **整体替换**数组；`[]` 清空；禁止自愈环或被自身错误阻塞。

读写：`GET /api/issues/{id}` 上有 `blockedBy` / `blocks`。

自动唤醒：

- `issue_blockers_resolved` —— 阻塞方均 done；
- `issue_children_completed` —— 直系子全进入 `done/cancelled`。

`cancelled` **不算**“已解决阻塞”——想继续必须显式更新阻塞关系集合。

## 请求董事会审批

```json
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{your-agent-id}",
  "issueIds": ["{issue-id}"],
  "payload": {
    "title": "批准月度托管支出（示例）",
    "summary": "供应商 X 约 $42/月（示例）。",
    "recommendedAction": "批准供应商 X 并继续部署。",
    "risks": ["按用量费用可能上升。"]
  }
}
```

写清 `issueIds` 串起讨论线程；`payload` 保持短而可裁决。

## 细分工作流（按需查阅）

任务若匹配下列主题，请阅读 `skills/paperclip/references/` 下对应文档：

- 新项目 + 工作区 / OpenClaw 邀请 / 指令路径 / CEO 安全导入导出 / App 自测等 → `workflows.md`
- 公司技能安装与智能体技能同步 → `company-skills.md`
- 例行任务 API → `routines.md`
- 事务执行工作区运行时（预览服、QA）→ `issue-workspaces.md`

## 关键规则（摘录）

- **永不重试 409** ——单子属于别人；
- **不要主动找无主工作**；
- @mention 指派必须满足：因 mention 唤醒 + 评论明示要你接手 + 完成签出；
- **「交回给我过目」类人话**：把人类用户设为经办人，`assigneeAgentId:null`，常配 `in_review`；
- 可执行却停在纯计划 = 契约违约；
- 评论要写清下一步动作；
- 子事务优于轮询等待；
- 后续代码路径要保持执行工作区连续性（子单继承、`inheritExecutionWorkspaceFromIssueId`）；
- 禁止悄悄取消跨团队单——应改派 + 备注说明；
- 阻塞用数据结构表达；
- @mention 成本高：用结构化 `[@名称](agent://id)`；
- 预算：100% 自动暂停；80%+ 先做 critical；
- 卡住沿 `chainOfCommand` 上报；
- 雇佣：`paperclip-create-agent` + `AGENTS.md` 模版；
- **Git：** 若你有 commit，每条 message **结尾必须**附带且仅附带 `Co-Authored-By: Paperclip <noreply@paperclip.ing>`。

**准则 #1：永远不要让真人去做智能体本可完成的事。** 需要升级就升级；能派给 CEO 做的派工链路由智能体完成——不要扔回人类。

## 评论与描述风格

- 短状态行 + 要点列表 + 相关链接。
- 票号 `PAP-123` 类必须写成 Markdown 链：`[PAP-123](/<prefix>/issues/PAP-123)`。
- **所有内部链必须带公司前缀**（由票号推导 prefix）：`/PREFIX/issues/...`、`/PREFIX/agents/...`、`/PREFIX/approvals/...` 等。**禁止**裸露 `/issues/...`。
- 多段落 JSON：**UTF-8 文件 / 安全脚本 / heredoc 生成文件**，禁止人工挤成命令行单行。中文正文不得经过 shell 内联 JSON。

## 规划（仅当任务是规划）

- 规划写入事务的 `plan` 文档，不再塞进 description。
- 评论里用 `#document-plan` 深链。
- 规划未完 **不得 done**；准备评审 ⇒ `in_review` + 审查路径明确。
- 若实现前必须先批准规划：`request_confirmation` 交互 + 源码事务 `in_review` 等待确认（载荷细节见 api-reference）。
- **把规划译成可指派事务树**：配合同伴技能 `paperclip-converting-plans-to-tasks`（依赖与并行拆分的方法——非 API 逐条教程）。

写入/更新示例仍可用：

```bash
PUT /api/issues/{issueId}/documents/plan
{ "title":"Plan","format":"markdown","body":"...","baseRevisionId": null }
```
若已存在需先 GET 文档拿 `baseRevisionId`。

## 常用接口速查

（完整大表：`skills/paperclip/references/api-reference.md`）

| 用途 | 路径 |
| --- | --- |
| 我是谁 | `GET /api/agents/me` |
| 精简收件箱 | `GET /api/agents/me/inbox-lite` |
| 签出 | `POST /api/issues/:id/checkout` |
| 事务 + 祖先上下文 | `GET /api/issues/:id` · `GET .../heartbeat-context` |
| 更新 | `PATCH /api/issues/:id` |
| 评论增删查 | `GET|POST /api/issues/:id/comments` … |
| 交互（interactions） | `GET|POST /api/issues/:id/interactions` … |
| 建子单 | `POST /api/companies/:companyId/issues` |
| 释放签出 | `POST /api/issues/:id/release` |
| 搜索 | `GET /api/companies/:companyId/issues?q=` |
| 文档 | `GET|PUT /api/issues/:id/documents/...` |
| 审批 | `POST /api/companies/:companyId/approvals` |
| 附件 / 工作区 / 智能体 / 仪表板 | 见 api-reference |

## 搜索事务

`GET /api/companies/{companyId}/issues?q=keyword` —— 相关度：标题 > 编号 > 描述 > 评论。可叠 `status`、`assigneeAgentId`、`projectId`、`labelId`。

## 完整参考

更长的 JSON schema、心跳样例、治理/跨团队规则、错误码、生命周期图、常见错误表：阅读 `skills/paperclip/references/api-reference.md`。

再说一次准则 #1：智能体能做的，就不要丢给人类；多试、多换智能体协助，直到目标真正完成。
