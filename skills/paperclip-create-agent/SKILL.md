---
name: paperclip-create-agent
description: >
  在 Paperclip 中按治理流程创建或招聘新智能体。适用于检查适配器配置、
  对比现有智能体配置、起草新智能体指令/配置并提交 hire request。
---

# Paperclip Create Agent Skill

当你被要求招聘或创建 Paperclip 智能体时使用这个 skill。

## 前置条件

你需要满足其中之一：

- 拥有 board 权限
- 当前公司内的智能体权限 `can_create_agents=true`

如果没有权限，请升级给 CEO 或 board，不要绕过治理流程。

## 工作流

1. 确认身份和公司上下文。

```sh
curl -sS "$PAPERCLIP_API_URL/api/agents/me" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

2. 读取当前 Paperclip 实例可用的适配器配置说明。

```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

3. 读取目标适配器的详细配置说明，例如 `claude_local`。

```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration/claude_local.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

4. 对比公司里已有智能体的配置，优先复用已经验证过的运行方式。

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-configurations" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

5. 起草 hire request 前，先查看可复用的指令模板。

模板索引：
`skills/paperclip-create-agent/references/agent-instruction-templates.md`

具体模板目录：
`skills/paperclip-create-agent/references/agents/`

语言选择规则：

- 如果当前公司或任务使用中文，优先使用 `*.zh-CN.md` 模板。
- 如果当前公司或任务使用英文，使用默认英文模板。
- 文件名、API 路径、skill 名和代码标识保持英文；自然语言指令按目标语言编写。

6. 读取允许使用的智能体图标，并选择符合角色的图标。

```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-icons.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

7. 起草新智能体配置，至少包含：

- `name`、`role`、`title`
- `icon`，实际创建时应从 `/llms/agent-icons.txt` 中选择
- `reportsTo`
- `adapterType`
- 与环境匹配的 `adapterConfig`
- 需要开箱即用技能时填写 `desiredSkills`
- `capabilities`
- 指令内容，例如 `AGENTS.md`
- 如来自任务，填写 `sourceIssueId` 或 `sourceIssueIds`

默认不要开启定时心跳。只有角色确实需要周期性工作，或用户明确要求时，才设置 `runtimeConfig.heartbeat.enabled=true` 和 `intervalSec`。

对于本地 managed-bundle 适配器，如果没有自定义 bundle 路径，优先让服务端按 `instructionsLocale` materialize 默认角色模板。只有当你确实需要自定义内容时，才在 `adapterConfig.promptTemplate` 中放入改写后的 `AGENTS.md`。

8. 提交 hire request。

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
    "capabilities": "负责技术路线图、架构、人员配置和执行。",
    "desiredSkills": ["vercel-labs/agent-browser/agent-browser"],
    "adapterType": "codex_local",
    "adapterConfig": {"cwd": "/abs/path/to/repo", "model": "o4-mini"},
    "runtimeConfig": {"heartbeat": {"enabled": false, "wakeOnDemand": true}},
    "instructionsLocale": "zh-CN",
    "sourceIssueId": "<issue-id>"
  }'
```

9. 处理治理状态。

- 如果响应包含 `approval`，说明 hire request 处于 `pending_approval`。
- 在 approval thread 中跟进 board 评论。
- board 批准后，你可能会带着 `PAPERCLIP_APPROVAL_ID` 被唤醒；读取相关 approval 和 issue，完成评论、关闭或后续交接。

```sh
curl -sS "$PAPERCLIP_API_URL/api/approvals/<approval-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/<approval-id>/comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"body":"## CTO hire request submitted\n\n- Approval: [<approval-id>](/approvals/<approval-id>)\n- Pending agent: [<agent-ref>](/agents/<agent-url-key-or-id>)\n- Source issue: [<issue-ref>](/issues/<issue-identifier-or-id>)\n\n已按 board 反馈更新指令和适配器配置。"}'
```

如果需要手动把 approval 关联回 issue：

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/<issue-id>/approvals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"approvalId":"<approval-id>"}'
```

## 质量标准

提交 hire request 前检查：

- 角色需要技能时，确认技能已经存在于公司技能库，或先完成导入。
- 复用同类智能体中已经验证过的配置模式。
- 角色匹配模板时，从 `references/agent-instruction-templates.md` 或 `references/agents/` 起草，并替换占位符。
- 按当前公司语言选择中文或英文模板，不要在中文公司里继续提交英文默认 `AGENTS.md`。
- 使用明确的 `icon`，便于在组织图和任务视图中识别。
- 不要把 secrets 明文写入配置，除非适配器行为明确要求。
- 汇报关系必须在当前公司内且符合组织结构。
- 指令要具体、可执行、边界清晰。
- 定时心跳保持 opt-in。
- 如果 board 要求修改，更新 payload 后按 approval 流程重新提交。

更多 API payload 和示例见：
`skills/paperclip-create-agent/references/api-reference.md`

可复用 `AGENTS.md` 模板索引见：
`skills/paperclip-create-agent/references/agent-instruction-templates.md`

具体智能体模板见：
`skills/paperclip-create-agent/references/agents/`
