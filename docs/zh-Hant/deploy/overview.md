---
title: 部署概述
summary: 部署模式一覽
---
Paperclip 支援三種部署配置，從零摩擦本地到面向互聯網的生產。

## 部署模式

|模式|授權 |最適合 |
|------|------|----------|
| `local_trusted` |無需登入 |單一操作員本機|
| `authenticated` + `private` |需要登入 |專用網路（Tailscale、VPN、LAN）|
| `authenticated` + `public` |需要登入 |面向互聯網的雲端部署|

## 快速比較

### 本地可信任（預設）

- 僅環回主機綁定 (localhost)
- 無需人工登入流程
- 最快的本地啟動
- 最適合：單獨開發和實驗

### 已驗證 + 私有

- 需透過 Better Auth 登入
- 綁定到所有網路存取介面
- 自動基本 URL 模式（低摩擦）
- 最適合：透過 Tailscale 或本地網路進行團隊訪問

### 已驗證 + 公開

- 需要登入
- 需要明確的公開 URL
- 更嚴格的安全檢查
- 最適合：雲端託管、網路導向的部署

## 選擇模式

- **只是嘗試 Paperclip？ ** 使用 `local_trusted` （預設）
- **與專用網路上的團隊分享？ ** 使用 `authenticated` + `private`
- **部署到雲端？ ** 使用 `authenticated` + `public`

在入職期間設定模式：

```sh
pnpm paperclipai onboard
```

或稍後更新：

```sh
pnpm paperclipai configure --section server
```