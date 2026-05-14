---
title: Gemini 本地适配器
summary: Gemini CLI 本地适配器的搭建与配置
---

`gemini_local` 适配器在本地运行 Google 的 Gemini CLI，支持 `--resume` 会话持久化、技能注入，以及结构化 `stream-json` 输出解析。

## 前置条件

- 已安装 Gemini CLI（`gemini` 命令可用）
- 设置 `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`，或配置本地 Gemini CLI 鉴权

## 配置字段

| 字段 | 类型 | 必填 | 说明 |
|-------|------|----------|-------------|
| `cwd` | string | 是 | 智能体进程的工作目录（绝对路径；权限允许时可自动创建） |
| `model` | string | 否 | 使用的 Gemini 模型，默认为 `auto` |
| `promptTemplate` | string | 否 | 各次运行使用的提示词 |
| `instructionsFilePath` | string | 否 | 前置拼接到提示词的 Markdown 指令文件 |
| `env` | object | 否 | 环境变量（支持密钥引用） |
| `timeoutSec` | number | 否 | 进程超时（0 表示不超时） |
| `graceSec` | number | 否 | 强制终止前的宽限期 |
| `yolo` | boolean | 否 | 传入 `--approval-mode yolo` 以实现无人值守运行 |

## 会话持久化

适配器会在心搏之间持久化 Gemini 会话 ID，下次唤醒时使用 `--resume` 接续对话。

会话恢复与工作目录绑定：若自上次运行以来 `cwd` 变更，会启动新会话。

若因未知会话错误导致恢复失败，适配器会自动用全新会话重试。

## 技能注入

适配器将 Paperclip 技能以符号链接放入 Gemini 全局技能目录（`~/.gemini/skills`），不会覆盖用户已有技能。

## 环境检测

在 UI 中使用「测试环境」可校验适配器配置，会检查：

- Gemini CLI 是否已安装且可调用
- 工作目录是否为绝对路径且可用（权限允许时可自动创建）
- API 密钥/鉴权提示（`GEMINI_API_KEY` 或 `GOOGLE_API_KEY`）
- 实时探活（`gemini --output-format json "Respond with hello."`）以确认 CLI 就绪
