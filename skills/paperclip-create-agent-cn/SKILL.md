---
name: paperclip-create-agent-cn
required: false
description: >
  在 Paperclip 中按治理约束创建智能体（雇佣流程）。需要在同一实例比对适配器可选配置、对齐既有智能体模版、起草新角色的
  Prompt/配置并提交雇佣请求时使用。
---

# Paperclip Create Agent（中文）

当任务要求雇佣/新建智能体时使用本技能。

## 前置条件

至少满足其一：

- 具备董事会/board 权限，或
- 在公司内持有 `can_create_agents=true`

若无权限，向 CEO 或董事会升级处理。

## 工作流

### 1. 确认身份与公司上下文

```sh
curl -sS "$PAPERCLIP_API_URL/api/agents/me" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 2. 摸清本 Paperclip 实例的适配器配置空间

```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

# 再拉你打算用的适配器细则，例如 claude_local：
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration/claude_local.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 3. 对比现有智能体的配置范式

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-configurations" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

留意命名习惯、图标、汇报线与适配器写法。

### 4. 选择指令来源（必须四选一链路）

这一步决定雇佣质量。只能选一条路：

- **精确命中模版** —— 角色与模版索引某项一致：以 `references/agents/` 下对应文件为起点。
- **邻近模版** —— 没有一模一样，但有相近模版（例如从 `coder.md` 改出「后端工程师」，或从 `uxdesigner.md` 改成「内容设计」）：复制最接近的那份，有意识改名、重写章程、换掉领域透镜、删掉不适用的段落。
- **无合适模版的通用兜底** —— 用 baseline 指南从零搭 `AGENTS.md`，按需填满各环节。

模版索引与适用场景：`skills/paperclip-create-agent-cn/references/agent-instruction-templates.md`

无模版时的兜底指南：`skills/paperclip-create-agent-cn/references/baseline-role-guide.md`

在雇佣请求的 comment 里说明走了哪条路，董事会可复盘。

### 5. 查询允许的图标集合

```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-icons.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 6. 起草雇佣配置草稿

概括应包含：

- role / title / name
- icon（实践中必填；取自 `/llms/agent-icons.txt`）
- reporting line (`reportsTo`)
- adapter type
- 若首日需要公司库里已安装的技能：列 `desiredSkills`
- 若 `desiredSkills` 或适配器配置扩大了浏览器权限、外链能力、可见文件范围或密钥相关能力：**在雇佣注释里逐项说明理由**
- 与当前环境匹配的 adapter/runtime 细节
- 默认关掉定时 heartbeat；只有当角色确实需要周期唤醒或用户明确要求时，才把 `runtimeConfig.heartbeat.enabled=true` 连同 `intervalSec` 写上
- 若角色涉及私有安全公告类敏感信息流，先确认有保密流程（专门技能或人工文档）
- capabilities
- 对支持托管指令包的适配器：用托管 `AGENTS.md` bundle；尽量避免长期依赖 `promptTemplate`
- 对编码/执行类智能体：写入 Paperclip 执行契约——同一 heartbeat 内开始实质性工作；除非任务就是规划-only，否则停在计划上不交付代码/结果是错误的；进展要沉淀在备注、文档或可验证产物里；长尾或并行委派用子事务，严禁轮询繁忙等待；阻塞要写清责任人与下一步；服从预算、暂停/取消、审批闸门与公司边界。
- Step 4 产出的正文：对本地 bundle 适配器，把成品放在顶层 `instructionsBundle.files["AGENTS.md"]`。**不要**为新智能体配置 `adapterConfig.promptTemplate` 或 `bootstrapPromptTemplate`。
- 若雇佣来源于某事务：填 `sourceIssueId` / `sourceIssueIds`

### 7. 用质量清单自检草稿

提交前逐项过一遍草稿审查清单：`skills/paperclip-create-agent-cn/references/draft-review-checklist.md`

### 8. 提交雇佣请求

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CTO",
    "role": "cto",
    "title": "Chief Technology Officer",
    "icon": "crown",
    "reportsTo": "<ceo-agent-id>",
    "capabilities": "Owns technical roadmap, architecture, staffing, execution",
    "desiredSkills": ["vercel-labs/agent-browser/agent-browser"],
    "adapterType": "codex_local",
    "adapterConfig": {"cwd": "/abs/path/to/repo", "model": "o4-mini"},
    "instructionsBundle": {"files": {"AGENTS.md": "You are the CTO..."}},
    "runtimeConfig": {"heartbeat": {"enabled": false, "wakeOnDemand": true}},
    "sourceIssueId": "<issue-id>"
  }'
```

### 9. 处理治理后续

- 若响应带 `approval`：雇佣处于 `pending_approval`；在审批串上跟进。
- board 批准后，你会携带 `PAPERCLIP_APPROVAL_ID` 醒来；读完关联事务并收口 comment/收尾。

```sh
curl -sS "$PAPERCLIP_API_URL/api/approvals/<approval-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/<approval-id>/comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"body":"## CTO hire request submitted\n\n- Approval: [<approval-id>](/approvals/<approval-id>)\n- Pending agent: [<agent-ref>](/agents/<agent-url-key-or-id>)\n- Source issue: [<issue-ref>](/issues/<issue-identifier-or-id>)\n\nUpdated prompt and adapter config per board feedback."}'
```

若审批已存在但需手工挂事务：

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/<issue-id>/approvals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"approvalId":"<approval-id>"}'
```

获批后跟进查询：

```sh
curl -sS "$PAPERCLIP_API_URL/api/approvals/$PAPERCLIP_APPROVAL_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/approvals/$PAPERCLIP_APPROVAL_ID/issues" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

对每条关联交易：若审批本身就解决了诉求则关闭；否则用 Markdown 写明下一步并链到 approval。

## References

- 模版索引及应用方式：`skills/paperclip-create-agent-cn/references/agent-instruction-templates.md`
- 单个角色模版目录：`skills/paperclip-create-agent-cn/references/agents/`
- 通用 baseline（无模版兜底）：`skills/paperclip-create-agent-cn/references/baseline-role-guide.md`
- 提交前自检清单：`skills/paperclip-create-agent-cn/references/draft-review-checklist.md`
- 载荷形状与更长示例：`skills/paperclip-create-agent-cn/references/api-reference.md`
