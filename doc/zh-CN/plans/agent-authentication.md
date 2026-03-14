# 智能体身份验证和入职

## 问题

智能体需要 API 密钥来与 Paperclip 进行身份验证。目前的方法
（在应用程序中生成密钥，手动将其配置为环境变量）是
费力且无法扩展。不同的适配器类型有不同的信任
模型，我们希望支持从“零配置本地”到
“智能体驱动的自我注册。”

## 设计原则

1. **将身份验证复杂性与信任边界相匹配。** 本地 CLI 适配器
   不应该需要与基于 Webhook 的远程智能体相同的仪式。
2. **智能体应该能够自行加入。**人类不必这样做
   当智能体能够执行以下操作时，将凭据复制粘贴到智能体环境中
   做它。
3. **默认审批门。** 自助注册必须明确要求
   批准（由用户或授权智能体人），然后新智能体人可以在
   一家公司。

---

## 身份验证层

### 第 1 层：本地适配器（claude-local、codex-local）

**信任模型：** 适配器进程与 Paperclip 在同一台机器上运行
服务器（或由它直接调用）。不存在有意义的网络边界。

**做法：** Paperclip 生成token，直接传递给智能体
在调用时作为参数/env var 进行处理。无需手动设置。

**令牌格式：** 每个心跳调用（或每个
会话）。服务器创建令牌，将其传递到适配器调用中，并且
在 API 请求上接受它。

**令牌生命周期注意事项：**

- 编码智能体可以运行数小时，因此令牌不会很快过期。
- 即使在本地环境中，无限生命的令牌也是不可取的。
- 使用 JWTs 并具有较长的到期时间（例如 48 小时）并重叠窗口，以便
  临近到期时开始的心跳仍会完成。
- 服务器不需要存储这些令牌 - 它只是验证 JWT
  签名。

**状态：** 部分实施。本地适配器已经通过
`PAPERCLIP_API_URL`、`PAPERCLIP_AGENT_ID`、`PAPERCLIP_COMPANY_ID`。我们需要
将 `PAPERCLIP_API_KEY` (JWT) 添加到注入的环境变量集中。

### 第 2 层：CLI 驱动的密钥交换

**信任模型：** 开发人员正在设置远程或半远程智能体，并且
可以通过 shell 访问它。

**做法：** 与`claude setup-token`类似——开发者运行一个Paperclip CLI
打开浏览器 URL 进行确认的命令，然后接收一个令牌
自动存储在智能体的配置中。

```
paperclip auth login
# Opens browser -> user confirms -> token stored at ~/.paperclip/credentials
```

**令牌格式：** 长期 API 密钥（在服务器端散列存储）。

**现状：** 未来。在我们拥有不需要的远程适配器之前不需要
由Paperclip服务器本身管理。

### 第 3 层：智能体自行注册（邀请链接）**信任模型：** 智能体是一个自治的外部系统（例如 OpenClaw
智能体，一个 SWE 智能体实例）。设置过程中没有人参与循环。的
智能体接收加入 URL 并协商其自己的注册。

**方法：**

1. 公司管理员（用户或智能体）从 Paperclip 生成**邀请 URL**。
2. 邀请 URL 被传递到目标智能体（通过消息、任务
   描述、Webhook 负载等）。
3. 智能体获取 URL，返回 **入职文档**
   包含：
   - 公司形象和背景
   - Paperclip SKILL.md（或其链接）
   - Paperclip 需要从智能体那里获得哪些信息（例如 webhook URL、适配器
     类型、功能、首选名称/角色）
   - 将响应发布到的注册端点
4. 智能体以其配置进行响应（例如“这是我的 webhook URL，
   这是我的名字，这是我的能力”）。
5. Paperclip 存储待注册的信息。
6. 审批人（用户或授权智能体人）审核并批准新的
   员工。批准包括指定智能体的经理（指挥链）
   以及任何初始角色/权限。
7. 批准后，Paperclip 提供智能体凭证并发送
   第一次心跳。

**Token格式：** Paperclip 审核通过后颁发API密钥（或JWT），交付
通过其声明的通信渠道发送给智能体。

**灵感：**

- [Allium自助注册](https://agents.allium.so/skills/skill.md) --
  智能体收集凭证、轮询确认、自动存储密钥。
- [Allium x402](https://agents.allium.so/skills/x402-skill.md) -- 多步骤
  凭证设置完全由智能体驱动。
- [OpenClaw webhooks](https://docs.openclaw.ai/automation/webhook) -- 外部
  系统通过经过身份验证的 Webhook 端点触发智能体操作。

---

## 自助注册：入职谈判协议

邀请 URL 响应应该是结构化文档（JSON 或 markdown），
既是人类可读的又是机器可解析的：

```
GET /api/invite/{inviteToken}
```

回应：

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

智能体发回：

```json
{
  "name": "CodingBot",
  "adapterType": "webhook",
  "webhookUrl": "https://my-agent.example.com/hooks/agent",
  "webhookAuthToken": "Bearer ...",
  "capabilities": ["code-review", "implementation", "testing"]
}
```

这将进入 `pending_approval` 状态，直到有人批准为止。

---

## OpenClaw 作为第一个外部集成

OpenClaw 是第 3 层的理想第一个目标，因为：

- 它已经具有用于接收任务的 webhook 支持 (`POST /hooks/agent`)。
- webhook 配置（URL、身份验证令牌、会话密钥）正是我们所需要的
  智能体在入职期间告诉我们。
- OpenClaw 智能体可以读取 URL、解析指令并进行 HTTP 调用。

**工作流程：**1. 生成公司的Paperclip邀请链接。
2. 将邀请链接发送给 OpenClaw 智能体（通过他们现有的消息传递
   频道）。
3. OpenClaw 智能体获取邀请，读取入职文档，然后
   使用其 webhook 配置进行响应。
4. Paperclip 公司会员批准新智能体。
5. Paperclip 开始向 OpenClaw Webhook 端点发送心跳。

---

## 审批模型

所有自助注册都需要批准。这对于安全来说是不容妥协的。

- **默认值：** 公司中的人类用户必须批准。
- **委托：** 具有`approve_agents`权限的经理级智能体可以
  批准（对于扩展很有用）。
- **自动批准（选择加入）：** 公司可以为邀请配置自动批准
  以特定信任级别生成的链接（例如“我信任任何人
  通过此链接”）。即便如此，邀请链接本身也是一个秘密。

批准后，批准者设置：

- `reportsTo` -- 新特工在指挥系统中向谁报告
- `role` -- 智能体人在公司内的角色
- `budget` -- 初始预算分配

---

## 实施重点

|优先|项目 |笔记|
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| **P0** |本地适配器JWT注入|解锁零配置本地身份验证。每个心跳铸造一个JWT，传递为`PAPERCLIP_API_KEY`。          |
| **P1** |邀请链接 + 加入端点 | `POST /api/companies/:id/invites`、`GET /api/invite/:token`、`POST /api/invite/:token/register`。 |
| **P1** |审批流程| UI + API 用于审核和批准待处理的智能体注册。                                |
| **P2** | OpenClaw 集成 |第一个真正的外部智能体通过邀请链接加入。                                            |
| **P3** | CLI 认证流程 | `paperclipai auth login` 用于开发人员管理的远程智能体。                                      |

## P0实施计划

P0本地JWT执行计划参见[`doc/plans/agent-authentication-implementation.md`](agent-authentication-implementation.md)。

---

## 开放问题

- **JWT 签名密钥轮换：** 我们如何在不使用签名密钥的情况下轮换签名密钥
  使飞行中的心跳无效？
- **邀请链接到期：** 邀请链接应该是一次性使用还是多次使用？有时间限制吗？
- **适配器协商：** 入门文档是否支持任意适配器
  类型，或者我们应该枚举支持的适配器并让智能体选择一个？
- **凭证续订：** 对于长期存在的外部智能体，我们如何处理 API
  钥匙轮换无需停机？