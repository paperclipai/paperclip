---
title: Claude 本地适配器
summary: Claude Code 本地适配器的搭建与配置
---

`claude_local` 适配器在本地运行 Anthropic 的 Claude Code CLI，支持会话持久化、技能注入与结构化输出解析。

## 前置条件

- 已安装 Claude Code CLI（`claude` 命令可用）
- 在环境或智能体配置中设置 `ANTHROPIC_API_KEY`

## 配置字段

| 字段 | 类型 | 必填 | 说明 |
|-------|------|----------|-------------|
| `cwd` | string | 是 | 智能体进程的工作目录（绝对路径；权限允许时可自动创建） |
| `model` | string | 否 | 使用的 Claude 模型（例如 `claude-opus-4-6`） |
| `promptTemplate` | string | 否 | 各次运行使用的提示词 |
| `env` | object | 否 | 环境变量（支持密钥引用） |
| `timeoutSec` | number | 否 | 进程超时（0 表示不超时） |
| `graceSec` | number | 否 | 强制终止前的宽限期 |
| `maxTurnsPerRun` | number | 否 | 每次心搏内最大智能体轮次（默认 `300`） |
| `dangerouslySkipPermissions` | boolean | 否 | 跳过权限确认（默认 `true`）；无头运行无法交互审批时必须开启 |

## 提示词模板

模板支持 `{{variable}}` 替换：

| 变量 | 取值 |
|----------|-------|
| `{{agentId}}` | 智能体 ID |
| `{{companyId}}` | 公司 ID |
| `{{runId}}` | 当前运行 ID |
| `{{agent.name}}` | 智能体名称 |
| `{{company.name}}` | 公司名称 |

## 会话持久化

适配器会在心搏之间持久化 Claude Code 的会话 ID，下次唤醒时接续对话，智能体保留完整上下文。

会话恢复与 `cwd` 绑定：若自上次运行以来工作目录变更，会启动新会话而非续接。

若因未知会话错误导致恢复失败，适配器会自动用全新会话重试。

## 技能注入

适配器会创建临时目录，将 Paperclip 技能以符号链接形式放入，并通过 `--add-dir` 传入。这样技能可被 CLI 发现，又不会污染智能体工作目录。

若要在心搏之外手动使用本地 CLI（例如直接以 `claudecoder` 运行），可使用：

```sh
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

该命令会把 Paperclip 技能安装到 `~/.claude/skills`、创建智能体 API 密钥，并打印以该智能体身份运行所需的 shell 导出变量。

## 环境检测

在 UI 中使用「测试环境」可校验适配器配置，会检查：

- Claude CLI 是否已安装且可调用
- 工作目录是否为绝对路径且可用（权限允许时可自动创建）
- API 密钥/鉴权方式提示（`ANTHROPIC_API_KEY` 与订阅登录等）
- 实时探活（`claude --print - --output-format stream-json --verbose`，提示词为 `Respond with hello.`）以确认 CLI 就绪
