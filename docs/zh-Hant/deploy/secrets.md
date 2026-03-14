---
title: 保密管理
summary: 主密鑰、加密和嚴格模式
---
Paperclip 使用本機主金鑰加密靜態機密。包含敏感值（API 金鑰、令牌）的智能體環境變數儲存為加密的秘密引用。

## 預設提供者：`local_encrypted`

秘密使用儲存在以下位置的本機主密鑰進行加密：

```
~/.paperclip/instances/default/secrets/master.key
```

該密鑰是在入職期間自動建立的。鑰匙永遠不會離開您的機器。

## 配置

### CLI 設定

Onboarding 寫入預設機密配置：

```sh
pnpm paperclipai onboard
```

更新機密設定：

```sh
pnpm paperclipai configure --section secrets
```

驗證機密配置：

```sh
pnpm paperclipai doctor
```

### 環境覆蓋

|變數|描述 |
|----------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | Base64、十六進位或原始字串形式的 32 位元組金鑰 |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` |自訂金鑰檔案路徑 |
| `PAPERCLIP_SECRETS_STRICT_MODE` |設定為 `true` 強制執行秘密引用 |

## 嚴格模式

啟用嚴格模式時，敏感環境鍵（匹配 `*_API_KEY`、`*_TOKEN`、`*_SECRET`）必須使用秘密引用而非內聯純值。

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

建議用於本地可信任之外的任何部署。

## 遷移內聯機密

如果您的現有智能體程式在其配置中具有內嵌 API 金鑰，請將它們移轉到加密的秘密引用：

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## 智能體配置中的秘密引用

智能體環境變數使用秘密引用：

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "8f884973-c29b-44e4-8ea3-6413437f8081",
      "version": "latest"
    }
  }
}
```

伺服器在執行時間解析並解密這些內容，將真實值注入智能體程式環境中。