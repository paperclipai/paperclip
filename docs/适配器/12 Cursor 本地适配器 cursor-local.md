---
title: Cursor 本地适配器
summary: Cursor Agent CLI 本地适配器的搭建与配置
---

`cursor` 在本地（或配置的执行目标环境内）运行 **Cursor Agent CLI**，通过 `stream-json` 解析运行记录，并支持 `--resume` 会话续接。实现位于 `packages/adapters/cursor-local`。

## 前置条件

- 已安装 **Cursor Agent CLI**（默认可执行名为 `agent`；安装步骤以 Cursor 官方文档为准）
- 完成 **`agent login`** 或配置可用的 **`CURSOR_API_KEY`**（以及 CLI 版本要求的其它变量）

## 配置字段

| 字段 | 类型 | 必填 | 说明 |
|-------|------|----------|-------------|
| `cwd` | string | 否 | 工作目录兜底绝对路径（执行上下文优先；权限允许时可自动创建） |
| `instructionsFilePath` | string | 否 | Markdown 指令文件绝对路径；运行前读入并前置拼入提示词 |
| `promptTemplate` | string | 否 | 各次运行主提示词模板 |
| `bootstrapPromptTemplate` | string | 否 | **仅新会话**首段模板；续会话时为空白则跳过 |
| `model` | string | 否 | 模型 ID，默认 `auto`（如 `gpt-5.3-codex` 等） |
| `mode` | string | 否 | 传入 `--mode`：`plan` 或 `ask`；不设则为常规自主运行 |
| `command` | string | 否 | 可执行名，默认 `agent` |
| `extraArgs` | string[] | 否 | 附加 CLI 参数；若已含 `--trust` / `--yolo` / `-f` 之一则适配器不再自动加 `--yolo` |
| `maxTurnsPerRun` | number | 否 | 单次运行工具调用轮次上限；`0`（默认）表示不限制 |
| `env` | object | 否 | 环境变量（支持密钥引用） |
| `timeoutSec` | number | 否 | 进程超时（`0` 表示不超时） |
| `graceSec` | number | 否 | SIGTERM 后的宽限期 |

## 提示词模板

支持 `{{variable}}` 替换：

| 变量 | 取值 |
|----------|-------|
| `{{agentId}}` | 智能体 ID |
| `{{companyId}}` | 公司 ID |
| `{{runId}}` | 当前运行 ID |
| `{{agent.name}}` | 智能体名称 |
| `{{company.name}}` | 公司名称 |

## 会话持久化

心搏之间保存会话 ID，下次运行携带 **`--resume`**。远程执行目标上还会校验会话身份与工作目录是否仍匹配；不匹配时自动新开会话并可在日志中看到 Paperclip 提示。

## 技能注入

Paperclip 技能以链接形式落入 **`~/.cursor/skills`**（可通过 `adapterConfig.env.HOME` 影响解析用的主目录）。本类型要求物化运行时技能。

手动拉起 CLI 并同步技能时：

```sh
pnpm paperclipai agent local-cli <agent-shortname> --company-id <company-id>
```

（智能体须为 `cursor`。）

## 计费与鉴权提示

环境或 `adapterConfig.env` 中存在 **`CURSOR_API_KEY`** 或 **`OPENAI_API_KEY`** 时，按 **API** 路径理解用量；否则按 **Cursor 订阅** 等 CLI 侧鉴权理解（以本机 `agent` 实际行为为准）。

## 环境检测

「测试环境」会按当前配置探测 **可执行命令**、工作目录、并结合一次轻量 **`agent -p`** 类探活（具体以适配器 `testEnvironment` 实现为准）；可提示未登录或缺少密钥等情况。
