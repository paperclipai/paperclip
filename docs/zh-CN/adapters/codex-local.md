---
title: Codex Local
summary: OpenAI Codex 本地适配器设置和配置
---

`codex_local` 适配器在本地运行 OpenAI 的 Codex CLI。它支持通过 `previous_response_id` 链接实现会话持久性，并通过全局 Codex 技能目录注入技能。

## 先决条件

- 已安装 Codex CLI（`codex` 命令可用）
- 在环境或智能体配置中设置了 `OPENAI_API_KEY`

## 配置字段

| 字段 | 类型 | 是否必填 | 描述 |
|-------|------|----------|-------------|
| `cwd` | string | 是 | 智能体进程的工作目录（绝对路径；如果权限允许且缺失时会自动创建） |
| `model` | string | 否 | 要使用的模型 |
| `promptTemplate` | string | 否 | 用于所有运行的提示 |
| `env` | object | 否 | 环境变量（支持安全引用） |
| `timeoutSec` | number | 否 | 进程超时（0 = 无超时） |
| `graceSec` | number | 否 | 强制终止前的宽限期 |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | 否 | 跳过安全检查（仅限开发） |

## 会话持久性

Codex 使用 `previous_response_id` 保持会话连续性。适配器在心跳之间序列化和恢复此功能，使智能体能够保持对话上下文。

## 技能注入

适配器将 Paperclip 技能符号链接到全局 Codex 技能目录（`~/.codex/skills`）中。现有的用户技能不会被覆盖。

若要在心跳运行之外进行手动本地 CLI 使用（例如，直接作为 `codexcoder` 运行），请使用：

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
```

这将安装任何缺少的技能，创建一个智能体 API 密钥，并打印 shell 输出来作为该智能体运行。

## 环境测试

环境测试会检查：

- 是否安装了 Codex CLI 并可访问
- 工作目录是否绝对且可用（如果缺失且被允许，则会自动创建）
- 身份验证信号（`OPENAI_API_KEY` 的存在）
- 实时问候探针探测（`codex exec --json -` 并提示 `Respond with hello.`）以验证 CLI 实际能否运行
