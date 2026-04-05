---
title: Codex 本地
summary: OpenAI Codex 本地适配器设置和配置
---
`codex_local` 适配器在本地运行 OpenAI 的 Codex CLI。它通过 `previous_response_id` 链接支持会话持久性，并通过全局 Codex 技能目录支持技能注入。

## 前置条件

- Codex CLI 安装（`codex` 命令可用）
- `OPENAI_API_KEY` 在环境或智能体配置中设置

## 配置字段

|领域 |类型 |必填 |描述 |
|-------|------|----------|-------------|
| `cwd` |字符串|是的 |智能体进程的工作目录（绝对路径；如果权限允许，则如果缺少则自动创建）|
| `model` |字符串|没有 |使用型号|
| `promptTemplate` |字符串|没有 |用于所有运行的提示 |
| `env` |对象|没有 |环境变量（支持秘密引用）|
| `timeoutSec` |数量 |没有 |进程超时（0 = 无超时）|
| `graceSec` |数量 |没有 |强制杀戮前的宽限期 |
| `dangerouslyBypassApprovalsAndSandbox` |布尔 |没有 |跳过安全检查（仅限开发）|

## 会话保持

Codex 使用 `previous_response_id` 来实现会话连续性。适配器通过心跳序列化并恢复此信息，从而允许智能体维护对话上下文。

## 技能注入

适配器将 Paperclip 技能符号链接到全局 Codex 技能目录 (`~/.codex/skills`) 中。现有的用户技能不会被覆盖。

对于心跳运行之外的手动本地 CLI 使用（例如直接作为 `codexcoder` 运行），请使用：

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
```

这将安装所有缺少的技能，创建智能体 API 密钥，并打印 shell 导出以作为该智能体运行。

## 环境测试

环境测试检查：

- Codex CLI 已安装并可访问
- 工作目录是绝对且可用的（如果缺少且允许则自动创建）
- 认证信号（`OPENAI_API_KEY`存在）
- 实时 hello 探针（带有提示符 `Respond with hello.` 的 `codex exec --json -`），用于验证 CLI 是否可以实际运行