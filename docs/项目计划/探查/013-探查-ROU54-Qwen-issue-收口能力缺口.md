# 探查报告：Qwen 无法正式收口 issue 的 API 能力缺口

> 对应 issue：ROU-54
> 日期：2026-05-16
> 性质：只读探查，不修改代码、数据库、issue 状态

---

## 1. 复现路径 / 背景

ROU-49 连续 4 次 run 均为 `succeeded`。最后一次 corrective handoff 中，Qwen 在评论里写了"最终处置: done"，但 ROU-49 仍未被 Paperclip 正式置为 done，随后系统创建 ROU-53 recovery 并阻塞 ROU-49。

核心问题：**Qwen agent 只写了评论说"done"，但没有真正调用 API 把 issue 状态改为 done**。

---

## 2. Qwen heartbeat 环境中的 Paperclip API 凭据

### 2.1 环境变量来源

Qwen 适配器（`packages/adapters/qwen-local/src/server/execute.ts`）在启动 Qwen CLI 子进程时，通过 `buildPaperclipEnv()` + `applyPaperclipWorkspaceEnv()` 注入以下环境变量：

| 变量 | 来源 | 说明 |
|------|------|------|
| `PAPERCLIP_AGENT_ID` | `buildPaperclipEnv()` | agent UUID |
| `PAPERCLIP_COMPANY_ID` | `buildPaperclipEnv()` | 公司 UUID |
| `PAPERCLIP_API_URL` | `buildPaperclipEnv()` | 默认 `http://localhost:3100`（可被 `PAPERCLIP_RUNTIME_API_URL` / `PAPERCLIP_API_URL` 覆盖） |
| `PAPERCLIP_API_KEY` | `execute.ts` §210-215 | **来自 `authToken`（即 `context.paperclipWake.authToken`）或 `adapter_config.env` 中显式配置的 `PAPERCLIP_API_KEY`** |
| `PAPERCLIP_RUN_ID` | `execute.ts` §192 | 当前 run UUID |
| `PAPERCLIP_TASK_ID` | wake context | 唤醒时传入 |
| `PAPERCLIP_WAKE_PAYLOAD_JSON` | wake context | 结构化唤醒负载 |

**结论**：Qwen 子进程**确实拿到了 `PAPERCLIP_API_URL` 和 `PAPERCLIP_API_KEY`**，具备调用 Paperclip REST API 的凭据。

### 2.2 API 凭据类型

- `PAPERCLIP_API_KEY` 是 **agent API key**（经过哈希存储在 `agent_api_keys` 表），不是 JWT/Bearer 会话 token
- 该 key 的权限范围：**只能访问该 agent 所属公司的数据，且只能执行 agent 级别的操作**（不能执行 board user 操作）

---

## 3. Qwen 是否能访问 Paperclip API

### 3.1 REST API 可访问性

**能**。Qwen 子进程通过 `PAPERCLIP_API_URL` + `PAPERCLIP_API_KEY` 可以直接调用 Paperclip REST API。

关键端点（agent 可访问的）：

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/issues/:id` | `PATCH` | **修改 issue（含 status 字段）** |
| `/api/issues/:id/comments` | `POST` | 添加评论 |
| `/api/issues/:id/checkout` | `POST` | 签出 issue |
| `/api/issues/:id/release` | `POST` | 释放 issue |

### 3.2 MCP 工具可访问性

**不确定 / 大概率不能**。

- Paperclip 有独立的 MCP server 包（`packages/mcp-server`），提供了 `paperclipUpdateIssue` 等工具
- **但 Qwen 适配器代码中没有配置 MCP server 连接**——它只启动 Qwen CLI 子进程，传入 prompt 和环境变量
- Qwen Code CLI 本身支持 MCP（通过 `~/.qwen/settings.json` 的 `mcpServers` 字段），但需要**显式配置**
- **如果用户的 `~/.qwen/settings.json` 没有配置 Paperclip MCP server，Qwen agent 就无法通过 MCP 协议调用工具**

---

## 4. 当前 agent prompt / skill / MCP 工具是否教了如何修改 issue 状态

### 4.1 默认 prompt 模板

`DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE`（`packages/adapter-utils/src/server-utils.ts` 第 149 行）内容：

```
You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.

Execution contract:
- Start actionable work in this heartbeat; do not stop at a plan unless the issue asks for planning.
- Leave durable progress in comments, documents, or work products, then update the issue to a clear final disposition before ending the heartbeat.
- ...
- To ask for that input, create an interaction on the current issue with POST /api/issues/{issueId}/interactions using kind suggest_tasks, ask_user_questions, or request_confirmation.
- When you intentionally restart follow-up work on a completed assigned issue, include structured `resume: true` with the POST /api/issues/{issueId}/comments or PATCH /api/issues/{issueId} comment payload.
```

**关键发现**：
- ✅ prompt 中**提到了 `PATCH /api/issues/{issueId}`**（在 resume 场景）
- ✅ prompt 中**提到了 "update the issue to a clear final disposition"**
- ❌ 但**没有明确教**如何调用 `PATCH /api/issues/{id}` 来设置 `status: "done"`
- ❌ 没有给出 status 字段的有效枚举值（done / in_review / blocked / cancelled / todo）
- ❌ 没有给出 request body 的 schema（`{ "status": "done", "comment": "..." }`）

### 4.2 Skill 注入

Qwen 适配器支持技能注入（`requiresMaterializedRuntimeSkills: true`），技能会落入 `~/.qwen/skills`。

但根据探查，**没有专门的 "paperclip-heartbeat-done" 或 "issue-disposition" 技能**教 agent 如何正式收口 issue。

### 4.3 MCP 工具

如果 MCP server 已配置，Qwen 可以调用：
- `paperclipUpdateIssue`：`{ issueId, status?, comment?, ... }`
- `paperclipAddComment`：`{ issueId, body, ... }`

但如 §3.2 所述，**MCP 连接大概率未配置**。

---

## 5. 修改 issue 状态需要调用哪个正式 API 或工具

### 5.1 REST API 方式

**端点**：`PATCH /api/issues/:id`

**Request body schema**（来自 `packages/shared/src/validators/issue.ts`）：

```typescript
updateIssueSchema = createIssueBaseSchema.partial().extend({
  requestDepth: issueRequestDepthInputSchema.optional(),
  assigneeAgentId: z.string().trim().min(1).optional().nullable(),
  comment: multilineTextSchema.pipe(z.string().min(1)).optional(),
  reviewRequest: issueReviewRequestSchema.optional().nullable(),
  reopen: z.boolean().optional(),
  resume: z.boolean().optional(),
  interrupt: z.boolean().optional(),
  hiddenAt: z.string().datetime().nullable().optional(),
});
```

其中 `createIssueBaseSchema` 包含 `status` 字段，有效值为：
```
"todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled"
```

**最小请求体**：
```json
{
  "status": "done",
  "comment": "工作完成的原因说明"
}
```

**认证**：`Authorization: Bearer {PAPERCLIP_API_KEY}`

### 5.2 MCP 工具方式

工具名：`paperclipUpdateIssue`
参数：
```json
{
  "issueId": "uuid-string",
  "status": "done",
  "comment": "工作完成的原因说明"
}
```

---

## 6. 根因判断：Qwen 没有正式收口的原因属于哪一类

根据以上探查，**属于以下类别的组合**：

### 主因：**有 API 但 prompt 未教**

- Qwen 有 `PAPERCLIP_API_KEY` 和 `PAPERCLIP_API_URL`
- Qwen 可以用 HTTP 客户端调用 `PATCH /api/issues/{id}`
- 但默认 prompt 只说 "update the issue to a clear final disposition"，**没有教具体怎么调 API、传什么字段、status 有哪些有效值**
- Qwen 模型只能凭自己的理解，选择写评论说"done"（因为它知道评论是安全的，但不确定 API 调用的正确格式）

### 次因：**有 API 但 MCP 未配置**

- 如果配置了 MCP server，Qwen 可以直接调用 `paperclipUpdateIssue` 工具（有 schema、有描述）
- 但目前 Qwen 适配器没有自动配置 MCP 连接，取决于用户 `~/.qwen/settings.json` 中是否有 mcpServers 配置

### 非因（排除项）：

- ❌ **不是**"没有工具能力"——Qwen CLI 可以发 HTTP 请求
- ❌ **不是**"权限不足"——agent API key 有权修改自己负责的 issue
- ❌ **不是**"缺少 issue id 上下文"——wake payload 中包含了 issue id
- ❌ **不是**"适配器未暴露"——REST API 始终可用，MCP 工具也可用（需配置）
- ❌ **不是**"模型只写评论没有执行动作"——如果 prompt 教了，模型会执行动作（其他适配器如 Claude/Codex 能做到）

---

## 7. ROU-49 的 corrective handoff 指令是否足够

**不够**。

Corrective handoff 可能告诉 Qwen "这个 issue 应该标记为 done"，但：
1. 没有教 Qwen 如何调 API 改状态
2. 没有告诉 Qwen 具体的 issue ID 和 request body 格式
3. Qwen 只能选择写评论表达意图，而不是执行 API 调用

---

## 8. 最小修复建议

### 方案 A（最小改动）：**更新默认 prompt 模板**

修改 `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE`，增加：

```
Final disposition: when work is complete, you MUST call PATCH /api/issues/{issueId} with:
{
  "status": "done" | "in_review" | "blocked" | "cancelled",
  "comment": "brief explanation of why"
}
Valid status values: todo, in_progress, in_review, done, blocked, cancelled.
Do NOT just write a comment saying "done" — you must actually update the issue status via the API.
```

**优点**：一行代码改动，所有 agent 立即生效
**缺点**：依赖模型自己构造 HTTP 请求（某些模型可能不会用 curl/fetch）

### 方案 B（更可靠）：**配置 MCP server 连接**

在 Qwen 适配器的 env 注入逻辑中，自动为 Qwen 子进程配置 MCP server 连接（例如通过 `~/.qwen/settings.json` 或 CLI 参数）。

**优点**：MCP 工具有 schema、有描述，模型更容易正确使用
**缺点**：需要 Qwen CLI 支持 MCP server 配置，且需要额外启动 MCP server 进程

### 方案 C（最彻底）：**创建专用技能**

创建 `paperclip-issue-disposition` 技能，专门教 agent 如何收口 issue。

**优点**：可以按需挂载，不污染全局 prompt
**缺点**：需要技能管理和 agent 配置更新

### 推荐：**方案 A + 方案 C**

- 短期：方案 A（改 prompt），立竿见影
- 中期：方案 C（专用技能），更可控

---

## 9. 需要人类确认的问题

1. **你的 `~/.qwen/settings.json` 是否配置了 Paperclip MCP server？**
   - 如果已配置，Qwen 应该能通过 MCP 调用 `paperclipUpdateIssue`
   - 如果未配置，Qwen 只能靠 prompt 中的 API 指令

2. **你是否希望统一所有 agent（不只是 Qwen）的 issue 收口行为？**
   - 如果是，应该改 `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE`（影响所有 agent）
   - 如果只想改 Qwen，可以在 Qwen 适配器的 `promptTemplate` 配置中覆盖

3. **ROU-49 是否需要人类手动收口？**
   - 当前 ROU-49 仍为 `in_progress`，需要有人（或 agent）调用 `PATCH /api/issues/ROU-49-id` 设置 `status: "done"`

---

## 10. 相关文件 / API / skill 路径

| 类型 | 路径 | 说明 |
|------|------|------|
| Qwen 适配器 execute | `packages/adapters/qwen-local/src/server/execute.ts` | 环境变量注入、prompt 构建 |
| 默认 prompt 模板 | `packages/adapter-utils/src/server-utils.ts` §149 | `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE` |
| updateIssue schema | `packages/shared/src/validators/issue.ts` §268 | `updateIssueSchema` |
| API 路由实现 | `server/src/routes/issues.ts` §2550 | `router.patch("/issues/:id", ...)` |
| MCP 工具定义 | `packages/mcp-server/src/tools.ts` §452 | `paperclipUpdateIssue` |
| MCP server 入口 | `packages/mcp-server/src/index.ts` | `createPaperclipMcpServer()` |
| Qwen 适配器文档 | `docs/适配器/11 Qwen 本地适配器 qwen-local.md` | 配置说明 |

---

## 11. 结论

**Qwen 无法正式收口 issue 的根本原因是：prompt 没有教 agent 如何调用 API 修改 issue 状态。**

Qwen 有 API 凭据、有网络访问能力、有权限修改自己负责的 issue，但它不知道：
1. 应该调哪个端点（`PATCH /api/issues/{id}`）
2. 应该传什么字段（`{ "status": "done", "comment": "..." }`）
3. status 有哪些有效值

因此 Qwen 只能选择写评论说"done"，而没有执行真正的 API 调用。

**最小修复方案**：更新 `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE`，明确教 agent 如何调用 API 设置 issue status。
