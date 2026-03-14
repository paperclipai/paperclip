---
title: 快速入門
summary: 幾分鐘內即可運行 Paperclip
---
5 分鐘內即可在本地運行 Paperclip。

## 快速入門（建議）

```sh
npx paperclipai onboard --yes
```

這將引導您完成設定、配置環境並執行 Paperclip。

## 本地開發

前置條件：Node.js 20+ 和 pnpm 9+。

```sh
pnpm install
pnpm dev
```

這將啟動 API 伺服器和 UI [http://localhost:3100](http://localhost:3100)。

無需外部資料庫 — Paperclip 預設使用嵌入式 PostgreSQL 實例。

## 單一命令引導

```sh
pnpm paperclipai run
```

如果缺少配置，此功能會自動啟動，透過自動修復運行運行狀況檢查，並啟動伺服器。

## 下一步是什麼

Paperclip 運行後：

1. 在 Web UI 中建立您的第一家公司
2. 定義公司目標
3. 建立CEO 智能體並配置其適配器
4. 與更多智能體一起建構組織架構圖
5. 設定預算並分配初始任務
6. 點擊執行－智能體開始心跳，公司開始運作

<Card title="核心概念" href="/zh-Hant/start/core-concepts">
  了解 Paperclip 背後的關鍵概念
</Card>