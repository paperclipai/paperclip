---
title: Gemini 本地
summary: Gemini CLI 本地适配器设置和配置
---
`gemini_local` 适配器在本地运行 Google 的 Gemini CLI。它支持 `--resume` 会话持久性、技能注入和结构化 `stream-json` 输出解析。

## 前置条件

- Gemini CLI 已安装（`gemini` 命令可用）
- `GEMINI_API_KEY` 或 `GOOGLE_API_KEY` 设置，或配置本地 Gemini CLI 身份验证

## 配置字段

|领域 |类型 |必填 |描述 |
|-------|------|----------|-------------|
| `cwd` |字符串|是的 |智能体进程的工作目录（绝对路径；如果权限允许，则如果缺少则自动创建）|
| `model` |字符串|没有 |使用Gemini型号。默认为 `auto`。 |
| `promptTemplate` |字符串|没有 |用于所有运行的提示 |
| `instructionsFilePath` |字符串|没有 |提示前添加 Markdown 说明文件 |
| `env` |对象|没有 |环境变量（支持秘密引用）|
| `timeoutSec` |数量 |没有 |进程超时（0 = 无超时）|
| `graceSec` |数量 |没有 |强制杀戮前的宽限期 |
| `yolo` |布尔 |没有 |通过`--approval-mode yolo`进行无人值守操作 |

## 会话保持

适配器在心跳之间保留 Gemini 会话 ID。下次唤醒时，它会恢复与 `--resume` 的现有对话，以便智能体保留上下文。

会话恢复可识别 cwd：如果自上次运行以来工作目录发生更改，则会启动新的会话。

如果恢复因未知会话错误而失败，适配器会自动使用新会话重试。

## 技能注入

适配器将 Paperclip 技能符号链接到 Gemini 全局技能目录 (`~/.gemini/skills`) 中。现有的用户技能不会被覆盖。

## 环境测试

使用 UI 中的“测试环境”按钮来验证适配器配置。它检查：

- Gemini CLI 已安装并可访问
- 工作目录是绝对且可用的（如果缺少且允许则自动创建）
- API 密钥/身份验证提示（`GEMINI_API_KEY` 或 `GOOGLE_API_KEY`）
- 实时 hello 探针 (`gemini --output-format json "Respond with hello."`)，用于验证 CLI 准备情况