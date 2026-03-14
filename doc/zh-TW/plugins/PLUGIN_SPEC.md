# Paperclip 插件系統規範

狀態：V1 後插件系統的完整規格建議

本文檔是Paperclip外掛程式和擴充架構的完整規格。
它擴展了 [doc/SPEC.md](../SPEC.md) 中的簡短插件註釋，並且應該與 [doc/plugins/ideas-from-opencode.md](ideas-from-opencode.md) 中的比較分析一起閱讀。

這不是 [doc/SPEC-implementation.md](../SPEC-implementation.md) 中 V1 實現合約的一部分。
這是應該遵循 V1 的插件系統的完整目標架構。

## 1.範圍

該規範涵蓋：

- 插件打包和安裝
- 運行時模型
- 信任模型
- 能力系統
- UI 擴充介面
- 插件設定使用者介面
- 智能體工具貢獻
- 事件、作業和 Webhook 介面
- 插件到插件的通信
- 工作區外掛程式的本機工具方法
- 用於擴展的 Postgres 持久性
- 卸載和資料生命週期
- 插件可觀察性
- 外掛程式開發和測試
- 操作員工作流程
- 熱插件生命週期（無需重新啟動伺服器）
- SDK版本控制和相容性規則

本規範不涵蓋：

- 公共市場
- 雲端/SaaS 多租戶
- 第一個外掛程式版本中的任意第三方架構遷移
- 第一個插件版本中的 iframe-sandboxed 插件 UI（插件在主機擴充插槽中呈現為 ES 模組）

## 2. 核心假設

Paperclip插件設計基於以下假設：

1. Paperclip是單一租戶、自架的。
2. 插件安裝對於實例是全域的。
3. 「公司」仍然是核心Paperclip業務對象，但它們不是插件信任邊界。
4. 董事會治理、審批門、預算硬停止和核心任務不變性仍由 Paperclip 核心擁有。
5. 專案已經透過 `project_workspaces` 擁有一個真實的工作區模型，本地/運行時插件應該在此基礎上構建，而不是發明一個單獨的工作區抽象。

## 3. 目標

插件系統必須：

1. 讓運營商安裝全域實例範圍的插件。
2. 讓外掛程式新增主要功能而無需編輯Paperclip核心。
3. 保持核心治理和審計完好無損。
4. 支援本地/運行時插件和外部 SaaS 連接器。
5. 支援未來的插件類別，例如：
   - 新的智能體適配器
   - 收入追蹤
   - 知識庫
   - 問題追蹤器同步
   - 指標/控制台
   - 文件/專案工具
6. 使用簡單、明確、類型化的合約。
7. 保持故障隔離，這樣一個插件就不會導致整個實例崩潰。

## 4. 非目標

第一個插件系統不得：1. 允許任意插件覆蓋核心路由或核心不變量。
2. 允許任意外掛程式改變核准、授權、問題結帳或預算執行邏輯。
3. 允許任意第三方外掛程式運行自由格式的資料庫遷移。
4. 依賴專案本地插件資料夾，例如`.paperclip/plugins`。
5. 依賴伺服器啟動時從任意設定檔自動安裝和執行的行為。

## 5. 術語

### 5.1 實例

操作員安裝和控制的單一 Paperclip 部署。

### 5.2 公司

實例內有一個一流的 Paperclip 業務物件。

### 5.3 專案工作區

透過 `project_workspaces` 附加到專案的工作區。
外掛程式從此模型解析工作空間路徑，以尋找檔案、終端、git 和流程操作的本機目錄。

### 5.4 平台模組

由 Paperclip 核心直接載入的可信任進程內擴充。

範例：

- 智能體適配器
- 儲存提供者
- 秘密提供者
- 運行日誌後端

### 5.5 插件

透過 Paperclip 外掛程式運行時載入的可安裝實例範圍擴充包。

範例：

- 線性同步
- GitHub 問題同步
- Grafana 小部件
- Stripe收入同步
- 文件瀏覽器
- 終端
- git工作流程

### 5.6 外掛工作者

用於插件的運行時進程。
在此規範中，第三方插件預設在進程外運行。

### 5.7 能力

主機授予插件的命名權限。
插件只能呼叫授予功能所涵蓋的主機 API。

## 6. 擴充類

Paperclip 有兩個擴充類別。

## 6.1 平台模組

平台模組有：

- 值得信賴
- 處理中
- 主機集成
- 低級

他們使用明確註冊表，而不是一般的插件工作協議。

平台模組表面：

- `registerAgentAdapter()`
- `registerStorageProvider()`
- `registerSecretProvider()`
- `registerRunLogStore()`

平台模組適合：

- 新的智能體適配器包
- 新的儲存後端
- 新的秘密後端
- 其他需要直接進程或資料庫整合的主機內部系統

## 6.2 插件

插件有：

- 每個實例全域安裝
- 透過插件運行時加載
- 添加劑
- 能力門控
- 透過穩定的 SDK 和主機協定與核心隔離

插件類別：

- `connector`
- `workspace`
- `automation`
- `ui`

一個插件可以聲明多個類別。

## 7. 專案工作區

Paperclip 已經有一個特定的工作空間模型：

- 項目曝光 `workspaces`
- 項目曝光`primaryWorkspace`
- 資料庫包含`project_workspaces`
- 專案路線已經管理工作區需要本地工具（檔案瀏覽、git、終端、進程追蹤）的插件可以透過專案工作區 APIs 解析工作區路徑，然後對檔案系統進行操作、產生進程並直接執行 git 命令。主機不包裝這些操作——插件擁有自己的實作。

## 8. 安裝模型

插件安裝是全域的且由操作員驅動。

沒有每家公司的安裝表，也沒有每家公司的啟用/停用開關。

如果插件需要特定於業務物件的映射，則這些映射將儲存為插件配置或插件狀態。

範例：

- 安裝一個全域線性插件
- 從 A 公司到 Linear 團隊 X 以及從 B 公司到 Linear 團隊 Y 的映射
- 安裝一個全域 git 插件
- 每個項目的工作空間狀態儲存在 `project_workspace` 下

## 8.1 磁碟佈局

插件位於 Paperclip 實例目錄下。

建議佈局：

- `~/.paperclip/instances/default/plugins/package.json`
- `~/.paperclip/instances/default/plugins/node_modules/`
- `~/.paperclip/instances/default/plugins/.cache/`
- `~/.paperclip/instances/default/data/plugins/<plugin-id>/`

包安裝目錄和插件資料目錄是分開的。

## 8.2 操作員命令

Paperclip 應新增 CLI 指令：

- `pnpm paperclipai plugin list`
- `pnpm paperclipai plugin install <package[@version]>`
- `pnpm paperclipai plugin uninstall <plugin-id>`
- `pnpm paperclipai plugin upgrade <plugin-id> [version]`
- `pnpm paperclipai plugin doctor <plugin-id>`

這些命令是實例級操作。

## 8.3 安裝過程

安裝過程是：

1. 解決npm套件和版本。
2. 安裝到實例插件目錄。
3. 閱讀並驗證外掛程式清單。
4. 拒絕不相容的插件API版本。
5. 向操作員顯示請求的功能。
6. 在 Postgres 中保留安裝記錄。
7. 啟動插件工作程序並執行運行狀況/驗證。
8. 標記插件`ready`或`error`。

## 9. 載入順序與優先權

載入順序必須是確定性的。

1. 核心平台模組
2. 內建第一方插件
3. 安裝的插件排序方式：
   - 明確的操作員配置的順序（如果存在）
   - 否則顯示 `id`

規則：

- 插件貢獻預設是累積的
- 插件不得透過名稱衝突覆蓋核心路由或核心操作
- UI 插槽 ID 自動按插件 ID 命名（例如 `@paperclip/plugin-linear:sync-health-widget`），因此跨插件衝突在結構上是不可能的
- 如果單一外掛程式在其自己的清單中聲明重複的插槽 ID，則主機必須在安裝時拒絕

## 10. 打包合約

每個插件包必須匯出一個清單、一個工作入口點和一個可選的 UI 包。

建議的封裝佈局：

- `dist/manifest.js`
- `dist/worker.js`
- `dist/ui/`（可選，包含插件的前端套件）

建議的 `package.json` 鍵：

```json
{
  "name": "@paperclip/plugin-linear",
  "version": "0.1.0",
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js",
    "ui": "./dist/ui/"
  }
}
```

## 10.1 清單形狀

規範的明顯形狀：

```ts
export interface PaperclipPluginManifestV1 {
  id: string;
  apiVersion: 1;
  version: string;
  displayName: string;
  description: string;
  categories: Array<"connector" | "workspace" | "automation" | "ui">;
  minimumPaperclipVersion?: string;
  capabilities: string[];
  entrypoints: {
    worker: string;
    ui?: string;
  };
  instanceConfigSchema?: JsonSchema;
  jobs?: PluginJobDeclaration[];
  webhooks?: PluginWebhookDeclaration[];
  tools?: Array<{
    name: string;
    displayName: string;
    description: string;
    parametersSchema: JsonSchema;
  }>;
  ui?: {
    slots: Array<{
      type: "page" | "detailTab" | "dashboardWidget" | "sidebar" | "settingsPage";
      id: string;
      displayName: string;
      /** Which export name in the UI bundle provides this component */
      exportName: string;
      /** For detailTab: which entity types this tab appears on */
      entityTypes?: Array<"project" | "issue" | "agent" | "goal" | "run">;
    }>;
  };
}
```

規則：- `id` 必须是全局唯一的
- `id` 通常应等于 npm 包名称
- `apiVersion` 必須與主機支援的插件 API 版本匹配
- `capabilities` 必須是靜態的且安裝時可見
- 設定模式必須與 JSON 模式相容
- `entrypoints.ui` 指向包含建置的 UI 套件的目錄
- `ui.slots` 聲明外掛程式填入哪些擴充槽，因此主機知道要安裝什麼，而無需急切地載入捆綁包；每個插槽引用 UI 包中的 `exportName`

## 11. 智能體工具

插件可能會提供 Paperclip 智能體程式在運行期間可以使用的工具。

### 11.1 工具聲明

插件在其清单中声明工具：

```ts
tools?: Array<{
  name: string;
  displayName: string;
  description: string;
  parametersSchema: JsonSchema;
}>;
```

工具名稱在運行時自動按插件 ID 命名（例如 `linear:search-issues`），因此外掛程式無法隱藏核心工具或彼此的工具。

### 11.2 工具執行

當智能體程式在運行期間呼叫插件工具時，主機透過 `executeTool` RPC 方法將呼叫路由到插件工作程序：

- `executeTool(input)` — 接收工具名稱、解析的參數和運作上下文（智能體 ID、運行 ID、公司 ID、專案 ID）

工作人員執行工具邏輯並傳回類型化結果。主機強制執行功能門 - 插件必須聲明 `agent.tools.register` 才能貢獻工具，並且各個工具可能需要額外的功能（例如，調用外部 API 的工具需要 `http.outbound`）。

### 11.3 工具可用性

預設情況下，插件工具可供所有智能體程式使用。操作員可以透過外掛程式配置限制每個智能體程式或每個項目的工具可用性。

插件工具與核心工具一起出現在智能體的工具清單中，但在 UI 中以視覺方式區分為插件提供的工具。

### 11.4 約束

- 插件工具不得以名稱覆蓋或隱藏核心工具。
- 插件工具必须尽可能是幂等的。
- 工具執行與其他外掛程式工作程序呼叫一樣受到相同的逾時和資源限制。
- 工具结果包含在运行日志中。

## 12. 運行時模型

## 12.1 過程模型

第三方插件默认在进程外运行。

預設運行時間：

- Paperclip 伺服器為每個安裝的插件啟動一個工作進程
-工作进程是一个Node进程
- 主機和工作人員透過 stdio 上的 JSON-RPC 進行通信

設計提供：

- 故障隔離
- 更清晰的记录边界
- 更简单的资源限制
- 比任意進程內執行更清晰的信任邊界

## 12.2 主持人職責

主辦單位負責：

- 套件安裝
- 清單驗證
- 能力執行
- 過程監督
- 作業調度
- 網路鉤子路由
- 活動日誌寫入
- 秘密決議
- UI路由註冊

## 12.3 工人的責任

外掛工作者負責：- 驗證自己的配置
- 處理領域事件
- 處理預定的作業
- 處理網路鉤子
- 透過 `getData` 和 `performAction` 為插件自己的 UI 提供資料和處理操作
- 透過SDK呼叫主機服務
- 報告健康資訊

## 12.4 失敗策略

如果工人失敗：

- 標記插件狀態 `error`
- 插件運行狀況 UI 中出現表面錯誤
- 保持實例的其餘部分運行
- 以有界退避重試開始
- 不要刪除其他外掛程式或核心服務

## 12.5 優雅關閉策略

當主機需要停止插件工作程序時（用於升級、卸載或實例關閉）：

1. Host發送`shutdown()`給Worker。
2. 工作人員有 10 秒的時間完成飛行中的工作並乾淨俐落地退出。
3. 如果worker沒有在期限內退出，則主機發送SIGTERM。
4. 如果worker在SIGTERM後5秒內沒有退出，則主機發送SIGKILL。
5. 任何正在進行的作業運行都標記為 `cancelled`，並附有指示強制關閉的註釋。
6. 任何正在進行的 `getData` 或 `performAction` 呼叫都會向橋接器傳回錯誤。

對於需要更長耗盡時間的插件，關閉截止時間應該可以在插件配置中針對每個插件進行配置。

## 13. 主機-工作協議

主機必須支援以下工作 RPC 方法。

所需方法：

- `initialize(input)`
- `health()`
- `shutdown()`

可選方法：

- `validateConfig(input)`
- `configChanged(input)`
- `onEvent(input)`
- `runJob(input)`
- `handleWebhook(input)`
- `getData(input)`
- `performAction(input)`
- `executeTool(input)`

### 13.1 `initialize`

在工作進程啟動時呼叫一次。

輸入包括：

- 外掛程式清單
- 解決了插件配置
- 實例資訊
- 主機API版本

### 13.2 `health`

返回：

- 狀態
- 當前錯誤（如果有）
- 可選外掛報告的診斷

### 13.3 `validateConfig`

在配置變更和啟動後運行。

返回：

- `ok`
- 警告
- 錯誤

### 13.4 `configChanged`

當操作員在運行時更新插件的實例配置時呼叫。

輸入包括：

- 新解決的配置

如果工作人員實作此方法，它將套用新配置而無需重新啟動。如果工作進程沒有實作此方法，主機將使用新配置重新啟動工作進程（正常關閉然後重新啟動）。

### 13.5 `onEvent`

接收一個類型為 Paperclip 的域事件。

傳遞語意：

- 至少一次
- 插件必須是冪等的
- 不保證所有活動類型的全域排序
- 每個實體的排序是盡力而為，但重試後不能保證

### 13.6 `runJob`

執行已宣告的預定作業。

樓主提供：

- 工作鑰匙
- 觸發來源
- 運行ID
- 安排元數據

### 13.7 `handleWebhook`

接收主機路由的入站 Webhook 負載。

樓主提供：- 端點金鑰
- 標題
- 原始身體
- 解析正文（如果適用）
- 請求ID

### 13.8 `getData`

返回插件自己的 UI 元件請求的插件資料。

插件 UI 呼叫主機橋，主機橋將請求轉送給工作執行緒。工作程序傳回插件自己的前端元件渲染的類型為 JSON 的值。

輸入包括：

- 資料金鑰（外掛程式定義，例如`"sync-health"`、`"issue-detail"`）
- 上下文（公司 ID、專案 ID、實體 ID 等）
- 可選的查詢參數

### 13.9 `performAction`

運行由板 UI 發起的明確插件操作。

範例：

- “立即重新同步”
-“連結GitHub問題”
- “從問題創建分支”
- “重新啟動進程”

### 13.10 `executeTool`

在運行期間運行插件提供的智能體工具。

樓主提供：

- 工具名稱（不含外掛名稱空間前綴）
- 與工具宣告的模式相符的解析參數
- 運行上下文：智能體 ID、運行 ID、公司 ID、專案 ID

工作人員執行該工具並傳回類型化結果（字串內容、結構化資料或錯誤）。

## 14. SDK 表面

插件不直接與資料庫對話。
插件不會從持久配置中讀取原始秘密材料。

向工作人員公開的 SDK 必須提供類型化的主機用戶端。

所需的 SDK 客戶端：

- `ctx.config`
- `ctx.events`
- `ctx.jobs`
- `ctx.http`
- `ctx.secrets`
- `ctx.assets`
- `ctx.activity`
- `ctx.state`
- `ctx.entities`
- `ctx.projects`
- `ctx.issues`
- `ctx.agents`
- `ctx.goals`
- `ctx.data`
- `ctx.actions`
- `ctx.tools`
- `ctx.logger`

`ctx.data` 和 `ctx.actions` 註冊插件自己的 UI 透過主機橋接器呼叫的處理程序。 `ctx.data.register(key, handler)` 在前端支援 `usePluginData(key)`。 `ctx.actions.register(key, handler)`支援`usePluginAction(key)`。

需要檔案系統、git、終端或進程操作的插件直接使用標準 Node API 或函式庫來處理這些操作。主機透過 `ctx.projects` 提供專案工作區元數據，以便插件可以解析工作區路徑，但主機不智能體低階作業系統操作。

## 14.1 SDK 形狀範例

```ts
/** Top-level helper for defining a plugin with type checking */
export function definePlugin(definition: PluginDefinition): PaperclipPlugin;

/** Re-exported from Zod for config schema definitions */
export { z } from "zod";

export interface PluginContext {
  manifest: PaperclipPluginManifestV1;
  config: {
    get(): Promise<Record<string, unknown>>;
  };
  events: {
    on(name: string, fn: (event: unknown) => Promise<void>): void;
    on(name: string, filter: EventFilter, fn: (event: unknown) => Promise<void>): void;
    emit(name: string, payload: unknown): Promise<void>;
  };
  jobs: {
    register(key: string, input: { cron: string }, fn: (job: PluginJobContext) => Promise<void>): void;
  };
  state: {
    get(input: ScopeKey): Promise<unknown | null>;
    set(input: ScopeKey, value: unknown): Promise<void>;
    delete(input: ScopeKey): Promise<void>;
  };
  entities: {
    upsert(input: PluginEntityUpsert): Promise<void>;
    list(input: PluginEntityQuery): Promise<PluginEntityRecord[]>;
  };
  data: {
    register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void;
  };
  actions: {
    register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void;
  };
  tools: {
    register(name: string, input: PluginToolDeclaration, fn: (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>): void;
  };
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface EventFilter {
  projectId?: string;
  companyId?: string;
  agentId?: string;
  [key: string]: unknown;
}
```

## 15. 能力模型

能力是強制性的和靜態的。
每個插件都會預先聲明它們。

主機強制執行 SDK 層中的功能，並拒絕授權集以外的呼叫。

## 15.1 能力類別

### 資料讀取

- `companies.read`
- `projects.read`
- `project.workspaces.read`
- `issues.read`
- `issue.comments.read`
- `agents.read`
- `goals.read`
- `activity.read`
- `costs.read`

### 資料寫入

- `issues.create`
- `issues.update`
- `issue.comments.create`
- `assets.write`
- `assets.read`
- `activity.log.write`
- `metrics.write`

### 外掛程式狀態

- `plugin.state.read`
- `plugin.state.write`

### 運行時/集成

- `events.subscribe`
- `events.emit`
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`

### 智能體工具

- `agent.tools.register`

### 使用者介面- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register`
- `ui.dashboardWidget.register`
- `ui.action.register`

## 15.2 禁止的能力

主機不得公開以下功能：

- 批准決定
- 預算超控
- 驗證繞過
- 問題結帳鎖定覆蓋
- 直接資料庫訪問

## 15.3 升級規則

如果外掛程式升級新增了功能：

1. 宿主必須標記插件`upgrade_pending`
2. 運營商必須明確批准新的能力集
3. 審核完成後新版本不會變成`ready`

## 16. 事件系統

主機必須發出插件可以訂閱的類型化域事件。

最小事件集：

- `company.created`
- `company.updated`
- `project.created`
- `project.updated`
- `project.workspace_created`
- `project.workspace_updated`
- `project.workspace_deleted`
- `issue.created`
- `issue.updated`
- `issue.comment.created`
- `agent.created`
- `agent.updated`
- `agent.status_changed`
- `agent.run.started`
- `agent.run.finished`
- `agent.run.failed`
- `agent.run.cancelled`
- `approval.created`
- `approval.decided`
- `cost_event.created`
- `activity.logged`

每個事件必須包括：

- 事件ID
- 事件類型
- 發生於
- 適用時演員元數據
- 主要實體元數據
- 輸入有效負載

### 16.1 事件過濾

插件可以在訂閱事件時提供可選的過濾器。過濾器在分派給工作執行緒之前由主機進行評估，因此過濾掉的事件永遠不會跨越進程邊界。

支援的過濾欄位：

- `projectId` — 僅接收特定項目的事件
- `companyId` — 僅接收特定公司的事件
- `agentId` — 僅接收特定智能體的事件

過濾器是可選的。如果省略，插件將接收訂閱類型的所有事件。過濾器可以組合（例如按公司和項目過濾）。

### 16.2 外掛到外掛事件

插件可以使用 `ctx.events.emit(name, payload)` 發出自訂事件。插件發出的事件使用命名空間事件類型：`plugin.<pluginId>.<eventName>`。

其他外掛程式可以使用相同的 `ctx.events.on()` API 訂閱這些事件：

```ts
ctx.events.on("plugin.@paperclip/plugin-git.push-detected", async (event) => {
  // react to the git plugin detecting a push
});
```

規則：

- 插件事件需要 `events.emit` 功能。
- 插件事件不是核心域事件 - 它們不會出現在核心活動日誌中，除非發出插件明確記錄它們。
- 插件事件遵循與核心事件相同的至少一次傳遞語意。
- 主機不得允許插件在核心命名空間中發出事件（沒有 `plugin.` 前綴的事件）。

## 17. 預定作業

插件可以在其清單中宣告預定的作業。

崗位規則：

1. 每個職業都有穩定的`job_key`。
2. 主機是記錄的調度者。
3. 主機防止相同外掛程式/作業組合的重疊執行，除非稍後明確允許。
4. 每個作業運行都記錄在 Postgres 中。
5. 失敗的作業可以重試。

## 18. Webhooks

外掛程式可以在其清單中聲明 webhook 端點。Webhook 路由形狀：

- `POST /api/plugins/:pluginId/webhooks/:endpointKey`

規則：

1. 主機擁有公共路由。
2. Worker透過`handleWebhook`接收請求體。
3. 使用主機解析的秘密引用在插件程式碼中進行簽名驗證。
4. 每次交貨都有記錄。
5. Webhook 處理必須是冪等的。

## 19. UI 擴充模型

插件將自己的前端 UI 作為捆綁的 React 模組提供。主機將插件 UI 載入到指定的擴充插槽中，並為插件前端提供與其自己的工作後端和主機 API 通訊的橋樑。

### 外掛程式 UI 發布的實際工作原理

插件的 `dist/ui/` 目錄包含建置的 React 套件。當使用者導航到插件介面（插件頁面、詳細資料標籤、控制台小工具等）時，主機提供該捆綁包並將其載入到頁面中。

**主機提供，外掛程式渲染：**

1. 主機定義**擴充槽** - UI 中可以出現插件元件（頁面、標籤、小工具、側邊欄條目、操作列）的指定安裝點。
2. 插件的 UI 包為其想要填入的每個插槽匯出命名元件。
3. 主機將插件元件安裝到插槽中，並向其傳遞一個**主機橋**物件。
4. 插件元件使用橋從自己的worker獲取資料（透過`getData`），呼叫操作（透過`performAction`），讀取主機上下文（目前公司，項目，實體），並使用共享主機UI原語（設計令牌，公共元件）。

**具體範例：線性插件附帶控制台小工具。 **

該插件的 UI 包導出：

```tsx
// dist/ui/index.tsx
import { usePluginData, usePluginAction, MetricCard, StatusBadge } from "@paperclipai/plugin-sdk/ui";

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading } = usePluginData("sync-health", { companyId: context.companyId });
  const resync = usePluginAction("resync");

  if (loading) return <Spinner />;

  return (
    <div>
      <MetricCard label="Synced Issues" value={data.syncedCount} trend={data.trend} />
      {data.mappings.map(m => (
        <StatusBadge key={m.id} label={m.label} status={m.status} />
      ))}
      <button onClick={() => resync({ companyId: context.companyId })}>Resync Now</button>
    </div>
  );
}
```

**運行時會發生什麼：**

1. 使用者開啟控制台。主機看到 Linear 插件註冊了 `DashboardWidget` 導出。
2. 主機將插件的`DashboardWidget`組件掛載到控制台小部件槽中，傳遞`context`（目前公司、用戶等）和橋接器。
3. `usePluginData("sync-health", ...)` 通過橋接 → 主機 → 插件工作者的 `getData` RPC → 返回 JSON → 插件組件根據需要渲染它。
4. 當使用者點選「立即重新同步」時，`usePluginAction("resync")` 透過橋接器 → 主機 → 外掛程式工作者的 `performAction` RPC 進行呼叫。

**主機控制什麼：**

- 主機決定插件元件出現的**位置**（存在哪些插槽以及何時安裝）。
- 主機提供 **bridge** — 插件 UI 無法發出任意網路請求或直接存取主機內部。
- 主機強制執行 **能力門** - 如果外掛程式的工作人員不具備能力，則即使 UI 請求，橋接器也會拒絕呼叫。
- 主機透過 `@paperclipai/plugin-sdk/ui` 提供**設計令牌和共享元件**，因此外掛程式可以匹配主機的視覺語言而無需被迫。

**插件控制什麼：**- 插件決定**如何**呈現其資料 - 它擁有其 React 元件、佈局、互動和狀態管理。
- 外掛程式決定**哪些資料**要取得以及**哪些操作**要公開。
- 此插件可以在其捆綁包內使用任何 React 模式（掛鉤、上下文、第三方元件庫）。

### 19.0.1 外掛程式UI SDK (`@paperclipai/plugin-sdk/ui`)

SDK 包含插件前端匯入的 `ui` 子路徑匯出。此子路徑提供：

- **橋鉤**：`usePluginData(key, params)`、`usePluginAction(key)`、`useHostContext()`
- **設計標記**：與主機主題相符的顏色、間距、排版、陰影
- **共享元件**：`MetricCard`、`StatusBadge`、`DataTable`、`LogView`、`ActionBar`、`Spinner` 等。
- **模式定義**：`PluginPageProps`、`PluginWidgetProps`、`PluginDetailTabProps`

鼓勵但不強制使用外掛程式來使用共用元件。只要插件透過橋接通信，就可以呈現完全自訂的 UI。

### 19.0.2 捆綁包隔離

插件 UI 包作為標準 ES 模組加載，而不是 iframe。這為插件提供了完整的渲染性能並可以存取主機的設計令牌。

隔離規則：

- 插件包不得從主機內部匯入。它們只能從 `@paperclipai/plugin-sdk/ui` 及其自己的依賴項匯入。
- 插件包不得直接存取 `window.fetch` 或 `XMLHttpRequest` 來進行主機 API 呼叫。所有主機通訊都通過網橋。
- 主機可以強制執行內容安全性原則規則，僅限制外掛網路存取橋接端點。
- 插件包必須是可靜態分析的－插件自己的套件之外沒有動態 `import()` 的 URL。

如果以後需要更強的隔離，主機可以將不受信任的插件轉移到基於 iframe 的安裝，而無需更改插件的原始程式碼（橋 API 保持不變）。

### 19.0.3 捆綁服務

插件 UI 捆綁包必須預先建置 ESM。主機不會在執行時間編譯或轉換插件 UI 程式碼。

主機將插件的 `dist/ui/` 目錄作為命名空間路徑下的靜態資產提供服務：

- `/_plugins/:pluginId/ui/*`

當主機渲染擴充槽時，它會從此路徑動態匯入插件的UI入口模組，解析`ui.slots[].exportName`中宣告的命名匯出，並將其掛載到槽中。

在開發過程中，主機可能會在插件配置中支援 `devUiUrl` 覆蓋，該配置指向本地開發伺服器（例如 Vite），因此插件作者可以在開發過程中使用熱重載而無需重建。

## 19.1 全球營運商路線

- `/settings/plugins`
- `/settings/plugins/:pluginId`

這些路由是實例級的。

## 19.2 公司上下文路由

- `/:companyPrefix/plugins/:pluginId`

這些路線的存在是因為董事會 UI 是圍繞著公司組織的，即使插件安裝是全域的。

## 19.3 詳細資料選項卡插件可以將選項卡新增至：

- 項目細節
- 問題詳細信息
- 智能體詳細信息
- 目標細節
- 運行細節

推薦路線模式：

- `/:companyPrefix/<entity>/:id?tab=<plugin-tab-id>`

## 19.4 控制台小工具

插件可以將卡片或部分新增到控制台。

## 19.5 側邊欄條目

插件可以將側邊欄連結新增至：

- 全域插件設置
- 公司上下文外掛頁面

## 19.6 `@paperclipai/plugin-sdk/ui` 中的共用元件

主機 SDK 提供了共享元件，外掛程式可以匯入這些元件來快速建立與主機外觀相符的 UI。這些是方便的構建塊，而不是必需的。

|組件|它呈現什麼 |典型用途|
|---|---|---|
| `MetricCard` |帶標籤的單一數字，可選趨勢/迷你圖 | KPI、計數、比率 |
| `StatusBadge` |內聯狀態指示器（正常/警告/錯誤/訊息）|同步健康狀況、連線狀態 |
| `DataTable` |具有可選排序和分頁功能的行和列 |問題清單、作業歷史記錄、流程清單 |
| `TimeseriesChart` |帶有時間戳資料點的折線圖或長條圖 |收入趨勢、同步量、錯誤率 |
| `MarkdownBlock` |渲染的 Markdown 文字 |描述、幫助文字、註解 |
| `KeyValueList` |定義清單版面配置中的標籤/值對 |實體元資料、設定摘要 |
| `ActionBar` |連接到 `usePluginAction` 的一排按鈕 |重新同步、建立分支、重新啟動進程 |
| `LogView` |可滾動日誌輸出的時間戳記 | Webhook 交付、作業輸出、流程日誌 |
| `JsonTree` |用於調試的可折疊 JSON 樹 |原始 API 回應，插件狀態檢查 |
| `Spinner` |載入指示器 |資料取得狀態 |

插件也可以使用完全自訂的元件。共享元件的存在是為了減少樣板檔案並保持視覺一致性，而不是限制插件可以渲染的內容。

## 19.7 透過橋的誤差傳播

橋接鉤子必須傳回結構化錯誤，以便插件 UI 可以優雅地處理故障。

`usePluginData` 返回：

```ts
{
  data: T | null;
  loading: boolean;
  error: PluginBridgeError | null;
}
```

`usePluginAction` 傳回一個非同步函數，該函數要麼解析結果，要麼拋出 `PluginBridgeError`。

`PluginBridgeError` 形狀：

```ts
interface PluginBridgeError {
  code: "WORKER_UNAVAILABLE" | "CAPABILITY_DENIED" | "WORKER_ERROR" | "TIMEOUT" | "UNKNOWN";
  message: string;
  /** Original error details from the worker, if available */
  details?: unknown;
}
```

錯誤代碼：

- `WORKER_UNAVAILABLE` — 外掛程式工作程序未運作（當機、關閉、尚未啟動）
- `CAPABILITY_DENIED` — 此外掛程式不具備此操作所需的功能
- `WORKER_ERROR` — 工作執行緒從其 `getData` 或 `performAction` 處理程序傳回錯誤
- `TIMEOUT` — 工作執行緒在設定的逾時時間內沒有回應
- `UNKNOWN` — 意外的橋接級故障

`@paperclipai/plugin-sdk/ui` 子路徑也應該匯出 `ErrorBoundary` 元件，外掛程式作者可以使用該元件來擷取渲染錯誤，而不會導致主機頁面崩潰。

## 19.8 插件設定使用者介面每個在其清單中聲明 `instanceConfigSchema` 的插件都會在 `/settings/plugins/:pluginId` 處獲得自動產生的設定表單。主機根據 JSON 架構呈現表單。

自動產生的表單支援：

- 文字輸入、數字輸入、切換、從模式類型和枚舉派生的選擇下拉列表
- 呈現為字段集的嵌套對象
- 數組呈現為可重複的字段組，並帶有添加/刪除控件
- 秘密引用欄位：以 `"format": "secret-ref"` 註解的任何模式屬性都會呈現為秘密選擇器，透過 Paperclip 秘密提供者係統而不是純文字輸入進行解析
- 從模式約束衍生的驗證訊息（`required`、`minLength`、`pattern`、`minimum` 等）
- 如果外掛程式宣告 `validateConfig` RPC 方法，則「測試連線」操作 - 主機呼叫它並內聯顯示結果

對於需要超出 JSON Schema 所能表達的更豐富設定 UX 的插件，該插件可以在 `ui.slots` 中聲明一個 `settingsPage` 插槽。當存在時，主機呈現插件自己的 React 元件，而不是自動產生的表單。插件組件透過標準橋與其工作人員通訊以讀取和寫入配置。

兩種方法共存：外掛程式可以使用自動產生的表單進行簡單配置，並新增自訂設定頁面槽以進行進階配置或操作控制台。

## 20. 本地工具

需要檔案系統、git、終端或進程操作的插件直接實現這些操作。主機不包裝或智能體這些操作。

主機透過 `ctx.projects` 提供工作區元資料（列出工作區、取得主工作區、解決問題或智能體程式/運作中的工作區）。外掛程式使用此元資料來解析本機路徑，然後對檔案系統進行操作，產生進程，shell 到 `git`，或使用標準 Node API 或他們選擇的任何函式庫開啟 PTY 會話。

這使主機保持精簡——它不需要為插件可能需要的每個作業系統層級操作維護並行的 API 表面。插件擁有自己的文件瀏覽、git 工作流程、終端會話和流程管理邏輯。

## 21. 持久化和 Postgres

## 21.1 資料庫原理

1. 核心Paperclip資料保留在第一方表中。
2. 大多數外掛程式擁有的資料都從通用擴充表開始。
3. 在引進新表格之前，插件資料的範圍應限於現有的 Paperclip 物件。
4. 任意第三方模式遷移超出了第一個插件系統的範圍。

## 21.2 核心表重用

如果資料成為實際Paperclip產品模型的一部分，它應該成為第一方表。

範例：- `project_workspaces` 已經是第一方
- 如果Paperclip後來決定git state是核心產品數據，它也應該成為第一方表

## 21.3 所需表格

### `plugins`

- `id` uuid pk
- `plugin_key` 文字唯一不為空
- `package_name` 文字不為空
- `version` 文字不為空
- `api_version` int 不為空
- `categories` 文字[]不為空
- `manifest_json` jsonb 不為空
- `status` 列舉：`installed | ready | error | upgrade_pending`
- `install_order` int null
- `installed_at` 時間戳記不為空
- `updated_at` 時間戳記不為空
- `last_error` 文字為空

索引：

- 獨特的`plugin_key`
- `status`

### `plugin_config`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` 唯一不為空
- `config_json` jsonb 不為空
- `created_at` 時間戳記不為空
- `updated_at` 時間戳記不為空
- `last_error` 文字為空

### `plugin_state`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` 不為空
- `scope_kind` 列舉：`instance | company | project | project_workspace | agent | issue | goal | run`
- `scope_id` uuid/文字為空
- `namespace` 文字不為空
- `state_key` 文字不為空
- `value_json` jsonb 不為空
- `updated_at` 時間戳記不為空

限制條件：

- 獨特的`(plugin_id, scope_kind, scope_id, namespace, state_key)`

範例：

- 由 `issue` 鍵入的線性外部 ID
- GitHub 同步遊標由 `project` 鍵入
- 由 `project_workspace` 鍵控的檔案瀏覽器首選項
- git 分支元資料由 `project_workspace` 鍵入
- 處理由`project_workspace`或`run`鍵入的元數據

### `plugin_jobs`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` 不為空
- `scope_kind` 枚舉可為空
- `scope_id` uuid/文字為空
- `job_key` 文字不為空
- `schedule` 文字為空
- `status` 列舉：`idle | queued | running | error`
- `next_run_at` 時間戳空
- `last_started_at` 時間戳空
- `last_finished_at` 時間戳空
- `last_succeeded_at` 時間戳空
- `last_error` 文字為空

限制條件：

- 獨特的`(plugin_id, scope_kind, scope_id, job_key)`

### `plugin_job_runs`

- `id` uuid pk
- `plugin_job_id` uuid fk `plugin_jobs.id` 不為空
- `plugin_id` uuid fk `plugins.id` 不為空
- `status` 列舉：`queued | running | succeeded | failed | cancelled`
- `trigger` 列舉：`schedule | manual | retry`
- `started_at` 時間戳為空
- `finished_at` 時間戳空
- `error` 文字為空
- `details_json` jsonb 空

索引：

- `(plugin_id, started_at desc)`
- `(plugin_job_id, started_at desc)`

### `plugin_webhook_deliveries`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` 不為空
- `scope_kind` 枚舉可為空
- `scope_id` uuid/文字為空
- `endpoint_key` 文字不為空
- `status` 列舉：`received | processed | failed | ignored`
- `request_id` 文字為空
- `headers_json` jsonb 空
- `body_json` jsonb 空
- `received_at`時間戳記不為空
- `handled_at` 時間戳空
- `response_code` int null
- `error` 文字為空

索引：

- `(plugin_id, received_at desc)`
- `(plugin_id, endpoint_key, received_at desc)`

### `plugin_entities`（可選但建議）- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` 不為空
- `entity_type` 文字不為空
- `scope_kind` 枚舉不為空
- `scope_id` uuid/文字為空
- `external_id` 文字為空
- `title` 文字為空
- `status` 文字為空
- `data_json` jsonb 不為空
- `created_at` 時間戳記不為空
- `updated_at` 時間戳記不為空

索引：

- 當 `external_id` 不為空時，`(plugin_id, entity_type, external_id)` 唯一
- `(plugin_id, scope_kind, scope_id, entity_type)`

使用案例：

- 導入線性問題
- 導入GitHub問題
- 外掛程式擁有的進程記錄
- 插件擁有的外部指標綁定

## 21.4 活動日誌更改

活動日誌應擴充 `actor_type` 以包含 `plugin`。

新演員列舉：

- `agent`
- `user`
- `system`
- `plugin`

插件引發的突變應該這樣寫：

- `actor_type = plugin`
- `actor_id = <plugin-id>`

## 21.5 插件遷移

第一個插件系統不允許任意第三方遷移。

稍後，如果需要自訂表，系統可能會新增僅受信任模組的遷移路徑。

## 22. 秘密

插件配置絕不能保留原始秘密值。

規則：

1. 外掛程式配置僅儲存秘密引用。
2. 透過現有的Paperclip秘密提供者係統進行秘密引用解析。
3. 插件工作人員僅在執行時接收已解析的機密。
4. 秘密值絕對不能寫入：
   - 插件配置 JSON
   - 活動日誌
   - webhook 傳遞行
   - 錯誤訊息

## 23. 審計

所有插件發起的變異操作都必須是可審計的。

最低要求：

- 每個突變的活動日誌條目
- 作業運行歷史記錄
- webhook 傳遞歷史記錄
- 外掛程式健康頁面
- 安裝/升級歷史記錄在`plugins`

## 24. 操作員使用者體驗

## 24.1 全域設置

全域插件設定頁面必須顯示：

- 安裝的插件
- 版本
- 狀態
- 要求的能力
- 目前錯誤
- 安裝/升級/移除操作

## 24.2 外掛程式設定頁面

每個插件可能會暴露：

- 設定表單源自`instanceConfigSchema`
- 健康詳情
- 最近的工作經歷
- 最近的 webhook 歷史記錄
- 能力列表

路線：

- `/settings/plugins/:pluginId`

## 24.3 公司上下文外掛頁面

每個外掛程式可能會公開一個公司上下文主頁：

- `/:companyPrefix/plugins/:pluginId`

此頁面是董事會使用者進行大部分日常工作的地方。

## 25. 卸載和資料生命週期

當插件被卸載時，主機必須明確處理插件擁有的資料。

### 25.1 卸載過程1. Host發送`shutdown()`給worker，遵循優雅關閉策略。
2. 主機在`plugins`表中標記插件狀態`uninstalled`（軟體刪除）。
3. 外掛程式擁有的資料（`plugin_state`、`plugin_entities`、`plugin_jobs`、`plugin_job_runs`、`plugin_webhook_deliveries`、ZXQQQ00376QZ、ZXQQZ375QQXZ、ZXQQQ00376QZ）。
4. 在寬限期內，操作員可以重新安裝相同的插件並恢復其狀態。
5. 寬限期過後，主機將清除已卸載插件的所有插件擁有的資料。
6. 操作者可透過CLI立即強制清除：`pnpm paperclipai plugin purge <plugin-id>`。

### 25.2 升級資料注意事項

插件升級不會自動遷移插件狀態。如果插件的 `value_json` 形狀在版本之間發生變化：

- 插件工作人員負責在升級後首次訪問時遷移自己的狀態。
- 主機不運行插件定義的架構遷移。
- 外掛程式應該對其狀態鍵進行版本控製或使用 `value_json` 內的架構版本欄位來檢測和處理格式變更。

### 25.3 升級生命週期

升級插件時：

1. 主機發送`shutdown()`給老worker。
2. 主機等待舊工作進程耗盡運作中的工作（遵守關閉期限）。
3. 任何未在截止日期內完成的正在進行的作業均標記為 `cancelled`。
4. 主機安裝新版本並啟動新worker。
5. 如果新版本增加了能力，插件進入`upgrade_pending`，必須經過運營商批准後，新的worker才會變成`ready`。

### 25.4 熱插件生命週期

插件安裝、卸載、升級和設定變更**必須**生效，而無需重新啟動 Paperclip 伺服器。這是規範性要求，不是可選的。

該架構已經支援這一點——插件作為進程外工作人員運行，具有動態 ESM 導入、IPC 橋接和主機管理的路由表。本節明確了要求，因此實現不會倒退。

#### 25.4.1 熱安裝

當插件在運行時安裝時：

1. 主機在不停止現有服務的情況下解析並驗證清單。
2. 主機為插件產生一個新的工作進程。
3. 主機在即時路由表中註冊插件的事件訂閱、作業計畫、webhook 端點和智能體工具聲明。
4. 主機將插件的 UI 包路徑載入到擴充槽註冊表中，以便前端可以在下次導航時或透過即時通知發現它。
5. 插件進入`ready`狀態（若需要能力審核則進入`upgrade_pending`狀態）。

沒有其他插件或主機服務被中斷。

#### 25.4.2 熱卸載

當插件在運行時被卸載時：1.主機發送`shutdown()`並遵循優雅關閉策略（第12.5節）。
2. 主機從即時路由表中刪除插件的事件訂閱、作業計畫、Webhook 端點和智能體工具宣告。
3. 主機從擴充槽註冊表中刪除插件的 UI 包。任何目前安裝的插件 UI 元件都將被卸載並替換為佔位符或完全刪除。
4. 主機標記插件 `uninstalled` 並啟動資料保留寬限期（第 25.1 節）。

無需重新啟動伺服器。

#### 25.4.3 熱升級

當插件在運行時升級時：

1. 主機遵循升級生命週期（第25.3節）－關閉舊的worker，啟動新的worker。
2. 如果新版本更改了事件訂閱、作業計劃、Webhook 端點或智能體工具，主機會自動將舊註冊替換為新註冊。
3. 如果新版本發布了更新的 UI 包，則主機將使所有快取的包資源失效，並通知前端重新載入插件 UI 元件。活躍用戶會在下次導覽時或透過即時刷新通知看到更新的 UI。
4. 如果清單 `apiVersion` 未更改且未新增功能，則升級無需操作員互動即可完成。

#### 25.4.4 熱配置更改

當操作員在運行時更新插件的實例配置時：

1. 主機將新設定寫入`plugin_config`。
2. 主機透過IPC向正在執行的worker發送`configChanged`通知。
3. worker透過`ctx.config`接收新配置並套用它而無需重新啟動。如果外掛程式需要重新初始化連線（例如新的 API 令牌），它會在內部執行此操作。
4. 如果外掛程式不處理 `configChanged`，主機將使用新設定重新啟動工作進程（正常關閉然後重新啟動）。

#### 25.4.5 前端快取失效

主機必須對插件 UI 捆綁包 URL（例如 `/_plugins/:pluginId/ui/:version/*` 或基於內容哈希的路徑）進行版本控制，以便瀏覽器快取在升級或重新安裝後不會提供過時的捆綁包。

主機應發出 `plugin.ui.updated` 事件，前端偵聽該事件以觸發重新匯入更新的插件模組，而無需重新載入整個頁面。

#### 25.4.6 工作進程管理

主機的插件進程管理器必須支援：

- 為新安裝的插件啟動一個worker，而不影響其他worker
- 停止已卸載外掛程式的工作人員，而不影響其他工作人員
- 從路由表的角度來看，在升級期間自動替換工作人員（停止舊的，開始新的）
- 崩潰後重新啟動工作程序，無需操作員幹預（帶退避）

每個工作進程都是獨立的。沒有共享進程池或批次重啟機制。

## 26. 外掛程式可觀察性

### 26.1 日誌記錄插件工作人員使用 `ctx.logger` 發出結構化日誌。主機捕獲這些日誌並以可查詢的格式儲存它們。

日誌儲存規則：

- 插件日誌儲存在 `plugin_logs` 表中或附加到插件資料目錄下的日誌檔案。
- 每個日誌條目包括：外掛程式 ID、時間戳記、等級、訊息和可選的結構化元資料。
- 日誌可從 UI 中的外掛程式設定頁面查詢。
- 日誌具有可設定的保留期限（預設值：7 天）。
- 即使工作流程不使用 `ctx.logger`，主機也會從工作流程擷取 `stdout` 和 `stderr` 作為後備日誌。

### 26.2 健康控制台

插件設定頁面必須顯示：

- 目前工作狀態（運轉、錯誤、停止）
- 自上次重啟以來的正常運作時間
- 最近的日誌條目
- 作業運行歷史記錄以及成功/失敗率
- webhook 傳送歷史記錄以及成功/失敗率
- 最後的健康檢查結果和診斷
- 資源使用情況（如果可用）（記憶體、CPU）

### 26.3 警報

當插件運作狀況惡化時，主機應發出內部事件。這些使用 `plugin.*` 命名空間（不是核心域事件）並且不會出現在核心活動日誌中：

- `plugin.health.degraded` — 工人回報錯誤或健康檢查失敗
- `plugin.health.recovered` — 工作執行緒從錯誤狀態恢復
- `plugin.worker.crashed` — 工作進程意外退出
- `plugin.worker.restarted` — 工作進程在崩潰後重新啟動

這些事件可以由其他外掛程式（例如通知外掛程式）使用或顯示在控制台中。

## 27. 外掛程式開發與測試

### 27.1 `@paperclipai/plugin-test-harness`

主機應發布一個測試工具包，供插件作者用於本地開發和測試。

測試工具提供：

- 實現完整SDK介面的模擬主機（`ctx.config`、`ctx.events`、`ctx.state`等）
- 能夠發送合成事件並驗證處理程序回應
- 能夠觸發作業運行並驗證副作用
- 能夠模擬 `getData` 和 `performAction` 調用，就像來自 UI 橋接器一樣
- 能夠模擬 `executeTool` 調用，就像來自智能體運行一樣
- 用於斷言的記憶體狀態和實體存儲
- 用於測試能力拒絕路徑的可配置能力集

用法範例：

```ts
import { createTestHarness } from "@paperclipai/plugin-test-harness";
import manifest from "../dist/manifest.js";
import { register } from "../dist/worker.js";

const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
await register(harness.ctx);

// Simulate an event
await harness.emit("issue.created", { issueId: "iss-1", projectId: "proj-1" });

// Verify state was written
const state = await harness.state.get({ pluginId: manifest.id, scopeKind: "issue", scopeId: "iss-1", namespace: "sync", stateKey: "external-id" });
expect(state).toBeDefined();

// Simulate a UI data request
const data = await harness.getData("sync-health", { companyId: "comp-1" });
expect(data.syncedCount).toBeGreaterThan(0);
```

### 27.2 本機外掛程式開發

針對正在運行的 Paperclip 實例開發插件：

- 操作員從本機路徑安裝外掛：`pnpm paperclipai plugin install ./path/to/plugin`
- 主機監視插件目錄的變更並在重建時重新啟動工作程序。
- 插件配置中的`devUiUrl`可以指向本地Vite開發伺服器以進行UI熱重載。
- 外掛程式設定頁面顯示來自工作人員的即時日誌以進行偵錯。

### 27.3 外掛入門模板

主辦單位應發布一個入門範本（`create-paperclip-plugin`），該範本建構：- `package.json` 具有正確的 `paperclipPlugin` 金鑰
- 帶有佔位符值的清單
- 具有 SDK 類型匯入和範例事件處理程序的工作條目
- 使用橋接鉤子的 UI 條目，範例為 `DashboardWidget`
- 使用測試工具測試文件
- Worker 和 UI 套件的建置配置（esbuild 或類似）
- `.gitignore` 和 `tsconfig.json`

## 28. 範例映射

此規範直接支援以下插件類型：

- `@paperclip/plugin-workspace-files`
- `@paperclip/plugin-terminal`
- `@paperclip/plugin-git`
- `@paperclip/plugin-linear`
- `@paperclip/plugin-github-issues`
- `@paperclip/plugin-grafana`
- `@paperclip/plugin-runtime-processes`
- `@paperclip/plugin-stripe`

## 29. 相容性與版本控制

### 29.1 API 版本規則

1. 主機支援一個或多個明確插件API版本。
2. 插件清單恰好聲明了一個 `apiVersion`。
3. 主機在安裝時拒絕不支援的版本。
4. 插件升級是明確的操作員操作。
5. 能力擴展需要運營商的明確批准。

### 29.2 SDK 版本控制

主辦單位為插件作者發布了單一 SDK 套件：

- `@paperclipai/plugin-sdk` — 完整的插件 SDK

該套件使用子路徑匯出來分離工作執行緒和 UI 問題：

- `@paperclipai/plugin-sdk` — 工作端 SDK（上下文、事件、狀態、工具、記錄器、`definePlugin`、`z`）
- `@paperclipai/plugin-sdk/ui` — 前端 SDK（橋接鉤子、共用元件、設計令牌）

單一套件簡化了插件作者的依賴管理—一個依賴、一個版本、一個變更日誌。子路徑匯出保持包分離乾淨：工作程式碼從根匯入，UI 程式碼從 `/ui` 匯入。相應地建立工具 tree-shake，以便工作程式包不包含 React 元件，且 UI 套件不包含僅工作程式程式碼。

版本控制規則：1. **Semver**：SDK 遵循嚴格的語意版本控制。主要版本的變更表明工作人員或 UI 介面發生了重大變化；次要版本添加向後相容的新功能；補丁版本僅修復錯誤。
2. **與API版本綁定**：每個主要SDK版本都對應一個插件`apiVersion`。當 `@paperclipai/plugin-sdk@2.x` 發佈時，它的目標是 `apiVersion: 2`。使用 SDK 1.x 建構的插件繼續聲明 `apiVersion: 1`。
3. **主機多版本支援**：主機必須至少同時支援目前和先前的一個`apiVersion`。這意味著針對先前的 SDK 主要版本建立的插件無需修改即可繼續工作。主機為每個支援的 API 版本維護單獨的 IPC 協定處理程序。
4. **清單中的最低 SDK 版本**：插件在清單中將 `sdkVersion` 宣告為 semver 範圍（例如 `">=1.4.0 <2.0.0"`）。主機在安裝時驗證這一點，並在插件聲明的範圍超出主機支援的SDK 版本時發出警告。
5. **棄用時間表**：當新的 `apiVersion` 發佈時，先前的版本進入至少 6 個月的棄用期。在此期間：
   - 主機繼續載入已棄用版本的插件。
   - 主機在插件啟動時記錄棄用警告。
   - 外掛程式設定頁面顯示一個橫幅，指示外掛程式應該升級。
   - 棄用期結束後，主機可能會在未來版本中放棄對舊版本的支援。
6. **SD​​K 變更日誌和遷移指南**：每個主要 SDK 版本都必須包含記錄每個重大變更的遷移指南、新的 API 介面以及插件作者的逐步升級路徑。
7. **UI 表面穩定性**：對共享 UI 元件的重大更改（刪除元件、更改所需的 props）或設計令牌需要主要版本更新，就像工作人員 API 更改一樣。單包模型意味著兩個表面都一起進行版本控制，避免了工作程序和 UI 相容性之間的偏差。

### 29.3 版本相容性矩陣

主機應發布相容性矩陣：

|主機版本 |支援的 API 版本 | SDK範圍|
|---|---|---|
| 1.0 | 1 | 1.x |
| 2.0 | 1, 2 | 1.x、2.x |
| 3.0 | 2, 3 | 2.x、3.x |

此矩陣發佈在主機文件中，可透過 `GET /api/plugins/compatibility` 查詢。

### 29.4 外掛程式作者工作流程

當新的SDK版本發佈時：

1. 插件作者更新了`@paperclipai/plugin-sdk`依賴。
2. 插件作者依照遷移指南更新程式碼。
3. 插件作者更新了清單中的`apiVersion`和`sdkVersion`。
4. 插件作者發布新的插件版本。
5. 運營商升級其實例上的插件。舊版本將繼續工作，直到明確升級為止。## 30. 推薦交貨單

## 第一階段

- 外掛程式清單
- 安裝/列出/刪除/升級CLI
- 全域設定使用者介面
- 外掛程式進程管理器
- 能力執行
- `plugins`、`plugin_config`、`plugin_state`、`plugin_jobs`、`plugin_job_runs`、`plugin_webhook_deliveries`
- 活動巴士
- 職位
- 網路鉤子
- 設定頁面
- 插件 UI 套件載入、主機橋接器和 `@paperclipai/plugin-sdk/ui`
- 用於頁面、選項卡、小工具、側邊欄條目的擴充槽安裝
- 橋接錯誤傳播 (`PluginBridgeError`)
- 從 `instanceConfigSchema` 自動產生的設定表單
- 外掛提供的智能體工具
- 插件到插件事件（`plugin.<pluginId>.*` 命名空間）
- 事件過濾
- 優雅地關閉並可配置截止日期
- 插件日誌記錄和健康控制台
- `@paperclipai/plugin-test-harness`
- `create-paperclip-plugin` 入門模板
- 卸載並保留資料寬限期
- 熱插件生命週期（安裝、卸載、升級、設定更改，無需重新啟動伺服器）
- SDK 版本控制，具有多版本主機支援和棄用政策

此階段足以：

- 線性
- GitHub 問題
- 格拉法納
- 條紋
- 文件瀏覽器
- 終端
- git工作流程
- 進程/伺服器跟踪

工作區插件（檔案瀏覽器、終端、git、進程追蹤）不需要額外的主機 API - 它們透過 `ctx.projects` 解析工作區路徑並直接處理檔案系統、git、PTY 和進程操作。

## 第二階段

- 可選`plugin_entities`
- 更豐富的動作系統
- 如果確實需要的話，可信任模組遷移路徑
- 針對不受信任的插件 UI 套件的基於 iframe 的隔離
- 插件生態系統/分送工作

## 31. 最終設計決策

Paperclip 不應實現直接仿照本地編碼工具的通用進程內鉤包。

Paperclip 應實現：

- 用於低階主機整合的可信任平台模組
- 全域安裝的進程外插件，用於附加實例範圍的功能
- 插件貢獻的智能體工具（命名空間、功能門控）
- 插件交付的 UI 套件透過具有結構化錯誤傳播的類型化橋在主機擴充插槽中呈現
- 從設定模式自動產生設定 UI，並可選擇自訂設定頁面
- 用於跨插件協調的插件到插件事件
- 伺服器端事件過濾以實現高效率的事件路由
- 外掛直接擁有其本機工具邏輯（檔案系統、git、終端、流程）
- 大多數插件狀態的通用擴充表
- 正常關閉、卸載資料生命週期和插件可觀察性
- 熱插件生命週期 — 安裝、卸載、升級和配置更改，無需重新啟動伺服器
- SDK 版本控制，具有多版本主機支援和明確的棄用政策
- 測試工具和入門範本可降低創作難度
- 嚴格保留核心治理與審計規則這就是Paperclip插件系統的完整目標設計。