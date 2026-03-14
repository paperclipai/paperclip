# 工作空間策略與 Git 工作樹

## 上下文

`PAP-447` 詢問 Paperclip 應如何支援本地編碼智能體的工作樹驅動編碼工作流程，而不將其轉變為通用產品需求。

激勵用例很強大：

- 當問題開始時，本地編碼智能體可能需要自己的獨立檢查
- 智能體可能需要一個專用分支和一個可預測的路徑來稍後推送
- 智能體程式可能需要啟動一個或多個長期存在的工作區運行時服務，發現可存取的連接埠或 URL，並將其報告回問題中
- 工作流程應重複使用相同的 Paperclip 實例和嵌入式資料庫，而不是建立空白環境
- 本地智能體身份驗證應保持低摩擦

同時，我們不想將「每個智能體程式使用 git worktrees」硬編碼到 Paperclip 中：

- 有些操作員使用 Paperclip 來管理 Paperclip 並且非常需要工作樹
- 其他操作員根本不需要工作樹
- 並非每個適配器都在本機 git 儲存庫中執行
- 並非每個轉接器都與 Paperclip 在同一台電腦上執行
- Claude 和 Codex 公開不同的內建功能可見性，因此 Paperclip 不應過度適合一種工具

## 核心產品決策

Paperclip 應該建模**執行工作區**，而不是**工作樹**。

更具體地說：

- 持久的錨點是**專案工作區**或回購結帳
- 問題可能會從該專案工作區派生臨時的**執行工作區**
- 執行工作區的一種實作是 **git 工作樹**
- 適配器決定是否以及如何使用該派生工作區

這使抽象保持可移植性：

- `project workspace` 是倉庫/專案層級的概念
- `execution workspace` 是運行時的運行時簽出/cwd
- `git worktree` 是建立執行工作區的一種策略
- `workspace runtime services` 是附加到該工作區的長期進程或預覽

這也使抽象化對非本地適配器有效：

- 本機適配器可能會收到由 Paperclip 產生的真實檔案系統 cwd
- 遠端或雲端適配器可以以結構化形式接收相同的執行意圖，並在自己的環境中實現它
- Paperclip 不應假設每個適配器都可以直接檢視或使用主機檔案系統路徑

## 主要框架問題的回答

### 工作樹是用於智能體還是用於儲存庫/專案？

它們應該被視為**存儲庫/項目範圍的基礎設施**，而不是智能體身份。

穩定的對像是專案工作區。智能體來來去去，所有權發生變化，同一個問題可能會被重新分配。 git 工作樹是針對特定任務或問題的儲存庫工作區的衍生簽出。智能體使用它，但不應該擁有該抽象。

如果 Paperclip 使工作樹智能體程式優先，它將變得模糊：- 智能體主目錄
- 專案回購根源
- 特定問題的分支/結帳

這使得重複使用、重新分配、清理和 UI 可見度變得更加困難。

### 我們如何保留選擇性？

透過使執行工作區策略**在適配器/配置層**選擇加入**，而不是全域不變量。

應保留預設值：

- 現有專案工作空間分辨率
- 現有任務會話履歷
- 現有智能體主頁後備

然後本地編碼智能體可以選擇類似 `git_worktree` 的策略。

### 我們如何使其便攜且適用於適配器？

透過職責劃分：

- Paperclip 核心解析並記錄執行工作區狀態
- 共享的本地運行時助手可以實現基於 git 的結帳策略
- 每個適配器使用特定於適配器的標誌在解析的 cwd 中啟動其工具

這可以避免將 Claude 形狀或 Codex 形狀的模型強制安裝到所有適配器上。

它還避免將主機檔案系統模型強製到雲端智能體上。雲端適配器可以將相同請求的策略解釋為：

- 從 repo + ref 建立一個新的沙箱結帳
- 在供應商的遠端環境中建立一個獨立的分支/工作區
- 忽略僅本地字段，如主機 cwd，同時仍尊重分支/引用/隔離意圖

## 產品和使用者體驗要求

目前的技術模型方向是正確的，但產品表面需要更清晰地分離：

- **執行工作空間**的通用跨適配器概念
- **孤立問題檢查**的使用者可見的 local-git 實作概念
- **git 工作樹** 的具體 git 實作細節

這些不應折疊到 UI 中的一個標籤。

### 術語推薦

對於產品/UI 副本：

- 使用**執行工作空間**來實現通用跨適配器概念
- 當我們想說「這個問題有自己的分支/結帳」時，使用**隔離問題結帳**作為面向使用者的功能
- 保留**git worktree**用於進階或實作細部視圖

這為 Paperclip 提供了支援的空間：

- 本地 git 工作樹
- 遠程沙箱結帳
- 適配器管理的遠端工作空間

沒有教導使用者「工作區」總是意味著「我的機器上的 git worktree」。

### 專案級預設值應該會驅動該功能

應該配置的主要位置是**項目**，而不是智能體表單。

推理：

- 儲存庫/專案是否需要孤立的問題檢查主要是專案工作流程決策
- 大多數操作員不希望為每個智能體程式配置運行時 JSON
- 智能體應繼承專案的工作區策略，除非存在強大的特定於適配器的覆蓋
- 董事會需要一個地方來表達回購工作流程預設值，例如分支、PR、清理和預覽生命週期

因此該項目應該擁有以下設定：- `isolatedIssueCheckouts.enabled` 或同等學歷

這應該是該專案中新問題的預設驅動程式。

### 問題層級的使用應該保持可選

即使項目支援孤立的問題檢查，也不應該將每個問題強制合併為一個。

範例：

- 在主專案工作區中進行一個小修復可能就可以了
- 操作員可能希望直接在長期存在的分支上工作
- 董事會使用者可能希望創建一個任務而不支付設定/清理開銷

所以模型應該是：

- 項目定義孤立問題檢查是否可用以及預設值是什麼
- 每個問題在創建時都可以選擇加入或退出
- 預設問題值可以從項目繼承

這不需要在正常問題建立流程中顯示進階適配器配置。

### 運行時服務通常應該在智能體表單中隱藏

目前的原始運行時服務 JSON 作為大多數本地智能體的主要 UI 等級太低。

對於 `claude_local` 和 `codex_local`，可能期望的行為是：

- Paperclip 使用專案/工作空間策略在背景處理工作空間執行時間服務
- 運營商不需要以智能體形式手工編寫通用運行時JSON
- 如果特定於提供者的適配器稍後需要更豐富的運行時配置，請為其提供專用的 UI，而不是預設的通用 JSON

所以UI推薦是：

- 將執行時間服務 JSON 排除在預設的本機智能體編輯體驗之外
- 僅允許在高級部分或適配器特定的專家模式後面使用
- 將通用工作流程設定移至專案級工作區自動化設置

### 拉取請求工作流程需要明確的所有權和批准規則

一旦 Paperclip 創建孤立的問題檢查，它就隱式地觸及了更大的工作流程：

- 分支創建
- 運行時服務啟動/停止
- 提交並推送
- PR創作
- 合併或放棄後的清理

這意味著該產品需要一個明確的模型來說明**誰擁有 PR 創建和合併準備**。

至少有兩種有效模式：

- 智能體管理的PR創建
- PR創建需經過批准

可能有三個不同的決策點：

1. 智能體應該自動提交嗎？
2. 智能體程式是否應該自動打開PR？
3. 開放或標示就緒是否需要董事會批准？

這些不應被隱藏在適配器提示中。它們是工作流程規則。

### 人工操作工作流程與問題隔離工作流程不同

人類操作員可能想要一個長期存在的個人整合分支，例如 `dotta`，並且可能不希望每個任務都創建一個新的分支/工作空間舞蹈。

這是一個合法的工作流程，應該直接支援。

所以Paperclip應該要區分：- **隔離問題檢查工作流程**：針對智能體程式並行性和問題範圍隔離進行了最佳化
- **個人分支工作流程**：針對人員或操作員進行最佳化，在長期分支上進行多項相關更改，並在方便時將 PR 建立回主分支

這意味著：

- 即使可用，孤立的問題檢查也應該是可選的
- 專案工作流程設定應支援「直接使用基礎分支」或「使用首選操作員分支」路徑
- PR 政策不應假設每個工作單元 1:1 對應到新分支或 PR

## 推薦的使用者體驗模型

### 1. 專案層級「執行工作空間」設置

專案應該有一個用於工作區自動化的專用設定區域。

建議結構：

- `Execution Workspaces`
  - `Enable isolated issue checkouts`
  - `Default for new issues`
  - `Checkout implementation`
  - `Branch and PR behavior`
  - `Runtime services`
  - `Cleanup behavior`

對於本地 git 支援的項目，可見語言可以更具體：

- `Enable isolated issue checkouts`
- `Implementation: Git worktree`

對於遠端或適配器管理的項目，同一部分可以改為：

- `Implementation: Adapter-managed workspace`

### 2.問題建立應該公開一個簡單的選擇加入

在啟用了執行工作區支援的專案內建立問題時：

- 顯示複選框或切換開關，例如 `Use isolated issue checkout`
- 從項目設定中預設它
- 隱藏高級工作區控件，除非操作員擴展了高級部分

如果專案不支援執行工作區，則完全不顯示控制項。

這會在保留控制的同時保持預設的 UI 燈光。

### 3.智能體配置應該主要基於繼承

智能體表單不應成為操作員為常見本地智能體組裝工作樹/運行時策略的主要位置。

相反：

- 本地編碼智能體繼承項目的執行工作空間策略
- 智能體表單僅在真正必要時才公開覆蓋
- 原始 JSON 配置僅適用於高級

這意味著常見情況變為：

- 配置項目一次
- 指定本地編碼智能體
- 與可選的隔離結帳行為產生問題

### 4. 高階實作細節仍然存在

進階使用者仍應有一個進階視圖，顯示：

- 執行工作區策略有效負載
- 運行時服務意圖有效負載
- 特定於適配器的覆蓋

但這應該被視為專家/調試介面，而不是預設的心理模型。

## 推薦的工作流程策略模型

### 工作空間實現政策

建議的策略值：

- `shared_project_workspace`
- `isolated_issue_checkout`
- `adapter_managed_isolated_workspace`

對於本地 git 項目，`isolated_issue_checkout` 可能會對應到 `git_worktree`。

### 分行政策

建議的專案級分支政策領域：

- `baseBranch`
- `branchMode`: `issue_scoped | operator_branch | project_primary`
- `branchTemplate` 用於問題範圍的分支
- `operatorPreferredBranch` 用於人體/操作員工作流程

這允許：- 嚴格智能體發行分公司
- 人類長壽的個人分支
- 需要時直接使用專案主工作區

### 拉取請求策略

建議的專案級PR政策領域：

- `prMode`: `none | agent_may_open | agent_auto_open | approval_required`
- `autoPushOnDone`：布林值
- `requireApprovalBeforeOpen`：布林值
- `requireApprovalBeforeReady`：布林值
- `defaultBaseBranch`

這使得PR行為變得明確且可控。

### 清理政策

建議的專案級清理欄位：

- `stopRuntimeServicesOnDone`
- `removeIsolatedCheckoutOnDone`
- `removeIsolatedCheckoutOnMerged`
- `deleteIssueBranchOnMerged`
- `retainFailedWorkspaceForInspection`

這些很重要，因為工作區自動化不僅僅是設定。清理路徑是產品的一部分。

## 針對當前UI問題的設計建議

基於上述問題，UI 應以以下方式進行更改：

### 智能體使用者介面

- 從預設的本機智能體程式設定介面中移除通用執行時間服務 JSON
- 僅將原始工作區/運行時 JSON 保留在進階設定後面
- 偏好從 `claude_local` 和 `codex_local` 的專案設定繼承
- 僅當適配器確實需要 Paperclip 無法推斷的設定時才添加特定於適配器的運行時 UI

### 專案使用者介面

- 新增專案級執行工作區設定部分
- 允許為該項目啟用孤立的問題檢查
- 在那裡儲存預設問題行為
- 公開分支、PR、執行時間服務和清理預設值

### 問題建立 UI

- 僅當專案啟用了執行工作區支援時才顯示 `Use isolated issue checkout`
- 將其保留為問題層級的選擇加入/退出，預設為項目
- 除非有要求，否則隱藏高級執行工作區詳細信息

## 對規範的影響

這以一種有用的方式改變了計劃的重點：

- 專案成為主要工作流程配置擁有者
- 此問題成為獨立結帳行為選擇加入/退出的單位
- 智能體程式成為執行者，通常繼承工作流程規則
- 原始運行時 JSON 成為高級/內部表示，而不是主要 UX

它還澄清了 PR 創建和清理不是可選的旁注。它們是工作區自動化產品表面的核心部分。

## 具體整合清單

本節將上述產品需求轉化為目前程式碼庫的具體實施計畫。

### 指導優先規則

運行時決策順序應變為：

1. 問題層級執行工作區覆蓋
2. 專案級執行工作區策略
3. 智能體級適配器覆蓋
4. 當前預設行為

這是關鍵的架構變化。如今，對於所需的使用者體驗來說，實現過於以智能體配置為中心。

## 建議的欄位名稱

### 專案級字段

新增專案擁有的執行工作區策略物件。建議共享形狀：

```ts
type ProjectExecutionWorkspacePolicy = {
  enabled: boolean;
  defaultMode: "inherit_project_default" | "shared_project_workspace" | "isolated_issue_checkout";
  implementation: "git_worktree" | "adapter_managed";
  branchPolicy: {
    baseBranch: string | null;
    branchMode: "issue_scoped" | "operator_branch" | "project_primary";
    branchTemplate: string | null;
    operatorPreferredBranch: string | null;
  };
  pullRequestPolicy: {
    mode: "none" | "agent_may_open" | "agent_auto_open" | "approval_required";
    autoPushOnDone: boolean;
    requireApprovalBeforeOpen: boolean;
    requireApprovalBeforeReady: boolean;
    defaultBaseBranch: string | null;
  };
  cleanupPolicy: {
    stopRuntimeServicesOnDone: boolean;
    removeExecutionWorkspaceOnDone: boolean;
    removeExecutionWorkspaceOnMerged: boolean;
    deleteIssueBranchOnMerged: boolean;
    retainFailedWorkspaceForInspection: boolean;
  };
  runtimeServices: {
    mode: "disabled" | "project_default";
    services?: Array<Record<string, unknown>>;
  };
};
```

注意事項：- `enabled` 控制項目是否公開孤立問題檢查行為
- `defaultMode` 控制問題建立預設值
- `implementation` 對於本地或遠端適配器來說足夠通用
- 運行時服務配置嵌套在此處，而不是預設智能體形式

### 問題層級字段

新增問題所屬的選擇加入/覆蓋欄位。建議形狀：

```ts
type IssueExecutionWorkspaceSettings = {
  mode?: "inherit_project_default" | "shared_project_workspace" | "isolated_issue_checkout";
  branchOverride?: string | null;
  pullRequestModeOverride?: "inherit" | "none" | "agent_may_open" | "agent_auto_open" | "approval_required";
};
```

這通常應該隱藏在簡單的 UI 後面：

- 像 `Use isolated issue checkout` 這樣的複選框
- 僅在需要時進行高級控制

### 智能體級別字段

保留智能體級工作區/運行時配置，但僅將其重新定位為進階覆蓋。

建議的語意：

- 若缺席，繼承項目+發布政策
- 如果存在，僅覆蓋該適配器所需的實作細節

## 共享類型和 API 更改

### 1. 共享項目類型

首先要更改的文件：

- `packages/shared/src/types/project.ts`
- `packages/shared/src/validators/project.ts`

添加：

- `executionWorkspacePolicy?: ProjectExecutionWorkspacePolicy | null`

### 2. 共享問題類型

要更改的文件：

- `packages/shared/src/types/issue.ts`
- `packages/shared/src/validators/issue.ts`

添加：

- `executionWorkspaceSettings?: IssueExecutionWorkspaceSettings | null`

### 3.資料庫模式

如果我們希望這些欄位直接保留在現有實體上，而不是存在於不透明的 JSON 中：

- `packages/db/src/schema/projects.ts`
- `packages/db/src/schema/issues.ts`
- `packages/db/src/migrations/` 中的遷移生成

推薦第一剪：

- 在 `projects` 上將專案策略儲存為 JSONB
- 將問題設定覆蓋儲存為 `issues` 上的 JSONB

當產品模型仍在移動時，這可以最大限度地減少模式變更。

建議欄：

- `projects.execution_workspace_policy jsonb`
- `issues.execution_workspace_settings jsonb`

## 伺服器端解析度更改

### 4.專案服務讀取/寫入路徑

文件：

- `server/src/services/projects.ts`
- `server/src/routes/projects.ts`的專案路線

任務：

- 接受並驗證專案執行工作空間政策
- 從專案 API 有效負載返回它
- 照常執行公司範圍界定

### 5. 發布服務建立/更新路徑

文件：

- `server/src/services/issues.ts`
- `server/src/routes/issues.ts`

任務：

- 接受問題等級 `executionWorkspaceSettings`
- 在啟用執行工作區的專案中建立問題時，如果未明確提供，則預設專案策略中的問題設置
- 對於普通客戶端來說，保持問題有效負載簡單；進階欄位可以是可選的

### 6. 心跳與運行分辨率

主文件：

- `server/src/services/heartbeat.ts`

應重構當前行為，以便工作區解析基於：

- 問題設定
- 然後是專案政策
- 然後適配器覆蓋

具體技術工作：

- 在執行解析期間載入專案執行工作區策略
- 在運行解決期間載入問題執行工作區設置
- 在適配器啟動之前匯出有效的執行工作空間決策對象
- 僅將適配器配置保留為覆蓋

建議的內部助手：

```ts
type EffectiveExecutionWorkspaceDecision = {
  mode: "shared_project_workspace" | "isolated_issue_checkout";
  implementation: "git_worktree" | "adapter_managed" | "project_primary";
  branchPolicy: {...};
  pullRequestPolicy: {...};
  cleanupPolicy: {...};
  runtimeServices: {...};
};
```

## 使用者介面更改

### 7. 專案設定 UI

可能的文件：- `ui/src/components/ProjectProperties.tsx`
- `ui/src/pages/` 下的專案詳細資料/設定頁面
- `ui/src/api/projects.ts` 中的專案 API 用戶端

新增專案擁有的部分：

- `Execution Workspaces`
  - 啟用孤立問題檢查
  - 新問題的預設設定
  - 實施類型
  - 分支設定
  - PR設定
  - 清理設置
  - 運行時服務預設值

重要的使用者體驗規則：

- 運行時服務配置不應預設為原始 JSON
- 如果第一次剪輯必須在內部使用 JSON，請將其包裝在最小的結構化形式或進階揭露中

### 8.問題建立/編輯 UI

可能的文件：

- 在 `ui/src/pages/` 中建立 UI 元件並發布詳細編輯介面
- 在`ui/src/api/issues.ts`中發布API客戶端

添加：

- `Use isolated issue checkout` 切換，僅當專案策略啟用時
- 高階工作區行為僅在展開時進行控制

不顯示：

- 原始運行時服務 JSON
- 原始策略有效負載

在預設問題建立流程中。

### 9. 智能體程式 UI 清理

文件：

- `ui/src/adapters/local-workspace-runtime-fields.tsx`
- `ui/src/adapters/codex-local/config-fields.tsx`
- `ui/src/adapters/claude-local/config-fields.tsx`

技術方向：

- 保留現有的配置表面作為進階覆蓋
- 將其從本機編碼智能體程式的預設表單流程中刪除
- 新增解釋性副本，說明專案執行工作區策略將被繼承，除非被覆寫

## 適配器和編排更改

### 10. 本機適配器行為

文件：

- `packages/adapters/codex-local/src/ui/build-config.ts`
- `packages/adapters/claude-local/src/ui/build-config.ts`
- 本機適配器執行路徑已消耗 env/context

任務：

- 繼續從心跳接受已解析的工作區/運行時上下文
- 停止假設智能體配置是工作區策略的主要來源
- 保留特定於適配器的覆蓋支持

### 11.運行時服務編排

文件：

- `server/src/services/workspace-runtime.ts`

任務：

- 接受有效專案/問題策略中的執行時間服務預設值
- 將適配器配置運行時服務 JSON 保留為僅覆蓋
- 保留遠端適配器的可移植性

## 拉取請求與清理工作流程

### 12.PR政策執行

目前這尚未完全實現，應將其視為單獨的編排層。

可能的文件：

- `server/src/services/heartbeat.ts`
- 未來的 git/provider 整合助手

需要做出的決定：

- 當問題完成時，Paperclip 應該自動提交嗎？
- 它應該自動推送嗎？
- 它應該自動打開 PR 嗎？
- PR開放/準備就緒是否應該經過批准？

建議的方法：

- 儲存項目的PR政策
- 解決每個問題/運作的有效PR政策
- 發出明確的工作流程操作，而不是僅依賴提示文本

### 13.清理策略執行

可能的文件：

- `server/src/services/workspace-runtime.ts`
- `server/src/services/heartbeat.ts`
- 任何未來的合併檢測掛鉤

需要的行為：

- 完成或合併時停止運行時服務
- 刪除完成或合併時的單獨結帳
- 如果保單如此規定，則刪除合併後的分支
- 可選擇保留失敗的工作空間以供檢查## 建議的第一個實施順序

若要在不破壞系統穩定性的情況下整合這些想法，請依照以下順序實作：

1. 將專案策略欄位新增至共用類型、驗證器、資料庫、服務、路由和專案 UI。
2. 將問題層級執行工作區設定欄位新增至共用類型、驗證器、資料庫、服務、路由和問題建立/編輯 UI。
3. 重構心跳以從問題 -> 專案 -> 智能體覆蓋中計算有效的執行工作區策略。
4. 變更本機智能體程式 UI，使工作區/執行時間 JSON 變成僅限高階。
5. 將預設運行時服務行為移至項目設定。
6. 新增顯式PR策略儲存和解析。
7. 新增明確清理策略儲存和解析。

## 此產品轉換完成的定義

當所有條件都成立時，此設計轉變就完成了：

- 專案設定擁有預設工作區策略
- 問題創建公開了一個簡單的選擇加入/退出（如果可用）
- 對於常見情況，本機智能體表單不再需要原始執行時間 JSON
- 心跳解決了專案+問題+涵蓋優先順序的有效工作空間行為
- PR 和清理行為被建模為明確的策略，而不是隱含的提示行為
- UI 語言將執行工作區與本機 git 工作樹實作細節區分開來

## 當前程式碼已經支援什麼

Paperclip 已經具備了專案優先模式的正確基礎。

### 專案工作區已經是一流的

- `project_workspaces` 已存在於 `packages/db/src/schema/project_workspaces.ts` 中
- 共享的 `ProjectWorkspace` 類型已包含 `packages/shared/src/types/project.ts` 中的 `cwd`、`repoUrl` 和 `branch`
- 文件已經聲明智能體程式使用專案的主工作區來執行 `docs/api/goals-and-projects.md` 中的專案範圍任務

### Heartbeat 已以正確的順序解析工作空間

目前的運行解析度已經首選：

1. 專案工作區
2. 之前的任務會話cwd
3. 智能體-home 後備

參見 `server/src/services/heartbeat.ts`。

### 會話復原已支援 cwd

兩個本機編碼適配器都將會話連續性視為受 cwd 限制：

- Codex: `packages/adapters/codex-local/src/server/execute.ts`
- Claude: `packages/adapters/claude-local/src/server/execute.ts`

這意味著乾淨的插入點是在適配器執行之前：先解析最終執行cwd，然後讓適配器正常運作。

### 伺服器產生的本機驗證已存在

對於伺服器產生的本機適配器，Paperclip 已經注入了一個短暫的本地 JWT：

- JWT 創建：`server/src/services/heartbeat.ts`
- 適配器環境注入：
  - `packages/adapters/codex-local/src/server/execute.ts`
  - `packages/adapters/claude-local/src/server/execute.ts`

在身份驗證模式下，手動本地引導路徑仍然較弱，但這是一個相關的身份驗證人體工學問題，而不是使工作樹成為核心不變量的原因。

## 來自供應商文件的工具觀察

連結的工具文件支援專案優先、特定於適配器的啟動模型。

### Codex- Codex 應用程式具有用於 git 儲存庫中平行任務的本機工作樹概念
- Codex CLI 文件在選定的工作目錄中運行並從當前工作目錄恢復會話
- Codex CLI 不提供 Paperclip 應該直接鏡像的單一一流可移植 CLI 工作樹抽象

意義：

- 對於 `codex_local`，Paperclip 通常應建立/選擇結帳本身，然後在該 cwd 內啟動 Codex

### Claude

- Claude 記錄並行會話的明確 git worktree 工作流程
- Claude CLI 支援 `--worktree` / `-w`
- Claude 會話也仍然與目錄上下文相關

意義：

- `claude_local` 可以選擇使用原生 `--worktree`
- 但 Paperclip 仍應將其視為適配器最佳化，而不是規範的跨適配器模型

## 本機適配器與遠端適配器

該計劃必須明確考慮到許多適配器不是本地的事實。

範例：

- 本機 CLI 轉接器，例如 `codex_local` 和 `claude_local`
- 雲端託管編碼智能體，例如 Cursor 雲端智能體
- 未來託管Codex或Claude智能體模式
- 基於 E2B、Cloudflare 或類似環境建構的自訂沙箱適配器

這些適配器並不都具有相同的功能：

- 有些可以直接使用主機 git worktrees
- 有些可以遠端克隆儲存庫並建立分支
- 有些可能會揭露虛擬工作空間概念，而沒有直接的 git worktree 等效項
- 有些可能根本不允許持久檔案系統狀態

因此，Paperclip 應該分開：

- **執行工作區意圖**：我們想要什麼隔離/分支/儲存庫行為
- **適配器實作**：特定適配器如何實現該行為

### 執行工作區意圖

Paperclip 應該能夠表達諸如以下的意圖：

- 直接使用專案的主工作區
- 建立一個孤立的問題範圍結帳
- 基於給定存儲庫參考的基礎工作
- 從問題中取得分支名稱
- 如果啟動執行時間服務，則公開一個或多個可存取的預覽或服務 URL

### 適配器實現

適配器應該可以自由地將意圖映射到自己的環境：

- 本機適配器：建立主機 git worktree 並在該 cwd 中執行
- 雲端沙箱適配器：將儲存庫克隆到沙箱中，在那裡建立分支，並返回沙箱元數據
- 託管遠端編碼智能體：呼叫提供者 APIs，建立綁定到請求的分支/引用的遠端工作區/線程

重要的限制是適配器以規範化的形式報告已實現的執行工作空間元數據，即使底層實作不是 git 工作樹。

## 建議模型

使用三層：1.`project workspace`
2. `execution workspace`
3. `workspace runtime services`
4. `adapter session`

### 1. 專案工作區

長壽的回購錨。

範例：

- `./paperclip`
- 儲存庫 URL 和基本參考
- 項目的初步檢查

### 2. 執行工作區

針對特定問題/運行的派生運行時檢查。

範例：

- 直接使用專案主工作區
- 從專案工作區派生的 git worktree
- 從儲存庫 URL + ref 派生的遠端沙箱結帳
- 由適配器特定腳本產生的自訂結帳

### 3.適配器會話

與工作空間關聯的長壽命或半長壽命進程。

範例：

- 本地網路伺服器
- 後台工作者
- 沙箱預覽 URL
- 測試觀察者
- 隧道工藝

這些並不是 Paperclip 特有的。它們是在開發工作區（無論是本地還是遠端）中工作的常見屬性。

### 4. 適配器會話

Claude/Codex 會話連續性和運行時狀態，保持 cwd 感知，並且應該遵循執行工作空間而不是定義它。

## 推薦配置面

在適配器配置中引入通用執行工作區策略。

形狀範例：

```json
{
  "workspaceStrategy": {
    "type": "project_primary"
  }
}
```

或者：

```json
{
  "workspaceStrategy": {
    "type": "git_worktree",
    "baseRef": "origin/main",
    "branchTemplate": "{{issue.identifier}}-{{slug}}",
    "worktreeParentDir": ".paperclip/instances/default/worktrees/projects/{{project.id}}",
    "cleanupPolicy": "on_merged",
    "startDevServer": true,
    "devServerCommand": "pnpm dev",
    "devServerReadyUrlTemplate": "http://127.0.0.1:{{port}}/api/health"
  }
}
```

遠端適配器可以使用以下形狀：

```json
{
  "workspaceStrategy": {
    "type": "isolated_checkout",
    "provider": "adapter_managed",
    "baseRef": "origin/main",
    "branchTemplate": "{{issue.identifier}}-{{slug}}"
  }
}
```

重要的一點是，`git_worktree`是可以使用它的適配器的策略值，而不是通用合約。

### 工作區運行時服務

不要將其建模為 Paperclip 特定的 `devServer` 標誌。

相反，將其建模為工作區附加的運行時服務的通用清單。

形狀範例：

```json
{
  "workspaceRuntime": {
    "services": [
      {
        "name": "web",
        "description": "Primary app server for this workspace",
        "command": "pnpm dev",
        "cwd": ".",
        "env": {
          "DATABASE_URL": "${workspace.env.DATABASE_URL}"
        },
        "port": {
          "type": "auto"
        },
        "readiness": {
          "type": "http",
          "urlTemplate": "http://127.0.0.1:${port}/api/health"
        },
        "expose": {
          "type": "url",
          "urlTemplate": "http://127.0.0.1:${port}"
        },
        "reuseScope": "project_workspace",
        "lifecycle": "shared",
        "stopPolicy": {
          "type": "idle_timeout",
          "idleSeconds": 1800
        }
      }
    ]
  }
}
```

本合約故意是通用的：

- `command` 可以啟動任何工作區附加進程，而不僅僅是 Web 伺服器
- 資料庫重複使用是透過 env/config 注入來處理的，而不是特定於產品的特殊情況
- 本地和遠端適配器可以以不同的方式實現相同的服務意圖

### 服務意圖與服務實現

Paperclip 應區分：

- **服務意圖**：工作區需要什麼樣的配對運行時
- **服務實作**：本地或遠端適配器如何實際啟動並公開它

範例：

- 本地適配器：
  - 開始 `pnpm dev`
  - 分配一個空閒的主機端口
  - 健康檢查本地主機 URL
  - 報告 `{ pid, port, url }`
- 雲端沙箱轉接器：
  - 在沙箱內啟動預覽過程
  - 接收提供者預覽 URL
  - 報告 `{ sandboxId, previewUrl }`
- 託管遠端編碼智能體：
  - 可能會要求提供者建立預覽環境
  - 報告提供者本機工作區/服務元數據

Paperclip 應該規範報告的元數據，而不要求每個適配器看起來像主機本地進程。

透過 `packages/shared/src/types/issue.ts` 中現有的 `assigneeAdapterOverrides` 形狀保持問題等級覆蓋成為可能。

## 分層職責

### Paperclip 核心Paperclip 核心應該：

- 解決基礎專案工作區的問題
- 解析或請求執行工作空間
- 配置後解析或請求工作區運行時服務
- 將執行工作區元資料注入運行上下文
- 保留足夠的元資料以供板可見性和清理
- 在需要時管理運行開始/結束的生命週期掛鉤

Paperclip 核心不應：

- 需要所有智能體的工作樹
- 假設每個適配器都是本地的並且由 git 支持
- 假設每個執行時間服務都是具有 PID 的本機主機進程
- 將特定於工具的工作樹提示編碼為核心產品行為

### 共享本機運行時助手

共享伺服器端助手應該處理本地 git 機制：

- 驗證倉庫根
- 建立/選擇分支
- 建立/選擇 git 工作樹
- 分配一個空閒端口
- 可選擇啟動並追蹤開發伺服器
- 返回`{ cwd, branchName, url }`

該助手可以透過以下方式重複使用：

- `codex_local`
- `claude_local`
- 未來的本機適配器，例如 Cursor/OpenCode 等效項

此幫助程序僅適用於本機適配器。不應透過主機本機 git 幫助程式強制遠端適配器。

### 共用執行時間服務管理器

除了本地 git 助手之外，Paperclip 還應該定義一個通用的執行時間服務管理員合約。

它的工作是：

- 決定是否應重複使用已設定的服務或重新啟動
- 在需要時分配本機連接埠
- 當適配器/運行時實現是主機本地時啟動並監視本地進程
- 記錄標準化服務元資料以用於遠端實現
- 運轉準備檢查
- 提供董事會服務 URL 和狀態
- 應用關閉政策

此管理器不應硬編碼為“開發伺服器”。它應該適用於任何長期存在的工作區伴隨進程。

### 適配器

適配器應該：

- 接受已解析的執行cwd
- 或在沒有可用的主機 cwd 時接受結構化執行工作區意圖
- 當服務編排委託給適配器時接受結構化工作區運作時服務意圖
- 使用特定於適配器的標誌啟動其工具
- 保持自己的會話連續性語義

例如：

- `codex_local`：在cwd內運行，可能與`--cd`或進程cwd一起運行
- `claude_local`：在cwd內運行，如果有幫助，可以選擇使用`--worktree`
- 遠端沙箱適配器：從 repo/ref/branch 意圖建立自己的隔離工作區，並將實現的遠端工作區元資料回報回 Paperclip

對於運行時服務：

- 本機適配器或共用主機管理員：啟動本機進程並返回主機本機元數據
- 遠端適配器：建立或重複使用遠端預覽/服務並傳回規範化的遠端元資料

## 新增最少的資料模型

暫時不要建立完全一流的 `worktrees` 表。透過記錄有關運行、問題或兩者的派生執行工作區元數據，從小規模開始。

建議引入的領域：

- `executionWorkspaceStrategy`
- `executionWorkspaceCwd`
- `executionBranchName`
- `executionWorkspaceStatus`
- `executionServiceRefs`
- `executionCleanupStatus`

這些可以首先存在於 `heartbeat_runs.context_snapshot` 或相鄰的運行元資料上，如果 UI 和清理工作流程證明合理，則可以選擇稍後移至專用表中。

特別是對於運行時服務，Paperclip 最終應該追蹤規範化字段，例如：

- `serviceName`
- `serviceKind`
- `scopeType`
- `scopeId`
- `status`
- `command`
- `cwd`
- `envFingerprint`
- `port`
- `url`
- `provider`
- `providerRef`
- `startedByRunId`
- `ownerAgentId`
- `lastUsedAt`
- `stopPolicy`
- `healthStatus`

如果需要，第一個實作可以將其保留在運行元資料中，但長期形狀是通用運行時服務註冊表，而不是一次性伺服器 URL 欄位。

## 具體實施方案

## 第一階段：定義共享合約

1. 在`packages/shared`中引入共享執行工作空間策略合約。
2. 新增適配器配置架構支援：
   - `workspaceStrategy.type`
   - `baseRef`
   - `branchTemplate`
   - `worktreeParentDir`
   - `cleanupPolicy`
   - 可選的工作區運行時服務設定
3. 保持現有的 `useProjectWorkspace` 標誌作為較低的兼容性控制。
4. 將本機實作欄位與通用意圖欄位區分開，以便遠端適配器不會被迫使用主機 cwd 值。
5. 定義通用 `workspaceRuntime.services[]` 合約：
   - 服務名稱
   - 命令或提供者管理的意圖
   - 環境覆蓋
   - 準備狀況檢查
   - 曝光元數據
   - 重複使用範圍
   - 生命週期
   - 停止政策

驗收：

- 適配器配置可以表示`project_primary`和`git_worktree`
- 配置仍然是可選的並且向後相容
- 執行時間服務一般表示，而非 Paperclip-only 開發伺服器標誌

## 第 2 階段：解決 Heartbeat 中的執行工作空間

1. 擴展心跳工作區分辨率，使其能夠返回更豐富的執行工作區結果。
2. 保持目前的後備順序，但區分：
   - 基礎專案工作區
   - 派生執行工作空間
3. 將解析的執行工作空間詳細資訊注入到本機適配器的 `context.paperclipWorkspace` 中，以及需要結構化遠端實現的適配器的通用執行工作空間意圖負載中。
4. 與執行工作區一起解析配置的執行時間服務意圖，以便適配器或主機管理員接收完整的工作區執行時間合約。

主要接觸點：

- `server/src/services/heartbeat.ts`

驗收：

- 未配置策略時，運行仍保持不變
- 已解決的上下文清楚地表明哪個策略產生了 CWD

## 第 3 階段：新增共用本機 Git 工作區助手1. 為本機儲存庫簽出原則建立伺服器端幫助程式模組。
2、實施`git_worktree`策略：
   - 在基礎工作區 cwd 驗證 git 儲存庫
   - 從問題中取得分支名稱
   - 建立或重複使用工作樹路徑
   - 乾淨地偵測碰撞
3. 返回結構化元資料：
   - 最終的CWD
   - 分行名稱
   - 工作樹路徑
   - 回購根

驗收：

- 助手可以在單一適配器之外重複使用
- 工作樹的創建對於給定的問題/配置是確定性的
- 遠端適配器不受此幫助程式的影響

## 第 4 階段：可選的開發伺服器生命週期

從概念上講，將此階段重新命名為 **工作區運行時服務生命週期**。

1. 在建立執行工作區時新增可選的運行時服務啟動。
2. 同時支持：
   - 主機管理的本機服務
   - 適配器管理的遠端服務
3. 對於本地服務：
   - 在需要時在啟動前分配一個空閒端口
   - 在正確的cwd中啟動配置的命令
   - 運轉準備檢查
   - 註冊已實現的元數據
4. 對於遠端服務：
   - 讓適配器在配置後返回規範化的服務元數據
   - 不假設 PID 或本地主機訪問
5. 使用服務 URL 和標籤發佈或更新問題可見元資料。

驗收：

- 運行時服務啟動仍然是選擇加入
- 失敗產生可操作的運行日誌並發出評論
- 適當時可以透過 env/config 注入重複使用相同的嵌入式 DB / Paperclip 實例
- 遠端服務實作無需假裝是本地進程即可表示

## 第 5 階段：執行時期服務重複使用、追蹤和關閉1.引入通用運行時服務註冊中心。
2. 應追蹤每項服務：
   - `scopeType`: `project_workspace | execution_workspace | run | agent`
   - `scopeId`
   - `serviceName`
   - `status`
   - `command` 或提供者元數據
   - `cwd`（如果是本地）
   - `envFingerprint`
   - `port`
   - `url`
   - `provider` / `providerRef`
   - `ownerAgentId`
   - `startedByRunId`
   - `lastUsedAt`
   - `stopPolicy`
3. 引入一個確定性的`reuseKey`，例如：
   - `projectWorkspaceId + serviceName + envFingerprint`
4. 重複使用政策：
   - 如果存在具有相同重複使用金鑰的健康服務，則附加到它
   - 否則啟動新服務
5. 區分生命週期類別：
   - `shared`：可跨運行重複使用，通常範圍為 `project_workspace`
   - `ephemeral`：綁定到 `execution_workspace` 或 `run`
6. 停工政策：
   - `run`範圍：運轉結束時停止
   - `execution_workspace` 範圍：清理工作區時停止
   - `project_workspace` 範圍：空閒逾時、明確停止或工作區刪除時停止
   - `agent` 範圍：所有權轉讓或智能體政策要求時停止
7. 衛生政策：
   - 啟動時的準備檢查
   - 定期或按需活性檢查
   - 盡可能在殺死前標記不健康

驗收：

- Paperclip 可以確定性地決定是否重複使用或啟動新服務
- 本地和遠端服務共享標準化的追蹤模型
- 關閉是政策驅動的而不是隱性的
- 董事會可以理解為什麼服務被保留、重複使用或停止

## 第 6 階段：適配器集成

1. 更新 `codex_local` 以使用已解析的執行工作區 cwd。
2. 更新 `claude_local` 以使用已解析的執行工作區 cwd。
3. 為接收執行工作區意圖而非主機本地 cwd 的遠端適配器定義規範化適配器協定。
4. 選擇性地允許使用本機 `--worktree` 的 Claude 特定最佳化路徑，但保持共用伺服器端簽出策略作為本機適配器的規格。
5. 定義適配器如何返回執行時間服務實作：
   - 本地主機管理服務參考
   - 遠端供應商管理的服務參考

驗收：

- 當策略不存在時，適配器行為保持不變
- 會話恢復仍然是 CWD 安全的
- 沒有適配器被強制進入 git 行為
- 遠端適配器可以實現等效隔離，而無需假裝是本地工作樹
- 適配器可以以規範化的形式報告服務 URL 和生命週期元數據

## 第 7 階段：可見性與問題評論1. 在運行詳細資訊中公開執行工作區元數據，並可選擇發出詳細資訊 UI：
   - 策略
   - CWD
   - 分公司
   - 運行時服務參考
2. 透過以下方式公開運行時服務：
   - 服務名稱
   - 狀態
   - 網址
   - 範圍
   - 業主
   - 健康
3. 當工作樹支援或遠端隔離運行啟動時新增標準問題註解輸出：
   - 分公司
   - 工作樹路徑
   - 服務 URL（如果存在）

驗收：

- 董事會可以看到智能體在哪裡工作
- 董事會可以看到該工作區有哪些運行時服務
- 問題線程成為分支名稱和可到達 URL 的交接面

## 第 8 階段：清理政策

1. 實施清理政策：
   - `manual`
   - `on_done`
   - `on_merged`
2. 對於工作樹清理：
   - 如果屬於工作空間生命週期，則停止追蹤的運行時服務
   - 刪除工作樹
   - 合併後可選擇刪除本機分支
3. 從保守的預設值開始：
   - 除非明確配置，否則不要自動刪除任何內容

驗收：

- 預設清理是安全且可逆的
- 基本生命週期穩定後可以引入基於合併的清理

## 第 9 階段：驗證人體工學後續行動

這是相關的，但應與工作區策略工作分開追蹤。

需要改進：

- 使手動本機智能體引導在身份驗證/私有模式下更容易，因此操作員可以在本地成為 `codexcoder` 或 `claudecoder` ，而無需依賴已建立的瀏覽器身份驗證 CLI 上下文

這可能應該採取本地操作員引導流程的形式，而不是削弱運行時身份驗證邊界。

## 推出策略

1. 首先發送共享配置合約和無操作相容的心跳變更。
2. 僅使用 `codexcoder` 和 `claudecoder` 進行試點。
3. 首先針對 Paperclip-on-Paperclip 工作流程進行測試。
4. 將 `project_primary` 保留為所有現有智能體程式的預設值。
5. 僅在核心運行時路徑穩定後添加UI暴露和清理。

## 驗收標準1. 工作樹行為是可選的，不是全域要求。
2. 專案工作區仍然是規範的儲存庫錨點。
3. 本機編碼智能體程式可以選擇進入隔離的問題範圍執行工作區。
4. 相同的模型適用於 `codex_local` 和 `claude_local`，而無需將特定於工具的抽象強製到核心中。
5. 遠端適配器可以使用相同的執行工作區意圖，而不需要主機本機檔案系統存取。
6. 會話連續性保持正確，因為每個適配器都相對於其實現的執行工作空間恢復。
7. 工作區運行時服務是通用建模的，而不是 Paperclip 特定的開發伺服器切換。
8. Board 使用者可以查看工作樹支援或遠端隔離運行的分支/路徑/URL 資訊。
9. 服務重用和關閉是確定性的和策略驅動的。
10. 預設清理是保守的。

## 建議的初始範圍

為了保持這個易於處理，第一次實現應該：

- 僅支援本地編碼適配器
- 僅支援 `project_primary` 和 `git_worktree`
- 避免為工作樹使用新的專用資料庫表
- 從單一主機管理的執行階段服務實作路徑開始
- 推遲合併驅動的清理自動化，直到證明基本的啟動/運行/可見性之後

這足以驗證本地產品形狀，而不會過早凍結錯誤的抽象。

驗證後的後續擴展：

- 為適配器管理的隔離結帳定義遠端適配器契約
- 新增一個雲端/沙盒適配器實作路徑
- 規範化已實現的元數據，以便本地和遠端執行工作空間在 UI 中顯示相似
- 將運行時服務註冊表從本機主機管理的服務擴展到遠端適配器管理的服務
