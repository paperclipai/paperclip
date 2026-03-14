---
title: 環境變數
summary: 完整環境變數參考
---
Paperclip 用於伺服器配置的所有環境變數。

## 伺服器配置

|變數|預設 |描述 |
|----------|---------|-------------|
| `PORT` | `3100` |伺服器連接埠 |
| `HOST` | `127.0.0.1` |伺服器主機綁定 |
| `DATABASE_URL` | （嵌入）| PostgreSQL 連接字串 |
| `PAPERCLIP_HOME` | `~/.paperclip` |所有 Paperclip 資料的基底目錄 |
| `PAPERCLIP_INSTANCE_ID` | `default` |實例標識符（對於多個本地實例）|
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` |運行時模式覆蓋 |

## 秘密

|變數|預設 |描述 |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | （來自檔案）| 32 位元組加密金鑰（base64/hex/raw）|
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` |金鑰檔案的路徑 |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` |敏感環境變數需要秘密引用 |

## 智能體程式運行時（注入智能體程式）

這些是伺服器在調用智能體時自動設定的：

|變數|描述 |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` |智能體的唯一ID |
| `PAPERCLIP_COMPANY_ID` |公司ID |
| `PAPERCLIP_API_URL` | Paperclip API 基本 URL |
| `PAPERCLIP_API_KEY` | API 驗證的短暫 JWT |
| `PAPERCLIP_RUN_ID` |目前心跳運行ID |
| `PAPERCLIP_TASK_ID` |觸發此喚醒的問題 |
| `PAPERCLIP_WAKE_REASON` |喚醒觸發原因 |
| `PAPERCLIP_WAKE_COMMENT_ID` |引發此喚醒的評論 |
| `PAPERCLIP_APPROVAL_ID` |已解決的核准 ID |
| `PAPERCLIP_APPROVAL_STATUS` |核准決定 |
| `PAPERCLIP_LINKED_ISSUE_IDS` |以逗號分隔的連結問題 ID |

## LLM 提供者金鑰（用於適配器）

|變數|描述 |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API 金鑰（適用於 Claude 本機適配器）|
| `OPENAI_API_KEY` | OpenAI API 金鑰（用於 Codex 本機適配器）|