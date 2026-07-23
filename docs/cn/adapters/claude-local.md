---
title: Claude 本地
summary: Claude Code 本地适配器设置和配置
---
`claude_local` 适配器在本地运行 Anthropic 的 Claude Code CLI。它支持会话持久化、技能注入和结构化输出解析。

## 前置条件

- 安装了Claude Code CLI（`claude`命令可用）
- `ANTHROPIC_API_KEY` 在环境或智能体配置中设置

## 配置字段

|领域|类型 |必填|描述 |
|-------|------|----------|-------------|
| `cwd` |字符串|是的 |智能体进程的工作目录（绝对路径；如果权限允许，则如果缺少则自动创建）|
| `model` |字符串|没有 |要使用的 Claude 型号（例如 `claude-opus-4-6`）|
| `promptTemplate` |字符串|没有 |用于所有运行的提示 |
| `env` |对象|没有 |环境变量（支持秘密引用）|
| `timeoutSec` |数量 |没有 |进程超时（0 = 无超时）|
| `graceSec` |数量 |没有 |强制杀戮前的宽限期 |
| `maxTurnsPerRun` |数量 |没有 |每次心跳最大智能体转数|
| `dangerouslySkipPermissions` |布尔 |没有 |跳过权限提示（仅限开发）|

## 提示模板

模板支持`{{variable}}`替换：

|变量|价值|
|----------|-------|
| `{{agentId}}` |智能体 ID |
| `{{companyId}}` |公司ID |
| `{{runId}}` |当前运行 ID |
| `{{agent.name}}` |智能体人姓名 |
| `{{company.name}}` |公司名称 |

## 会话保持

适配器在心跳之间保留 Claude Code 会话 ID。下次唤醒时，它会恢复现有对话，以便智能体保留完整的上下文。

会话恢复可识别 cwd：如果自上次运行以来智能体的工作目录发生更改，则会启动新的会话。

如果恢复因未知会话错误而失败，适配器会自动使用新会话重试。

## 技能注入

适配器创建一个临时目录，其中包含指向 Paperclip 技能的符号链接，并通过 `--add-dir` 传递它。这使得技能可以被发现，而不会污染智能体的工作目录。

对于心跳运行之外的手动本地 CLI 使用（例如直接作为 `claudecoder` 运行），请使用：

```sh
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

这会在 `~/.claude/skills` 中安装 Paperclip 技能，创建智能体 API 密钥，并打印 shell 导出以作为该智能体运行。

## 环境测试

使用 UI 中的“测试环境”按钮来验证适配器配置。它检查：

- Claude CLI 已安装并可访问
- 工作目录是绝对且可用的（如果缺少且允许则自动创建）
- API 密钥/身份验证模式提示（`ANTHROPIC_API_KEY` 与订阅登录）
- 实时 hello 探针（带有提示符 `Respond with hello.` 的 `claude --print - --output-format stream-json --verbose`），用于验证 CLI 准备情况