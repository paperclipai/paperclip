---
title: CodeBuddy 本地适配器
summary: CodeBuddy CLI 本地适配器的搭建与配置
---

`codebuddy_local` 在本地运行 CodeBuddy Code CLI（`@tencent-ai/codebuddy-code`）。实现见 `packages/adapters/codebuddy-local`；随服务端内置注册，也可通过适配器插件以 `file:` 加载。

## 前置条件

- 已安装 CodeBuddy CLI（全局安装示例：`npm install -g @tencent-ai/codebuddy-code`，命令默认可执行名为 `codebuddy`）
- 按 CodeBuddy / 所选模型提供方完成登录或密钥配置。常见计费路径：环境或 `adapterConfig.env` 中若存在可用的 `CODEBUDDY_API_KEY`、`OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`，适配器按 **API** 路径理解；否则视为依赖 **订阅** 等其它鉴权方式（以你本机 CodeBuddy 配置为准）

## 配置字段

| 字段 | 类型 | 必填 | 说明 |
|-------|------|----------|-------------|
| `cwd` | string | 否 | 进程工作目录的兜底绝对路径（执行上下文里的工作区 `cwd` 优先；权限允许时可自动创建） |
| `instructionsFilePath` | string | 否 | Markdown 指令文件的绝对路径；新会话时通过 `--system-prompt-file` 注入（续会话时不再重复传入） |
| `model` | string | 否 | CodeBuddy 模型 ID，默认 `V-glm-5.1`。UI 列表中带 `V-` / `D-` / `M-` 前缀的条目会在传给 CLI 前剥掉前缀，并加上 `custom-local:` 以走自定义模型配置 |
| `effort` | string | 否 | 传给 `--effort` 的推理档位（如 `low` \| `medium` \| `high`） |
| `promptTemplate` | string | 否 | 各次运行主提示词模板 |
| `bootstrapPromptTemplate` | string | 否 | **仅新会话**首段注入的模板；续会话时为空白则跳过 |
| `maxTurnsPerRun` | number | 否 | 单次运行最大轮次，映射 `--max-turns`；`0` 表示不传该参数 |
| `dangerouslySkipPermissions` | boolean | 否 | 为 `true`（默认）时传 `-y`，便于无头环境 |
| `outputFormat` | string | 否 | CLI `--output-format`，默认 **`stream-json`**（运行中按块写入运行日志，便于旁路观测「距上次输出」）；可改回 `json` 等 CodeBuddy 支持的格式 |
| `includePartialMessages` | boolean | 否 | 为 `true` 且 `outputFormat` 为 `stream-json` 时传 `--include-partial-messages`（更细粒度流式块，日志更大） |
| `terminalResultCleanupGraceMs` | number | 否 | 见到流式 `type:result` 后等待子进程退出的毫秒数，默认 `5000` |
| `command` | string | 否 | 可执行文件名，默认 `codebuddy` |
| `extraArgs` | string[] | 否 | 附加 CLI 参数 |
| `env` | object | 否 | 环境变量（支持密钥引用） |
| `timeoutSec` | number | 否 | 进程超时（`0` 表示不超时） |
| `graceSec` | number | 否 | 强制终止前的宽限期，默认 `15` |

## 提示词模板

以下模板支持 `{{variable}}` 替换（与 Claude/Codex 等本地适配器一致）：

| 变量 | 取值 |
|----------|-------|
| `{{agentId}}` | 智能体 ID |
| `{{companyId}}` | 公司 ID |
| `{{runId}}` | 当前运行 ID |
| `{{agent.name}}` | 智能体名称 |
| `{{company.name}}` | 公司名称 |

## 会话持久化

适配器会在心搏之间保存 CodeBuddy 返回的 `session_id`，下次运行附带 `--resume <session_id>` 接续对话。

会话与 `cwd` 绑定：若自上次运行以来解析后的工作目录变更，会丢弃旧会话并新开一轮（标准输出中会有一行 Paperclip 提示）。

## 技能注入

Paperclip 技能以符号链接形式落入 **全局** CodeBuddy 技能目录 `~/.codebuddy/skills`，不覆盖目录中其它技能。本类型在注册表中标记为需要物化运行时技能（与仓库中 `requiresMaterializedRuntimeSkills: true` 一致）。

若要在心搏以外手动拉起本地 CLI，可使用（技能会装到 `~/.codebuddy/skills`，并创建智能体 API 密钥）：

```sh
pnpm paperclipai agent local-cli <agent-shortname> --company-id <company-id>
```

（`<agent-shortname>` 需对应 `adapterType` 为 `codebuddy_local` 的智能体。）

## 环境检测

在 UI 中「测试环境」会校验：

- 配置的 `command` 是否可执行（默认可执行名与 **`codebuddy --version`** 是否成功）
- 版本字符串是否非空（空则记为警告）

当前实现**不包含**对模型的实时探活；若需验证完整链路，可本机手动执行一次小型 `--print` 任务。

## 流式日志与存活旁路（059）

- 默认 **`stream-json`**：stdout/stderr 按块经 `onLog` 落盘（带 `ts`），运行详情可显示 **已运行时长** 与 **距上次输出**。
- 原始日志模式下列出每块时间戳；不要求把 NDJSON 解析成可读助手正文。
- **运行中致命错误快停**：流式 `type:result` 且 `is_error`，或 stderr 命中认证失败 / max-turns / 配额 / OOM / 崩溃等模式时，适配器终止子进程并返回对应 `errorCode`。
- 见到 `type:result` 后按 `terminalResultCleanupGraceMs` 宽限等待进程退出（与 Cursor 类似），避免僵尸进程。
