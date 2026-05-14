---
title: Codex 本地适配器
summary: OpenAI Codex 本地适配器的搭建与配置
---

`codex_local` 适配器在本地运行 OpenAI 的 Codex CLI，通过 `previous_response_id` 链支持会话持久化，并通过全局 Codex 技能目录注入技能。

## 前置条件

- 已安装 Codex CLI（`codex` 命令可用）
- 在环境或智能体配置中设置 `OPENAI_API_KEY`

## 配置字段

| 字段 | 类型 | 必填 | 说明 |
|-------|------|----------|-------------|
| `cwd` | string | 是 | 智能体进程的工作目录（绝对路径；权限允许时可自动创建） |
| `model` | string | 否 | 使用的模型 |
| `promptTemplate` | string | 否 | 各次运行使用的提示词 |
| `env` | object | 否 | 环境变量（支持密钥引用） |
| `timeoutSec` | number | 否 | 进程超时（0 表示不超时） |
| `graceSec` | number | 否 | 强制终止前的宽限期 |
| `fastMode` | boolean | 否 | 启用 Codex Fast 模式；当前仅在 `gpt-5.4` 上支持，且会更快消耗额度 |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | 否 | 跳过安全检查（仅限开发） |

## 会话持久化

Codex 使用 `previous_response_id` 维持对话连续性。适配器会在心搏之间序列化并恢复该 ID，使智能体保持上下文。

## 技能注入

适配器将 Paperclip 技能以符号链接方式放入全局 Codex 技能目录（`~/.codex/skills`），不会覆盖用户已有技能。

## Fast 模式

启用 `fastMode` 时，Paperclip 会添加等价于下列配置的 Codex 覆盖项：

```sh
-c 'service_tier="fast"' -c 'features.fast_mode=true'
```

当前 Paperclip 仅在选择模型为 `gpt-5.4` 时应用上述覆盖；其它模型上会保留开关但执行阶段忽略，避免不支持的组合。

## 托管 `CODEX_HOME`

当 Paperclip 运行在托管的工作树实例中（`PAPERCLIP_IN_WORKTREE=true`）时，适配器改用 Paperclip 实例下与工作树隔离的 `CODEX_HOME`，避免 Codex 技能、会话、日志等状态在不同检出之间串线。该隔离目录会从用户主 Codex 主目录做种子复制，以共享鉴权/配置连续性。

## 手动本地 CLI

若要在心搏之外手动使用本地 CLI（例如直接以 `codexcoder` 运行），可使用：

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
```

该命令会安装缺失技能、创建智能体 API 密钥，并打印以该智能体身份运行所需的 shell 导出变量。

## 指令解析

若配置了 `instructionsFilePath`，Paperclip 会在每次运行读取该文件，并将其内容前置拼接到发给 `codex exec` 的标准输入提示词前。

这与 Codex 在运行 `cwd` 下自行发现的工作区级指令是分开的。Paperclip 不会关闭 Codex 原生的仓库指令文件，因此仓库内的 `AGENTS.md` 仍可能被 Codex 加载，与 Paperclip 托管的智能体指令并存。

## 环境检测

环境检测会校验：

- Codex CLI 是否已安装且可调用
- 工作目录是否为绝对路径且可用（权限允许时可自动创建）
- 鉴权信号（是否存在 `OPENAI_API_KEY`）
- 实时探活（`codex exec --json -`，提示词为 `Respond with hello.`）以确认 CLI 能实际运行
