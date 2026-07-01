---
title: Claude Local
summary: Claude Code 本地适配器设置和配置
---

`claude_local` 适配器在本地运行 Anthropic 的 Claude Code CLI。它支持会话持久性、技能注入和结构化输出解析。

## 先决条件

- 已安装 Claude Code CLI（`claude` 命令可用）
- 在环境或智能体配置中设置了 `ANTHROPIC_API_KEY`

## 配置字段

| 字段 | 类型 | 是否必填 | 描述 |
|-------|------|----------|-------------|
| `cwd` | string | 是 | 智能体进程的工作目录（绝对路径；如果权限允许且缺失时会自动创建） |
| `model` | string | 否 | 要使用的 Claude 模型（例如 `claude-opus-4-6`） |
| `promptTemplate` | string | 否 | 用于所有运行的提示 |
| `env` | object | 否 | 环境变量（支持安全引用） |
| `timeoutSec` | number | 否 | 进程超时（0 = 无超时） |
| `graceSec` | number | 否 | 强制终止前的宽限期 |
| `maxTurnsPerRun` | number | 否 | 每次心跳的最大代理轮换次数 |
| `dangerouslySkipPermissions` | boolean | 否 | 跳过权限提示（仅限开发） |

## 提示模板

模板支持 `{{variable}}` 替换：

| 变量 | 值 |
|----------|-------|
| `{{agentId}}` | 智能体 ID |
| `{{companyId}}` | 公司 ID |
| `{{runId}}` | 当前运行 ID |
| `{{agent.name}}` | 智能体名称 |
| `{{company.name}}` | 公司名称 |

## 会话持久性

适配器在心跳之间持久化 Claude Code 会话 ID。在下一次唤醒时，它会恢复现有对话，因此智能体保留完整的上下文。

会话恢复可感知 cwd：如果智能体的工作目录自上次运行后发生了更改，则会启动一个新会话。

如果恢复因未知会话错误失败，适配器会自动重试新的会话。

## 技能注入

适配器创建一个临时目录，该目录包含 Paperclip 技能的符号链接，并通过 `--add-dir` 传递它。这使得可以发现技能而不会污染智能体的工作目录。

若要在心跳运行之外进行手动本地 CLI 使用（例如，直接作为 `claudecoder` 运行），请使用：

```sh
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

这会在 `~/.claude/skills` 中安装 Paperclip 技能，创建一个智能体 API 密钥，并打印 shell 输出来作为该智能体运行。

## 环境测试

使用 UI 中的“测试环境”按钮来验证适配器配置。它会检查：

- 是否安装了 Claude CLI 并可访问
- 工作目录是否绝对且可用（如果缺失且被允许，则会自动创建）
- API 密钥/身份验证模式提示（`ANTHROPIC_API_KEY` 与订阅登录）
- 实时问候探针探测（`claude --print - --output-format stream-json --verbose` 并提示 `Respond with hello.`）以验证 CLI 的准备就绪状态
