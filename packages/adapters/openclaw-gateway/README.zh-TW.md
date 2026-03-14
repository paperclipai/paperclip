# OpenClaw 閘道轉接器

[English](./README.md) | [简体中文](./README.zh-CN.md) | **繁體中文**

本文檔介紹了`@paperclipai/adapter-openclaw-gateway`如何透過網關協定呼叫OpenClaw。

## 傳輸

此轉接器始終使用 WebSocket 閘道傳輸。

- URL必須是`ws://`或`wss://`
- 連線流程遵循網關協定：
1. 接收`connect.challenge`
2. 發送`req connect`（協定/客戶端/身份驗證/設備負載）
3. 發送`req agent`
4. 透過`req agent.wait`等待完成
5. 將 `event agent` 幀串流傳輸到 Paperclip 日誌/腳本解析中

## 身份驗證模式

可以透過以下任一方式提供網關憑證：

- 適配器配置中的 `authToken` / `token`
- `headers.x-openclaw-token`
- `headers.x-openclaw-auth`（舊版）
- `password`（共享密碼模式）

當存在令牌並且缺少 `authorization` 標頭時，適配器將衍生 `Authorization: Bearer <token>`。

## 裝置驗證

預設情況下，適配器會在 `connect` 參數中發送簽署的 `device` 有效負載。

- 設定 `disableDeviceAuth=true` 忽略設備簽名
- 設定 `devicePrivateKeyPem` 固定穩定的簽章金鑰
- 如果沒有 `devicePrivateKeyPem`，適配器每次運行都會產生臨時 Ed25519 金鑰對
- 啟用 `autoPairOnFirstConnect` 時（預設），適配器透過共用驗證呼叫 `device.pair.list` + `device.pair.approve` 來處理一個初始 `pairing required`，然後重試一次。

## 會話策略

此適配器支援與 HTTP OpenClaw 模式相同的會話路由模型：

- `sessionKeyStrategy=issue|fixed|run`
- 當策略為 `fixed` 時，使用 `sessionKey`

解析的會話金鑰以 `agent.sessionKey` 形式傳送。

## 有效負載映射

智能體請求建置為：

- 必填欄位：
  - `message`（喚醒文字加上選購的 `payloadTemplate.message`/`payloadTemplate.text` 前綴）
  - `idempotencyKey` (Paperclip `runId`)
  - `sessionKey`（已解決策略）
- 可選添加：
  - 所有 `payloadTemplate` 欄位合併
  - `agentId` 來自配置（如果已設定且尚未在模板中）

## 逾時

- `timeoutSec` 控制適配器等級請求預算
- `waitTimeoutMs` 控制 `agent.wait.timeoutMs`

如果 `agent.wait` 傳回 `timeout`，則轉接器傳回 `openclaw_gateway_wait_timeout`。

## 日誌格式

結構化網關事件日誌使用：

- `[openclaw-gateway] ...` 用於生命週期/系統日誌
- `[openclaw-gateway:event] run=<id> stream=<stream> data=<json>` 適用於 `event agent` 框架

UI/CLI 解析器使用這些行來呈現記錄更新。
