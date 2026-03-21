# 智能体认证与入职

## 问题

智能体需要 API 密钥来向 Paperclip 认证。当前方法（在应用中生成密钥，手动配置为环境变量）很繁琐且不可扩展。不同的适配器类型有不同的信任模型，我们希望支持从"零配置本地"到"智能体驱动的自注册"的全谱系。

## 设计原则

1. **认证复杂度匹配信任边界。** 本地 CLI 适配器不应该需要与远程 webhook 智能体相同的仪式。
2. **智能体应该能够自行入职。** 当智能体有能力自己完成时，人类不应该需要复制粘贴凭据到智能体环境中。
3. **默认审批门。** 自注册必须要求显式批准（由用户或授权智能体）才能让新智能体在公司内行动。

---

## 认证层级

### 层级 1：本地适配器（claude-local、codex-local）

**信任模型：** 适配器进程在与 Paperclip 服务器相同的机器上运行（或由其直接调用）。没有有意义的网络边界。

**方法：** Paperclip 生成 Token 并在调用时直接作为参数/环境变量传递给智能体进程。无需手动设置。

**Token 格式：** 每次心跳调用（或每次会话）发放的短期 JWT。服务器铸造 Token，在适配器调用中传递，并在 API 请求中接受它。

**Token 生命周期考虑：**

- 编码智能体可以运行数小时，所以 Token 不能过期太快。
- 即使在本地上下文中，无限期 Token 也不理想。
- 使用具有宽限到期时间（如 48 小时）的 JWT 和重叠窗口，这样在到期附近开始的心跳仍然可以完成。
- 服务器不需要存储这些 Token——它只需验证 JWT 签名。

**状态：** 部分实现。本地适配器已经传递 `PAPERCLIP_API_URL`、`PAPERCLIP_AGENT_ID`、`PAPERCLIP_COMPANY_ID`。我们需要在注入的环境变量集中添加 `PAPERCLIP_API_KEY`（JWT）。

### 层级 2：CLI 驱动的密钥交换

**信任模型：** 开发者正在设置远程或半远程智能体，并拥有其 shell 访问权限。

**方法：** 类似于 `claude setup-token`——开发者运行 Paperclip CLI 命令，打开浏览器 URL 进行确认，然后收到一个自动存储在智能体配置中的 Token。

```
paperclip auth login
# 打开浏览器 -> 用户确认 -> Token 存储在 ~/.paperclip/credentials
```

**Token 格式：** 长期 API 密钥（服务器端存储哈希）。

**状态：** 未来。在我们拥有不由 Paperclip 服务器自身管理的远程适配器之前不需要。

### 层级 3：智能体自注册（邀请链接）

**信任模型：** 智能体是自治的外部系统（如 OpenClaw 智能体、SWE-agent 实例）。设置期间没有人在循环中。智能体收到入职 URL 并协商自己的注册。

**方法：**

1. 公司管理员（用户或智能体）从 Paperclip 生成**邀请 URL**。
2. 邀请 URL 被传递给目标智能体（通过消息、任务描述、webhook 负载等）。
3. 智能体获取该 URL，返回一个**入职文档**，包含：
   - 公司身份和上下文
   - Paperclip SKILL.md（或其链接）
   - Paperclip 需要从智能体获取的信息（如 webhook URL、适配器类型、能力、首选名称/角色）
   - 用于 POST 响应的注册端点
4. 智能体以其配置响应（如"这是我的 webhook URL，这是我的名称，这是我的能力"）。
5. Paperclip 存储待处理的注册。
6. 审批者（用户或授权智能体）审查并批准新员工。审批包括分配智能体的管理者（指挥链）和任何初始角色/权限。
7. 批准后，Paperclip 为智能体的凭据提供服务并发送第一次心跳。

**Token 格式：** Paperclip 在批准后发放 API 密钥（或 JWT），通过其声明的通信通道传递给智能体。

**灵感：**

- [Allium 自注册](https://agents.allium.so/skills/skill.md)——智能体收集凭据，轮询确认，自动存储密钥。
- [Allium x402](https://agents.allium.so/skills/x402-skill.md)——完全由智能体驱动的多步凭据设置。
- [OpenClaw webhooks](https://docs.openclaw.ai/automation/webhook)——外部系统通过认证 webhook 端点触发智能体操作。

---

## 自注册：入职协商协议

邀请 URL 响应应该是一个结构化文档（JSON 或 markdown），既可人类阅读又可机器解析：

```
GET /api/invite/{inviteToken}
```

响应：

```json
{
  "company": {
    "id": "...",
    "name": "Acme Corp"
  },
  "onboarding": {
    "instructions": "You are being invited to join Acme Corp as an employee agent...",
    "skillUrl": "https://app.paperclip.ing/skills/paperclip/SKILL.md",
    "requiredFields": {
      "name": "Your display name",
      "adapterType": "How Paperclip should send you heartbeats",
      "webhookUrl": "If adapter is webhook-based, your endpoint URL",
      "capabilities": "What you can do (free text or structured)"
    },
    "registrationEndpoint": "POST /api/invite/{inviteToken}/register"
  }
}
```

智能体回传：

```json
{
  "name": "CodingBot",
  "adapterType": "webhook",
  "webhookUrl": "https://my-agent.example.com/hooks/agent",
  "webhookAuthToken": "Bearer ...",
  "capabilities": ["code-review", "implementation", "testing"]
}
```

这将进入 `pending_approval` 状态，直到有人批准。

---

## OpenClaw 作为首个外部集成

OpenClaw 是层级 3 的理想首个目标，因为：

- 它已经有 webhook 支持（`POST /hooks/agent`）用于接收任务。
- webhook 配置（URL、认证 Token、会话密钥）正是我们需要智能体在入职期间告诉我们的。
- OpenClaw 智能体可以读取 URL、解析指令并发起 HTTP 调用。

**工作流：**

1. 为公司生成 Paperclip 邀请链接。
2. 将邀请链接发送给 OpenClaw 智能体（通过其现有的消息通道）。
3. OpenClaw 智能体获取邀请，读取入职文档，并以其 webhook 配置响应。
4. Paperclip 公司成员批准新智能体。
5. Paperclip 开始向 OpenClaw webhook 端点发送心跳。

---

## 审批模型

所有自注册都需要审批。这在安全方面不可协商。

- **默认：** 公司中的人类用户必须批准。
- **委托：** 具有 `approve_agents` 权限的管理者级别智能体可以批准（用于扩展）。
- **自动批准（选择加入）：** 公司可以为使用特定信任级别生成的邀请链接配置自动批准（如"我信任拥有此链接的任何人"）。即便如此，邀请链接本身也是保密的。

批准时，审批者设置：

- `reportsTo`——新智能体在指挥链中向谁汇报
- `role`——智能体在公司中的角色
- `budget`——初始预算分配

---

## 实现优先级

| 优先级 | 项目 | 说明 |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| **P0** | 本地适配器 JWT 注入 | 解锁零配置本地认证。每次心跳铸造 JWT，作为 `PAPERCLIP_API_KEY` 传递。 |
| **P1** | 邀请链接 + 入职端点 | `POST /api/companies/:id/invites`、`GET /api/invite/:token`、`POST /api/invite/:token/register`。 |
| **P1** | 审批流程 | 用于审查和批准待处理智能体注册的 UI + API。 |
| **P2** | OpenClaw 集成 | 首个通过邀请链接的真实外部智能体入职。 |
| **P3** | CLI 认证流程 | `paperclipai auth login` 用于开发者管理的远程智能体。 |

## P0 实现计划

参见 [`doc/plans/agent-authentication-implementation.md`](./agent-authentication-implementation.md) 获取 P0 本地 JWT 执行计划。

---

## 待解决问题

- **JWT 签名密钥轮换：** 如何在不使进行中的心跳失效的情况下轮换签名密钥？
- **邀请链接过期：** 邀请链接应该是一次性还是多次使用？有时间限制吗？
- **适配器协商：** 入职文档是否应该支持任意适配器类型，还是应该枚举支持的适配器并让智能体选择一个？
- **凭据更新：** 对于长期存在的外部智能体，如何在不停机的情况下处理 API 密钥轮换？
