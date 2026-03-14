---
title: 部署模式
summary: local_trusted 與經過身份驗證的（私有/公共）
---
Paperclip 支援兩種具有不同安全性設定檔的運作模式。

## `local_trusted`

預設模式。針對單一操作員本地使用進行了最佳化。

- **主機綁定**：僅環回（本地主機）
- **身份驗證**：無需登入
- **用例**：本地開發、單獨實驗
- **董事會身分**：自動建立的本地董事會用戶

```sh
# Set during onboard
pnpm paperclipai onboard
# Choose "local_trusted"
```

## `authenticated`

需要登入。支援兩種曝光策略。

### `authenticated` + `private`

用於專用網路存取（Tailscale、VPN、LAN）。

- **身份驗證**：需透過 Better Auth 登入
- **URL 處理**：自動基本 URL 模式（較低摩擦）
- **主機信任**：需要私有主機信任策略

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "private"
```

允許自訂 Tailscale 主機名稱：

```sh
pnpm paperclipai allowed-hostname my-machine
```

### `authenticated` + `public`

用於面向互聯網的部署。

- **身份驗證**：需要登入
- **URL**：需要明確的公開 URL
- **安全**：對醫生進行更嚴格的部署檢查

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "public"
```

## 董事會索賠流程

從 `local_trusted` 遷移到 `authenticated` 時，Paperclip 在啟動時發出一次性聲明 URL：

```
/board-claim/<token>?code=<code>
```

登入使用者存取此 URL 即可聲明論壇所有權。這個：

- 將目前使用者提升為實例管理員
- 降級自動建立的本地板管理員
- 確保聲明用戶擁有活躍的公司會員資格

## 改變模式

更新部署模式：

```sh
pnpm paperclipai configure --section server
```

透過環境變數覆蓋運行時：

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated pnpm paperclipai run
```