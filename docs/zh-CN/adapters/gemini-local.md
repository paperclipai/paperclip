---
title: Gemini Local
summary: Gemini CLI 本地适配器设置和配置
---

`gemini_local` 适配器在本地运行 Google 的 Gemini CLI。它支持通过 `--resume` 实现会话持久性、技能注入和结构化 `stream-json` 输出解析。

## 先决条件

- 已安装 Gemini CLI（`gemini` 命令可用）
- 设置了 `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`，或配置了本地 Gemini CLI 身份验证

## 配置字段

| 字段 | 类型 | 是否必填 | 描述 |
|-------|------|----------|-------------|
| `cwd` | string | 是 | 智能体进程的工作目录（绝对路径；如果权限允许且缺失时会自动创建） |
| `model` | string | 否 | 要使用的 Gemini 模型。默认为 `auto`。 |
| `promptTemplate` | string | 否 | 用于所有运行的提示 |
| `instructionsFilePath` | string | 否 | 附加在提示前面的 Markdown 说明文件 |
| `env` | object | 否 | 环境变量（支持安全引用） |
| `timeoutSec` | number | 否 | 进程超时（0 = 无超时） |
| `graceSec` | number | 否 | 强制终止前的宽限期 |
| `yolo` | boolean | 否 | 传递 `--approval-mode yolo` 以进行无人值守操作 |

## 会话持久性

适配器在心跳之间持久化 Gemini 会话 ID。在下一次唤醒时，它使用 `--resume` 恢复现有对话，因此智能体保留上下文。

会话恢复可感知 cwd：如果工作目录自上次运行后发生了更改，则会启动一个新会话。

如果恢复因未知会话错误失败，适配器会自动重试新的会话。

## 技能注入

适配器将 Paperclip 技能符号链接到 Gemini 全局技能目录（`~/.gemini/skills`）中。现有的用户技能不会被覆盖。

## 环境测试

使用 UI 中的“测试环境”按钮来验证适配器配置。它会检查：

- 是否安装了 Gemini CLI 并可访问
- 工作目录是否绝对且可用（如果缺失且被允许，则会自动创建）
- API 密钥/身份验证提示（`GEMINI_API_KEY` 或 `GOOGLE_API_KEY`）
- 实时问候探针探测（`gemini --output-format json "Respond with hello."`）以验证 CLI 的准备就绪状态
