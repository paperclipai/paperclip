# 儲存系統實施方案（V1）

狀態：草案
所有者：後端+UI
日期：2026-02-20

## 目標

為 Paperclip 新增單一儲存子系統，支援：

- 用於單一使用者本機部署的本機磁碟存儲
- 用於雲端部署的S3相容物件存儲
- 用於問題圖像和未來文件附件的與提供者無關的介面

## V1 範圍

- 第一個消費者：發出附件/圖像。
- 儲存適配器：`local_disk` 和 `s3`。
- 文件始終屬於公司範圍並受存取控制。
- API 透過經過驗證的 Paperclip 端點提供附件位元組。

## 超出範圍（本草案）

- 公共未經身份驗證的物件 URL。
- CDN/簽名 URL 優化。
- 影像轉換/縮圖。
- 惡意軟體掃描管道。

## 關鍵決策

- 預設本機路徑位於實例根目錄下：`~/.paperclip/instances/<instanceId>/data/storage`。
- 物件位元組存在於儲存提供者中；元資料存在於 Postgres 中。
- `assets` 是通用元資料表；`issue_attachments` 將資產連結到問題/評論。
- S3 憑證來自執行時間環境/預設 AWS 提供者鏈，而不是資料庫行。
- 所有物件鍵都包含公司前綴以保留硬租賃邊界。

## 第 1 階段：共享設定 + 提供者合約

### 清單（每個文件）

- [ ] `packages/shared/src/constants.ts`：新增`STORAGE_PROVIDERS`和`StorageProvider`類型。
- [ ] `packages/shared/src/config-schema.ts`：新增 `storageConfigSchema`：
  - 提供者：`local_disk | s3`
  - localDisk.baseDir
  - s3.bucket、s3.region、s3.endpoint？ 、s3.prefix？ 、s3.forcePathStyle？
- [ ] `packages/shared/src/index.ts`：匯出新的儲存配置/類型。
- [ ] `cli/src/config/schema.ts`：確保重新匯出包含新的儲存架構/類型。
- [ ] `cli/src/commands/configure.ts`：新增`storage`部分支援。
- [ ] `cli/src/commands/onboard.ts`：初始化預設儲存配置。
- [ ] `cli/src/prompts/storage.ts`：本機磁碟與 s3 設定的新提示流程。
- [ ] `cli/src/prompts/index`（如果存在）或直接匯入：連接新儲存提示。
- [ ] `server/src/config.ts`：載入儲存配置並解析家庭感知本機路徑。
- [ ] `server/src/home-paths.ts`：新增`resolveDefaultStorageDir()`。
- [ ] `doc/CLI.md`：文檔`configure --section storage`。
- [ ] `doc/DEVELOPING.md`：文件預設本機儲存路徑和覆蓋。

### 驗收標準

- `paperclipai onboard` 預設寫入有效的 `storage` 設定區塊。
- `paperclipai configure --section storage` 可以在本地和 s3 模式之間切換。
- 伺服器啟動讀取儲存配置，無需僅環境駭客。

## 第 2 階段：伺服器儲存子系統 + 提供者

### 清單（每個文件）- [ ] `server/src/storage/types.ts`：定義提供者+服務介面。
- [ ] `server/src/storage/service.ts`：與提供者無關的服務（金鑰產生、驗證、流 API）。
- [ ] `server/src/storage/local-disk-provider.ts`：實作具有安全路徑解析的本機磁碟提供者。
- [ ] `server/src/storage/s3-provider.ts`：實作 S3 相容提供者 (`@aws-sdk/client-s3`)。
- [ ] `server/src/storage/provider-registry.ts`：透過設定的 ID 尋找提供者。
- [ ] `server/src/storage/index.ts`：匯出儲存工廠助手。
- [ ] `server/src/services/index.ts`：出口`storageService`工廠。
- [ ] `server/src/app.ts` 或路由接線點：在需要的地方注入/使用儲存服務。
- [ ] `server/package.json`：新增 AWS SDK 相依性（如果不存在）。

### 驗收標準

- 在`local_disk`模式下，上傳+讀取檔案在磁碟上往返位元組。
- 在 `s3` 模式下，服務可以針對 S3 相容端點 `put/get/delete`。
- 無效的提供者設定會產生明顯的啟動/設定錯誤。

## 第 3 階段：資料庫元資料模型

### 清單（每個文件）

- [ ] `packages/db/src/schema/assets.ts`：新的通用資產元資料表。
- [ ] `packages/db/src/schema/issue_attachments.ts`：發行到資產的連結表。
- [ ] `packages/db/src/schema/index.ts`：匯出新表。
- [ ] `packages/db/src/migrations/*`：為表格和索引產生遷移。
- [ ] `packages/shared/src/types/issue.ts`（或新資產類型檔案）：新增 `IssueAttachment` 類型。
- [ ] `packages/shared/src/index.ts`：匯出新類型。

### 建議專欄

- `assets`：
  - `id`、`company_id`、`provider`、`object_key`
  - `content_type`、`byte_size`、`sha256`、`original_filename`
  - `created_by_agent_id`、`created_by_user_id`、時間戳
- `issue_attachments`：
  - `id`、`company_id`、`issue_id`、`asset_id`、`issue_comment_id`（可為空）、時間戳

### 驗收標準

- 遷移完全適用於空的和現有的本機開發資料庫。
- 元資料行是公司範圍內的，並為問題查找建立索引。

## 第四階段：發布附件API

### 清單（每個文件）

- [ ] `packages/shared/src/validators/issue.ts`：新增上傳/列出/刪除附件操作的模式。
- [ ] `server/src/services/issues.ts`：新增附有公司檢查的附件 CRUD 助理。
- [ ] `server/src/routes/issues.ts`：新增端點：
  - `POST /companies/:companyId/issues/:issueId/attachments`（多部分）
  - `GET /issues/:issueId/attachments`
  - `GET /attachments/:attachmentId/content`
  - `DELETE /attachments/:attachmentId`
- [ ] `server/src/routes/authz.ts`：重複使用/強制公司存取附件端點。
- [ ] `server/src/services/activity-log.ts` 使用呼叫網站：記錄附件新增/刪除突變。
- [ ] `server/src/app.ts`：確保上傳路由具有分段解析中間件。

### API 行為

- 在 V1 中強制執行最大尺寸和圖像/內容類型白名單。
- 回傳一致錯誤：`400/401/403/404/409/422/500`。
- 流字節而不是在記憶體中緩衝大量有效負載。

### 驗收標準

- 董事會和同一公司智能體可以根據問題權限上傳和讀取附件。
- 即使附件 ID 有效，跨公司存取也會被拒絕。
- 活動日誌記錄附件新增/刪除操作。

## 第 5 階段：UI 問題附件集成### 清單（每個文件）

- [ ] `ui/src/api/issues.ts`：新增附件API客戶端方法。
- [ ] `ui/src/api/client.ts`：支援分段上傳助手（`FormData` 沒有 JSON `Content-Type`）。
- [ ] `ui/src/lib/queryKeys.ts`：新增問題附件查詢鍵。
- [ ] `ui/src/pages/IssueDetail.tsx`：新增上傳UI + 附件清單/查詢失效。
- [ ] `ui/src/components/CommentThread.tsx`：可選評論圖像附加或顯示連結圖像。
- [ ] `packages/shared/src/types/index.ts`：確保附件類型在 UI 中被乾淨地消耗。

### 驗收標準

- 用戶可以上傳問題詳細資訊中的圖像並立即看到它列出。
- 上傳的映像可以透過經過驗證的 API 路由開啟/渲染。
- 上傳和取得失敗對使用者可見（無靜默錯誤）。

## 第六階段：CLI醫師+操作強化

### 清單（每個文件）

- [ ] `cli/src/checks/storage-check.ts`：新增儲存檢查（本地可寫入目錄，可選的S3可達性檢查）。
- [ ] `cli/src/checks/index.ts`：匯出新儲存檢查。
- [ ] `cli/src/commands/doctor.ts`：在醫生序列中包含儲存檢查。
- [ ] `doc/DATABASE.md` 或 `doc/DEVELOPING.md`：依部署模式提及儲存後端行為。
- [ ] `doc/SPEC-implementation.md`：新增儲存子系統和發布附件端點合約。

### 驗收標準

- `paperclipai doctor` 報告可操作的儲存狀態。
- 本地單用戶安裝無需額外的雲端憑證即可運作。
- 雲端配置支援 S3 相容端點，無需更改程式碼。

## 測試計劃

### 伺服器整合測試

- [ ] `server/src/__tests__/issue-attachments.auth.test.ts`：公司邊界與權限測試。
- [ ] `server/src/__tests__/issue-attachments.lifecycle.test.ts`：上傳/列出/讀取/刪除流程。
- [ ] `server/src/__tests__/storage-local-provider.test.ts`：本地提供者路徑安全與往返。
- [ ] `server/src/__tests__/storage-s3-provider.test.ts`：s3 提供者合約（模擬客戶端）。
- [ ] `server/src/__tests__/activity-log.attachments.test.ts`：突變記錄斷言。

### CLI 測試

- [ ] `cli/src/__tests__/configure-storage.test.ts`：設定部分寫入有效的設定。
- [ ] `cli/src/__tests__/doctor-storage-check.test.ts`：儲存健康輸出與修復行為。

### UI 測試（如果目前堆疊中存在）

- [ ] `ui/src/...`：問題詳細上傳和錯誤處理測試。

## 合併前的驗證門

運行：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

如果跳過任何命令，請準確記錄跳過的內容及其原因。

## 實施令

1. 第一階段和第二階段（地基，無使用者可見的破損）
2. 第三階段（DB合約）
3. 第四階段（API）
4. 第5階段（UI消費者）
5. 第6階段（醫師/文件強化）