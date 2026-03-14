# 來自 OpenCode 的外掛程式創意

狀態：設計報告，不是 V1 承諾

Paperclip V1 在 [doc/SPEC-implementation.md](../SPEC-implementation.md) 中明確排除了插件框架，但長期規範表示該架構應該為擴充留出空間。本報告研究了 `opencode` 插件系統，並將有用的模式轉換為 Paperclip 形狀的設計。

本文檔的假設：Paperclip 是單一租用戶操作員控制的實例。因此，插件安裝應該是跨實例的全域安裝。 「公司」仍然是一流的 Paperclip 對象，但它們是組織記錄，而不是插件信任或安裝的租戶隔離邊界。

## 執行摘要

`opencode`已經有了一個真正的插件系統。它是故意低摩擦的：

- 插件是普通的 JS/TS 模組
- 它們從本地目錄和 npm 套件加載
- 他們可以掛鉤許多運行時事件
- 他們可以添加自訂工具
- 他們可以擴展提供者身份驗證流程
- 它們在進程內運行並且可以直接改變運行時行為

此模型非常適合本地編碼工具。不應逐字複製到 Paperclip 中。

主要結論是：

- Paperclip 應複製 `opencode` 的類型化 SDK、確定性加載、低創作摩擦和清晰的擴展表面。
- Paperclip 不應複製 `opencode` 的信任模型、專案本地插件載入、「按名稱衝突覆蓋」行為或核心業務邏輯的任意進程內突變掛鉤。
- Paperclip 應該使用多個擴充類別而不是一個通用插件包：
  - 用於低階平台問題的可信任進程內模組，例如智能體程式適配器、儲存提供者、秘密提供者以及可能的執行日誌後端
  - 適用於大多數第三方整合的進程外插件，例如 Linear、GitHub Issues、Grafana、Stripe 和調度程序
  - 插件提供的智能體工具（命名空間，不是碰撞覆蓋）
  - 外掛程式提供的 React UI 透過類型化橋接器載入到主機擴充插槽中
  - 具有伺服器端過濾和插件到插件事件的類型化事件總線，以及用於自動化的預定作業

如果 Paperclip 做得很好，那麼您列出的範例就會變得簡單：

- 檔案瀏覽器/終端/git工作流程/子進程追蹤成為工作區插件，可以解析來自主機的路徑並直接處理作業系統操作
- Linear / GitHub / Grafana / Stripe 成為連接器插件
- 未來的知識庫和會計功能也可以適合同一模型

## 來源審查

我克隆了 `anomalyco/opencode` 並審查了提交：

- `a965a062595403a8e0083e85770315d5dc9628ab`

審查的主要文件：

- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/plugin/src/index.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/plugin/src/tool.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/opencode/src/plugin/index.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/opencode/src/config/config.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/opencode/src/tool/registry.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/opencode/src/provider/auth.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/web/src/content/docs/plugins.mdx`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/web/src/content/docs/custom-tools.mdx`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/web/src/content/docs/ecosystem.mdx`針對目前擴充接縫審核的相關 Paperclip 檔案：

- [伺服器/src/適配器/registry.ts](../../server/src/adapters/registry.ts)
- [ui/src/adapters/registry.ts](../../ui/src/adapters/registry.ts)
- [伺服器/src/儲存/provider-registry.ts](../../server/src/storage/provider-registry.ts)
- [伺服器/src/secrets/provider-registry.ts](../../server/src/secrets/provider-registry.ts)
- [伺服器/src/services/run-log-store.ts](../../server/src/services/run-log-store.ts)
- [伺服器/src/services/activity-log.ts](../../server/src/services/activity-log.ts)
- [doc/SPEC.md](../SPEC.md)
- [doc/SPEC-implementation.md](../SPEC-implementation.md)

## OpenCode 實際上實作了什麼

## 1. 外掛程式編寫 API

`opencode` 公開了一個小套件 `@opencode-ai/plugin`，帶有類型化的 `Plugin` 函數和類型化的 `tool()` 幫助程式。

核心形狀：

- 外掛程式是接收上下文物件的非同步函數
- 插件傳回一個 `Hooks` 對象
- 掛鉤是可選的
- 外掛程式還可以貢獻工具和身份驗證提供者

外掛初始化上下文包括：

- SDK客戶端
- 目前專案資訊
- 目前目錄
- 目前的 git 工作樹
- 伺服器網址
- 包子殼訪問

這很重要：`opencode` 立即為插件提供豐富的運行時功能，而不是狹窄的功能 API。

## 2. 鉤子模型

鉤組很寬。它包括：

- 事件訂閱
- 配置時間掛鉤
- 訊息掛鉤
- 模型參數/標題掛鉤
- 權限決策掛鉤
- shell 環境注入
- 鉤子之前/之後的工具執行
- 工具定義突變
- 壓縮提示定制
- 文字完成變換

實作模式非常簡單：

- 核心程式碼建構一個`output`對象
- 每個匹配的插件掛鉤按順序運行
- 鉤子使 `output` 變異
- 最終變異輸出由核心使用

這是優雅且易於擴展的。

它的威力也是極為強大的。插件可以更改身份驗證標頭、模型參數、權限答案、工具輸入、工具描述和 shell 環境。

## 3. 外掛程式發現與載入順序

`opencode` 支援兩種插件來源：

- 本地文件
- npm 包

本地目錄：

- `~/.config/opencode/plugins/`
- `.opencode/plugins/`

Npm 插件：

- 在 `plugin: []` 下的設定中列出

載入順序是確定性的並記錄在案：

1. 全域配置
2. 項目配置
3. 全域插件目錄
4. 項目插件目錄

重要細節：

- 配置數組是連接而不是替換
- 重複的插件名稱將被刪除，優先順序較高的條目獲勝
- 內部第一方插件和預設插件也透過插件管道加載

這為 `opencode` 提供了真正的優先權模型，而不是「偶然最後載入的內容」。

## 4. 依賴關係處理

對於本地配置/插件目錄，`opencode` 將：

- 確保 `package.json` 存在
-注入`@opencode-ai/plugin`
- 運行`bun install`

這允許本地插件和本地自訂工具導入依賴項。這對於本地開發人員的人體工學來說非常有用。

對於操作員控制的控制平面伺服器來說，這不是安全的預設。

## 5. 錯誤處理

預設情況下，插件載入失敗不會導致運行時硬崩潰。

相反，`opencode`：

- 記錄錯誤
- 發布會話錯誤事件
- 繼續加載其他插件

這是一個很好的營運模式。一個糟糕的插件不應該破壞整個產品，除非操作員已根據需要明確配置它。

## 6. 工具是一流的擴充點

`opencode`有兩種添加工具的方式：

- 透過 `hook.tool` 直接從外掛程式匯出工具
- 在`.opencode/tools/`或全域工具目錄中定義本機文件

API這個工具很強大：

- 工具有描述
- 工具具有 Zod 模式
- 工具執行取得上下文，如會話 ID、訊息 ID、目錄和工作樹
- 工具被合併到與內建工具相同的註冊表中
- 工具定義本身可以透過 `tool.definition` 掛鉤進行變異

設計中最激進的部分：

- 自訂工具可以按名稱覆蓋內建工具

這對於本地編碼助手來說非常強大。
對於Paperclip的核心動作來說太危險了。

然而，插件貢獻智能體可用工具的概念對於 Paperclip 來說非常有價值——只要插件工具是命名空間的（不能影子核心工具）和能力門控的。

## 7. Auth 也是插件表面

`opencode` 允許外掛程式為提供者註冊身份驗證方法。

插件可以貢獻：

- 驗證方法元數據
- 提示流程
- OAuth 流程
- API 關鍵流程
- 請求載入器在驗證成功後調整提供者的行為

這是一個值得效仿的強大模式。整合通常需要自訂身份驗證使用者體驗和令牌處理。

## 8. 生態系證據

生態系統頁面是該模型在實踐中發揮作用的最佳證明。
社群外掛程式已經涵蓋：

- 沙箱/工作空間系統
- 授權提供者
- 會話標頭/遙測
- 記憶/情境特徵
- 日程安排
- 通知
- 工作樹助手
- 後台特工
- 監控

這驗證了主要論點：一個簡單的類型插件 API 可以創造真正的生態系統速度。

## OpenCode 的正確之處

## 1. 將插件 SDK 與主機運行時分開

這是設計中最好的部分之一。

- 外掛程式作者針對乾淨的公共包編寫程式碼
- 主機內部結構可以在載入程式後面進化
- 運行時程式碼和外掛程式碼有一個乾淨的契約邊界

Paperclip 絕對應該這樣做。

## 2. 確定性載入和優先權

`opencode` 明確表示：

- 插件從哪裡來
- 配置如何合併
- 什麼順序獲勝

Paperclip 應該複製這個紀律。

## 3. 低調的創作

插件作者不必學習龐大的框架。- 導出非同步函數
- 返回掛鉤
- 可選擇匯出工具

這種簡單性很重要。

## 4. 類型化工具定義

`tool()` 助理非常出色：

- 鍵入
- 基於模式
- 易於記錄
- 易於運行時驗證

Paperclip 應該對外掛程式操作、自動化和 UI 模式採用這種風格。

## 5.內建功能和外掛程式使用相似的形狀

`opencode` 在多個地方對內部和外部插件式行為使用相同的鉤子系統。
這減少了特殊情況。

Paperclip 可以從適配器、秘密後端、儲存提供者和連接器模組中受益。

## 6. 增量擴展，而不是預先進行巨大的抽象

`opencode` 最初並沒有設計一個龐大的市場平台。
它添加了實際功能所需的具體擴展點。

這也是Paperclip的正確心態。

## Paperclip 不應該直接複製的內容

## 1.預設進程內任意外掛程式碼

`opencode` 基本上是本地智能體運行時，因此非沙盒插件執行對其受眾來說是可以接受的。

Paperclip 是具有公司物件的操作員管理實例的控制平面。
風險狀況不同：

- 秘密很重要
- 審核關卡很重要
- 預算很重要
- 變異操作需要可審計性

預設第三方外掛程式不應在對伺服器記憶體、資料庫句柄和機密進行不受限制的進程內存取的情況下運作。

## 2.專案本地外掛程式加載

`opencode` 具有專案本地插件資料夾，因為該工具以程式碼庫為中心。

Paperclip 不是專案範圍。它是實例範圍的。
可比單位是：

- 實例安裝的插件包

Paperclip 不應從工作區儲存庫（如 `.paperclip/plugins` 或專案目錄）自動載入任意程式碼。

## 3. 任意突變會影響核心業務決策

鉤子如：

- `permission.ask`
- `tool.execute.before`
- `chat.headers`
- `shell.env`

在 `opencode` 中有意義。

對於 Paperclip，等效掛鉤到：

- 批准決定
- 問題結帳語義
- 活動日誌行為
- 預算執行

將是一個錯誤。

核心不變量應該保留在核心程式碼中，而不是可鉤重寫的。

## 4. 按名稱覆蓋衝突

允許插件按名稱替換內建工具在本地智能體產品中非常有用。

Paperclip 不應允許外掛程式靜默替換：

- 核心路線
- 核心變異動作
- 授權行為
- 權限評估器
- 預算邏輯
- 審計邏輯

擴展應該是附加的或明確委託的，而不是意外的遮蔽。

## 5. 從使用者設定自動安裝並執行

`opencode` 的「啟動時安裝依賴項」流程符合人體工學。
對於 Paperclip 來說，這是有風險的，因為它結合了：

- 套件安裝
- 程式碼載入
- 執行在控制平面伺服器啟動路徑內。

Paperclip 應該需要明確的操作員安裝步驟。

## 為什麼 Paperclip 需要不同的形狀

產品正在解決不同的問題。

|主題 |開放代碼 | Paperclip |
|---|---|---|
|主要單位|本地項目/工作樹 |具有公司物件的單一租戶操作員實例 |
|信任假設|自己機器上的本機高階使用者|操作員管理一個受信任的Paperclip 實例|
|失效爆炸半徑|本地會話/運行時 |整個公司的控制平面|
|擴展樣式|自由改變運行時行為 |保持治理和可審計性|
|使用者介面模型 |本機應用程式可以載入本機行為|主機板 UI 必須保持連貫且安全 |
|安全模型 |主機信任的本機插件 |需求能力邊界和可審計性|

這意味著Paperclip應該借鏡`opencode`的好想法，但使用更嚴格的架構。

## Paperclip 已經有有用的預插件接縫

Paperclip 已經有幾個類似擴展的接縫：

- 伺服器適配器註冊表：[server/src/adapters/registry.ts](../../server/src/adapters/registry.ts)
- UI適配器登錄：[ui/src/adapters/registry.ts](../../ui/src/adapters/registry.ts)
- 儲存提供者註冊表：[server/src/storage/provider-registry.ts](../../server/src/storage/provider-registry.ts)
- 秘密提供者註冊表：[server/src/secrets/provider-registry.ts](../../server/src/secrets/provider-registry.ts)
- 可插入運行日誌儲存接縫：[server/src/services/run-log-store.ts](../../server/src/services/run-log-store.ts)
- 活動日誌與即時事件發射：[server/src/services/activity-log.ts](../../server/src/services/activity-log.ts)

這是個好消息。
Paperclip 不需要從頭開始發明可擴充性。
它需要統一並加固現有的接縫。

## 推薦 Paperclip 外掛型號

## 1.使用多個擴充類

不要為所有內容創建一個巨大的 `hooks` 物件。

使用具有不同信任模型的不同插件類別。|延伸類別|範例 |運行時模型|信任等級 |為什麼 |
|---|---|---|---|---|
|平台模組|智能體適配器、儲存提供者、秘密提供者、運行日誌後端 |進行中|高度信賴|緊密整合、效能、低階 APIs |
|連接器插件 |線性、GitHub 問題、Grafana、條紋 |進程外工作者或 sidecar |中等|外部同步，隔離更安全，故障邊界更清晰 |
|工作區外掛程式 |檔案瀏覽器、終端機、git 工作流程、子程序/伺服器追蹤 |進程外、直接作業系統存取中等|解析主機的工作空間路徑，直接擁有檔案系統/git/PTY/行程邏輯 |
| UI 貢獻 |控制台小部件、設定表單、公司面板 |透過橋接在主機擴展插槽中提供插件 React 捆綁包 |中等|插件擁有自己的渲染；主機控制插槽放置和橋接訪問
|自動化插件 |警報、調度程序、同步作業、webhook 處理器 |進程外|中等|事件驅動的自動化是一個自然的插件配合|

這種分割是本報告中最重要的設計建議。

## 2. 將低階模組與第三方外掛程式分開

Paperclip 已經隱式具有此模式：

- 適配器是一回事
- 儲存提供者是另一個
- 秘密供應商是另一個

保持這種分離。

我會這樣正式化它：

- `module` 表示主機為低階運行時服務所載入的可信任程式碼
- `plugin` 表示透過類型化插件協定和功能模型與 Paperclip 對話的整合程式碼

這避免了嘗試強制 Stripe、PTY 終端機和新智能體程式適配器進入相同的抽象。

## 3. 優先選擇事件驅動的擴展而不是核心邏輯突變

對於第三方插件，主要的 API 應該是：

- 訂閱類型化網域事件（帶有可選的伺服器端過濾）
- 發出插件命名空間事件以進行跨插件通信
- 讀取實例狀態，包括相關的公司業務記錄
- 註冊網路鉤子
- 執行預定的作業
- 提供智能體在運行期間可以使用的工具
- 寫入插件擁有的狀態
- 新增附加 UI 表面
- 透過 API 呼叫明確 Paperclip 操作

不要讓第三方外掛程式負責：

- 決定是否批准通過
- 攔截問題結帳語義
- 重寫活動日誌行為
- 壓倒性的預算硬停止

這些都是核心不變量。

## 4. 外掛提供自己的 UI

插件將自己的 React UI 作為 `dist/ui/` 內的捆綁模組提供。主機將插件元件載入到指定的**擴充槽**（頁面、選項卡、小部件、側邊欄條目）中，並為插件前端提供一個**橋**，以與其自己的工作後端通訊並存取主機上下文。**它是如何工作的：**

1. 插件的 UI 為其填滿的每個槽導出命名元件（例如 `DashboardWidget`、`IssueDetailTab`、`SettingsPage`）。
2. 主機將插件組件安裝到正確的插槽中，並傳遞帶有 `usePluginData(key, params)` 和 `usePluginAction(key)` 等鉤子的橋接物件。
3. 插件元件透過橋接器從自己的工作執行緒獲取數據，並根據需要進行渲染。
4. 主機透過網橋強制執行能力門 - 如果工作人員沒有能力，網橋將拒絕呼叫。

**主機控制的內容：** 插件元件出現的位置、橋接 API、功能實作以及具有設計令牌和通用元件的共享 UI 基元 (`@paperclipai/plugin-sdk/ui`)。

**插件控制什麼：**如何呈現其資料、取得哪些資料、公開哪些操作以及是否使用主機的共用元件或建立完全自訂的 UI。

第一個版本擴充槽：

- 控制台小部件
- 設定頁面
- 詳細資訊頁面標籤（專案、問題、智能體、目標、運行）
- 側邊欄條目
- 公司上下文外掛頁面

主機 SDK 附帶共用元件（MetricCard、DataTable、StatusBadge、LogView 等）以實現視覺一致性，但這些是可選的。

稍後，如果不受信任的第三方插件變得普遍，主機可以轉移到基於 iframe 的隔離，而無需更改插件的原始程式碼（橋 API 保持不變）。

## 5. 使安裝全域化並保持映射/配置獨立

`opencode` 主要是用戶級本地配置。
Paperclip 應該將插件安裝視為全域實例級操作。

範例：

- 安裝一次 `@paperclip/plugin-linear`
- 立即使其隨處可用
- 如果一家公司映射到與另一家公司不同的 Linear 團隊，則可選擇儲存 Paperclip 物件上的映射

## 6. 使用專案工作區作為本地工具的主要錨點

Paperclip 已經有了一個具體的專案工作空間模型：

- 專案公開 `workspaces` 和 `primaryWorkspace`
- 資料庫已有`project_workspaces`
- 專案路由已經支援建立、更新和刪除工作區
- 在回退到任務會話或智能體主工作區之前，心跳解析已經優先選擇專案工作區

這意味著本地/運行時插件通常應該首先將自己錨定到項目，而不是發明並行工作空間模型。

實用指導：

- 文件瀏覽器應先瀏覽專案工作區
- 終端會話應該可以從專案工作區啟動
- git 應該將專案工作區視為儲存庫根錨點
- 開發伺服器和子進程追蹤應附加到專案工作區
- 問題和智能體視圖仍然可以深入連結到相關的專案工作空間上下文

換句話說：- `project` 是業務對象
- `project_workspace` 是本地運行時錨點
- 插件應該在此基礎上構建，而不是先創建不相關的工作區模型

## 7. 讓外掛程式貢獻智能體工具

`opencode` 讓工具成為一流的擴充點。這也是 Paperclip 價值最高的表面之一。

線性插件應該能夠提供智能體在運行期間使用的 `search-linear-issues` 工具。 git 插件應該貢獻 `create-branch` 和 `get-diff`。文件瀏覽器插件應提供 `read-file` 和 `list-directory`。

关键限制：

- 插件工具以插件 ID 命名（例如 `linear:search-issues`），因此它們無法隱藏核心工具
- 插件工具需要 `agent.tools.register` 功能
- 工具執行與其他所有內容一樣通過相同的工作 RPC 邊界
- 工具結果顯示在運行日誌中

這是一個自然的配合 - 該插件已經具有 SDK 上下文、外部 API 憑證和域邏輯。對於插件作者來說，將其包裝在工具定義中是最少的額外工作。

## 8. 支援外掛到外掛事件

插件應該能夠發出其他插件可以訂閱的自訂事件。例如，git 插件偵測到推送並發出 `plugin.@paperclip/plugin-git.push-detected`。 GitHub Issues 外掛程式訂閱此事件並更新 PR 連結。

這避免了插件需要透過共享狀態或外部通道進行協調。主機透過相同的事件總線路由插件事件，並具有與核心事件相同的傳遞語義。

插件事件使用 `plugin.<pluginId>.*` 命名空間，因此它們不會與核心事件發生衝突。

## 9. 從設定模式自動產生設定 UI

聲明 `instanceConfigSchema` 的插件應該免費獲得自動產生的設定表單。主機直接從 JSON 模式呈現文字輸入、下拉式選單、切換、陣列和秘密引用選擇器。

對於需要更豐富的設定 UX 的插件，他們可以聲明 `settingsPage` 擴充槽並提供自訂 React 元件。两种方法并存。

這很重要，因為設定表單是每個插件都需要的樣板。從已經存在的模式自動產生它們可以消除大量的創作摩擦。

## 10. 優雅關機與升級的設計

規格應該明確說明插件工作程序在升級、卸載或實例重新啟動期間停止時會發生什麼。

推荐政策：

- 傳送 `shutdown()` 並設定可設定的截止時間（預設 10 秒）
- 截止時間後 SIGTERM，再過 5 秒後 SIGKILL
- 標示為 `cancelled` 的飛行中作業
- 進行中的橋接呼叫將結構化錯誤傳回 UI特別是對於升級：舊工作人員耗盡，新工作人員啟動。如果新版本增加了功能，則輸入`upgrade_pending`，直到運營商批准。

## 11.定義卸載資料生命週期

卸載插件時，其資料（`plugin_state`、`plugin_entities`、`plugin_jobs` 等）應保留一段寬限期（預設為 30 天），而不是立即刪除。操作員可在寬限期內重新安裝並恢復狀態，或透過CLI強制清除。

這很重要，因為意外卸載不應導致不可逆轉的資料遺失。

## 12. 投資外掛程式可觀察性

通過 `ctx.logger` 的插件日誌應該被儲存並且可以從插件設定頁面查詢。主機也應該從工作進程捕獲原始 `stdout`/`stderr` 作為後備。

插件運作狀況控制台應顯示：工作人員狀態、正常運作時間、最近日誌、作業成功/失敗率、Webhook 交付率和資源使用情況。主機應發出其他外掛程式或控制台可使用的內部事件（`plugin.health.degraded`、`plugin.worker.crashed`）。

這對於營運商來說至關重要。如果沒有可觀察性，偵錯插件問題需要 SSH 存取和手動日誌追蹤。

## 13. 發送測試工具和入門模板

`@paperclipai/plugin-test-harness` 套件應為模擬主機提供記憶體儲存、合成事件發射和 `getData`/`performAction`/`executeTool` 模擬。插件作者應該能夠在沒有運行的 Paperclip 實例的情況下編寫單元測試。

`create-paperclip-plugin` CLI 應該建立一個包含清單、worker、UI 套件、測試檔案和建置設定的工作外掛程式。

低創作摩擦被認為是 `opencode` 的最佳品質之一。測試工具和入門範本是 Paperclip 實現相同功能的方式。

## 14.支援熱插件生命週期

插件安裝、卸載、升級和設定變更應在不重新啟動 Paperclip 伺服器的情況下生效。這對於開發人員工作流程和操作員體驗至關重要。

進程外工作架構使這變得很自然：- **熱安裝**：產生一個新的工作線程，在即時路由表中註冊其事件訂閱、作業計劃、Webhook 端點和智能體工具，將其 UI 套件載入到擴充槽註冊表中。
- **熱卸載**：正常關閉工作線程，從路由表中刪除所有註冊，卸載 UI 元件，啟動資料保留寬限期。
- **熱升級**：關閉舊的worker，啟動新的worker，自動交換路由表條目，使UI套件快取無效，以便前端載入更新的套件。
- **熱配置變更**：將新配置寫入`plugin_config`，透過IPC（`configChanged`）通知正在執行的worker。工作人員無需重新啟動即可套用變更。如果它不處理 `configChanged`，則主機僅重新啟動該工作執行緒。

前端快取失效使用版本化或內容雜湊的捆綁包 URL 和 `plugin.ui.updated` 事件，該事件會觸發重新匯入，而無需重新載入整個頁面。

每個工作進程都是獨立的－啟動、停止或替換一個工作進程不會影響任何其他外掛程式或主機本身。

## 15. 定義 SDK 版本控制和相容性

`opencode` 沒有正式的 SDK 版本控制故事，因為插件在進程內運行並有效地固定到當前運行時。 Paperclip 的進程外模型意味著插件可以針對一個 SDK 版本建置並在已更新的主機上運行。這需要明確的規則。

推薦方法：

- **單一 SDK 套件**：帶有子路徑匯出的 `@paperclipai/plugin-sdk` — 用於工作程式碼的 root，用於前端程式碼的 `/ui`。一種依賴、一種版本、一份變更日誌。
- **SD​​K主要版本= API版本**：`@paperclipai/plugin-sdk@2.x`目標為`apiVersion: 2`。使用 SDK 1.x 建立的插件聲明 `apiVersion: 1` 並繼續工作。
- **主機多版本支援**：主機至少同時支援目前和一個先前的 `apiVersion`，每個版本都有單獨的 IPC 協定處理程序。
- **清單中的 `sdkVersion`**：外掛程式宣告 semver 範圍（例如 `">=1.4.0 <2.0.0"`）。主機在安裝時驗證這一點。
- **棄用時間表**：以前的 API 版本在新版本發布後獲得至少 6 個月的持續支援。主機記錄棄用警告並在插件設定頁面上顯示橫幅。
- **遷移指南**：每個主要 SDK 版本都附帶涵蓋每項重大變更的逐步遷移指南。
- **UI 表面與工作人員版本化**：工作人員和 UI 表面都在同一個包中，因此它們一起版本化。共享 UI 元件的重大變更需要主要版本更新，就像工作人員 API 變更一樣。
- **發布的兼容性矩陣**：主機發布了支援的API版本和SDK範圍的矩陣，可透過API查詢。

## Paperclip 的具體 SDK 形狀故意縮小的第一遍可能如下：

```ts
import { definePlugin, z } from "@paperclipai/plugin-sdk";

export default definePlugin({
  id: "@paperclip/plugin-linear",
  version: "0.1.0",
  categories: ["connector", "ui"],
  capabilities: [
    "events.subscribe",
    "jobs.schedule",
    "http.outbound",
    "instance.settings.register",
    "ui.dashboardWidget.register",
    "secrets.read-ref",
  ],
  instanceConfigSchema: z.object({
    linearBaseUrl: z.string().url().optional(),
    companyMappings: z.array(
      z.object({
        companyId: z.string(),
        teamId: z.string(),
        apiTokenSecretRef: z.string(),
      }),
    ).default([]),
  }),
  async register(ctx) {
    ctx.jobs.register("linear-pull", { cron: "*/5 * * * *" }, async (job) => {
      // sync Linear issues into plugin-owned state or explicit Paperclip entities
    });

    // subscribe with optional server-side filter
    ctx.events.on("issue.created", { projectId: "proj-1" }, async (event) => {
      // only receives issue.created events for project proj-1
    });

    // subscribe to events from another plugin
    ctx.events.on("plugin.@paperclip/plugin-git.push-detected", async (event) => {
      // react to the git plugin detecting a push
    });

    // contribute a tool that agents can use during runs
    ctx.tools.register("search-linear-issues", {
      displayName: "Search Linear Issues",
      description: "Search for Linear issues by query",
      parametersSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }, async (params, runCtx) => {
      // search Linear API and return results
      return { content: JSON.stringify(results) };
    });

    // getData is called by the plugin's own UI components via the host bridge
    ctx.data.register("sync-health", async ({ companyId }) => {
      // return typed JSON that the plugin's DashboardWidget component renders
      return { syncedCount: 142, trend: "+12 today", mappings: [...] };
    });

    ctx.actions.register("resync", async ({ companyId }) => {
      // run sync logic
    });
  },
});
```

外掛程式的 UI 包（與工作執行緒分開）可能如下所示：

```tsx
// dist/ui/index.tsx
import { usePluginData, usePluginAction, MetricCard, ErrorBoundary } from "@paperclipai/plugin-sdk/ui";

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData("sync-health", { companyId: context.companyId });
  const resync = usePluginAction("resync");

  if (loading) return <Spinner />;
  if (error) return <div>Plugin error: {error.message} ({error.code})</div>;

  return (
    <ErrorBoundary fallback={<div>Widget failed to render</div>}>
      <MetricCard label="Synced Issues" value={data.syncedCount} trend={data.trend} />
      <button onClick={() => resync({ companyId: context.companyId })}>Resync Now</button>
    </ErrorBoundary>
  );
}
```

重要的一點不是確切的語法。
重要的一點是合約的形狀：

- 輸入清單
- 明確的能力
- 具有可選公司映射的明確全域配置
- 具有可選伺服器端過濾的事件訂閱
- 透過命名空間事件類型的插件到插件事件
- 智能體工具貢獻
- 職位
- 插件提供的 UI，透過主機橋與其工作人員通信
- 從worker到UI的結構化錯誤傳播

## 建議的核心擴充表面

## 1. 平台模組表面

這些應該與當前的註冊表風格保持接近。

候選人：

- `registerAgentAdapter()`
- `registerStorageProvider()`
- `registerSecretProvider()`
- `registerRunLogStore()`

這些是值得信賴的平台模組，而不是隨意的插件。

## 2. 連接器插件表面

這些是近期最好的候選插件。

能力：

- 訂閱領域事件
- 定義預定的同步作業
- 在 `/api/plugins/:pluginId/...` 下公開插件特定的 API 路由
- 使用公司秘密參考
- 寫入插件狀態
- 發布控制台數據
- 透過核心 APIs 記錄活動

範例：

- 線性問題同步
- GitHub 問題同步
- Grafana 儀表闆卡
- Stripe MRR/訂閱匯總

## 3. 工作空間-運作時表面

工作區插件直接處理本地工具：

- 文件瀏覽器
- 終端
- git工作流程
- 子進程追蹤
- 本地開發伺服器追蹤

外掛程式透過主機 API 解析工作區路徑（`ctx.projects` 提供工作區元數據，包括 `cwd`、`repoUrl` 等），然後對檔案系統進行操作、生成進程、`repoUrl` 等），然後對檔案系統進行操作、生成進程、shell 100Z API 或他們選擇的任何函式庫開啟 PTY 會話。

主機不包裝或智能體這些操作。這使得核心保持精簡——無需為插件可能需要的每個作業系統層級操作維護並行的 API 表面。插件擁有自己的實作。

## 治理與安全要求

任何 Paperclip 插件系統都必須保留儲存庫文件中的核心控制平面不變量。

這意味著：

- 插件安裝對於實例是全域的
- 「公司」仍然是 API 和資料模型中的業務對象，而不是租戶邊界
- 審批門仍由核心擁有
- 預算硬停仍由核心擁有
- 變異動作被活動記錄
- 秘密仍然基於參考並在日誌中進行編輯

我對每個插件都需要以下內容：

## 1. 能力聲明

每個插件都聲明一個靜態功能集，例如：- `companies.read`
- `issues.read`
- `issues.write`
- `events.subscribe`
- `events.emit`
- `jobs.schedule`
- `http.outbound`
- `webhooks.receive`
- `assets.read`
- `assets.write`
- `secrets.read-ref`
- `agent.tools.register`
- `plugin.state.read`
- `plugin.state.write`

董事會/操作員在安裝之前會看到這一點。

## 2.全域安裝

插件安裝一次後即可在整個實例中使用。
如果它需要特定 Paperclip 物件的映射，那麼這些是插件數據，而不是啟用/停用邊界。

## 3. 活動記錄

插件發起的突變應透過相同的活動日誌機制，並具有專用的 `plugin` 參與者類型：

- `actor_type = plugin`
- `actor_id = <plugin-id>`（例如`@paperclip/plugin-linear`）

## 4. 健康與故障報告

每個插件應該公開：

- 啟用/停用狀態
- 上次成功運行
- 最後一個錯誤
- 最近的網路鉤子/工作歷史記錄

一個損壞的插件不能破壞公司的其他部分。

## 5. 秘密處理

外掛程式應該接收秘密引用，而不是配置持久性中的原始秘密值。
解決方案應該經過現有的秘密提供者抽象化。

## 6. 資源限制

插件應該有：

- 逾時限制
- 並發限制
- 重試政策
- 可選的每個外掛程式預算

這對於同步連接器和工作區插件尤其重要。

## 需要考慮的資料模型添加

我會在第一個版本中避免「任意第三方外掛程式定義的 SQL 遷移」。
這太早了，力量太大了。

正確的心智模式是：

- 當資料明顯是 Paperclip 本身的一部分時，重複使用核心表
- 對大多數外掛程式擁有的狀態使用通用擴充表
- 稍後僅允許特定於插件的表，並且僅適用於受信任的平台模組或嚴格控制的遷移工作流程

## 推薦的 Postgres 擴充策略

### 1.核心表保持核心

如果一個概念成為 Paperclip 實際產品模型的一部分，它應該得到一個正常的第一方表。

範例：

- `project_workspaces` 已經是核心表，因為專案工作區現在是 Paperclip 本身的一部分
- 如果未來的「專案 git state」成為核心功能而不是插件擁有的元數據，那麼它也應該是第一方表

### 2. 大多數外掛程式應該從通用擴充表開始

對於大多數插件，主機應該提供一些通用的持久性表，並且插件在那裡儲存命名空間記錄。

這使系統易於管理：

- 更簡單的遷移
- 更簡單的備份/恢復
- 更簡單的便攜性故事
- 更輕鬆的操作員審查
- 插件模式漂移破壞實例的機會更少

### 3. 在新增自訂模式之前將插件資料範圍限定為 Paperclip 對象

許多插件資料自然地掛在現有的 Paperclip 物件上：- 專案工作區外掛程式狀態通常應範圍為 `project` 或 `project_workspace`
- 問題同步狀態範圍應為 `issue`
- 指標小工具的範圍可能為 `company`、`project` 或 `goal`
- 進程追蹤範圍可能為 `project_workspace`、`agent` 或 `run`

在引入自訂表之前，這提供了一個良好的預設鍵控模型。

### 4.稍後加入可信任模組遷移，而不是現在新增任意外掛遷移

如果 Paperclip 最終需要擴充擁有的表，我只會允許：

- 值得信賴的第一方軟體包
- 可信任平台模組
- 可能明確安裝了具有固定版本的管理員審查插件

我不會讓隨機的第三方插件在啟動時運行自由格式的架構遷移。

相反，如果有必要，可以稍後添加受控機制。

## 建議的基線擴展表

## 1.`plugins`

實例級安裝記錄。

建議字段：

- `id`
- `package_name`
- `version`
- `categories`
- `manifest_json`
- `installed_at`
- `status`

## 2.`plugin_config`

實例級插件配置。

建議字段：

- `id`
- `plugin_id`
- `config_json`
- `created_at`
- `updated_at`
- `last_error`

## 3.`plugin_state`

插件的通用鍵/值狀態。

建議字段：

- `id`
- `plugin_id`
- `scope_kind` (`instance | company | project | project_workspace | agent | issue | goal | run`)
- `scope_id` 可為空
- `namespace`
- `state_key`
- `value_json`
- `updated_at`

在允許自訂表之前，這對於許多連接器來說已經足夠了。

範例：

- 由 `issue` 鍵入的線性外部 ID
- GitHub 同步遊標由 `project` 鍵入
- 由 `project_workspace` 鍵控的檔案瀏覽器首選項
- git 分支元資料由 `project_workspace` 鍵入
- 處理由`project_workspace`或`run`鍵入的元數據

## 4.`plugin_jobs`

規劃作業和運行追蹤。

建議字段：

- `id`
- `plugin_id`
- `scope_kind` 可為空
- `scope_id` 可為空
- `job_key`
- `status`
- `last_started_at`
- `last_finished_at`
- `last_error`

## 5.`plugin_webhook_deliveries`

如果外掛公開網路鉤子，則值得儲存傳遞歷史記錄。

建議字段：

- `id`
- `plugin_id`
- `scope_kind` 可為空
- `scope_id` 可為空
- `endpoint_key`
- `status`
- `received_at`
- `response_code`
- `error`

## 6.也許稍後：`plugin_entities`

如果通用插件狀態變得過於有限，請在允許任意插件遷移之前為連接器記錄添加結構化、可查詢的實體表。

建議字段：

- `id`
- `plugin_id`
- `entity_type`
- `scope_kind`
- `scope_id`
- `external_id`
- `title`
- `status`
- `data_json`
- `updated_at`

這是一個有用的中間立場：- 比不透明的鍵/值狀態更可查詢
- 仍然避免讓每個外掛程式立即創建自己的關係模式

## 請求的範例如何對應到該模型

|使用案例 |最適合|所需的主機原語 |筆記|
|---|---|---|---|
|檔案瀏覽器|工作區外掛程式 |專案工作區元資料|插件直接擁有檔案系統操作|
|終端機|工作區外掛程式 |專案工作區元資料|插件直接產生 PTY 會話 |
| Git 工作流程 |工作區插件 |專案工作區元資料|插件直接 shell 到 git |
|線性問題追蹤 |連接器外掛程式 |作業、webhooks、秘密參考、問題同步 API |非常強大的候選外掛|
| GitHub 問題追蹤 |連接器外掛程式 |工作、webhooks、秘密參考 |非常強大的候選外掛|
| Grafana 指標 |連接器插件+控制台小工具|出站 HTTP |可能首先是唯讀的 |
|子進程/伺服器追蹤 |工作區外掛程式 |專案工作區元資料|外掛直接管理進程 |
| Stripe 收入追蹤 |連接器插件 |秘密參考、預定同步、公司指標 API |強大的候選插件|

# 外掛程式範例

## 工作區文件瀏覽器

封裝理念：`@paperclip/plugin-workspace-files`

此插件允許董事會檢查專案工作區、智能體工作區、生成的工件以及與問題相關的文件，而無需放入 shell。它適用於：

- 瀏覽專案工作空間內的文件
- 偵錯智能體程式更改的內容
- 在批准之前審查產生的輸出
- 將工作區中的文件附加到問題
- 了解公司的回購佈局
- 以本機信任模式檢查智能體主工作區

### 使用者體驗

- 設定頁面：`/settings/plugins/workspace-files`
- 首頁：`/:companyPrefix/plugins/workspace-files`
- 項目選項卡：`/:companyPrefix/projects/:projectId?tab=files`
- 可選問題選項卡：`/:companyPrefix/issues/:issueId?tab=files`
- 可選智能體選項卡：`/:companyPrefix/agents/:agentId?tab=workspace`

主螢幕與互動：- 外掛程式設定：
  - 選擇插件是否預設為`project.primaryWorkspace`
  - 選擇哪些專案工作區可見
  - 選擇檔案寫入是允許還是只讀
  - 選擇隱藏檔案是否可見
- 主瀏覽器頁面：
  - 頂部的項目選擇器
  - 工作區選擇器範圍為所選項目的 `workspaces`
  - 左側的樹視圖
  - 右側的文件預覽窗格
  - 檔案名稱/路徑搜尋的搜尋框
  - 操作：複製路徑、下載檔案、附加到問題、開啟差異
- 項目選項卡：
  - 直接開啟到專案的主工作區
  - 讓董事會在所有專案工作區之間切換
  - 顯示工作區元數據，例如 `cwd`、`repoUrl` 和 `repoRef`
- 問題選項卡：
  - 解決問題的專案並開啟該專案的工作區上下文
  - 顯示與問題相關的文件
  - 讓董事會將文件從專案工作區提取到問題附件中
  - 顯示每個連結檔案的路徑和上次修改訊息
- 智能體選項卡：
  - 顯示智能體目前解析的工作空間
  - 如果執行附加到項目，則連結回專案工作區視圖
  - 讓董事會檢查特工目前正在接觸的文件

核心工作流程：

- Board 開啟專案並瀏覽其主要工作區文件。
- 當專案有多個簽出或儲存庫引用時，板從一個專案工作區切換到另一個專案工作區。
- 委員會開啟一個問題，附加從文件瀏覽器產生的工件，並留下評論。
- Board 打開智能體詳細資訊頁面以檢查失敗運行背後的確切文件。

### 需要掛鉤

推薦的功能和擴充點：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register` 適用於 `project`、`issue` 和 `agent`
- `projects.read`
- `project.workspaces.read`
- 可選`assets.write`
- `activity.log.write`

此插件透過 `ctx.projects` 解析工作空間路徑，並直接使用 Node APIs 處理所有檔案系統操作（讀取、寫入、統計、搜尋、列出目錄）。

可選事件訂閱：

- `events.subscribe(agent.run.started)`
- `events.subscribe(agent.run.finished)`
- `events.subscribe(issue.attachment.created)`

## 工作區終端

封裝理念：`@paperclip/plugin-terminal`

該插件為開發板提供了用於專案工作區和智能體工作區的受控終端 UI。它適用於：

- 調試卡住的運行
- 驗證環境狀態
- 運行有針對性的手動命令
- 觀看長時間運行的命令
- 將人工操作員與智能體工作流程配對

### 使用者體驗

- 設定頁面：`/settings/plugins/terminal`
- 首頁：`/:companyPrefix/plugins/terminal`
- 項目選項卡：`/:companyPrefix/projects/:projectId?tab=terminal`
- 可選智能體選項卡：`/:companyPrefix/agents/:agentId?tab=terminal`
- 可選運行選項卡：`/:companyPrefix/agents/:agentId/runs/:runId?tab=terminal`

主螢幕與互動：- 外掛程式設定：
  - 允許的 shell 和 shell 策略
  - 指令是唯讀、自由格式還是列入允許列表
  - 終端在啟動前是否需要操作員明確確認
  - 新的終端會話是否預設為專案的主工作區
- 終端主頁：
  - 活動終端機會話列表
  - 開啟新會話的按鈕
  - 專案選擇器，然後是該專案工作區中的工作區選擇器
  - 可選智能體協會
  - 支援輸入、調整大小和重新連接的終端面板
  - 控制：中斷、終止、清除、儲存記錄
- 專案終端選項卡：
  - 開啟範圍已確定為專案主工作區的會話
  - 讓開發板在專案配置的工作區之間切換
  - 顯示該項目的最新命令和相關進程/伺服器狀態
- 智能體終端選項卡：
  - 開啟一個已經限定在智能體程式工作區範圍內的會話
  - 顯示最近的相關運行和命令
- 運行終端選項卡：
  - 讓董事會檢查特定失敗運行周圍的環境

核心工作流程：

- Board 針對智能體工作區開啟一個終端機以重現失敗的命令。
- Board 開啟專案頁面並直接在該專案的主工作區啟動終端。
- 板從終端頁面監視長時間運行的開發伺服器或測試命令。
- 主機板從同一使用者介面殺死或中斷失控的進程。

### 需要掛鉤

推薦的功能和擴充點：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register` 適用於 `project`、`agent` 和 `run`
- `projects.read`
- `project.workspaces.read`
- `activity.log.write`

此插件透過 `ctx.projects` 解析工作區路徑，並直接使用 Node PTY 庫處理 PTY 會話管理（開啟、輸入、調整大小、終止、訂閱）。

可選事件訂閱：

- `events.subscribe(agent.run.started)`
- `events.subscribe(agent.run.failed)`
- `events.subscribe(agent.run.cancelled)`

## Git 工作流程

封裝理念：`@paperclip/plugin-git`

該插件圍繞著問題和工作區添加了儲存庫感知工作流程工具。它適用於：

- 與問題相關的分支創建
- 快速差異審查
- 提交和工作樹可見性
- PR準備
- 將專案的主要工作空間視為規範的回購錨點
- 檢查客服人員的工作空間是否乾淨或骯髒

### 使用者體驗

- 設定頁面：`/settings/plugins/git`
- 首頁：`/:companyPrefix/plugins/git`
- 項目選項卡：`/:companyPrefix/projects/:projectId?tab=git`
- 可選問題選項卡：`/:companyPrefix/issues/:issueId?tab=git`
- 可選智能體選項卡：`/:companyPrefix/agents/:agentId?tab=git`

主螢幕與互動：- 外掛程式設定：
  - 分支命名模板
  - 可選的遠端提供者令牌秘密參考
  - 寫入操作是啟用還是只讀
  - 插件是否始終使用 `project.primaryWorkspace` 除非選擇了不同的專案工作區
- Git 概述頁：
  - 專案選擇器和工作區選擇器
  - 目前分支
  - 領先/落後狀態
  - 髒文件摘要
  - 最近的投稿
  - 活動工作樹
  - 操作：刷新、建立分支、建立工作樹、暫存所有、提交、開啟差異
- 項目選項卡：
  - 在專案的主工作區中打開
  - 顯示工作區元資料和儲存庫綁定（`cwd`、`repoUrl`、`repoRef`）
  - 顯示該專案工作區的分支、差異和提交歷史記錄
- 問題選項卡：
  - 解決問題的專案並使用該專案的工作區上下文
  - “從問題建立分支”操作
  - 差異視圖範圍僅限於專案的選取工作空間
  - 將分支/工作樹元資料連結到問題
- 智能體選項卡：
  - 顯示智能體的分支、工作樹和髒狀態
  - 顯示該智能體程式最近產生的提交
  - 如果智能體程式在專案工作區中工作，則連結回專案 git 選項卡

核心工作流程：

- 董事會根據問題建立一個分支並將其與專案的主要工作區連結起來。
- Board 開啟專案頁面並查看該專案工作區的差異，而無需離開 Paperclip。
- 董事會在運行後檢查差異，無需離開 Paperclip。
- Board 開啟工作樹清單以了解跨智能體的平行分支。

### 需要掛鉤

推薦的功能和擴充點：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register` 適用於 `project`、`issue` 和 `agent`
- `ui.action.register`
- `projects.read`
- `project.workspaces.read`
- 可選`agent.tools.register`（例如`create-branch`、`get-diff`、`get-status`）
- 選購 `events.emit`（例如 `plugin.@paperclip/plugin-git.push-detected`）
- `activity.log.write`

此插件透過 `ctx.projects` 解析工作空間路徑，並直接使用 git CLI 或 git 庫處理所有 git 操作（狀態、差異、日誌、分支創建、提交、工作樹創建、推送）。

可選事件訂閱：

- `events.subscribe(issue.created)`
- `events.subscribe(issue.updated)`
- `events.subscribe(agent.run.finished)`

git 插件可以發出其他插件（例如 GitHub Issues）訂閱的 `plugin.@paperclip/plugin-git.push-detected` 事件以進行跨插件協調。

注意：GitHub/GitLab PR 建立可能應該存在於單獨的連接器插件中，而不是重載本機 git 插件。

## 線性問題跟踪

包裝概念：`@paperclip/plugin-linear`

該插件將 Paperclip 與 Linear 同步工作。它適用於：- 從 Linear 匯入積壓訂單
- 將 Paperclip 問題連結到線性問題
- 同步狀態、評論和受讓人
- 將公司目標/專案對應到外部產品規劃
- 為董事會操作員提供一個查看同步運作狀況的單一位置

### 使用者體驗

- 設定頁面：`/settings/plugins/linear`
- 首頁：`/:companyPrefix/plugins/linear`
- 控制台小工具：`/:companyPrefix/dashboard`
- 可選問題選項卡：`/:companyPrefix/issues/:issueId?tab=linear`
- 可選項目選項卡：`/:companyPrefix/projects/:projectId?tab=linear`

主螢幕與互動：

- 外掛程式設定：
  - 線性 API 代幣秘密參考
  - 工作空間/團隊/專案映射
  - Paperclip 和 Linear 之間的狀態映射
  - 同步方向：僅匯入、僅匯出、雙向
  - 評論同步切換
- 線性概述頁：
  - 同步健康卡
  - 最近的同步作業
  - 映射專案和團隊
  - 未解決的衝突佇列
  - 導入團隊、專案和問題的操作
- 問題選項卡：
  - 連結的線性問題金鑰和 URL
  - 同步狀態和上次同步時間
  - 操作：連結現有、在 Linear 中建立、立即重新同步、取消連結
  - 同步評論/狀態變更的時間表
- 控制台小工具：
  - 開啟同步錯誤
  - 導入問題與連結問題計數
  - 最近的網路鉤子/作業失敗

核心工作流程：

- Board 啟用該插件，映射 Linear 團隊，並將待辦事項匯入 Paperclip。
- Paperclip 問題狀態變更推送至線性，線性評論透過 webhooks 傳回。
- 板從外掛頁面解決映射衝突，而不是默默地漂移狀態。

### 需要掛鉤

推薦的功能和擴充點：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.dashboardWidget.register`
- `ui.detailTab.register` 為 `issue` 和 `project`
- `events.subscribe(issue.created)`
- `events.subscribe(issue.updated)`
- `events.subscribe(issue.comment.created)`
- `events.subscribe(project.updated)`
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- 可選`issues.create`
- 可選`issues.update`
- 可選`issue.comments.create`
- 可選`agent.tools.register`（例如`search-linear-issues`、`get-linear-issue`）
- `activity.log.write`

重要約束：

- webhook 處理應該是冪等的並且具有衝突意識
- 外部 ID 和同步遊標屬於插件擁有的狀態，而不是內聯在第一個版本中的核心問題行上

## GitHub 問題跟踪

封裝理念：`@paperclip/plugin-github-issues`

該插件將 Paperclip 問題與 GitHub 問題同步，並可選擇連結 PR。它適用於：

- 導入回購積壓
- 鏡像問題狀態和評論
- 將 PR 連結到 Paperclip 問題
- 從一個公司內部的角度追蹤跨回購工作
- 透過 Paperclip 任務治理橋接工程工作流程

### 使用者體驗

- 設定頁面：`/settings/plugins/github-issues`
- 首頁：`/:companyPrefix/plugins/github-issues`
- 控制台小工具：`/:companyPrefix/dashboard`
- 可選問題選項卡：`/:companyPrefix/issues/:issueId?tab=github`
- 選用項目選項卡：`/:companyPrefix/projects/:projectId?tab=github`

主螢幕與互動：- 外掛程式設定：
  - GitHub App 或 PAT 機密參考
  - 組織/回購映射
  - 標籤/狀態映射
  - 是否啟用 PR 鏈接
  - 新的 Paperclip 問題是否應自動建立 GitHub 問題
- GitHub 概述頁：
  - 回購映射列表
  - 同步運作狀況和最近的 webhook 事件
  - 匯入積壓操作
  - 未連結的 GitHub 問題佇列
- 問題選項卡：
  - 連結的 GitHub 問題和可選的連結 PR
  - 操作：建立 GitHub 問題、連結現有問題、取消連結、重新同步
  - 評論/狀態同步時間軸
- 控制台小工具：
  - 與活躍的 Paperclip 問題相關的公開 PR
  - 網路鉤子失敗
  - 同步延遲指標

核心工作流程：

- 董事會將儲存庫的 GitHub 問題匯入 Paperclip 中。
- GitHub webhook 更新 Paperclip 中的狀態/評論狀態。
- PR 連結回 Paperclip 問題，以便董事會可以追蹤交付狀態。

### 需要掛鉤

推薦的功能和擴充點：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.dashboardWidget.register`
- `ui.detailTab.register` 為 `issue` 和 `project`
- `events.subscribe(issue.created)`
- `events.subscribe(issue.updated)`
- `events.subscribe(issue.comment.created)`
- `events.subscribe(plugin.@paperclip/plugin-git.push-detected)`（跨插件協調）
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- 選配 `issues.create`
- 可選`issues.update`
- 選購 `issue.comments.create`
- `activity.log.write`

重要約束：

- 將「本地 git 狀態」和「遠端 GitHub 問題狀態」保留在單獨的插件中，即使它們一起工作 - 跨插件事件處理協調

## Grafana 指標

封裝理念：`@paperclip/plugin-grafana`

該插件在 Paperclip 內顯示外部指標和控制台。它適用於：

- 公司KPI可見性
- 基礎設施/事件監控
- 顯示工作旁邊的部署、流量、延遲或收入圖表
- 根據異常指標建立 Paperclip 問題

### 使用者體驗

- 設定頁面：`/settings/plugins/grafana`
- 首頁：`/:companyPrefix/plugins/grafana`
- 控制台小工具：`/:companyPrefix/dashboard`
- 可選目標選項卡：`/:companyPrefix/goals/:goalId?tab=metrics`

主螢幕與互動：

- 外掛程式設定：
  - Grafana 基本 URL
  - 服務帳戶令牌秘密參考
  - 控制台和麵板映射
  - 刷新間隔
  - 可選的警報閾值規則
- 控制台小工具：
  - 主控制台上的一張或多張指標卡
  - 快速趨勢視圖和上次刷新時間
  - 連結到 Grafana 並連結到完整的 Paperclip 外掛程式頁面
- 完整指標頁：
  - 嵌入或智能體的選定控制台面板
  - 公制選擇器
  - 時間範圍選擇器
  - 「從異常創造問題」行動
- 目標選項卡：
  - 與特定目標或項目相關的度量卡

核心工作流程：- 董事會直接在 Paperclip 控制台上看到服務降級或業務 KPI 變動。
- 董事會點擊進入完整指標頁面以檢查相關 Grafana 面板。
- 董事會因違反門檻而創建 Paperclip 問題，並附有指標快照。

### 需要掛鉤

推薦的功能和擴充點：

- `instance.settings.register`
- `ui.dashboardWidget.register`
- `ui.page.register`
- `ui.detailTab.register` 為 `goal` 或 `project`
- `jobs.schedule`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- 可選`issues.create`
- 可選`assets.write`
- `activity.log.write`

可選事件訂閱：

- `events.subscribe(goal.created)`
- `events.subscribe(project.updated)`

重要約束：

- 首先以唯讀方式啟動
- 不要使 Grafana 警報邏輯成為 Paperclip 核心的一部分；將其保留為附加訊號和問題創建

## 子進程/伺服器跟踪

封裝理念：`@paperclip/plugin-runtime-processes`

該插件追蹤在專案工作區中啟動的長期本地進程和開發伺服器。它適用於：

- 查看哪個智能體程式啟動了哪個本地服務
- 追蹤連接埠、運作狀況和正常運作時間
- 重新啟動失敗的開發伺服器
- 公開進程狀態以及問題和運行狀態
- 使本地開發工作流程對董事會可見

### 使用者體驗

- 設定頁面：`/settings/plugins/runtime-processes`
- 首頁：`/:companyPrefix/plugins/runtime-processes`
- 控制台小工具：`/:companyPrefix/dashboard`
- 流程詳情頁：`/:companyPrefix/plugins/runtime-processes/:processId`
- 項目選項卡：`/:companyPrefix/projects/:projectId?tab=processes`
- 可選智能體選項卡：`/:companyPrefix/agents/:agentId?tab=processes`

主螢幕與互動：

- 外掛程式設定：
  - 是否允許手動流程註冊
  - 健康檢查行為
  - 操作員是否可以停止/重新啟動流程
  - 日誌保留偏好
- 進程列表頁面：
  - 狀態表，包含名稱、指令、cwd、擁有者智能體程式、連接埠、正常運作時間和運作狀況
  - 運行/退出/崩潰進程的過濾器
  - 操作：檢查、停止、重新啟動、尾部日誌
- 項目選項卡：
  - 將行程清單過濾到專案的工作區
  - 顯示每個行程屬於哪個工作區
  - 依專案工作空間將流程分組
- 流程詳情頁面：
  - 處理元數據
  - 即時日誌尾部
  - 健康檢查紀錄
  - 相關問題或運行的鏈接
- 智能體選項卡：
  - 顯示由該智能體程式啟動或指派給該智能體程式的進程

核心工作流程：

- 智能體啟動開發伺服器；該插件會偵測並追蹤它。
- Board 開啟一個專案並立即看到附加到該專案工作區的流程。
- Board 在控制台上看到崩潰的進程，並從插件頁面重新啟動它。
- 董事會在偵錯故障時將進程日誌附加到問題上。

### 需要掛鉤

推薦的功能和擴充點：

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.dashboardWidget.register`
- `ui.detailTab.register` 為 `project` 和 `agent`
- `projects.read`
- `project.workspaces.read`
- `plugin.state.read`
- `plugin.state.write`
- `activity.log.write`此插件透過 `ctx.projects` 解析工作空間路徑，並直接使用 Node API 處理程序管理（註冊、列出、終止、重新啟動、讀取日誌、運行狀況探測）。

可選事件訂閱：

- `events.subscribe(agent.run.started)`
- `events.subscribe(agent.run.finished)`

## Stripe 收入跟踪

包裝概念：`@paperclip/plugin-stripe`

該插件將 Stripe 收入和訂閱資料拉入 Paperclip。它適用於：

- 在公司目標旁顯示 MRR 和流失率
- 追蹤試用、轉換和失敗的付款
- 讓董事會將收入變動與正在進行的工作聯繫起來
- 讓未來的財務控制台超越代幣成本

### 使用者體驗

- 設定頁面：`/settings/plugins/stripe`
- 首頁：`/:companyPrefix/plugins/stripe`
- 控制台小工具：`/:companyPrefix/dashboard`
- 可選的公司/目標指標選項卡（如果這些表面稍後存在）

主螢幕與互動：

- 外掛程式設定：
  - 條紋秘密密鑰秘密參考
  - 如果需要的話選擇帳戶
  - 度量定義，例如 MRR 治療和試驗處理
  - 同步間隔
  - webhook 簽名秘密參考
- 控制台小工具：
  - MRR卡
  - 活躍訂閱
  - 試試到付費的轉化
  - 付款失敗提醒
- 條紋概述頁：
  - 時間序列圖表
  - 最近的客戶/訂閱活動
  - 網路掛鉤健康狀況
  - 同步歷史記錄
  - 操作：從計費異常建立問題

核心工作流程：

- Board 啟用外掛程式並連接 Stripe 帳戶。
- Webhooks 和計劃協調使插件狀態保持最新。
- 收入小工具出現在主控制台上，可以連結到公司目標。
- 失敗的付款高峰或流失事件可能會產生 Paperclip 問題以供後續處理。

### 需要掛鉤

推薦的功能和擴充點：

- `instance.settings.register`
- `ui.dashboardWidget.register`
- `ui.page.register`
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- `metrics.write`
- 可選`issues.create`
- `activity.log.write`

重要約束：

- 條帶資料應保留在 Paperclip 核心中
- 它不應該洩漏到核心預算邏輯中，該邏輯專門針對 V1 中的模型/代幣支出

## OpenCode 中值得採用的特定模式

## 採用

- 將 SDK 套件與運行時載入器分開
- 確定性的載入順序和優先級
- 非常小的創作API
- 外掛程式輸入/配置/工具的類型化模式
- 作為一流插件擴展點的工具（命名空間，而不是碰撞覆蓋）
- 在合理的情況下，內部擴展使用與外部相同的註冊形狀
- 盡可能將插件載入錯誤與主機啟動隔離
- 明確的社區導向的插件文件和範例模板
- 測試工具和入門範本可降低創作難度
- 熱插件生命週期無需重新啟動伺服器（由進程外工作人員啟用）
- 具有多版本主機支援的正式 SDK 版本控制## 適應，而不是複製

- 本地路徑載入
- 依賴項自動安裝
- 鉤突變模型
- 內建覆蓋行為
- 廣泛的運行時上下文對象

## 避免

- 專案本地任意程式碼加載
- 啟動時對 npm 套件的隱式信任
- 插件覆蓋核心不變量
- 非沙盒進程內執行作為預設擴展模型

## 建議的推出計劃

## 第 0 階段：加固已經存在的接縫

- 將適配器/儲存/秘密/運行日誌註冊表正式化為“平台模組”
- 盡可能刪除臨時後備行為
- 記錄穩定的註冊合約

## 第 1 階段：首先新增連接器插件

這是價值最高、風險最低的插件類別。

建構：

- 外掛程式清單
- 全域安裝/更新生命週期
- 全域插件配置和可選的公司映射存儲
- 秘密參考訪問
- 類型化域事件訂閱
- 預定的工作
- webhook端點
- 活動記錄助手
- 插件 UI 套件載入、主機橋接器、`@paperclipai/plugin-sdk/ui`
- 用於頁面、選項卡、小工具、側邊欄條目的擴充槽安裝
- 從 `instanceConfigSchema` 自動產生的設定表單
- 橋接錯誤傳播 (`PluginBridgeError`)
- 外掛提供的智能體工具
- 插件到插件事件（`plugin.<pluginId>.*` 命名空間）
- 事件過濾（伺服器端，每個訂閱）
- 優雅地關閉並可配置截止日期
- 插件日誌記錄和健康控制台
- 卸載並保留資料寬限期
- `@paperclipai/plugin-test-harness` 和 `create-paperclip-plugin` 入門模板
- 熱插件生命週期（安裝、卸載、升級、設定更改，無需重新啟動伺服器）
- SDK 版本控制，具有多版本主機支援和棄用政策

此階段將立即涵蓋：

- 線性
- GitHub
- 格拉法納
- 條紋
- 文件瀏覽器
- 終端
- git工作流程
- 子進程/伺服器跟踪

工作區插件不需要額外的主機 API - 它們透過 `ctx.projects` 解析工作區路徑並直接處理檔案系統、git、PTY 和進程操作。

## 第 2 階段：考慮更豐富的 UI 和外掛程式打包

僅當第一階段穩定後：

- 針對不受信任的第三方插件 UI 套件的基於 iframe 的隔離
- 簽名/驗證的插件包
- 外掛程式市場
- 可選的自訂外掛程式儲存後端或遷移

## 推薦的架構決策

如果我必須將這份報告分解為一項架構決策，那麼它將是：

Paperclip 不應實現「OpenCode 風格的通用進程內掛鉤系統」。
Paperclip 應該實現「具有多個信任層的插件平台」：- 用於低階運行時整合的可信任平台模組
- 用於實例範圍整合和自動化的類型化進程外插件
- 插件貢獻的智能體工具（命名空間、功能門控）
- 插件交付的 UI 套件透過具有結構化錯誤傳播的類型化橋在主機擴充插槽中呈現
- 用於跨插件協調的插件到插件事件
- 從設定模式自動產生設定 UI
- 核心擁有的不變量，插件可以觀察和操作，但不能替換
- 外掛程式可觀察性、優雅的生命週期管理和低創作摩擦的測試工具
- 熱插件生命週期 — 安裝、卸載、升級或配置變更時無需重新啟動伺服器
- SDK 版本控制，具有多版本主機支援和明確的棄用政策

這樣就可以發揮 `opencode` 的可擴充性的優勢，而無需匯入錯誤的威脅模型。

## 我將在 Paperclip 中採取的具體後續步驟

1. 寫一個簡短的擴充架構 RFC，形式化 `platform modules` 和 `plugins` 之間的差異。
2. 在 `packages/shared` 中引入一個小插件清單類型，並在實例配置中引入一個 `plugins` install/config 部分。
3. 圍繞現有活動/即時事件模式建立類型化域事件總線，並具有伺服器端事件過濾和用於跨插件事件的 `plugin.*` 命名空間。保持核心不變量不可掛鉤。
4. 實作外掛程式 MVP：全域安裝/設定、秘密引用、作業、webhooks、外掛程式 UI 套件、擴充槽、自動產生的設定表單、橋接錯誤傳播。
5. 新增智能體工具貢獻 - 插件註冊智能體可以在運行期間呼叫的命名空間工具。
6. 新增插件可觀察性：透過 `ctx.logger` 進行結構化日誌記錄、健康控制台、內部健康事件。
7. 新增優雅關閉策略和具有保留寬限期的卸載資料生命週期。
8. 傳送 `@paperclipai/plugin-test-harness` 和 `create-paperclip-plugin` 入門範本。
9. 實現熱插件生命週期 — 安裝、卸載、升級和配置更改，無需重新啟動伺服器。
10. 定義 SDK 版本控制策略 — semver、多版本主機支援、棄用時間表、遷移指南、發佈的相容性矩陣。
11. 建立工作區插件（檔案瀏覽器、終端、git、進程追蹤），用於解析主機的工作區路徑並直接處理作業系統層級操作。