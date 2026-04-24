# 智能体指令模板索引

招聘或创建智能体时先看这里。角色接近已有模板时，从模板起步，再按公司、汇报关系、适配器、工作区、权限和任务类型改写。

这些模板与核心 Paperclip heartbeat skill 分离，目的是让唤醒流程保持简短，同时让 `AGENTS.md` 有稳定起点。

## 语言选择

- 中文公司、中文 UI、中文任务：优先使用 `*.zh-CN.md`。
- 英文公司或英文任务：使用默认英文模板。
- 文件名、API 路径、skill 名、代码标识保持英文。
- 如果使用 managed-bundle 本地适配器，且不需要自定义内容，优先通过 `instructionsLocale` 让服务端写入角色默认模板。
- 如果需要自定义 `AGENTS.md`，可以把改写后的模板放入 `adapterConfig.promptTemplate`，Paperclip 会 materialize 到 managed bundle。

## 模板索引

| 角色 | 中文模板 | 英文模板 | 典型 `role` | 常用适配器 |
|---|---|---|---|---|
| CTO | [`CTO 中文`](agents/cto.zh-CN.md) | [`CTO`](agents/cto.md) | `cto` | `codex_local`, `claude_local`, `cursor` |
| CMO | [`CMO 中文`](agents/cmo.zh-CN.md) | [`CMO`](agents/cmo.md) | `cmo` | `claude_local`, `codex_local` |
| Coder | [`Coder 中文`](agents/coder.zh-CN.md) | [`Coder`](agents/coder.md) | `engineer` | `codex_local`, `claude_local`, `cursor` |
| QA | [`QA 中文`](agents/qa.zh-CN.md) | [`QA`](agents/qa.md) | `qa` | `claude_local` 或具备浏览器能力的适配器 |
| UX Designer | [`UX Designer 中文`](agents/uxdesigner.zh-CN.md) | [`UX Designer`](agents/uxdesigner.md) | `designer` | `codex_local`, `claude_local` |

## 使用步骤

1. 打开最匹配的 `references/agents/*.md`。
2. 按当前语言选择中文或英文版本。
3. 替换 `{{companyName}}`、`{{agentName}}`、`{{managerTitle}}`、`{{issuePrefix}}` 等占位符。
4. 删除目标适配器无法使用的工具或流程。
5. 保留 Paperclip 心跳要求、任务评论要求、阻塞升级要求和公司边界。
6. 只有目标公司确实安装了相关 skill 或引用文件时，才把它们写进指令。
