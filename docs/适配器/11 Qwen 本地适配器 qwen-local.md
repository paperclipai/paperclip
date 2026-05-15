---

## title: Qwen 本地适配器
summary: Qwen Code CLI 本地适配器的搭建与配置

`qwen_local` 在本地运行 Qwen Code CLI（`@qwen-code/qwen-code`），无头传参并解析 `stream-json` / `json` 输出。实现见 `packages/adapters/qwen-local`；随服务端内置注册，也可通过适配器插件以 `file:` 加载。

## 前置条件

- 已安装 Qwen Code CLI（全局安装示例：`npm install -g @qwen-code/qwen-code`，命令默认可执行名为 `qwen`）
- 按 Qwen Code 官方文档完成 API Key / Coding Plan / 本地端点配置。Qwen Code 0.15+ 的 `qwen auth` 已移除，推荐在用户级 `~/.qwen/settings.json` 配置 `modelProviders`、`security.auth.selectedType`、`model.name` 与 `env`。

## Qwen 账号与模型配置

`qwen_local` 不直接实现账号登录；它启动本机 `qwen` CLI。实际可用账号、业务空间、接入点与模型来自 Qwen Code 自己能读到的配置：

1. **用户级配置（推荐）**：`~/.qwen/settings.json`。适合所有 Paperclip 项目共用同一个 Qwen / CodePlan 账号。
2. **项目级配置**：项目根目录下 `.qwen/settings.json`。适合某个执行工作区覆盖用户级模型或端点。
3. **Agent env 覆盖**：在 Paperclip agent 的 `adapter_config.env` 里配置 `BAILIAN_CODING_PLAN_API_KEY`、`DASHSCOPE_API_KEY` 等变量。适合让 Paperclip 子进程拿到与交互式终端不同的密钥。

Coding Plan 常见配置形态：

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3.6-plus",
        "name": "qwen3.6-plus (Coding Plan)",
        "baseUrl": "https://coding.dashscope.aliyuncs.com/v1",
        "envKey": "BAILIAN_CODING_PLAN_API_KEY"
      },
      {
        "id": "qwen3-coder-plus",
        "name": "qwen3-coder-plus (Coding Plan)",
        "baseUrl": "https://coding.dashscope.aliyuncs.com/v1",
        "envKey": "BAILIAN_CODING_PLAN_API_KEY"
      }
    ]
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "qwen3.6-plus"
  }
}
```

如果 Paperclip 中运行失败而手工终端可用，优先核对：

- Paperclip server 进程的 `HOME` / 用户目录是否仍指向同一个 `~/.qwen/settings.json`
- 执行工作区是否有 `.qwen/settings.json` 覆盖了用户级配置
- agent `adapter_config.env` 是否覆盖了 `BAILIAN_CODING_PLAN_API_KEY` 或其它 `envKey`
- `model` 是否存在于当前 Qwen Code 可见的 `modelProviders` 中
- Coding Plan 中国站是否使用 `https://coding.dashscope.aliyuncs.com/v1`，以及对应账号是否属于该业务空间

## 配置字段


| 字段                        | 类型       | 必填  | 说明                                                                        |
| ------------------------- | -------- | --- | ------------------------------------------------------------------------- |
| `cwd`                     | string   | 否   | 进程工作目录的兜底绝对路径（执行上下文里的工作区 `cwd` 优先；权限允许时可自动创建）                             |
| `instructionsFilePath`    | string   | 否   | Markdown 指令文件绝对路径；**仅新会话**时通过 `--system-prompt` 以说明性字串传入（续会话时不重复传入）       |
| `model`                   | string   | 否   | Qwen Code 配置中可见的模型 ID，默认 `qwen3.6-plus`                                   |
| `promptTemplate`          | string   | 否   | 各次运行主提示词模板                                                                |
| `bootstrapPromptTemplate` | string   | 否   | **仅新会话**首段注入的模板；续会话时为空白则跳过                                                |
| `maxSessionTurns`         | number   | 否   | `--max-session-turns`，默认 `1`                                              |
| `approvalMode`            | string   | 否   | `--approval-mode`，默认 `yolo`（亦可选 `plan`、`default`、`auto-edit` 等于 CLI 一致的值） |
| `outputFormat`            | string   | 否   | `-o` 输出格式，默认 `stream-json`；亦可为 `json`、`text` 等 CLI 支持的格式                  |
| `command`                 | string   | 否   | 可执行文件名，默认 `qwen`                                                          |
| `extraArgs`               | string[] | 否   | 附加 CLI 参数                                                                 |
| `env`                     | object   | 否   | 环境变量（支持密钥引用）                                                              |
| `timeoutSec`              | number   | 否   | 进程超时（`0` 表示不超时）                                                           |
| `graceSec`                | number   | 否   | 强制终止前的宽限期，默认 `15`                                                         |


内置 UI 模型列表只提供常用 Coding Plan 候选，**不是** Qwen Code 的真源。最终是否可调用，以当前 `qwen` 子进程能读到的 `modelProviders` 为准。

## 提示词模板

模板支持 `{{variable}}` 替换：


| 变量                 | 取值      |
| ------------------ | ------- |
| `{{agentId}}`      | 智能体 ID  |
| `{{companyId}}`    | 公司 ID   |
| `{{runId}}`        | 当前运行 ID |
| `{{agent.name}}`   | 智能体名称   |
| `{{company.name}}` | 公司名称    |


## 会话持久化

适配器在上一次成功运行后记录 `session_id`，下次唤醒时在 CLI 参数中加入 `**-c`（`--continue`）** 以接续同一会话。

会话与 `cwd` 绑定：若工作目录相对上次运行已变更，会丢弃旧会话上下文并按新目录启动（行为与 Claude / CodeBuddy 等本地适配器一致）。

## 技能注入

Paperclip 技能以符号链接形式落入 **全局** Qwen 技能目录 `~/.qwen/skills`。本类型同样要求物化运行时技能。

手动本地 CLI 与技能安装可与其它本地 CLI 适配器相同，使用：

```sh
pnpm paperclipai agent local-cli <agent-shortname> --company-id <company-id>
```

技能目标目录为 `~/.qwen/skills`（智能体须为 `qwen_local`）。

## 环境检测

在 UI 中「测试环境」会校验：

- 配置的 `command` 是否可执行（默认可执行名与 `**qwen --version**` 是否成功）
- 版本字符串是否非空（空则记为警告）

当前实现不包含对模型或 `--approval-mode` 的实时探活；完整链路可在本机用小提示词试跑验证。